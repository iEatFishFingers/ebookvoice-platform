# EbookVoice — Android Release Guide

## One-Time Setup (do this once)

Build from a short path such as `C:\dev\ebv` (Windows MAX_PATH limit with CMake).

**Back up these files to a secure offline backup first:**
- `C:\dev\ebv\mobile-app\android\app\release.keystore`
- `C:\dev\ebv\mobile-app\android\gradle.properties`

Then in Command Prompt:
```cmd
rmdir /s /q C:\dev\ebv
git clone https://github.com/YOUR_USERNAME/YOUR_REPO.git C:\dev\ebv
```

Then restore from a secure offline backup:
- `release.keystore` → `C:\dev\ebv\mobile-app\android\app\release.keystore`
- `gradle.properties` → `C:\dev\ebv\mobile-app\android\gradle.properties`

Then re-create `local.properties`:
```cmd
echo sdk.dir=C\:\\Users\\<you>\\AppData\\Local\\Android\\Sdk > C:\dev\ebv\mobile-app\android\local.properties
```

---

## Every Release — Step by Step

### Step 1 — On your Linux machine (before switching to Windows)

Make sure all changes are committed and pushed:
```bash
git add .
git commit -m "your message"
git push origin main
```

---

### Step 2 — On the Windows build machine

**Pull latest code:**
```cmd
cd C:\dev\ebv
git pull origin main
```

**Install any new dependencies:**
```cmd
cd C:\dev\ebv\mobile-app
npm install
```

**Do you need to re-run prebuild?**

Only run `expo prebuild --platform android --clean` if you:
- Added or removed a plugin in `app.json`
- Added a native package via `expo install`
- The `android/` folder is broken or missing

For normal JS/TypeScript changes (99% of development) — **skip prebuild entirely.**

If you do run prebuild, restore these files immediately after:

```cmd
# 1. Restore local.properties
echo sdk.dir=C\:\\Users\\<you>\\AppData\\Local\\Android\\Sdk > C:\dev\ebv\mobile-app\android\local.properties

# 2. Copy release.keystore back from a secure offline backup to:
#    C:\dev\ebv\mobile-app\android\app\release.keystore

# 3. Add signing credentials back to gradle.properties:
#    C:\dev\ebv\mobile-app\android\gradle.properties
#
#    RELEASE_STORE_PASSWORD=<your password>
#    RELEASE_KEY_ALIAS=ebookvoice
#    RELEASE_KEY_PASSWORD=<your password>
```

---

**Bump the version** in `C:\dev\ebv\mobile-app\android\app\build.gradle`:
```gradle
versionCode 3        // increment by 1 on every Play Store upload
versionName "1.0.2"  // update as appropriate
```

**Set Java and build:**
```cmd
set JAVA_HOME=C:\Program Files\Eclipse Adoptium\jdk-17.0.18.8-hotspot
set PATH=%JAVA_HOME%\bin;%PATH%
cd C:\dev\ebv\mobile-app\android
gradlew bundleRelease
```

Output file: `app\build\outputs\bundle\release\app-release.aab`

---

### Step 3 — Upload to Google Play

1. Go to **Play Console → EbookVoice → Test and release → Closed testing**
2. Click **Create new release**
3. Upload the `.aab` file
4. Add release notes
5. Save and review → rollout

---

## Build Environment Reference

| Tool | Location |
|---|---|
| Java (JDK 17) | `C:\Program Files\Eclipse Adoptium\jdk-17.0.18.8-hotspot` |
| Android SDK | `C:\Users\<you>\AppData\Local\Android\Sdk` |
| Project path | `C:\dev\ebv\` (short path required — Windows MAX_PATH limit) |
| Release keystore | `android/app/release.keystore` (alias: `ebookvoice`) |

---

## What Lives Where

| File | In git? | Stored where |
|---|---|---|
| All source code | ✅ Yes | GitHub |
| `release.keystore` | ❌ No | a secure offline backup |
| `gradle.properties` (with passwords) | ❌ No | a secure offline backup |
| `local.properties` | ❌ No | Re-create each time (machine-specific) |
| `google-services.json` | ❌ No | a secure offline backup (if Firebase is added later) |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Build fails with MAX_PATH / CMake errors | Make sure you're building from `C:\dev\ebv`, not the original long path |
| "SDK location not found" | Re-create `android\local.properties` |
| "Signed in debug mode" | Restore `release.keystore` and signing credentials in `gradle.properties` |
| "Wrong signing key" | You're using a different keystore — restore the correct one from a secure offline backup |
| "Version code already used" | Bump `versionCode` in `android\app\build.gradle` |
| `expo prebuild` fails with google-services error | Confirm `googleServicesFile` is removed from `app.json` android section |
| Gradle can't find Java | Run `set JAVA_HOME=...` before building (see above) |
| `node_modules` errors after pull | Run `npm install` in `mobile-app/` |
