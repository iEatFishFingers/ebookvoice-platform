# Release History (iOS)

| Build | Version | Released | Highlights |
|---|---|---|---|
| 27 | 1.0.2 | May 2026 | First App Store release |
| 28 | 1.0.3 | May 2026 | Fixes |
| 30 | 1.0.4 | Jun 2026 | Fixes |
| 32 | 1.0.5 | Jun 2026 | VoiceOver accessibility pass; 27 languages / 214 voices; sandbox guard on the RevenueCat webhook |
| 33 | 1.0.5 | Jun 2026 | Public-domain Discover catalogue; accruing conversion-credit model; lifetime tier |
| 36 | 1.0.6 | Jun 2026 | Fixes |
| 37 | 1.0.6 | Jul 2026 | DAISY upload; shared sample book; plain-text user guide; karaoke WordBoundary root-cause fix |
| 38 | 1.0.7 | Jul 2026 | Store listing refresh; `.docx` upload; first in-app localisation pass |
| **39** | **1.1.0** | **Aug 2026** | **Final App Store release.** In-app UI localisation (es/fr/de/ja/zh/ru) with device-language auto-switch; resume-during-load and progress-save fixes; chapter navigation fixes; server-side bookmark-regression guard |
| 40 | 1.1.1 | built, not released | 3× speed ceiling with VoiceOver-adjustable chip and remembered speed; rate preserved across chapters; VoiceOver slider seeking; Bluetooth pause above 1× (native patch); word-cap → paywall hand-off to the tier that fits the book; anonymous "audiobook ready" push registration |

Server-side fixes deploy continuously and reach every installed build. The final server-side changes include the [TTS outage fixes](incidents/tts-outage-cascade.md) (edge-tts 7.3.1, per-chunk retry, partial-conversion detection, preview-cache poisoning), the [RevenueCat purchase-sync hardening](incidents/revenuecat-v2-key-breaks-purchase-sync.md), and the guarded CDN cleanup.

## Versioning notes

- **1.1.0 rather than 1.0.8.** `runtimeVersion` is a literal that must change with every native build. Reusing a runtime would let OTA bundles cross between binaries they weren't built for, so localisation (a native-config change) got a minor version bump.
- **Native patch ⇒ store build.** Build 40's Bluetooth fix patches RNTP's Swift code, so it couldn't ship over the air.
- **Measuring a build:** attribute users by **first-seen build cohort**, not by the build an event came from, so returning users can't inflate the newer build's numbers; exclude App Review traffic; and compare rates, not counts, on low-volume builds.

## Related

- [Deployment — OTA updates](operations/deployment.md#ota-updates-expo-updates)
- [Platforms](platforms.md)
