/**
 * ⚠️ THIS FILE IS NOT THE APP ENTRY POINT — IT NEVER RUNS.
 *
 * `package.json` has `"main": "node_modules/expo/AppEntry.js"`. Expo's
 * AppEntry imports `./App` and calls `registerRootComponent(App)` directly;
 * it does NOT import this file. There is no `expo.entryPoint` override.
 *
 * Historically the RNTP `registerPlaybackService` call lived here — which is
 * exactly why lock-screen / Bluetooth / CarPlay controls never worked despite
 * several fix attempts: the registration code was never executed.
 *
 * The registration now lives at module scope in `App.tsx` (the module AppEntry
 * actually loads). DO NOT put lock-screen / playback-service wiring here.
 */
