# VoiceOver couldn't seek with the position slider — the value moved and snapped back

**Severity:** high for screen-reader users · **Status:** fixed in code

## What was happening

A VoiceOver tester reported that the in-app position slider seemed to be "a non-standard control" — the lock-screen scrubber worked, the in-app one didn't, leaving only 15-second skips to cross a chapter.

The slider is `@react-native-community/slider`, a native `UISlider`, and VoiceOver already treats it as **adjustable** (swipe up / down moves 10% and fires `UIControlEventValueChanged`). The control *was* standard; the wiring wasn't:

- A finger drag fires **touch-down → value-change → touch-up**, mapped to `onSlidingStart → onValueChange → onSlidingComplete`. The seek lived in `onSlidingComplete`.
- A VoiceOver swipe fires **only value-change** — there's no touch. `onSlidingComplete` never came, no seek was issued, and the next 250 ms status tick wrote the real position back into the slider.

To a VoiceOver user: the new time is announced, then reverts.

## Fix

`handleSliderValueChange` tracks whether a touch is in flight (`sliderTouchActiveRef`, set on `onSlidingStart`, cleared on `onSlidingComplete`). A value change with **no touch in flight** is treated as an assistive adjustment: set `isSeeking` so status updates stop overwriting the slider, and seek **400 ms after the last swipe** via the existing completion handler, so five quick swipes produce one seek. The library's tap-to-seek emits start → change → complete synchronously, so it still takes the drag path. An accessibility hint was added: *"Swipe up or down to move through the chapter."*

## Lesson

**Native controls are only accessible if your event handling doesn't assume a finger.** Assistive technologies drive value changes without touch events.
