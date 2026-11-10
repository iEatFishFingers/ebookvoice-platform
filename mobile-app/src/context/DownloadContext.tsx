import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Audiobook, DownloadState, DownloadStatus } from '../types';

const STORAGE_KEY = 'download_state';
const DEFAULT_STATE: DownloadState = { status: 'none', progress: 0 };

interface DownloadContextType {
  downloads: Record<string, DownloadState>;
  downloadAudiobook: (audiobook: Audiobook) => Promise<void>;
  deleteDownload: (audiobookId: string) => Promise<void>;
  getDownloadState: (audiobookId: string) => DownloadState;
}

const DownloadContext = createContext<DownloadContextType | null>(null);

export const useDownload = (): DownloadContextType => {
  const ctx = useContext(DownloadContext);
  if (!ctx) throw new Error('useDownload must be used within DownloadProvider');
  return ctx;
};

export const DownloadProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({});
  // Tracks which audiobook IDs are actively downloading so we can cancel them
  const activeRef = useRef<Set<string>>(new Set());

  // Load persisted download state on mount
  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then(raw => {
      if (!raw) return;
      try {
        const parsed: Record<string, DownloadState> = JSON.parse(raw);
        // Any state left as 'downloading' means the app was killed mid-download — reset to 'failed'
        const cleaned = Object.fromEntries(
          Object.entries(parsed).map(([id, state]) => [
            id,
            state.status === 'downloading' ? { ...state, status: 'failed' as DownloadStatus, progress: 0 } : state,
          ])
        );
        setDownloads(cleaned);
        AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cleaned));
      } catch {}
    });
  }, []);

  const update = useCallback((id: string, patch: Partial<DownloadState>) => {
    setDownloads(prev => {
      const next = { ...prev, [id]: { ...(prev[id] ?? DEFAULT_STATE), ...patch } };
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const downloadAudiobook = useCallback(async (audiobook: Audiobook) => {
    if (Platform.OS === 'web') return;
    if (activeRef.current.has(audiobook.id)) return; // already downloading

    // Lazy import so web builds are unaffected
    let FileSystem: typeof import('expo-file-system/legacy');
    try {
      FileSystem = await import('expo-file-system/legacy');
    } catch {
      console.warn('[Download] expo-file-system not available');
      return;
    }
    const baseDir = `${FileSystem.documentDirectory}audiobooks/${audiobook.id}/`;
    await FileSystem.makeDirectoryAsync(baseDir, { intermediates: true });

    activeRef.current.add(audiobook.id);
    const isChapterBased = !!(audiobook.chapters && audiobook.chapters.length > 0);

    if (isChapterBased) {
      const chapters = audiobook.chapters!;
      const total = chapters.length;
      update(audiobook.id, { status: 'downloading', progress: 0, totalChapters: total, downloadedChapters: 0 });

      const localChapterPaths: Record<number, string> = {};

      for (let i = 0; i < chapters.length; i++) {
        if (!activeRef.current.has(audiobook.id)) return; // cancelled

        const chapter = chapters[i];
        if (!chapter.audioUrl) continue;

        const localPath = `${baseDir}chapter_${i}.mp3`;
        try {
          await FileSystem.downloadAsync(chapter.audioUrl, localPath);
          localChapterPaths[i] = localPath;
        } catch (err) {
          console.error(`[Download] Chapter ${i} failed:`, err);
          activeRef.current.delete(audiobook.id);
          update(audiobook.id, { status: 'failed', progress: 0 });
          return;
        }

        update(audiobook.id, {
          status: 'downloading',
          progress: (i + 1) / total,
          downloadedChapters: i + 1,
          localChapterPaths,
        });
      }

      activeRef.current.delete(audiobook.id);
      update(audiobook.id, {
        status: 'downloaded',
        progress: 1,
        totalChapters: total,
        downloadedChapters: total,
        localChapterPaths,
      });

    } else {
      // Single-file book (EPUB conversion)
      if (!audiobook.filePath) {
        activeRef.current.delete(audiobook.id);
        update(audiobook.id, { status: 'failed', progress: 0 });
        return;
      }

      update(audiobook.id, { status: 'downloading', progress: 0 });
      const localPath = `${baseDir}audio.mp3`;

      try {
        const resumable = FileSystem.createDownloadResumable(
          audiobook.filePath,
          localPath,
          {},
          (dp: { totalBytesWritten: number; totalBytesExpectedToWrite: number }) => {
            const pct = dp.totalBytesExpectedToWrite > 0
              ? dp.totalBytesWritten / dp.totalBytesExpectedToWrite
              : 0;
            update(audiobook.id, { status: 'downloading', progress: pct });
          }
        );
        await resumable.downloadAsync();
        activeRef.current.delete(audiobook.id);
        update(audiobook.id, { status: 'downloaded', progress: 1, localFilePath: localPath });
      } catch (err) {
        console.error('[Download] Single file failed:', err);
        activeRef.current.delete(audiobook.id);
        update(audiobook.id, { status: 'failed', progress: 0 });
      }
    }
  }, [update]);

  const deleteDownload = useCallback(async (audiobookId: string) => {
    if (Platform.OS === 'web') return;

    // Cancel any active download for this book
    activeRef.current.delete(audiobookId);

    let FileSystem: typeof import('expo-file-system/legacy');
    try {
      FileSystem = await import('expo-file-system/legacy');
    } catch {
      console.warn('[Download] expo-file-system not available');
      return;
    }
    const dir = `${FileSystem.documentDirectory}audiobooks/${audiobookId}/`;
    try {
      const info = await FileSystem.getInfoAsync(dir);
      if (info.exists) {
        await FileSystem.deleteAsync(dir, { idempotent: true });
      }
    } catch (err) {
      console.error('[Download] deleteDownload error:', err);
    }

    setDownloads(prev => {
      const next = { ...prev };
      delete next[audiobookId];
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const getDownloadState = useCallback(
    (audiobookId: string): DownloadState => downloads[audiobookId] ?? DEFAULT_STATE,
    [downloads]
  );

  return (
    <DownloadContext.Provider value={{ downloads, downloadAudiobook, deleteDownload, getDownloadState }}>
      {children}
    </DownloadContext.Provider>
  );
};
