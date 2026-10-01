# SecretChat 1.5.0 beta — build 5 — 1 October 2026

Package: `com.kittycorp.sidechat`. Visible name: **SecretChat**. Android 7.0+ (API 24), target API 36, JDK 21. The original release signing certificate is retained.

## Changes

- Supplied icon and notification MP3, including adaptive launcher icons and a new Android sound channel.
- Optional fingerprint/strong biometric lock, device PIN/password recovery, and sign-in callbacks that wait for unlock.
- Confirmed email one-time-link sign-in alongside Google.
- Screenshot exception only after native, server-verified administrator authorization; lock and recent-task previews remain protected.
- Creator-selected 1–24 hour rooms; admin groups without expiry; creator extension requests; administrator approval/decline and direct extension.
- Responsive website bottom navigation, touch controls, supplied branding, APK download, room duration and admin extension controls.

## Completed verification

- Website encryption checks, production build, and live Supabase integration passed, including concurrent quotas, outsider denial, admin-only controls, deletion approval, notices, duration and extension authorization.
- Ten mobile encryption/history/storage tests and nine Edge endpoint tests passed.
- Fifteen baseline and seven v1.5 live database groups passed. All synthetic SQL fixtures were rolled back.
- Three updated Edge Functions deployed; live unauthenticated rejection and CORS checks passed.
- Eight Android update-policy tests passed with zero failures/errors/skips; signed APK/AAB release build and release lint gate passed.
- APK signature, original certificate, label, package, build number, release mode and private credential scan passed.
- AAB contents were verified using Java JarFile against the original release certificate and validated using Google's bundletool.
- Supabase advisory review found no new v1.5 privilege exposure. Mobile tables intentionally deny direct access under RLS and use authorized RPCs. Inherited website/other-project warnings remain; this is not an independent security audit.
- The source packager scans its explicit allowlist and completed archive contents against private key patterns and known local secrets.

APK SHA-256: `3003c4169c1fd1fe14581e35c996b6396d39e167ae87ed4407ffe791b06637c7`.

AAB SHA-256: `6842cd294ef1d6781597cb1223d5f7c3f1d7e1f3b8ffd03de74ff603124661fd`.

## Remaining validation and setup

No Android phone or emulator was connected. Fingerprint/PIN behavior, browser-to-app email/Google return, Keystore persistence, normal/admin capture behavior, background sound/delivery, battery impact, and an actual upgrade installation still need a phone test. Prior browser Google login confirmed the designated admin role; that does not prove the new native flows.

Supabase still uses its default test email sender, restricted to project team addresses. Public email sign-in needs a custom SMTP sender and a real recipient delivery test. Google sign-in remains available.

The APK includes public Supabase/Firebase client configuration. Server keys, OAuth secrets, signing passwords, and the release private key are excluded. Keep a private encrypted backup of `.android-signing`. See [the update guide](../../UPDATES.md).
