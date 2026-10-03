# Android build and release

The app identifier is `com.kittycorp.sidechat`. The current release is version `1.6.1`, code `8`, with Android 7.0 (API 24) as its minimum and API 36 as its target. Node 22 or later is required. The checked-in native project uses Capacitor 8 and a workspace-local JDK 21 and Android SDK. See the [owner handover](OWNER-HANDOVER.md) before moving computers or preparing an update.

From the repository root in PowerShell:

```powershell
npm.cmd --prefix mobile ci
./mobile/scripts/native-setup.ps1
./mobile/scripts/native-build.ps1
```

Configure the repository root `.env.local` using `.env.example` before building; the mobile Vite configuration reads its environment from that parent directory. The build script compiles the web client, generates the original notification chirp, synchronizes Capacitor, builds and signs both releases, runs the native unit tests, verifies both signatures, and copies the results to `release/SecretChat-<versionName>.apk` and `release/SecretChat-<versionName>.aab`. Install the APK directly on a phone. The AAB is for upload to Google Play; it cannot be installed directly.

The first build creates `.android-signing/sidechat-release.p12` and its private password file. **Back up `.android-signing` securely.** Never commit it, include it in a source ZIP, or regenerate it for an update to an existing install. Losing this key prevents compatible updates to this APK. The build script does not print the password. If you move the project to another folder or computer, update only the `storeFile` path in the private `keystore.properties` file to point to the same restored key; retain the original passwords and alias.

## Local data protection

`SideChatDevice.secureGet`, `secureSet`, and `secureRemove` keep app records in private no-backup storage. AES-256-GCM encrypts and authenticates every record using a non-exportable Android Keystore key. Each key name is bound as authenticated data, each write gets a fresh IV, and atomic writes protect against interrupted saves. Records are limited to 4 MiB and the vault to 64 MiB. Encrypted storage is not a substitute for a device lock or a guarantee against a compromised operating system.

Cloud backups and device-transfer backups are disabled. App updates preserve local files and keys, while uninstalling the app or clearing its data destroys local history. Google sign-in restores the account identity, not chat messages that exist only on a lost or reset phone.

The Activity uses Android `FLAG_SECURE` for system screenshot, recording, and recent-task-preview protection. The sole exception is an unlocked foreground session whose administrator role is confirmed by the native layer against the fixed Supabase profile endpoint. JavaScript cannot supply the admin flag or endpoint. The permission expires within five minutes and is rechecked; logout, a locked app, invalid/revoked session, backgrounding, or an unsuccessful recheck restores protection. Recent-task previews remain protected for the administrator too.

Fingerprint/strong biometric lock is optional in Account settings. Enabling and disabling require device authentication. The native cover locks on backgrounding and survives a cancelled prompt. Device PIN/password is available for recovery. Native vault reads are denied while locked; the chat view is invisible and excluded from touch/accessibility navigation; sign-in callbacks wait for unlock. A camera pointed at a screen or a compromised phone cannot be prevented by the app. Release WebView debugging and cleartext network access are disabled.

## Sign-in and notifications

The callback is `com.kittycorp.sidechat://auth/callback`, registered only for the exact host and path in the Android manifest. Account authorization is handled by the web client's PKCE sign-in flow.

Native `getCapabilities()` returns `{pushConfigured, screenProtection}`. Firebase configuration is included only when `mobile/android/app/google-services.json` is present. Background notifications need both this client configuration and the server FCM sender setup. Their delivery also depends on Android notification permission, network connectivity, and operating-system restrictions.

The `secretchat_room_v15` notification channel uses the supplied `secretchat_ping_v15.mp3` sound. A new channel lets existing installations receive the new default without changing an immutable older channel. Users can change or disable sound in Android Settings. No microphone or recording permission is requested.

## Future APK updates

`installUpdate({url, sha256, versionCode})` accepts a direct HTTPS URL on port 443, with no URL credentials or redirects. The transfer is limited to 128 MiB and three minutes. Before Android's installation confirmation is opened, the plugin verifies the SHA-256 checksum, exact app package ID, increasing version code, and the same signing certificate as the installed app. Android performs its own package verification during installation as well.

If Android has not allowed this app to request installations, the method opens the system permission screen and returns `status: "permission_required"`. The user must return and tap Update again. Successful handoff returns `status: "installer_opened"`; this is not confirmation that the user installed it. No update is installed silently.

For a release, increase `versionCode` and `versionName` in `mobile/android/app/build.gradle`, build with the original signing key, host the APK at a direct HTTPS download URL, and publish the exact hash and version through the administrator's release controls. A redirecting download URL is intentionally rejected. Distribute a Google Play build using Play's update flow instead of the sideload updater if publishing to Play.

References: [Capacitor Android native code](https://capacitorjs.com/docs/android/custom-code), [Android Keystore](https://developer.android.com/privacy-and-security/keystore), [Capacitor push setup](https://capacitorjs.com/docs/apis/push-notifications), [Android secure activities](https://developer.android.com/security/fraud-prevention/activities).

## Research export

The administrator explicitly selects View / export for a consented research room and unlocks its password-encrypted vault locally. Its imported RSA private key is nonextractable and kept only in memory, discarded on backgrounding/sign-out. Export sanitizes spreadsheet formula-like cells and requires an explicit Share/Save chooser. The exported plaintext CSV is outside encrypted chat storage and may be copied by its recipient. One temporary export (maximum 8 MiB) is kept in the app-private cache; the next export replaces it. Standard FileProvider exposes only its cache directory with temporary read access. This feature does not give administrators private-room keys.
