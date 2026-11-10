# Non-Apple Bluetooth headsets could resume but never pause — at any speed above 1×

**Severity:** high · **Status:** fixed with a native patch

## Symptom

On iOS, AirPods paused and resumed normally, but AVRCP headsets (bone-conduction and open-ear models tested) could only **resume**. VoiceOver made no difference. The same behaviour had been seen in one other audiobook app.

## Root cause — an Apple contract SwiftAudioEx doesn't honour

iOS publishes two now-playing keys to Bluetooth accessories: `MPNowPlayingInfoPropertyPlaybackRate` and `MPNowPlayingInfoPropertyDefaultPlaybackRate`. Apple's header for the second:

> *"If you are playing back content at a rate of 2.0 and your playback state is not fast-forwarding, then the default playback rate should also be 2.0."*

When the two disagree, iOS reports the app as **fast-forwarding**. A headset in that state maps its play/pause key to *Play* (to return to normal speed) — and *Play* while playing is a no-op. When actually paused, the same key sends *Play* and it resumes. Hence "can resume, can't pause".

- **AirPods** use the `togglePlayPause` command, which RNTP routes by player state — unaffected.
- **The lock screen** uses the discrete `pause` command — unaffected.
- **At 1×**, both keys agree by default — unaffected. It only bites above 1×, which is where fast listeners live.

SwiftAudioEx's `updateNowPlayingPlaybackValues()` sets only `playbackRate`; it has the `defaultPlaybackRate` enum case and never uses it. RNTP inherits the gap. Reference: Apple Developer Forums thread 654413.

## Fix — a one-line native patch via `patch-package`

`mobile-app/patches/react-native-track-player+4.1.2.patch` adds to `RNTrackPlayer.setRate`:

```swift
player.nowPlayingInfoController.set(keyValue: NowPlayingInfoProperty.defaultPlaybackRate(Double(rate)))
```

Supporting changes:

- `"postinstall": "patch-package"` in `package.json`, so EAS and Vercel apply the patch on install. `.gitattributes` pins `*.patch` to LF so hunks apply on Windows checkouts.
- `RNTPMobileAudioPlayer.loadAsync` calls `TrackPlayer.setRate(currentRate)` **after every load, unconditionally** — `reset()` clears now-playing info, so the key must be republished per chapter (it was previously skipped at 1×).

> If `react-native-track-player` is bumped, the patch file name and hunk must move with it, or `patch-package` fails the install.

## Lesson

**Read the platform header, not just the library.** The bug was a documented OS contract that a transitive dependency silently skipped.
