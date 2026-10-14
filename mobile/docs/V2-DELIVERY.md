# SecretChat V2.0 delivery

Final Android release: **2.0.0 / build11**. Published 14 October 2026. Candidate build10 is preserved and superseded; install build11 over your existing app without uninstalling.

## Published source and website

- Application source commit: [2e70d118632972fd4f11f4f3c3dd14b95ba58fcb](https://github.com/psychspy7/secret.chat/commit/2e70d118632972fd4f11f4f3c3dd14b95ba58fcb), pushed to the existing main branch.
- Vercel project secret-chat, production deployment **dpl_AUFfYut2kJ9fGnmaEn6NNC7XyEbC**, READY from that commit.
- [Live app](https://secret-chat-sable.vercel.app/). Actual HTTP checks passed for13 modern/legacy/descendant/false-prefix routes, their assets and the configured existing backend.
- [Check SecretChat](https://github.com/psychspy7/secret.chat/actions/runs/38609801525) and [production dependency audit](https://github.com/psychspy7/secret.chat/actions/runs/38609801659): completed successfully.
- The earlier candidate's stuck Node24 check was cancelled. Async Web Locks error normalization fixed the reproduced failure; all102 mobile tests pass under Node22.23.2 and Node24.21.0. CI now bounds test/job timeouts.

## Public app and update service

[Direct final APK](https://secret-chat-sable.vercel.app/downloads/SecretChat-2.0.0-build11.apk): **5,344,109 bytes**, SHA256 **7de456d3ef90e6ee130b93e4049845cc6392a0a08af1cf2081577c4afc085adc**. The actual hosted bytes match the verified signed APK.

The existing Supabase release manifest was advanced only after that download check: version2.0.0, version_code11, the direct URL above and the same checksum. Firebase accepted both registered-device generic update alerts: accepted2, invalid0, retry0. The outbox was read back at completed2/pending0. No chat text was included; the temporary device-token helper file was removed. Acceptance/outbox completion does not establish phone receipt or beep.

The signed Google Play bundle is **4,890,270 bytes**, SHA256 **56b6e8fbc2ec715d8bef7e164ac0f66af00c4e1ebe5ed49dd59c9bed0827092c**. An AAB is not directly installable. Original package com.kittycorp.sidechat and signing certificate are preserved.

## Source and continuation package

The full package includes the final APK/AAB, SecretChat-v2.0.0-Source.zip, canonical SOURCE-LATEST.zip, OWNER-HANDOVER.md, AI-HANDOVER-PROMPT.md, V2.0-RELEASE-CHECKS.md, V2-REVIEW-RESOLUTION.md, this delivery record and checksums. The relevant canonical snapshot is refreshed through the workspace's supplied SecretChat updater after verified checks; final archive CRC/content/known-secret results and hashes are supplied with the package.

Private credentials, original signing keys/passwords, live user/chat data, environment settings, dependency/build caches, raw partial reviews and Git history are excluded. Preserve encrypted private backups and the original live Git checkout separately. A fresh clean source archive cannot sign a compatible update without the original owner key.

Read the owner guide before future work. Use the continuation prompt with your exact request. Inspect the live maximum version_code first; the next compatible build must be higher than11. Source push updates the website; installed Android apps still need a new signed APK and a published verified manifest.

## Verification limits

102 mobile,11 Edge,2 routing and8 native-policy checks pass; crypto checks, both dependency audits, production builds, signatures, known-secret scans and matching final bundled assets pass. Read the release-checks file for exact test/fixture coverage.

Code review: skipped (ce-code-review unavailable) — the interrupted full review produced no completed receipt; manual diff scan and supported proof-first/runtime fixes are recorded. No independent full security-audit claim is made.

No attached phone/emulator verified an actual upgrade, Google/email callback, fingerprint/PIN, screen-capture roles, chooser return, notification sound or installer completion. Custom SMTP plus real-recipient testing remains required for public email sign-in. Desktop browser inspection timed out; recorded small-screen dark/light fixture checks are limited to the states described in release checks.

Owner monitoring: verify login/join/send, legacy invitations/admin paths, research consent/controls and outbox/CI/Vercel signals immediately and over24h. Roll back unintended website regressions through the existing repo; fix Android forward with a higher build and the same key. Never delete data or lower the manifest to simulate rollback.
