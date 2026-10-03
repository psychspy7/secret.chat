# SecretChat Android

Current release: **1.6.1 / build 8**. See [UI release checks](V1.6.1-RELEASE-CHECKS.md).

The Android app is in `mobile/`. The existing browser website remains at the repository root. They share a Supabase project but use separate room and storage systems; website invitation codes do not open mobile rooms.

## What the Android app does

- Google and confirmed email sign-in, with server-checked administrator access for `viratanand1221@gmail.com`.
- Private invitation codes, participant-side AES-GCM message encryption, and device-encrypted local history.
- Room creation limits, named participants, online presence, optional room join and message alerts, and your supplied notification sound.
- Rooms with a chosen 1–24 hour lifetime; administrator groups without expiry; creator extension requests and administrator approval or direct extension.
- Unanimous shared clear requests, admin clearing, optional consented research room view/export, and generic update notifications.
- Administrator room closure, member controls, notices, deletion-request review, and signed APK release publishing.
- Optional fingerprint/strong biometric unlock with device PIN/password recovery; Android screenshot protection with a server-verified admin exception; the new premium monogram, cinematic launch, reduced-motion support, and a verified update installer.

Messages are delivered live. Private rooms have no message archive or administrator decryption key. Optional research rooms require explicit creator opt-in and participant acceptance. Their encrypted archive retains at most 1,000 messages until an approved manual clear, with the invitation encrypted to an administrator research vault. Admin viewing/export decrypts locally after the vault is unlocked with its password. Existing private rooms are unaffected. Private participants cannot retrieve messages they missed while disconnected. Up to 500 received messages per room are saved locally. Google sign-in restores identity and room membership; it does not restore local messages or invitations after uninstalling, clearing app data, or changing phones.

The administrator can view account and room metadata, including the last IP address observed by the backend. No claim of complete anonymity or protection against compromised devices is made. See `info-site/privacy.html` for the public privacy explanation.

## Build and install

1. Install Node.js 22 or newer.
2. Copy the repository-root `.env.example` to `.env.local` and set its public Supabase URL and publishable key. Never put a service-role key or OAuth client secret in a `VITE_` variable.
3. Download the Firebase Android client configuration for package `com.kittycorp.sidechat` and save it as `mobile/android/app/google-services.json`. This file is deliberately excluded from the source archive. Firebase project: `kitty-sidechat-20260930`.
4. From the repository root, run:

   ```powershell
   npm.cmd --prefix mobile ci
   ./mobile/scripts/native-setup.ps1
   ./mobile/scripts/native-build.ps1
   ```

5. The build creates both a signed APK and AAB in `release/`. Copy the APK to your Android phone and open it. Android may ask you to allow installation from the app used to open the file. Android 7.0 or newer is required. Keep the AAB for a Google Play upload; it cannot be installed directly on a phone.
6. Sign in with Google. Room notifications are optional and can be enabled under your account settings.

The tooling stays in the ignored `.android-tools` folder. The first build creates the release signing key in `.android-signing`. **Keep a secure backup of that folder outside GitHub. All compatible future updates require the same signing key.** Neither server credentials nor signing keys belong in the APK or source ZIP.

See `docs/ANDROID-NATIVE.md` for native security and build details. Supabase migrations and Edge functions are under the repository-root `supabase/` directory.

## Google sign-in setup

The Google Web OAuth client must point to `https://zpeadphldseifbfxpkaa.supabase.co/auth/v1/callback`. Enable Google in the Supabase Auth provider settings and store the client secret there only. Add the exact Android redirect `com.kittycorp.sidechat://auth/callback` to Supabase Auth's URL allowlist. Browser development uses `http://127.0.0.1:5174`.

Google's OAuth audience must be published for general access, or each tester must be eligible under Google's testing rules. Configuring the provider alone does not prove that the whole login flow works.

## Email sign-in

Email uses a one-time link on the same device that requested it. Connect a custom SMTP sender in Supabase Authentication → Emails → SMTP Settings before offering this to all users. The default test sender only allows project team addresses. Google remains available while this setup is pending. Keep the sender password out of source and chat.

## Notifications

Firebase Cloud Messaging delivers generic room-activity alerts. The mobile service uses the `FCM_SERVICE_ACCOUNT_JSON` Supabase Edge Function secret, with permission to send Firebase messages. That private credential is server-only. Notification contents never contain chat text. Android permissions, battery restrictions, network connectivity, and user sound settings can delay or silence delivery.

## Publish an update

Pushing website code to GitHub does not update an installed APK by itself.

1. Update the app and increase `versionCode` and `versionName` in `mobile/android/app/build.gradle`. Keep `mobile/package.json` version aligned.
2. Build with the original `.android-signing` folder.
3. Upload the APK to a direct HTTPS URL with no redirects. The website serves release APKs from `public/downloads/` on Vercel. Firebase Spark Hosting blocks APK/AAB files. Keep binary downloads out of the source ZIP. See [the update guide](../UPDATES.md).
4. Calculate the APK SHA-256 using `Get-FileHash -Algorithm SHA256`.
5. Sign in as the administrator, open Control, and publish the version, version code, direct URL, SHA-256, and release notes.
6. Publishing sends registered devices a generic update alert. Version 1.6 checks automatically on open/resume and while active and shows an Install banner; users can also select **Check for updates**. Older versions must install 1.6 once using their existing update button. The app verifies the hash, package name, version code, and signing certificate before Android asks them to confirm installation.

Normal updates preserve local data. Do not uninstall the old app to apply an update.

## Local development and checks

```powershell
npm.cmd --prefix mobile run dev
npm.cmd --prefix mobile run check
npm.cmd --prefix mobile run build
```

The browser preview supports interface and encryption checks. Native screenshot protection, Android Keystore storage, background push, and APK installation require the Android app and must be tested on an Android device.

The shared research archive is capped at 4,096 messages globally and 1,000 per room; new research messages pause at capacity until an approved manual clear. Private messages are never part of that archive.
