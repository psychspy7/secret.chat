# SecretChat owner handover

Prepared 3 October 2026. Current Android release: **1.6.1 / build 8**.

Use this guide when maintaining the project yourself, moving computers, or handing it to another developer or AI coding tool. Start from the current repository, preserve the existing accounts and signing identity, and release changes in the order below.

## 1. Keep these files

| File | Purpose |
| --- | --- |
| `release/SecretChat-1.6.1.apk` | Signed Android installation and update file. |
| `release/SecretChat-1.6.1.aab` | Signed bundle for Google Play Console, subject to Play setup and review. It is not a directly installable APK. |
| `release/SecretChat-v1.6.1-Source.zip` | Clean website, Android, backend, tests, artwork and documentation snapshot. Configuration and private credentials are excluded. |
| `mobile/docs/OWNER-HANDOVER.md` | This maintenance guide. |
| `mobile/docs/AI-HANDOVER-PROMPT.md` | Instructions you can give another AI coding tool. |
| `UPDATES.md` | Short release procedure. |
| `mobile/V1.6.1-RELEASE-CHECKS.md` | Evidence and remaining device checks for this release. |
| `release/SecretChat-1.6.1-SHA256.txt` | Checksums for the final APK, AAB and source ZIP. Generated separately, not inside the ZIP. |

The source ZIP is a code snapshot, not a backup of your live database, user chats, signing identity, or dashboard settings. For ongoing development, clone the GitHub repository so you retain its history and can push changes.

## 2. Accounts and identifiers

| Service | Existing project or location |
| --- | --- |
| Website | https://secret-chat-sable.vercel.app/ |
| GitHub | https://github.com/psychspy7/secret.chat |
| Vercel | Project `secret-chat`, production branch `main` |
| Supabase | Project `zpeadphldseifbfxpkaa` |
| Firebase notifications | Project `kitty-sidechat-20260930` |
| Android application ID | `com.kittycorp.sidechat` |
| Android administrator | Confirmed account `viratanand1221@gmail.com`, then Control |
| Website administrator | `/SECRET`, using the existing permanent host credentials |

The visible brand is SecretChat. Existing technical identifiers retain their original names. Keep the Android application ID and signing identity for compatible updates. Google login is provided through Supabase; Firebase is used for Android push notifications.

The website and Android app currently have separate room systems. Their codes, memberships and administrator sign-ins are not interchangeable. Editing only `src/` changes the website; editing only `mobile/src/` changes the Android interface after a new APK is built. A deliberate change in both directories is required when both should gain a feature.

## 3. Make private backups before moving computers

Back up the following separately in encrypted storage that you control. These are deliberately absent from GitHub and the source ZIP:

- **`.android-signing/sidechat-release.p12` and `.android-signing/keystore.properties`**: the original key, passwords and alias. Preserve both together. The existing build script creates a new key if all signing files are missing, so restore these files before running a release build.
- Root `.env.local`, and any local production environment file. They contain the client connection settings; recreate from `.env.example` if necessary.
- `mobile/android/app/google-services.json`: the Firebase Android client configuration. It can be downloaded again from the existing Firebase project for the existing application ID. Its project identifiers are not private server credentials, but this project excludes the file from the clean archive.
- `.mobile-secrets/`, if you retain the existing server setup credentials locally. The Firebase sender private key must remain server-only. The deployed copy is in the Supabase Edge Function secret named `FCM_SERVICE_ACCOUNT_JSON`.
- The permanent website host credentials and the Android research vault password, stored in a password manager. The current research vault has no password recovery or rotation feature. Ordinary app login cannot recover it.
- Access to the GitHub, Vercel, Supabase, Google Cloud/Firebase and any email sender accounts. Use account recovery and MFA settings that you control.

Never put private signing files, passwords, service-role keys, OAuth client secrets or service-account keys into a public repository, browser build, APK, source ZIP, or an AI chat attachment. An AI can edit clean source without those credentials; do private signing and dashboard configuration locally or through authorized secure tools.

The original public signing certificate SHA-256 is:

```text
8e4f4cdfcbd905336944969b6d23e8c9e15826bce322b05e03a4f5ef6b8820b0
```

This is a public certificate fingerprint, not the private key. Compare future APK certificate output against it. See [Android signing guidance](https://developer.android.com/studio/publish/app-signing).

## 4. Work from another computer or AI coding tool

Use Windows, PowerShell 7 or newer, Git, and Node.js 22 or newer. The build scripts prepare JDK 21 and Android SDK tooling in `.android-tools`. Use a normal local folder outside OneDrive or other synced storage; this project previously encountered Gradle file-lock/cache problems in OneDrive.

For example, in PowerShell:

```powershell
git clone https://github.com/psychspy7/secret.chat.git "$env:USERPROFILE\Downloads\SecretChat"
Set-Location "$env:USERPROFILE\Downloads\SecretChat"
git switch -c codex/my-update
npm.cmd ci
npm.cmd --prefix mobile ci
```

Choose a new branch name for each change. If you already have a checkout, save any local work and pull the latest `main` before starting. Keep the two package lockfiles; use `npm ci` to install the recorded versions. Upgrade dependencies deliberately with the relevant tests rather than replacing the project with a new scaffold.

Copy `.env.example` to root `.env.local` and restore:

```text
VITE_SUPABASE_URL=https://zpeadphldseifbfxpkaa.supabase.co
VITE_SUPABASE_PUBLISHABLE_KEY=YOUR_EXISTING_PUBLISHABLE_KEY
```

Get the publishable key from the existing Supabase project's API settings. Never substitute a service-role or secret key. Both Vite apps read this root file; the native Gradle configuration also uses it. Restore the original signing folder and Firebase client configuration before building Android. If the checkout path changed, update only `storeFile` in private `keystore.properties` to the absolute path of the same restored `.p12`; retain the passwords and alias.

Open the cloned folder in the AI coding tool and give it `AI-HANDOVER-PROMPT.md` plus your exact change request. A tool without a terminal or native Android build environment can prepare source changes, but cannot prove a signed APK works. Build and test locally before publishing. Previewing the interface in a browser does not test native fingerprint, screenshot protection, notifications or installation.

## 5. Where to make changes

| Change | Main source locations |
| --- | --- |
| Website pages and navigation | `src/main.js` |
| Website premium presentation | `src/refinement.css` and the other existing styles in `src/` |
| Android screens and actions | `mobile/src/main.js` |
| Android premium presentation | `mobile/src/polish.css`, `mobile/src/style.css` |
| Client backend calls | `mobile/src/backend.js` |
| Local history and encryption | `mobile/src/storage.js`, `mobile/src/crypto.js` |
| Research vault and CSV export | `mobile/src/research.js` |
| Activity alerts and sound behavior | `mobile/src/notifications.js`, `mobile/src/alert-policy.js`, `supabase/functions/_shared/push.ts` |
| Room rules, roles, limits and retention | New reviewed files in `supabase/migrations/` |
| Server message delivery, devices, presence, releases | `supabase/functions/mobile-send/`, `mobile-device/`, `mobile-presence/`, `mobile-release/`, plus `_shared/` |
| Android fingerprint, secure storage, screenshots and updater | `mobile/android/app/src/main/java/com/kittycorp/sidechat/` |
| Android package, version and release signing setup | `mobile/android/app/build.gradle` |
| Logo source and generated app assets | `mobile/brand/`, `mobile/public/secretchat-icon.jpg`, native `res/mipmap-*` |
| Public website download link | `src/main.js`; APK binaries go in `public/downloads/` |
| Privacy explanation | `public/mobile-privacy.html`, `mobile/info-site/privacy.html`, and relevant in-app copy |

For another logo or sound, `mobile/scripts/import-brand-assets.py` resizes artwork and imports the MP3. It requires Python with Pillow. Its `--icon`, `--sound` and optional `--monogram` arguments are documented in the script. Copy equivalent public artwork to the website when needed. Android notification channel sound settings are persistent; changing just an MP3 does not necessarily change a channel already configured on an installed phone. Review native and server channel IDs together when introducing a new channel.

## 6. Preview and check an edit

Run from the repository root:

```powershell
npm.cmd run dev
```

This previews the website at the URL printed by Vite. In another terminal:

```powershell
npm.cmd --prefix mobile run dev
```

This previews the Android web interface at `http://127.0.0.1:5174`. Both previews connect to the configured backend; use test accounts and clearly named test rooms, or a separate staging backend, for changes that write data. A Vercel preview does not automatically give you a separate Supabase database.

Before a release:

```powershell
npm.cmd run check
npm.cmd run build
npm.cmd --prefix mobile run check
npm.cmd --prefix mobile run build
node --test tests/mobile-backend-edge.test.mjs
```

The GitHub workflow runs website/mobile checks and web builds. It does not automatically produce your privately signed APK/AAB, deploy Supabase migrations, or deploy Edge Functions. Backend SQL suites require database-owner access and are documented in `mobile/docs/BACKEND.md`; review them before running, preferably in staging. Native unit tests run in the release build script.

## 7. Update the website

1. Edit and test the root website source. If the change depends on new server behavior, deploy the compatible backend change first.
2. Commit only the intended files and push your branch. Review the diff and preview.
3. Merge the tested change to `main`. The connected Vercel project automatically deploys that branch. Check that the production deployment is Ready and open the website on desktop and phone widths.
4. Vercel builds with `npm run build`, output `dist`. Restore `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` in its environment settings when moving/recreating the hosting project. They are public client configuration, not server secrets. Redeploy after an environment change.

You can use GitHub Desktop to select changes, commit, push and open/merge a pull request. Keep private folders out of commits. See [Vercel Git deployment](https://vercel.com/docs/git).

## 8. Build the next Android release

For the next release, an example is **1.6.2 / build 9**. Inspect the current published build first and choose a number greater than it; 9 is appropriate only while 8 remains the latest.

1. In `mobile/android/app/build.gradle`, set `versionName "1.6.2"` and `versionCode 9`. Keep `applicationId "com.kittycorp.sidechat"`.
2. Align the version in `mobile/package.json`, `mobile/package-lock.json`, the fallback version/build and beta label in `mobile/src/main.js`, and release documentation. Do not change package IDs to match the new display name.
3. Confirm the original `.android-signing` files, root `.env.local` and Firebase `google-services.json` are present. If the original signing material is missing, restore it before continuing. A newly generated signing key cannot update the existing APK installation.
4. From the repository root:

```powershell
./mobile/scripts/native-setup.ps1
./mobile/scripts/native-build.ps1
./mobile/scripts/verify-apk.ps1 -Apk release/SecretChat-1.6.2.apk
```

The setup step is needed on a new machine. The build compiles the mobile client, prepares audio, syncs Capacitor, builds APK/AAB, runs native unit tests, verifies signatures and copies the files into `release/`. The verifier checks the APK's label, application ID, release mode and private-credential patterns. Compare the certificate fingerprint to the original fingerprint above; the script's signature validity check alone does not establish that it is the original key.

5. Install the APK **over the existing app** on a real phone. Do not uninstall or clear app data: chats and invitations are stored locally and Google login does not restore them. Check login return, email link on the requesting device, fingerprint/PIN, keyboard/composer, reconnect, joins/messages, sound/background alerts, admin screenshot exception, ordinary screenshot protection, timed/permanent rooms, extension requests, research consent/view/export and shared clear behavior relevant to your changes.
6. Keep the APK and AAB from this exact build. An AAB is uploaded to Play Console; it is not opened on the phone like an APK.

Increasing `versionCode` distinguishes each release to Android and to this app's updater. See [Android versioning](https://developer.android.com/studio/publish/versioning).

## 9. Publish the APK and announce it inside the app

1. Copy the verified APK to a new immutable path, for example:

```powershell
Copy-Item -LiteralPath release/SecretChat-1.6.2.apk -Destination public/downloads/SecretChat-1.6.2-build9.apk
Get-FileHash -Algorithm SHA256 -LiteralPath public/downloads/SecretChat-1.6.2-build9.apk
git add -f public/downloads/SecretChat-1.6.2-build9.apk
```

Force-add only that intended public APK because APKs are normally ignored. Stage the intended source changes separately. Preserve earlier download files and URLs; replacing a published binary breaks its recorded hash. Update the website's download link to the new filename, commit and deploy through `main`.

2. Wait for Vercel Ready. Download the new public URL and confirm it returns an APK directly over HTTPS without redirects, login pages or HTML fallback. Verify the downloaded file's SHA-256 matches the local APK. An example URL is `https://secret-chat-sable.vercel.app/downloads/SecretChat-1.6.2-build9.apk`.
3. Sign in as `viratanand1221@gmail.com`, open **Control → Android releases → Publish**, and provide the version, increasing build number, exact direct URL, exact SHA-256 and release notes. Do this only after the file is reachable.
4. The release service stores the manifest and queues generic update notifications for registered devices. The current app checks on open/resume, while active, and through **Account → Check for updates**. Users choose Install and confirm Android's permission/installation prompts. Notification beeps depend on notification permissions, channel sound, battery settings and connectivity; FCM acceptance is not proof that every phone sounded.

Publishing website code alone does not replace the APK installed on users' phones. Publishing a manifest before its APK is deployed causes a failed download. The installer verifies the file hash, package, higher version code and matching signing certificate; it does not silently install updates.

For Play distribution, configure Play App Signing and its certificate compatibility deliberately before the first release, using Android's official signing guidance. Use Play's update flow for Play installations. The AAB by itself does not create a store listing or satisfy Play's account, privacy and release requirements.

## 10. Backend or authentication changes

Keep the existing Supabase and Firebase projects when maintaining the current app. Creating a different project does not move users, memberships, OAuth configuration, research keys, device registrations or local data.

For a database change, make a backup using the project's supported backup/export options, test in staging, create a new migration with the current Supabase tooling, review its authorization and compatibility with older apps, and apply only pending migrations to the existing project. All baseline and v1.6 migrations, including `20261003051645_mobile_v16_manual_research_retention.sql`, were already applied during this release. Do not replay the initial schema or reset production. On a genuinely new empty project, migration order and separate Auth/server configuration matter.

If server code changes, deploy the affected Edge Functions and shared dependencies separately from Vercel. The four current functions are `mobile-send`, `mobile-device`, `mobile-presence`, and `mobile-release`. The existing functions have gateway JWT verification disabled because they perform custom Supabase Auth checks and guarded database session/role checks. Preserve that complete authentication architecture when deploying; disabling gateway verification without those checks would expose an endpoint. A new checkout has no tracked `supabase/config.toml`, so do not assume deployment defaults preserve the cloud settings. Review current CLI `--help` and function configuration, or deploy through an authenticated Supabase tool with the existing settings. See [function deployment](https://supabase.com/docs/guides/functions/deploy).

Retain `FCM_SERVICE_ACCOUNT_JSON` only in Supabase Edge Function secrets. Google OAuth client secrets belong in Supabase's provider settings, and SMTP credentials in its email settings. Never embed them in `VITE_` variables. Keep RLS and server-enforced roles; a frontend flag or user-editable profile field must not grant administrator access. New exposed tables need deliberate grants and RLS; check current Supabase docs/changelog before changing the schema.

Google's current Android callback is `com.kittycorp.sidechat://auth/callback`; the OAuth web client uses `https://zpeadphldseifbfxpkaa.supabase.co/auth/v1/callback`. Keep the exact app redirect in the Supabase allowlist and review origins/callbacks before changing domains. Use the existing Firebase Android registration when restoring `google-services.json`. See [Firebase Android setup](https://firebase.google.com/docs/android/setup) and [Supabase server secrets](https://supabase.com/docs/guides/functions/secrets).

**Public email sign-in still needs custom SMTP.** Supabase's default sender delivers only to project team addresses. Configure a verified sender through Authentication → Emails → SMTP Settings, then test a non-team recipient on the requesting phone. Google sign-in is available while this is pending. See [Supabase SMTP setup](https://supabase.com/docs/guides/auth/auth-smtp).

## 11. Daily administration without a code release

Use the Android Control panel to manage notices, participants and room approvals, create permanent admin groups, extend room time, review deletion/extension requests, publish app releases, and access consented research archives. The website `/SECRET` manages website rooms and notices separately. A notice or approved extension uses the backend and does not need a new APK.

For Android research view/export, unlock Research vault with its existing password, then choose a research room's View / export action. Private Android rooms have no administrator archive/key and missed live messages cannot be fetched later. Private rooms cannot be retroactively converted into research archives. Research access requires explicit room opt-in and participant consent; keep these notices accurate in future versions.

Research archives stay until an approved manual clear. At 1,000 messages per room or 4,096 globally, new research messages are rejected rather than silently deleting old ones. Export what you need and approve a manual clear to free capacity. Unanimous member clearing includes current offline members; declines or new members cancel the request. Clearing updates connected clients and reconciles on later sync, but cannot erase exports or copies outside the app. Do not add automatic research cleanup without a new owner decision.

Private history is device-local and bounded; signing in on another phone does not restore its messages or invitation keys. Keep useful exported research CSVs securely outside public source. The website's legacy retained-message model differs and expires/limits its own room data as documented in `README.md`.

## 12. If an update goes wrong

| Symptom | First checks |
| --- | --- |
| Website says connect backend | Check Vercel's public environment values and redeploy; check local root `.env.local` for previews. |
| App reports no update | Manifest build must exceed the installed build; confirm the manifest was published through Control after APK deployment. |
| Download/hash error | Check immutable URL, HTTP response, redirects, deployment readiness and exact APK SHA-256. Do not disable verification to work around it. |
| Android refuses replacement | Compare application ID, increasing build code and original signing certificate. Check available storage. Restore the original key instead of uninstalling. |
| Google callback fails | Check provider client/callback, exact Android redirect allowlist, OAuth audience and that the app on the phone is the new build. |
| Public email never arrives | Configure custom SMTP, verify sender domain, and test an actual recipient; check spam and Auth logs. |
| Beep is silent | Enable app alerts and Android notification permission/channel sound; check network and battery restrictions, Firebase client config and server function logs. |
| Room code fails in another client | Website and Android room codes are separate. Check expiry and the original invitation. |
| Admin cannot see private Android chat | That room has no admin archive. Use an explicitly consented research room for future research messages. |
| Research room cannot send | Check room/global archive limits; use the approved manual-clear process. |
| Gradle cache or lock errors | Move the checkout and restored configuration to ordinary local storage outside OneDrive; rebuild there. |

A website rollback/revert can restore a previous frontend. It does not undo database migrations or an APK already installed. For an Android hotfix, fix the source and publish a new APK with a still higher build number; a lower build is rejected. Design database changes to remain compatible during rollout instead of removing fields immediately.

## 13. Package a clean source handover

After finishing source/docs updates, run from a Git checkout:

```powershell
./mobile/scripts/package-source.ps1 -Name SecretChat-v1.6.2-Source.zip
```

Use the actual release version. The packager allowlists source and scans the finished ZIP for private key patterns and known local credentials. It excludes signing/server keys, environment/configuration files, APK/AABs, caches, build folders and local helper files. Give another AI or developer the clean source ZIP or repo plus the handover prompt; share release binaries separately. Private backups stay under your control.

For 1.6.1, automated web/mobile/Edge checks, APK/AAB builds, signing checks, source scans and native update-policy tests passed. Local browser layouts were visually reviewed. Real-phone native login, keyboard, fingerprint, screenshot, notification and update installation checks remain necessary before a wider rollout. See `mobile/V1.6.1-RELEASE-CHECKS.md` for the precise evidence.
