/**
 * featureFlags.ts
 * ===============
 * Frontend feature flags. Compile-time only — change the value, ship via
 * `eas update`, all 1.0.2+ installs get it instantly.
 *
 * For *server*-driven flags, see `services/featureFlags.ts` (e.g. RNTP).
 * For *backend* env-driven values, see the backend Render env vars
 * (e.g. MAX_CONVERSION_WORDS, MAX_TASK_RETRIES).
 */

/**
 * Master kill-switch for the in-app tutorial system —
 *   OnboardingOverlay (the big first-launch walkthrough on Library)
 *   AND every TutorialTooltip instance.
 *
 * When `false`, nothing tutorial-related renders for users (the components
 * early-return `null`). The Settings "Show Tutorial on Launch" toggle is
 * also hidden so users don't see a broken-looking switch.
 *
 * Why off:
 *  - We suspected the tutorial was hurting first-run UX (interrupts the user
 *    before they've even chosen to engage with the product).
 *  - We had no analytics on it, so we couldn't tell if it helped or hurt.
 *  - Solution: instrument all tutorial interactions (see analytics events
 *    tutorial_shown / tutorial_step_next / tutorial_completed /
 *    tutorial_dismissed) AND disable it. When we flip this back to true
 *    later (e.g. for an A/B test), we'll have a clean baseline to compare.
 *
 * The code is intentionally kept in place — don't delete OnboardingOverlay
 * or TutorialTooltip. We will likely want to revisit / re-enable / A/B this.
 */
export const TUTORIAL_ENABLED = false;
