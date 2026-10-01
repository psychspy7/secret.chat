# SecretChat mobile backend

The mobile service uses the existing Supabase project `zpeadphldseifbfxpkaa` and Firebase project `kitty-sidechat-20260930`. Project identifiers and the Android package `com.kittycorp.sidechat` intentionally retain their original technical names after the SecretChat branding change.

## Deploy

Apply the repository's SQL migrations in filename order on a fresh project. The mobile migrations include `mobile_private_android`, `mobile_delivery_limits`, `mobile_cipher_validation`, and the v1.5 feature and overview migrations. These have already been applied to the configured project. Do not reapply the initial schema to that project.

Deploy `mobile-send`, `mobile-device`, and `mobile-presence` with their relative `_shared` dependencies. They use custom authentication: each request is checked against Supabase Auth, and the database verifies a live session and a confirmed Google or email identity. Platform `verify_jwt` is disabled for these functions to support the project's asymmetric tokens; this does not make the endpoints anonymous. Requests without authentication are rejected.

Configure Google in Supabase Auth, including the exact Android callback and public OAuth audience. Store `FCM_SERVICE_ACCOUNT_JSON` in Supabase Edge Function secrets only. The service account requires Firebase Cloud Messaging send permission. Download the Firebase Android client configuration separately when building the app.

## Access and storage

Mobile tables use row-level security and deny direct client table access. Authenticated RPCs validate membership and roles. Only the confirmed account `viratanand1221@gmail.com` receives administrative controls; editable profile metadata cannot grant that role.

Messages are encrypted on participating devices. `mobile-send` validates membership, message identity, size, timestamp, and rate before using private ephemeral Realtime REST Broadcast. No mobile ciphertext archive or escrow decryption key is maintained. Room invitation hashes, account and room metadata, message identifiers for duplicate prevention, observed connection IP, and optional push tokens are stored on the backend.

Limits include three active rooms per creator, ten creations per account daily, fifty active rooms globally, twenty active participants per room, and five messages per sender per five seconds. Ordinary rooms last 1–24 hours, chosen at creation. Only the administrator can create permanent groups; these still count toward capacity limits. Creators can request 1–24 additional hours. Only the administrator can approve/decline requests or extend a room directly. A closed room cannot be reopened by extension. Admin limits are twenty active/created rooms daily; the global fifty-room ceiling still applies. Browser/native history is bounded to five hundred messages per room. Device data is not a cloud backup.

Notification messages contain generic activity text and a room/account identifier, never chat contents. Sending uses FCM HTTP v1 with the supplied v1.5 notification sound and an account-specific tap target. Notification delivery still depends on the phone's settings and connectivity.

## Verification

`node --test tests/mobile-backend-edge.test.mjs` runs the authentication, identity binding, private relay, request size, IP ownership, and push payload tests without accessing real user data.

`tests/mobile-backend.sql` and `tests/mobile-v15.sql` are database-owner integration tests. It creates synthetic users and sessions inside a transaction and rolls them back. The completed run passed twenty-two security/integration groups across the baseline and v1.5 SQL suites, including role spoof rejection, room isolation, creator restrictions, message and room limits, replay prevention, deletion approval, notices, releases, disabled-account rejection, and attempts by the authenticated database role to read raw tables or forge broadcasts.

FCM accepted the configured sender and a `validate_only` payload during setup; no test notification was sent to a real device. Verify background delivery on a phone before a wider rollout.
