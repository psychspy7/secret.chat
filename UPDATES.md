# SecretChat updates

Current Android release: **1.6.0 / build 7**. Website: [SecretChat](https://secret-chat-sable.vercel.app). Repository: [psychspy7/secret.chat](https://github.com/psychspy7/secret.chat).

## Update the website

1. Edit the repository, apply any new Supabase migrations, and run `npm ci`, `npm run check`, and `npm run build`.
2. Commit and push to `main`. The connected Vercel project `secret-chat` automatically deploys that branch.
3. Wait for Vercel to show Ready, open the production site, and refresh it. The website reads its public Supabase configuration from Vercel's environment settings.

The browser website and Android app currently use separate room systems. Their invitation codes are not interchangeable. The website administrator uses `/SECRET`; the Android administrator signs in with the confirmed account `viratanand1221@gmail.com` and opens Control.

## Update the Android app

1. Keep the same package ID, `com.kittycorp.sidechat`, and **restore the original private `.android-signing` folder**. Never upload it to GitHub or include it in the source ZIP. Keep an encrypted private backup. Changing the signing key prevents updates to existing installations.
2. Increase `versionCode` beyond **7** and set the new `versionName` in `mobile/android/app/build.gradle`. Align `mobile/package.json`, its lockfile, and the browser-preview version in `mobile/src/main.js`.
3. Restore your public client settings in root `.env.local` and download `mobile/android/app/google-services.json` from the Firebase project. These files are excluded from the clean source ZIP. Never use a Supabase service-role key in the app.
4. Run these commands from the repository root in PowerShell:

   ```powershell
   npm.cmd --prefix mobile ci
   ./mobile/scripts/native-setup.ps1
   npm.cmd --prefix mobile run check
   ./mobile/scripts/native-build.ps1
   ./mobile/scripts/verify-apk.ps1 -Apk release/SecretChat-1.7.0.apk
   ```

   Replace `1.7.0` with your new version. Keep the build checkout outside OneDrive or other cloud-synced folders: cloud file locking can corrupt Gradle caches. If the project moved, change only `storeFile` in the private signing properties to the restored original key's absolute path.
5. Test the new APK on a phone by installing it **over the previous version**. Check login return, fingerprint/PIN unlock, normal screenshot blocking, the verified admin screenshot exception, notifications, room expiry and extension approval. Do not uninstall: local messages and invitations are removed by uninstalling or clearing app data.
6. Put the verified signed APK in `public/downloads/`, using a new versioned filename. APKs are normally ignored; add only the intended release explicitly, for example `git add -f public/downloads/SecretChat-1.7.0.apk`. Update the website download link, commit, push, and wait for Vercel.
7. Verify the **direct HTTPS download** returns the APK with no redirect. Use `Get-FileHash release/SecretChat-1.7.0.apk -Algorithm SHA256` to get its checksum.
8. Sign in to the app as the administrator, open Control → Android releases → Publish, and enter the version, build number, direct download URL, exact SHA-256, and notes. You can publish the installed version to older users; the new build number must exceed the last published release.

Publishing through Control sends a generic update notification to registered devices. Version 1.6 also checks when opening/resuming and every ten minutes while active, and shows an **Install** banner after verifying the server manifest. Older versions still use Account → **Check for updates**; install 1.6 once to get automatic prompts for future updates. Users must enable notifications for beeps. The app checks the download hash, package, increasing version code, and original signing certificate. Android asks the user to allow and confirm installation. Pushing website code alone does not update an installed APK. Updates preserve local data when installed over the existing app.

Firebase's current Spark Hosting plan blocks APK/AAB hosting. Use the Vercel download path above, or another host that permits direct APK downloads.

## Google Play / AAB

`release/SecretChat-<version>.aab` is for uploading to Google Play Console; it cannot be opened to install the app directly. For the first Play release, configure Play App Signing with the **existing app signing key** if you need compatibility with the sideloaded APK. Keep private signing material out of this repository and use Google's secure key-upload process. A different Play signing certificate produces installations incompatible with the existing APK updater. Prefer Play's update flow for Play installations. See [Android signing guidance](https://developer.android.com/studio/publish/app-signing).

## Email sender setup

Email sign-in uses a one-time link opened on the same device that requested it. Supabase's default sender only delivers to project team addresses; it is unsuitable for public email sign-in. Connect your own sender at Supabase → Authentication → Emails → SMTP Settings, verify the sender's domain, and test a real recipient before announcing public email access. Enter the sender password directly in Supabase, never in this repository or a chat message. See [Supabase SMTP setup](https://supabase.com/docs/guides/auth/auth-smtp). Google sign-in remains available.

## Clean source ZIP

Run `./mobile/scripts/package-source.ps1 -Name SecretChat-v1.6-Source.zip`. The archive includes website and Android source, migrations, icon and notification assets. It excludes APK/AAB files, client configuration files, server keys, signing keys/passwords, caches, and build folders, and scans the actual archive contents for known local credentials.

## Research and shared clearing in v1.6

The Android administrator opens Control → Research vault and chooses a unique password of at least 12 characters. Store it safely: this version cannot recover or rotate it. Research rooms are optional, visibly labeled, and require acceptance before joining. The admin can view/export their encrypted messages, retained until an approved manual clear. Limits are 1,000 per room and 4,096 across research rooms. At capacity, new research messages are rejected without deleting any saved message; export and approve a manual clear before continuing. Existing private rooms are never converted and have no admin archive.

Room options → Ask everyone to clear chat starts a 24-hour vote among every current non-disabled member, including offline members. Any decline rejects it; a new member cancels it. Unanimous approval advances the server chat epoch. Administrators can clear any room directly. Updated clients remove local history on their next authenticated sync; exports, other copies and old apps cannot be erased. Older clients must update before sending again after a shared clear.
