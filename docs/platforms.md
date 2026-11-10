# Platforms — iOS, Android, Web

One Expo / React Native codebase (`mobile-app/`), one backend, three targets.

| Platform | Final state | Version |
|---|---|---|
| **iOS** | Primary platform, released on the App Store | 1.1.0 (build 39); 1.1.1 (build 40) built but not released |
| **Web** | Live on Vercel (partial feature set) | continuous deploy |
| **Android** | One early build (1.0.0, versionCode 3); never released to production | — |

## How the targets arrived

```
   WEB  ──────────────▶  iOS  ──────────────▶  ANDROID
   built first           primary platform       parked
```

- **Web first.** React Native can target the browser, so the app was built as a web app from day one. The cross-platform structure is native to the codebase, not retrofitted.
- **iOS second.** An app store was the most practical route to an audience; iOS became the primary platform.
- **Android parked.** New personal Google Play developer accounts must run a closed test with **12 testers opted in continuously for 14 days** before applying for production. Apple has no equivalent gate. That policy asymmetry — not the code — is why Android was never released.

## What's shared

Roughly 90% of the app is common:

```
        ┌───────────────┐   ┌───────────────┐   ┌───────────────┐
        │  iOS          │   │  Android      │   │  Web          │
        │  App Store    │   │  (unreleased) │   │  Vercel       │
        └───────┬───────┘   └───────┬───────┘   └───────┬───────┘
                └───────────────────┼───────────────────┘
                                    │
                         mobile-app/src/  (shared)
                         screens · contexts · components
                                    │
                         services/api.ts  ← the single client
                                    │
              ┌─────────────────────┼─────────────────────┐
              │                     │                     │
        Flask on Render        Supabase              Cloudinary
        conversion queue     auth · Postgres        audio · images · timings
```

**Everything server-side is platform-agnostic** — the backend only sees HTTP. All API calls go through the `api.ts` singleton, which owns token refresh, anonymous `device_id` identity, and the 404-vs-503 task-status distinction, so no platform re-solves them.

## Where they diverge

Divergence is concentrated in ~25 files that branch on `Platform.OS`, heaviest where native capabilities differ:

| File | What differs |
|---|---|
| `context/AuthContext.tsx` | Apple Sign In vs Google OAuth vs web redirect flow |
| `screens/SignUpScreen.tsx` | available sign-in providers |
| `screens/SubscriptionScreen.tsx` | Stripe checkout (web) vs IAP (mobile) |
| `services/purchaseService.ts` | RevenueCat layer; **every method no-ops on web** by design |
| `services/api.ts` | file upload and storage differences |
| `utils/audioPlayer.ts` | three player implementations |

The audio layer is the clearest example:

```ts
export const createAudioPlayer = (): AudioPlayerInterface => {
  if (Platform.OS === 'web') return new WebAudioPlayer();          // HTMLAudioElement
  if (TrackPlayer && getFeatureFlags().rntp_enabled)
    return new RNTPMobileAudioPlayer();                            // lock screen / CarPlay
  return new MobileAudioPlayer();                                  // expo-av fallback
};
```

All three satisfy `AudioPlayerInterface`, so every screen above them is platform-blind. See [audio playback](subsystems/audio-playback.md).

## Capability matrix

| Capability | iOS | Android (early build) | Web |
|---|:--:|:--:|:--:|
| Browse & search the catalogue | ✅ | — | ✅ |
| Upload EPUB / `.docx` / DAISY | ✅ | ✅ | ✅ |
| Convert to audio | ✅ | ✅ | ✅ |
| Play audio + karaoke | ✅ | ✅ | ✅ |
| Save playback progress | ✅ | ✅ | ✅ |
| Background / lock-screen playback | ✅ RNTP | ❌ no `MusicService` | ❌ |
| CarPlay / Android Auto | ✅ | ❌ | ❌ |
| Subscribe / pay | ✅ RevenueCat → Apple IAP | RevenueCat → Play (unconfigured) | ✅ Stripe |
| Apple Sign In | ✅ | ❌ | web OAuth flow |
| Push notifications | ✅ | needs `google-services.json` | ❌ |
| OTA updates | ✅ | ✅ | n/a — redeploy |

## iOS

| | |
|---|---|
| Bundle ID | `com.ebookvoice.mobile` |
| Expo SDK | 54 |
| Release | `eas build --platform ios --profile production --auto-submit` (~5 min build + 10–15 min Apple processing) |

```jsonc
"ios": {
  "supportsTablet": true,
  "bundleIdentifier": "com.ebookvoice.mobile",
  "usesAppleSignIn": true,
  "associatedDomains": ["applinks:<supabase-ref>.supabase.co"],   // auth deep-link callbacks
  "infoPlist": {
    "ITSAppUsesNonExemptEncryption": false,
    "UIBackgroundModes": ["audio"]        // background playback depends on this
  }
}
```

`UIBackgroundModes` is declared inline, which is why iOS doesn't need the `react-native-track-player` config plugin. That plugin was removed from `app.json` because RNTP 4.1.2 ships extensionless ESM imports that break `npx expo config` during prebuild; iOS autolinks RNTP via CocoaPods and is unaffected.

## Web

| | |
|---|---|
| Host | Vercel, auto-deploys on push to `main` |
| Build | `npx expo export -p web` → `dist/` (Metro bundler) |
| Routing | `mobile-app/vercel.json` — SPA catch-all to `index.html` |

`mobile-app/public/index.html` is the Expo web template and owns the site's `<head>` metadata and JSON-LD.

**Web takes payment through Stripe** — the original payment system, predating RevenueCat. `SubscriptionScreen.tsx` branches at purchase: web calls `apiService.createCheckoutSession(planId)` and opens the hosted checkout; mobile calls `purchaseTier(planId)`. Billing management is a Stripe portal session.

**Not on web:** background/lock-screen playback (RNTP has no web implementation — playback stops with the tab), push notifications, native Apple Sign In.

A new web origin must be registered in four external systems (CORS allowlist, Supabase auth redirects, Google OAuth client, Stripe return URL) — see the checklist in [deployment](operations/deployment.md). The first symptom of a missing entry is an empty Discover tab.

## Android

The last Android build predates the credit model, the Discover catalogue, multi-language, RNTP playback, the karaoke root-cause fix and in-app localisation. Releasing it would effectively be a first release. Blockers in the final code:

1. **`google-services.json` is absent.** `app.json` declares `"googleServicesFile": "./google-services.json"` (Firebase config for push). Either restore it or remove the reference and `POST_NOTIFICATIONS`.
2. **No `MusicService` in `AndroidManifest.xml`.** The RNTP config plugin's job was to inject it; with the plugin removed, `FOREGROUND_SERVICE_MEDIA_PLAYBACK` is declared but background playback can't work until the service is added by hand.
3. **`mobile-app/android/` is committed.** Native config can drift from `app.json`; either let Continuous Native Generation own it (delete the folder) or treat the committed manifest as the source of truth — not half and half.

The payment path is already coded: `purchaseService.ts` routes Android through RevenueCat, which supports Google Play Billing natively. Releasing it needs Play Console products matching the RevenueCat entitlements (`starter_monthly`, `pro_monthly`, `lifetime`) and a Play service account connected to RevenueCat. See [`ANDROID_RELEASE_GUIDE.md`](../ANDROID_RELEASE_GUIDE.md) for the local Gradle build path.

## Related

- [Paywall, credits & payments](subsystems/paywall-and-credits.md)
- [Audio playback](subsystems/audio-playback.md)
- [Deployment](operations/deployment.md)
