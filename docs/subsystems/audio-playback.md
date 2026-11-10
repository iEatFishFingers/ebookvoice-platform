# Audio Playback

## Two players, one server-side switch

`react-native-track-player` (RNTP) provides lock-screen, Bluetooth, CarPlay and Android Auto controls. `expo-av` is the legacy fallback.

- The player is chosen at `createAudioPlayer()` time in `mobile-app/src/utils/audioPlayer.ts`, which checks `getFeatureFlags().rntp_enabled`.
- `getFeatureFlags()` reads an in-memory cache populated once at `App.tsx` mount by `loadFeatureFlags()`, which calls `GET /api/feature-flags`.
- Server side, `feature_flags` in `epub_to_audio.py` returns `{rntp_enabled: <bool>}` from the `FEATURE_RNTP_ENABLED` env var (default `false`).

Flipping the env var rolls playback forward or back on every installed binary without a rebuild — the fastest lever available if playback regresses in production.

**Invariants:**

- **Voice previews use `createPreviewPlayer()`** (always expo-av on mobile) so a 5-second sample never takes over the lock-screen session.
- **Web uses `WebAudioPlayer`** (HTMLAudioElement) only — RNTP has no web implementation.

## Background playback is free

Background play with lock-screen / Bluetooth / CarPlay controls is treated as core listening and is available to everyone, including anonymous users. Anonymous progress-saving relies on `PUT /api/audiobooks/<id>/progress` being `@optional_auth`. See [paywall & credits](paywall-and-credits.md).

## Playback speed

`PlayerScreen.tsx` — `PLAYBACK_SPEEDS`, nine steps with a 3× ceiling:

```
[0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0]
```

One chip, three ways to drive it:

- **Tap** advances one step and wraps.
- **VoiceOver swipe up / down** — the chip is `accessibilityRole="adjustable"` with `increment` / `decrement` actions. It steps **without wrapping**, so a swipe past 3× can't drop the listener back to 0.5×. The value is announced from `accessibilityValue` (*"Playback speed, 2.5 times, adjustable"*).
- **Remembered** in AsyncStorage (`@playback_speed`) and restored on every book and launch.

**Why 3×.** On iOS both backends time-stretch through `AVAudioTimePitchAlgorithm.timeDomain` (RNTP's default `voice` algorithm; expo-av with `shouldCorrectPitch`). Apple rates it for 1/32×–32×, so the ceiling is a product choice: past ~3× synthetic narration stops being intelligible before the algorithm gives out. The original 2× ceiling was raised after screen-reader users — who listen to speech much faster than sighted listeners — reported it as a deal breaker.

**The rate survives chapter boundaries in every backend.** Each `AudioPlayerInterface` implementation stores `currentRate` and re-applies it inside `loadAsync`. expo-av creates a fresh `Audio.Sound` per chapter and both web players a fresh `<audio>` element — all of which start at 1×. See [the incident](../incidents/playback-speed-resets-per-chapter.md).

## Seeking with VoiceOver

The position slider is a native `UISlider`, so VoiceOver can already drive it (swipe up / down moves 10% of the chapter). The seek used to live in `onSlidingComplete`, which only a touch fires. Assistive value changes — with no touch in flight — now seek 400 ms after the last swipe. See [the incident](../incidents/voiceover-slider-cannot-seek.md).

## Bluetooth headsets above 1×

Non-Apple (AVRCP) headsets and car systems could resume but not pause at any rate above 1×: SwiftAudioEx publishes `playbackRate` without `defaultPlaybackRate`, and iOS reads the mismatch as *fast-forwarding*. AirPods use the toggle command and never noticed. Fixed with a one-line `patch-package` on RNTP's `setRate`, re-published after every load.

> `mobile-app/patches/react-native-track-player+4.1.2.patch` must travel with any RNTP version bump — `patch-package` runs in `postinstall`, and a bump without moving the patch fails the install on EAS and Vercel. See [the incident](../incidents/bluetooth-headset-cannot-pause-above-1x.md).

## Downloaded books play from local storage

Downloads are real files, not a cache hint. `DownloadContext` writes each chapter under `documentDirectory/audiobooks/<id>/` via `downloadAsync` / `createDownloadResumable`, and every load site in the player prefers the local file:

```ts
const audioUri = localPath ?? (chapter.audioUrl?.startsWith('http') ? chapter.audioUrl : null);
```

Offline listening therefore works for any downloaded book.

## Progress persistence

An in-car test session found the app losing its place three different ways. Seven defects were fixed together:

- progress sync was **debounced, not throttled** — zero invocations across 10 s of 250 ms ticks
- `currentTimeRef` was zeroed by an effect that also fired when the background detail fetch resolved (~1 s after opening a book), so anything reading it in that window saw `0`
- a race between chapter navigation and the resume-seek
- a **server-side monotonic guard**: within a chapter, an unexplained backwards jump beyond 90 s is rejected and acknowledged with the stored value (**never a 4xx** — the client is mid-playback). Chapter changes are always allowed. Clients send `explicitSeek` on deliberate playhead moves to opt out; older binaries never send it, which is the safe default because they are the ones with the bug.

## Cost model

The API serves one HTTP request at a time (see [server architecture](../operations/server-architecture.md)), so each progress write (three database round trips) briefly blocks other traffic. Caching immutable chapter durations and moving the periodic cadence from 10 s to 30 s would cut ~1,080 → ~240 queries per listener-hour.

The more important lesson came from egress: a cost review that priced progress writes at ~32 MB per heavy listener-month missed `GET /api/audiobooks/<id>`, which read the whole book's word timings on every Player open — ~250× larger per event. That path exhausted the Supabase egress allowance. **A cost review has to price every read on the hot path × expected volume**, not just the one being edited. See [detail-fetch egress](../incidents/detail-fetch-egress.md).

## Related

- [Karaoke timings](karaoke-timings.md) — the follow-along layer on top of playback
- [Server architecture](../operations/server-architecture.md)
