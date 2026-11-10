# Playback speed reset to 1× at chapter boundaries while the UI still showed the old speed

**Severity:** high for screen-reader users · **Status:** fixed in code

## What was wrong

Found by reading the code while answering a tester's question, then confirmed by a deeper read of each backend:

- **expo-av** — `setRateAsync` forwarded straight to `this.sound.setRateAsync` and stored nothing, so a fresh `Audio.Sound` per chapter started at 1×.
- **Web players** — a fresh `<audio>` element per chapter, also starting at 1×.
- **RNTP** — stored `currentRate` but only read it back in the status callback; SwiftAudioEx happens to carry its own private `_rate` across loads, so the shipping path was probably unaffected.

Meanwhile `playbackSpeed` in `PlayerScreen.tsx` was React state that was **never reset on chapter change**, so the chip kept announcing *"Playback speed, 1.5 times"* while the audio had dropped to normal.

A silently wrong control is worse than a missing one, and worst for users who can't see it: they just hear the narrator inexplicably slow down once per chapter.

## Fix

The rate is part of the `AudioPlayerInterface` contract: **every backend stores `currentRate` and re-applies it inside `loadAsync`**, so the rate survives chapter boundaries regardless of what the underlying library does. The UI state remains the single source of truth. In the same change the speed ceiling was raised from 2× to 3× — see [audio playback](../subsystems/audio-playback.md#playback-speed).
