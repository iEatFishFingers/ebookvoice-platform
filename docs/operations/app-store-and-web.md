# App Store Review & Web Template

## App Store metadata rules (guidelines 2.3.7 / 3.1.2(c))

The app was rejected by App Review more than once for pricing language in store metadata. The rules that came out of it:

**Pricing is forbidden in:** app name, subtitle, keywords, description, promotional text, "What's New", screenshots, and the marketing URL target. That includes currency symbols, specific prices, the words *free* / *discounted*, and plan names tied to feature differences. It applies to **every localisation** — a translation that reintroduces "free" is a rejection.

**Pricing is allowed in:** the in-app `SubscriptionScreen` (Apple *requires* it there) and the legal Terms / Privacy documents.

**Required for submission:**

- a working Terms of Use (EULA) link in the App Description
- a Privacy Policy URL in App Store Connect's dedicated field
- demo account credentials in App Review Information

**Payments:** Stripe checkout inside the iOS app was rejected under guideline 3.1.1 (digital goods must use Apple IAP), which is why RevenueCat exists — see [paywall, credits & payments](../subsystems/paywall-and-credits.md).

The store listing shipped in six localisations: `en-US`, `ar`, `fr`, `de`, `ja`, `es-ES`.

## The Expo web template (`mobile-app/public/index.html`)

Expo reads `public/index.html`, substitutes `%LANG_ISO_CODE%`, and appends the bundle `<script>`. The template carries the site's `<title>`, description, canonical URL, Open Graph / Twitter tags, the App Store smart banner, `Organization` + `WebSite` + `SoftwareApplication` JSON-LD, and a `<noscript>` summary for crawlers.

- **Keep the `#expo-reset` style block and `<div id="root">` exactly as they are**, or the app won't mount.
- **Don't set `web.description` in `app.json`** — it injects a second `<meta name="description">`.

Static pages can be added to `mobile-app/public/` with a rewrite in `mobile-app/vercel.json` placed **above** the SPA catch-all `/(.*)`, which swallows everything after it.

## Related

- [Deployment](deployment.md)
- [Platforms](../platforms.md)
