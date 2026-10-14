# SecretChat V2 owner handover

Prepared 14 October 2026. Release identity: **2.0.0 / Android build 10**. Read the final `mobile/V2.0-RELEASE-CHECKS.md` for actual verification and remaining device checks.

## Keep these deliverables

- `SecretChat-2.0.0.apk`: Android installation/update. Install over the old app; do not uninstall or clear app data.
- `SecretChat-2.0.0.aab`: signed Google Play bundle, not a directly installable file.
- `SecretChat-v2.0.0-Source.zip`: flat clean source, assets, backend migrations/functions, tests and guides.
- `SOURCE-LATEST.zip`: canonical source snapshot with Source/, CONTINUE.md/.py, project metadata and per-file checksums.
- `SecretChat-2.0.0-Full-Package.zip`: release files, both source snapshots, this guide, the AI prompt, release evidence and checksums.

Source ZIPs exclude private credentials, signing material, dependencies and generated caches. They are not backups of live accounts, chats, dashboard configuration or Git history. Keep the existing Git repository and encrypted private backups separately.

## Existing services and identities

| Service | Keep this identity |
| --- | --- |
| GitHub | https://github.com/psychspy7/secret.chat |
| Website | https://secret-chat-sable.vercel.app/ |
| Vercel | secret-chat; production branch main |
| Supabase | zpeadphldseifbfxpkaa |
| Firebase push | kitty-sidechat-20260930 |
| Android package | com.kittycorp.sidechat |
| Verified app/modern website administrator | viratanand1221@gmail.com; Control tab |
| Permanent legacy host panel | /SECRET, /secret or /host; existing host ID/password |
| KITTY AI integration | Fixed installed package com.kitty.ai; fallback https://kittycorp.vercel.app/launches/kitty-ai |
| Company/review | https://kittycorp.vercel.app/ and /contact?subject=Review&product=SecretChat |

The visible brand is SecretChat V2. Technical identifiers intentionally retain old SideChat names for compatibility. Never recreate the backend, replace the Android package, or generate a new signing identity for an ordinary update.

## Architecture

`mobile/src/` is now the shared account-based client for Android and the production website root. Google and confirmed email accounts share room memberships. Messages, invitations, drafts, themes, pins and unread counts remain separately encrypted on each device/browser; signing in elsewhere does not transfer history. Android uses Keystore-backed encrypted private storage; the browser uses IndexedDB and a non-extractable Web Crypto key. Preserve database/storage/key names and account-scoped record formats.

Root `src/` retains the older anonymous browser service. Old /r invitations, /create and permanent /SECRET administration are routed to `legacy.html`; its home is /legacy. It keeps its original separate encryption/admin-access/retention model. The modern root never silently imports or converts legacy rooms.

`mobile/scripts/build-website.mjs` builds the legacy entry, preserves it as legacy.html, then overlays the modern entry without clearing legacy assets/downloads. Vercel and Netlify route old URLs to that preserved entry. Native builds use only mobile/dist. Do not combine the two invitation formats or accidentally route old encrypted invitations into the new app.

The modern private relay is end-to-end encrypted and live-only. Up to 500 received messages per room are saved locally. Messages sent while a device is offline/backgrounded are not later added to its private history. Unread counts describe newly received local messages, not server read receipts. At most four recent rooms are actively watched; channels stop in the background/offline. Generic FCM alerts do not include message text.

Research rooms are optional, labeled and require participant consent. Only those rooms have an encrypted administrator archive, unlocked with the separate password-encrypted research vault. Preserve manual retention: messages stay until an approved clear; at 1,000 per room or 4,096 total, reject new research messages instead of deleting older ones. Private rooms have no administrator archive/key. Shared clear needs unanimous current-member approval within 24 hours; a decline/new member stops it. Administrators may clear directly. Epoch checks stop replay/old sending; reconnecting updated clients clear history, but existing exports and older apps cannot be remotely erased.

KITTY AI is an explicit shortcut, not a chat-data integration. It receives no account, room code, key or message. Reviews carry public product context only. Invitation sharing/message copying is explicit. Do not promise impossible screenshot prevention or hide research/admin metadata access. Android capture is protected for normal users; only a server-verified unlocked admin session may capture. Fingerprint/PIN, recent-task protection and native update validation remain in place.

## Private backups — never put these in the ZIP or an AI chat

Preserve .android-signing/sidechat-release.p12 and keystore.properties together in encrypted storage, including their original alias/passwords. Native release builds deliberately fail when they are missing. Moving the checkout may require updating only the private storeFile path to the SAME key.

Also retain root .env.local/.env.production, mobile/android/app/google-services.json, excluded .mobile-secrets, permanent host credentials, research-vault password and access/recovery to existing service accounts. Firebase client configuration can be downloaded again for the same package. Server FCM credentials remain in Supabase server secrets. No service-role key, OAuth secret, signing password or private key belongs in VITE_ variables.

Original public APK certificate SHA-256: `8e4f4cdfcbd905336944969b6d23e8c9e15826bce322b05e03a4f5ef6b8820b0`. This fingerprint is safe to share; it is not the private key.

## Work yourself or with another AI

Use the canonical workspace C:/Users/HP/Downloads/Project (Kitty-Corp)/PRIVATE CHAT ROOM (KITTY CORP)/SecretChat-Source. Read parent AGENTS.md, START-HERE.md and project instructions. Keep separate repositories/history and never move this build into OneDrive or old synced project mirrors. On another computer, clone the existing repository into a normal local folder; an extracted source snapshot may be overlaid on that clone while preserving .git. Give the AI `AI-HANDOVER-PROMPT.md` and your exact new request.

Use Windows PowerShell 7+, Git, Node.js 22+, and the supplied native setup (JDK21/AndroidSDK36). From the repo:

```powershell
npm.cmd run setup:workspace
# Restore .env.local from .env.example with the existing URL and publishable key only.
npm.cmd --prefix mobile run dev   # modern UI, 127.0.0.1:5174
npm.cmd run dev                   # legacy browser UI
npm.cmd run check:all
npm.cmd run build                 # both website entries into root dist
npm.cmd run preview               # combined production routes, 127.0.0.1:5176
npm.cmd --prefix mobile run build # native web assets only
```

Both normal development previews use your configured backend. Use staging/test accounts for writes; a Vercel preview does not isolate Supabase. The excluded .release-tools UI fixture is local synthetic testing only and is never deployed or packaged. Browser previews do not verify native phone behavior.

Important source map: mobile/src/main.js (shared UI/actions), v2.css (V2 presentation), organizer.js (bounded pins/search/preferences/debounced drafts), storage.js/crypto.js (encryption/local records), runtime.js (lifecycle/render queues), notifications.js/alert-policy.js (alerts), research.js (vault/export), backend.js (PKCE/account backend), Android Java package (Keystore/biometric/capture/updater/native sharing/theme/haptics/AI shortcut), supabase/migrations and functions (server rules), root src/main.js/v2.css (legacy service), build/preview scripts and hosting config (dual entries).

## Future release order

1. Inspect main and the live Supabase mobile_releases maximum version_code. Choose a strictly larger build; after this release the next candidate is 11 only if 10 remains latest. Example display/package version 2.0.1. Align mobile/package.json+lockfile, build.gradle versionName/versionCode, main.js fallback/beta label, docs and versioned download links. Keep the package ID and original key.
2. Run relevant checks, dependency audit and responsive QA. Backend changes need reviewed new migrations/Edge deployment separately; Vercel does not deploy them. Never reset/reseed live data or rewrite applied migration history.
3. Restore original private signing/Firebase settings. On a new machine run native-setup.ps1. Then:

```powershell
./mobile/scripts/native-build.ps1
./mobile/scripts/verify-apk.ps1 -Apk release/SecretChat-2.0.1.apk
```

The build emits matching APK/AAB and runs native unit tests. Compare the original certificate and verify package, increasing version, non-debuggable build, known-secret scan and bundled web assets. Test a real upgrade over the installed APK: login callback, email on requesting device, biometric/PIN, screenshot roles, composer/keyboard, reconnect, notifications/beep, room expiry/extensions, research consent/export/shared clear. Report untested behavior honestly.
4. Put the verified APK at a NEW immutable public/downloads filename; explicitly force-add only that intended binary. Preserve old release links. Commit/review/push/merge only SecretChat work. Verify GitHub checks and Vercel Ready, modern root and legacy routes, and the actual public APK byte hash.
5. Only AFTER that public-download check, publish version/build/direct HTTPS URL/SHA256/notes through Control → Releases → Publish (or authorized owner setup). That advances the update manifest and queues generic update alerts. Never announce a nonexistent APK or fabricate JWT roles. Users still confirm Android installation; pushing source alone does not update installed apps. FCM acceptance is not proof a phone beeped.
6. Refresh only the SecretChat archive via Source File Zip/Update-Source-Zips.ps1 -Project secretchat after successful checks. Build the flat source ZIP with mobile/scripts/package-source.ps1. Verify actual ZIP contents, CRC and known-secret exclusions; package APK/AAB, guides and checksums. Preserve private files and Git history locally.

For Google Play, upload the AAB through Play Console and configure Play App Signing using the existing identity when compatible sideload updates are required. AABs cannot be installed directly. Follow Play's own update flow for Play-distributed builds.

## Remaining setup and honest limits

Public email one-time links need a custom SMTP sender in the EXISTING Supabase project and a real recipient delivery test. The default test sender is restricted to project-team addresses. Enter credentials directly in Supabase, not source/chat; keep Google available. Do not claim public email delivery from a rendered button.

History and invitation recovery are intentionally local; uninstall, app/browser data clearing, device loss or key loss may erase them. A website cannot block OS captures. Native notification delivery/sound depends on Android permission, channel, battery and network settings. Keep the research-vault password safe: this version has no recovery/rotation flow.

Post-deploy owner validation: immediately and for the first 24 hours, check sign-in/room join/send, private-vs-research boundaries, old invitation/host routes, Vercel/CI errors and release-outbox pending/failed counts without reading private transcripts. Roll back a website commit if unintended login/route/data regression appears; for Android, fix forward with a higher build and the same key. Never delete chats or lower the manifest build to simulate a rollback.
