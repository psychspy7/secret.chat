# SecretChat prompt for another AI coding tool

Copy the text below into your coding tool, then replace the final line with your change request. Open the latest repo checkout or attach the clean source ZIP. Do not attach private credentials or signing files to a chat.

---

Maintain my existing SecretChat project. Read `mobile/docs/OWNER-HANDOVER.md`, `UPDATES.md`, `README.md`, `mobile/README.md`, `mobile/docs/BACKEND.md`, `mobile/docs/ANDROID-NATIVE.md` and the latest release checks before changing it.

The current release at this handover is Android 1.6.1, versionCode 8. Inspect the latest repository and published manifest before choosing the next release number. This project uses Vite/JavaScript, Capacitor 8, native Android Java, Supabase Auth/Database/Realtime/Edge Functions, and Firebase Cloud Messaging. Repository: https://github.com/psychspy7/secret.chat. Website: https://secret-chat-sable.vercel.app/.

Preserve Android application ID `com.kittycorp.sidechat`, the original signing identity, existing Supabase project `zpeadphldseifbfxpkaa`, Firebase project `kitty-sidechat-20260930`, confirmed admin `viratanand1221@gmail.com`, local encrypted storage, room rules and server authorization. Website source is `src/`; Android source is `mobile/`. Their room codes and admin sign-ins are separate.

Work on a branch and keep the lockfiles. Preserve private Android encryption and research opt-in/participant consent. Research messages stay until approved manual clear; reaching 1,000 per room or 4,096 globally rejects new research messages instead of automatically deleting saved messages. Do not grant administrators hidden access to private chats. Do not reset production, replay existing initial migrations, weaken RLS/custom authentication, or erase local history to fix an update.

Keep service-role keys, OAuth secrets, Firebase sender keys and signing passwords out of source, APK/AAB and source ZIP. I will restore the original signing folder and client configuration privately in the local build environment. If the original signing key is unavailable, report that compatible APK updates cannot be signed with a new key.

For Android releases, increase versionCode beyond the latest published code, align visible version metadata, build APK and AAB with the original key, run relevant web/mobile/Edge/native checks, compare the original signing certificate, and test on a real Android device where available. A browser preview or passing build is not proof of native-device behavior. State anything not tested.

Deploy backend changes separately from Vercel. Host each signed APK at a new direct HTTPS URL, verify its downloaded SHA-256, then publish the manifest through the admin release controls. Push reviewed website changes to the connected repo so Vercel deploys `main`. Pushing source alone does not update installed APKs. Return clean source, signed release artifacts when the original key is available, checksums, test results and release steps. Do not send messages to users or third parties without my explicit instruction.

My requested change: [write the exact feature, fix or design change here].
