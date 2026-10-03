Current release checks: [v1.6 / build 7](../V1.6-RELEASE-CHECKS.md). The following is the historical v1.5 record.

# SecretChat 1.5.0 beta — build 6 — 1 October 2026

Package: `com.kittycorp.sidechat`. Visible name: **SecretChat**. Android 7.0+ (API 24), target API 36, JDK 21. The original release signing certificate is retained.

## Changes

- Supplied icon and notification MP3, including adaptive launcher icons and a new Android sound channel.
- Optional fingerprint/strong biometric lock, device PIN/password recovery, disabled underlying touch/accessibility controls while locked, and sign-in callbacks that wait for unlock.
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

APK SHA-256: `b32be6a4ac9555a1fe23943a90507a6e9d4583f9522e018162240268ca9de53b`.

AAB SHA-256: `78db93c3d326ca6fa01a29c682a6e87e50c9b1fa43aed185ea4e64c31ea68d00`.

## Remaining validation and setup

No Android phone or emulator was connected. Fingerprint/PIN behavior, browser-to-app email/Google return, Keystore persistence, normal/admin capture behavior, background sound/delivery, battery impact, and an actual upgrade installation still need a phone test. Prior browser Google login confirmed the designated admin role; that does not prove the new native flows.

Supabase still uses its default test email sender, restricted to project team addresses. Public email sign-in needs a custom SMTP sender and a real recipient delivery test. Google sign-in remains available.

The APK includes public Supabase/Firebase client configuration. Server keys, OAuth secrets, signing passwords, and the release private key are excluded. Keep a private encrypted backup of `.android-signing`. See [the update guide](../../UPDATES.md).
