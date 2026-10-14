# V2 review and data-preservation record

Release work: SecretChat 2.0.0 / Android build 10. Baseline: 4e8ed373e4c17ae9e72cb1df29dd98932deceab9. Plan: V2-RELEASE-PLAN.md.

Code review: skipped (ce-code-review unavailable)

The actual full ce-code-review invocation could not produce a completed receipt after a usage interruption lost two launched reviewer handles. There was no available native semantic review to substitute. Partial reviewer artifacts are not a completed review or security audit. The external xAI peer was blocked by automatic approval review before launch; no source was sent. Raw review prompts/source snapshots stay local and are excluded from deploys and deliverable ZIPs.

The ce-work unavailable-review path therefore requires an explicit manual diff scan and focused validation. The release-checks file records their actual results. Supported concerns from the partial run were checked against source, reproduced where applicable and fixed under the owner's existing authorization:

- Browser first-use tabs must select one stored nonextractable encryption key atomically. Existing database/version/key names, ciphertext and account AAD stay compatible. Independent-context fake IndexedDB plus real WebCrypto tests reproduced unreadable ciphertext before the fix.
- Optional browser Web Locks cover complete per-record operations. Concurrency tests reproduced a lost update and history resurrected during removal. Native storage and no-LockManager queue fallback remain intact.
- Account identity changes must detach private UI before asynchronous cleanup. Composer ownership, serialized latest-session handling and generation checks protect draft attribution; same-account token refresh must finish initial loading.
- Confirmed sends consume only the captured unchanged draft revision, including after leaving a room. Newer typing, another account, failed writes and retries remain isolated.
- Unread persistence rechecks the viewing session inside the serialized modifier; opening a room always queues a read marker. Visible room collections refresh without replacing the focused search input.
- Navigation retains composer and presence when draft persistence fails. Local clear actions bind history/drafts/unread and visible state to their captured account.
- The dual-entry website build includes mobile source in deployment inputs. All six legacy route prefixes, descendants and false-prefix boundaries are checked across hosting configurations and actual preview HTTP requests.
- Native share/AI launch accept only explicit actions and recheck unlock status on the UI thread. The AI package is fixed; no chat/account/invitation context is attached.

Manual final scan must confirm that every changed backend-bound action preserves verified identity/role checks, modern private/research boundaries, manual research retention, legacy invitation/admin behavior, original Android signing identity and secret exclusions. No live chat cleanup, research deletion, backend reset or new credential is part of this release.

Actual Android chooser cancellation/biometric return, real upgrade/auth/capture roles, notification receipt/sound and public SMTP delivery remain acceptance checks on real devices/accounts. Node VM/LockManager fixtures and signed release builds do not establish those outcomes.
