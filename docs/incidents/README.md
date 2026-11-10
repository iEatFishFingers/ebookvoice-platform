# Incidents

Post-mortems from running the platform in production. Each one records what broke, how it was diagnosed (including the wrong turns), the fix, and the lesson.

| Incident | Area | Lesson in one line |
|---|---|---|
| [The TTS outage cascade](tts-outage-cascade.md) | Conversion pipeline | Six days of empty books with every health check green — failure must never count as progress |
| [Detail-fetch egress](detail-fetch-egress.md) | Database / cost | One unpriced hot-path read exhausted the egress quota and restricted the database |
| [Karaoke statement timeout](karaoke-timings-statement-timeout.md) | Database | A graceful fallback nobody hears about is a silent failure |
| [RevenueCat v2 key](revenuecat-v2-key-breaks-purchase-sync.md) | Payments | Fixing an auth bug can open a hole the bug was hiding |
| [Anonymous gate fails closed](anonymous-gate-fails-closed.md) | API | Fail closed on structural conditions, retryable on transient ones |
| [Raw public_ids keep their extension](raw-public-id-keeps-its-extension.md) | CDN ops | Check results against invariants — an impossible number caught a library-wide deletion |
| [Bluetooth pause above 1×](bluetooth-headset-cannot-pause-above-1x.md) | iOS audio | A transitive dependency skipped a documented OS contract |
| [VoiceOver slider seek](voiceover-slider-cannot-seek.md) | Accessibility | Assistive tech changes values without touch events |
| [Speed resets per chapter](playback-speed-resets-per-chapter.md) | Playback | Make the invariant part of the interface contract |
| [Log timestamps are flush times](log-timestamps-are-flush-times.md) | Observability | Check timestamps are event times before trusting a timeline |
