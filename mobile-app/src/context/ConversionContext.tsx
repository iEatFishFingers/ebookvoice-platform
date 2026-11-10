import React, { createContext, useContext, useState, useEffect, useRef, ReactNode } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import apiService from '../services/api';
import { track } from '../services/analytics';
import { QueueStatus } from '../types';
import { registerForPushNotifications } from '../utils/notifications';

// v2 key: incompatible with the old single-task format
const ACTIVE_CONVERSIONS_KEY = 'active_conversions_v2';
// Two polling rates, picked dynamically:
// - FAST_MS while a conversion is actively synthesizing — user wants smooth
//   progress updates.
// - SLOW_MS while all incomplete conversions are merely queued (worker hasn't
//   claimed the task yet, so polling rapidly is just burning requests against
//   an unchanging "Queued" status). 30 s feels responsive enough — when the
//   worker picks up the task, the next poll switches us back to fast.
const POLL_INTERVAL_FAST_MS = 3000;
const POLL_INTERVAL_SLOW_MS = 30000;
const MAX_CONSECUTIVE_ERRORS = 5;
// A /status 404 is ambiguous: it means EITHER the task is genuinely gone (reaped
// by cleanup_old_tasks, or never persisted) OR it's transient — a just-submitted
// task 404s for a poll or two before the server registers it, and during a backend
// DB outage the status endpoint also returns 404. So we never drop on a single
// 404; only after a task 404s this many polls in a row (counted across both the
// reconcile and poll paths) do we treat it as truly gone and remove the stub.
// Without this, a stale stub pointing at a reaped task polls a 404 forever and the
// "converting…" UI never clears (the 2026-06-02 Supabase-outage incident).
const NOT_FOUND_DROP_THRESHOLD = 3;

export interface TrackedConversion {
  taskId: string;
  epubName: string;
  voiceId: string;
  progress: number;       // 0–1 normalized
  status: string;
  error: string | null;
  audioUrl: string | null;
  complete: boolean;
  initialized: boolean;   // true after first successful poll
  queueStatus: QueueStatus;
  queuePosition: number | null;
  title: string | null;
  /** Server-computed seconds remaining; undefined until first chapter completes. */
  etaSeconds?: number;
  /** Database UUID for the saved audiobook — available after conversion completes. */
  databaseId?: string;
}

// Minimal stub persisted in AsyncStorage (server is source of truth for the rest)
interface ConversionStub {
  taskId: string;
  epubName: string;
  voiceId: string;
}

interface ConversionContextType {
  activeConversions: TrackedConversion[];
  /** The most relevant single conversion — for backward compat with ConversionScreen */
  activeConversion: TrackedConversion | null;
  startConversion: (taskId: string, epubName: string, voiceId: string) => void;
  clearConversion: (taskId: string) => void;
  cancelConversion: (taskId: string) => Promise<void>;
}

const ConversionContext = createContext<ConversionContextType>({
  activeConversions: [],
  activeConversion: null,
  startConversion: () => {},
  clearConversion: () => {},
  cancelConversion: async () => {},
});

export const useConversion = () => useContext(ConversionContext);

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeInitialTracked(stub: ConversionStub, status = 'Resuming...'): TrackedConversion {
  return {
    taskId: stub.taskId,
    epubName: stub.epubName,
    voiceId: stub.voiceId,
    progress: 0,
    status,
    error: null,
    audioUrl: null,
    complete: false,
    initialized: false,
    queueStatus: 'queued',
    queuePosition: null,
    title: stub.epubName.replace(/\.epub$/i, ''),
    etaSeconds: undefined,
  };
}

function mergeServerTask(
  server: Awaited<ReturnType<typeof apiService.getConversionStatus>>,
  existing: TrackedConversion,
): TrackedConversion {
  return {
    ...existing,
    progress: Math.max(existing.progress, (server.progress ?? 0) / 100),
    status: server.status ?? existing.status,
    error: server.error ?? null,
    audioUrl: server.audioUrl ?? existing.audioUrl,
    complete: server.complete,
    initialized: true,
    queueStatus: server.queueStatus ?? existing.queueStatus,
    queuePosition: server.queuePosition ?? null,
    title: server.title ?? existing.title,
    etaSeconds: server.etaSeconds ?? existing.etaSeconds,
    databaseId: server.databaseId ?? existing.databaseId,
  };
}

function persistStubs(conversions: TrackedConversion[]): void {
  const stubs: ConversionStub[] = conversions
    .filter(c => !c.complete)
    .map(c => ({ taskId: c.taskId, epubName: c.epubName, voiceId: c.voiceId }));
  AsyncStorage.setItem(ACTIVE_CONVERSIONS_KEY, JSON.stringify(stubs)).catch(() => {});
}

// ── Provider ─────────────────────────────────────────────────────────────────

export const ConversionProvider = ({ children }: { children: ReactNode }) => {
  const [conversions, setConversions] = useState<TrackedConversion[]>([]);
  const conversionsRef = useRef<TrackedConversion[]>([]);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastPollIntervalMsRef = useRef<number | null>(null);
  const consecutiveErrorsRef = useRef(0);
  // Per-task count of consecutive /status 404s. Shared by reconcileWithServer and
  // pollAll so a dead task is dropped after NOT_FOUND_DROP_THRESHOLD strikes no
  // matter which path observed them; any successful status fetch resets it.
  const notFoundCountsRef = useRef<Map<string, number>>(new Map());

  // Returns the new consecutive-404 count for this task (after incrementing).
  const recordNotFound = (taskId: string): number => {
    const n = (notFoundCountsRef.current.get(taskId) ?? 0) + 1;
    notFoundCountsRef.current.set(taskId, n);
    return n;
  };
  const clearNotFound = (taskId: string): void => {
    notFoundCountsRef.current.delete(taskId);
  };

  // Keep ref in sync for AppState listener (avoids stale closure)
  useEffect(() => {
    conversionsRef.current = conversions;
  }, [conversions]);

  // Computed: the most relevant single conversion (backward compat for ConversionScreen)
  const activeConversion: TrackedConversion | null = (() => {
    const incomplete = conversions.filter(c => !c.complete);
    if (incomplete.length === 0) return conversions[0] ?? null;
    return incomplete.find(c => c.queueStatus === 'processing') ?? incomplete[0];
  })();

  // ── On mount: restore stubs → reconcile with server ──────────────────────
  useEffect(() => {
    const init = async () => {
      // Step 1: Load stubs from AsyncStorage for immediate UI feedback
      try {
        const raw = await AsyncStorage.getItem(ACTIVE_CONVERSIONS_KEY);
        if (raw) {
          const stubs: ConversionStub[] = JSON.parse(raw);
          setConversions(stubs.map(s => makeInitialTracked(s)));
        }
      } catch { /* non-critical */ }

      // Step 2: Authoritative state from server
      await reconcileWithServer();
    };
    init();

    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, []);

  // ── On app foreground: reconcile with server ──────────────────────────────
  useEffect(() => {
    const onStateChange = async (next: AppStateStatus) => {
      if (next !== 'active') return;
      const hasIncomplete = conversionsRef.current.some(c => !c.complete);
      if (!hasIncomplete) return;
      console.log('[ConversionContext] App foregrounded — reconciling with server');
      consecutiveErrorsRef.current = 0;
      await reconcileWithServer();
    };
    const sub = AppState.addEventListener('change', onStateChange);
    return () => sub.remove();
  }, []);

  // ── Polling: auto-start/stop based on incomplete conversions ─────────────
  // Two rates: fast while any conversion is actively synthesizing, slow
  // (30 s) while everything is merely queued. Cuts request volume by ~10×
  // for users waiting in line behind another conversion.
  useEffect(() => {
    const hasIncomplete = conversions.some(c => !c.complete);
    if (!hasIncomplete) {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
        lastPollIntervalMsRef.current = null;
      }
      return;
    }

    const anyProcessing = conversions.some(
      c => !c.complete && c.queueStatus === 'processing',
    );
    const intervalMs = anyProcessing ? POLL_INTERVAL_FAST_MS : POLL_INTERVAL_SLOW_MS;

    // Only reset the interval when the chosen rate actually changes — every
    // poll updates conversions state, so without this guard we'd recreate
    // the timer constantly.
    if (lastPollIntervalMsRef.current !== intervalMs) {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = setInterval(pollAll, intervalMs);
      lastPollIntervalMsRef.current = intervalMs;
    }
  }, [conversions]);

  // ── Core logic ────────────────────────────────────────────────────────────

  const reconcileWithServer = async () => {
    try {
      const serverTasks = await apiService.getActiveConversions();

      // For any local incomplete task NOT in the server's active list, the
      // task has either: (a) completed since we last looked, or (b) it was
      // just submitted and the server hasn't seen it yet. We can't tell
      // which from /api/conversions/active alone, so fetch /status directly
      // for each. If /status says complete, we update local state on this
      // reconcile tick; if it's still in flight, we leave the stub alone
      // and the polling interval will catch it.
      //
      // Without this lookup, a conversion that completed while the app
      // was backgrounded would stay stuck on the "still converting" screen
      // even after the user tapped the "done" push notification.
      const localIncomplete = conversionsRef.current.filter(c => !c.complete);
      const serverIdSet = new Set(serverTasks.map(t => t.taskId));
      const missingFromServer = localIncomplete.filter(c => !serverIdSet.has(c.taskId));
      const directStatuses = await Promise.allSettled(
        missingFromServer.map(c => apiService.getConversionStatus(c.taskId))
      );
      const directStatusByTaskId = new Map<string, any>();
      // Task IDs whose direct /status fetch has now 404'd often enough to be
      // considered gone. Anything not in here (network error, single 404) is
      // treated as transient and the stub is kept for the next tick.
      const reconcileDropIds = new Set<string>();
      directStatuses.forEach((r, i) => {
        const taskId = missingFromServer[i].taskId;
        if (r.status === 'fulfilled') {
          directStatusByTaskId.set(taskId, r.value);
          clearNotFound(taskId);
        } else if ((r.reason as any)?.response?.status === 404) {
          if (recordNotFound(taskId) >= NOT_FOUND_DROP_THRESHOLD) {
            reconcileDropIds.add(taskId);
          }
        }
        // Non-404 rejection (network/outage): leave the counter untouched and
        // keep the stub — we can't conclude the task is gone.
      });

      setConversions(prev => {
        const byId = new Map(prev.map(c => [c.taskId, c]));
        const merged: TrackedConversion[] = [];
        const serverIds = new Set<string>();

        for (const st of serverTasks) {
          serverIds.add(st.taskId);
          clearNotFound(st.taskId); // server still knows it — it's alive
          const local = byId.get(st.taskId);
          const existing = local ?? makeInitialTracked(
            { taskId: st.taskId, epubName: st.title ?? st.taskId, voiceId: '' }
          );
          const updated = mergeServerTask(st, existing);
          merged.push(updated);
          // Handle completions discovered on reconcile — but only for tasks
          // this device was tracking. /api/conversions/active also returns
          // tasks completed in the last 24 h; with no local stub (already
          // handled, or another device's) the "completion" is old news, and
          // firing it re-saved the library and re-tracked conversion_completed
          // on every app open until the row was purged.
          if (updated.complete && local && !local.complete) {
            handleCompletion(updated, st).catch(() => {});
          }
        }

        // For local-only tasks: use the /status fetch we just did to decide
        // whether they completed (server dropped them from active) or are
        // genuinely just-submitted (server doesn't know yet).
        for (const local of prev) {
          if (serverIds.has(local.taskId) || local.complete) continue;
          const direct = directStatusByTaskId.get(local.taskId);
          if (direct) {
            const updated = mergeServerTask(direct, local);
            merged.push(updated);
            if (updated.complete && !local.complete) {
              handleCompletion(updated, direct).catch(() => {});
            }
          } else if (reconcileDropIds.has(local.taskId)) {
            // /status has 404'd NOT_FOUND_DROP_THRESHOLD times — the task is
            // gone (reaped by cleanup, or never persisted). Drop the stub so the
            // UI stops showing a conversion that will never resolve.
            clearNotFound(local.taskId);
            // (intentionally not pushed → removed from merged)
          } else {
            // Transient failure (network, single/early 404, outage) — keep the
            // stub so the polling loop can retry.
            merged.push(local);
          }
        }

        persistStubs(merged);
        return merged;
      });
    } catch (err) {
      console.warn('[ConversionContext] reconcileWithServer failed:', (err as Error).message);
    }
  };

  const pollAll = async () => {
    const incomplete = conversionsRef.current.filter(c => !c.complete);
    if (incomplete.length === 0) return;

    try {
      const results = await Promise.allSettled(
        incomplete.map(c => apiService.getConversionStatus(c.taskId))
      );

      consecutiveErrorsRef.current = 0;

      const completions: Array<{ updated: TrackedConversion; serverTask: any }> = [];

      // A task whose /status 404s repeatedly no longer exists on the server.
      // Count consecutive 404s per task and only drop after the threshold, so a
      // just-submitted task — or a healthy one during a transient DB outage —
      // that 404s for a poll or two isn't dropped prematurely. A successful poll
      // resets the count.
      const notFoundIds = new Set<string>();
      results.forEach((r, i) => {
        const taskId = incomplete[i].taskId;
        if (r.status === 'fulfilled') {
          clearNotFound(taskId);
        } else if ((r.reason as any)?.response?.status === 404) {
          if (recordNotFound(taskId) >= NOT_FOUND_DROP_THRESHOLD) {
            notFoundIds.add(taskId);
          }
        }
      });

      setConversions(prev => {
        let next = [...prev];
        results.forEach(result => {
          if (result.status === 'rejected') return;
          const st = result.value;
          const idx = next.findIndex(c => c.taskId === st.taskId);
          if (idx === -1) return;
          const updated = mergeServerTask(st, next[idx]);
          next[idx] = updated;
          if (updated.complete && !prev[idx].complete) {
            completions.push({ updated, serverTask: st });
          }
        });
        // Drop stubs for tasks that don't exist on the server
        if (notFoundIds.size > 0) {
          next = next.filter(c => !notFoundIds.has(c.taskId));
          notFoundIds.forEach(clearNotFound);
          console.log('[ConversionContext] Dropped', notFoundIds.size, 'not-found task(s)');
        }
        persistStubs(next);
        return next;
      });

      // Run side-effects (library saves) outside setState
      for (const { updated, serverTask } of completions) {
        handleCompletion(updated, serverTask).catch(() => {});
      }

    } catch (err) {
      if (AppState.currentState !== 'active') return;
      consecutiveErrorsRef.current += 1;
      console.error(`[ConversionContext] Poll error (${consecutiveErrorsRef.current}/${MAX_CONSECUTIVE_ERRORS}):`, err);

      if (consecutiveErrorsRef.current >= MAX_CONSECUTIVE_ERRORS) {
        clearInterval(pollIntervalRef.current!);
        pollIntervalRef.current = null;
        setConversions(prev => {
          const next = prev.map(c =>
            c.complete ? c : { ...c, error: 'Connection lost — reopen the app to retry', complete: true }
          );
          AsyncStorage.removeItem(ACTIVE_CONVERSIONS_KEY).catch(() => {});
          return next;
        });
      }
    }
  };

  const handleCompletion = async (
    conv: TrackedConversion,
    serverTask: Awaited<ReturnType<typeof apiService.getConversionStatus>>,
  ) => {
    if (serverTask.error) {
      // Error path — no library save needed
      track('conversion_failed', {
        // task_id matches the conversion_tasks row + every Render log line
        // for this conversion — the cross-reference key for incident digs.
        task_id: conv.taskId,
        error_stage: serverTask.status ?? 'unknown',
        chapter_count: serverTask.chapters?.length,
      });
      return;
    }

    if (serverTask.chapters && serverTask.chapters.length > 0) {
      await saveAudiobookWithChapters(conv.taskId, conv.epubName, conv.voiceId, serverTask.chapters, conv.databaseId);
    } else if (serverTask.audioUrl) {
      await saveToLibrary(conv.taskId, conv.epubName, conv.voiceId, serverTask.audioUrl);
    }

    track('conversion_completed', {
      task_id: conv.taskId,
      audiobook_id: conv.databaseId ?? serverTask.databaseId,
      chapter_count: serverTask.chapters?.length,
      duration_seconds: (serverTask as any).duration,
    });

    // Remove this task's stub from AsyncStorage
    try {
      const raw = await AsyncStorage.getItem(ACTIVE_CONVERSIONS_KEY);
      if (raw) {
        const stubs: ConversionStub[] = JSON.parse(raw).filter(
          (s: ConversionStub) => s.taskId !== conv.taskId
        );
        await AsyncStorage.setItem(ACTIVE_CONVERSIONS_KEY, JSON.stringify(stubs));
      }
    } catch { /* non-critical */ }
  };

  // ── Public API ────────────────────────────────────────────────────────────

  const startConversion = (taskId: string, epubName: string, voiceId: string) => {
    const stub: ConversionStub = { taskId, epubName, voiceId };
    const newConv = makeInitialTracked(stub, 'Queued — waiting to start...');

    // Ask for the "Audiobook Ready" push now — the one moment it is obviously
    // useful, rather than at first launch. Signed-in users already registered
    // on SIGNED_IN (harmless repeat); anonymous trials had no path at all and
    // 6 of 11 delivered books in the AppleVis week went unannounced. The
    // request carries X-Device-Id, so the server scopes it correctly.
    if (Platform.OS !== 'web') {
      registerForPushNotifications()
        .then(token => (token ? apiService.savePushToken(token) : undefined))
        .catch(err => console.warn('[ConversionContext] push token registration failed:', err));
    }

    setConversions(prev => {
      const next = [newConv, ...prev.filter(c => c.taskId !== taskId)];
      persistStubs(next);
      return next;
    });

    // Trigger a quick reconcile so the UI shows the real server state
    // without waiting the full 3-second poll interval.
    setTimeout(reconcileWithServer, 800);
  };

  const clearConversion = (taskId: string) => {
    clearNotFound(taskId);
    setConversions(prev => {
      const next = prev.filter(c => c.taskId !== taskId);
      persistStubs(next);
      return next;
    });
  };

  const cancelConversion = async (taskId: string) => {
    try {
      await apiService.cancelConversion(taskId);
    } catch (err) {
      // If the server returns 409 (already finished) or 404, still clear locally
      const status = (err as any)?.response?.status;
      if (status !== 404 && status !== 409) throw err;
    } finally {
      clearConversion(taskId);
    }
  };

  // ── Library save helpers (preserved from original) ────────────────────────

  const saveToLibrary = async (
    taskId: string, epubName: string, voiceId: string, url: string
  ) => {
    try {
      const raw = await AsyncStorage.getItem('audiobook_library');
      const library = raw ? JSON.parse(raw) : [];
      const voices = await apiService.getVoices();
      const voice = voices.find(v => v.id === voiceId);
      library.push({
        id: taskId,
        title: epubName.replace('.epub', ''),
        voiceId,
        voiceName: voice?.name ?? 'AI Voice',
        filePath: url,
        createdAt: new Date().toISOString(),
        status: 'completed',
        progress: 0,
        currentPosition: 0,
        duration: 0,
      });
      await AsyncStorage.setItem('audiobook_library', JSON.stringify(library));
    } catch (err) {
      console.error('[ConversionContext] saveToLibrary error:', err);
    }
  };

  const saveAudiobookWithChapters = async (
    taskId: string, epubName: string, voiceId: string, chapters: any[], databaseId?: string
  ) => {
    try {
      // Try DB sync first — server already saved it in process_chapters_conversion
      // Use databaseId (UUID) for lookup since the library returns UUID-keyed records
      const lookupId = databaseId ?? taskId;
      try {
        const updated = await apiService.getLibrary();
        await AsyncStorage.setItem('audiobook_library', JSON.stringify(updated));
        const found = updated.find((b: any) => b.id === lookupId);
        if (found && found.chapters && found.chapters.length > 0) {
          console.log('[ConversionContext] Audiobook verified in synced library:', found.title, `(${found.chapters.length} chapters)`);
          return;
        }
        if (found) {
          console.warn('[ConversionContext] Book found in DB but has no chapters — will save locally from task response');
        }
      } catch (syncErr) {
        console.warn('[ConversionContext] DB sync failed, saving locally:', syncErr);
      }

      // Fallback: save locally with the ID that PlayerScreen will look up
      const raw = await AsyncStorage.getItem('audiobook_library');
      const library = raw ? JSON.parse(raw) : [];
      const voices = await apiService.getVoices();
      const voice = voices.find(v => v.id === voiceId);
      const totalDuration = chapters.reduce((sum: number, ch: any) => sum + (ch.duration || 0), 0);
      library.push({
        id: lookupId,
        title: epubName.replace('.epub', ''),
        voiceId,
        voiceName: voice?.name ?? 'AI Voice',
        createdAt: new Date().toISOString(),
        status: 'completed',
        progress: 0,
        currentPosition: 0,
        duration: totalDuration,
        chapters,
        currentChapter: 0,
      });
      await AsyncStorage.setItem('audiobook_library', JSON.stringify(library));
      console.log('[ConversionContext] Saved locally with', chapters.length, 'chapters');
    } catch (err) {
      console.error('[ConversionContext] saveAudiobookWithChapters error:', err);
    }
  };

  return (
    <ConversionContext.Provider value={{
      activeConversions: conversions,
      activeConversion,
      startConversion,
      clearConversion,
      cancelConversion,
    }}>
      {children}
    </ConversionContext.Provider>
  );
};
