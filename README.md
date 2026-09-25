# SideChat · Managed by Kitty Corp.

A responsive private chat website for Vercel or Netlify with Supabase Auth, Database and Realtime. The current deployment is https://secret-chat-sable.vercel.app. There is no custom always-on server. Each browser encrypts and decrypts messages using AES-256-GCM.

## What users can do

- Anyone can create an invitation-only room without registering an email address. Creators enter a temporary name and appear as Host (Name). Supabase anonymous authentication gives each browser session an identity.
- The permanent administrator signs in at /SECRET to see all rooms, join them, export retained chat, clear messages and close rooms.
- A room creator can copy the invitation, chat and leave like other participants, and request room deletion. The administrator must approve the request before the room closes. Database functions enforce this restriction.
- The administrator can publish, edit, hide and remove public notices from /SECRET. Visitors see published notices on the homepage. Incoming-message sound is optional and off by default.
- The home page includes support addresses for Bitcoin on BITCOIN and USDT on ETHEREUM.

Public rooms last 24 hours. Each anonymous identity can have 3 active rooms and create 10 in 24 hours. The service caps public creation at 50 active rooms and 200 rooms created per 24 hours. Each room allows 20 simultaneously active participants, 100 participant identities over its lifetime, and 5 messages per 5 seconds per sender. It retains the newest 1,000 encrypted messages; the browser keeps at most 500 decrypted messages in memory. These limits are enforced by database functions, including against simultaneous requests. Actual capacity also depends on the Supabase plan and network conditions.

The browser handles encryption and rendering on each participant's device. The app does not require peer-to-peer networking or use a visitor's device to relay someone else's traffic.

## Privacy model

Messages, display names and room labels are encrypted in the browser. New rooms use a randomly generated 32-character access code with 150 bits of randomness. The browser derives the room key from this code, so guests can join with the code alone. Room-code and key checks are stored as hashes; encrypted room-key copies support administrator access. Invitations also carry the room key in a URL fragment, which is not sent as part of the page request. Older rooms created before the access-code update still require both their short code and full invitation link. The permanent administrator has a password-protected private key that can unlock public room keys. **The administrator can access room content.** During beta, Kitty Corp. may use it for support, training, and research, so participants must be told this before sharing sensitive information. Supabase and the hosting provider can still see connection and operational metadata. Invite recipients can copy messages. A compromised browser, invite, or host account can expose room content.

The chat offers a manual **Hide chat** button and covers content when the tab is hidden. Printing displays a privacy notice. **A website cannot stop operating-system screenshots, screen recording, or an external camera.** Do not promise screenshot prevention to participants.

The website includes a strict content security policy, no analytics scripts, and server-side authorization for room access. Public creation relies on anonymous Auth and can still be abused by people who clear browser data or use multiple devices; configure Supabase CAPTCHA and review usage as the site grows. This code has not undergone an independent security audit.

## Set up a new Supabase project

1. Create a Supabase project. Enable **Anonymous Sign-Ins** in Authentication and configure Auth CAPTCHA for a public site.
2. Apply the SQL files in supabase/migrations in filename order. The privacy-and-retention migration installs a five-minute expiry cleanup job using pg_cron. It only operates on SideChat public rooms. The admin-controls migration adds deletion approvals and public notices.
3. Create a confirmed permanent Auth user with a strong password. Choose a Host ID of 3–32 lowercase letters, digits, dots, underscores or hyphens. Its internal sign-in email must be HOST_ID@kittycorp.invalid. Add its user UUID in SQL using: insert into public.hosts(user_id,host_id,vault_salt) values ('USER_UUID','HOST_ID',encode(gen_random_bytes(24),'base64'));
4. Set the local variables below. Run npm run provision:host-keypair once using the host credentials. It creates an RSA key pair locally, stores the public key in Supabase and stores the private key encrypted under the host password. It refuses to overwrite an existing pair.

Once the permanent host account exists, disable unwanted public email registration. Anonymous sign-ins must remain enabled. Plan separate retention for old Supabase anonymous Auth accounts as described in Supabase documentation.

## Run locally

Requires Node.js 22 or later. Run npm ci. Copy .env.example to .env.local, then add your own Supabase Project URL and **publishable** key. Never put a service-role or secret key in Vite variables. Set the host credentials as local environment variables when provisioning or running the live integration check:

- SIDECHAT_HOST_ID
- SIDECHAT_HOST_PASSWORD
- SIDECHAT_HOST_EMAIL (optional if the internal email follows the Host ID convention)

Run npm run provision:host-keypair, then npm run dev. Open the local URL shown by Vite. The permanent host panel is /SECRET.

## Deploy

Import this repository into Vercel or Netlify. Use the Vite preset, npm run build, and dist as the output folder. Set VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY in the hosting dashboard for Production and Preview. On Vercel, choose **Config** for both variables, not **Secret**: Vite embeds variables beginning with VITE_ in the browser build, and Vercel will not expose a Secret that way. These are the Supabase project URL and publishable key, never a service-role or secret key. Redeploy after adding or changing either value; an existing build will not pick them up. vercel.json and netlify.toml contain SPA routing and security headers. .env.local and .env.production are intentionally ignored and excluded from the ZIP.

To deploy to another domain, review allowed origins and the Site URL in Supabase Auth settings. Share invitations privately. For public room creators, save the access code or invitation displayed in the room panel before closing the tab; anonymous identity can be lost if browser data is cleared. Apply any new SQL migrations before deploying frontend changes that use them.

## Check

- npm run check tests crypto and JavaScript syntax.
- npm run build builds the static website.
- npm run check:integration checks real Supabase login, concurrent creation limits, outsider access, encrypted joins and messages, rate limits, admin-only controls, deletion approvals, and notice permissions. It creates temporary test rooms and closes them afterward.

For a production release, also check two real browsers or devices, tab hiding, reconnection, responsive layout, and CSV export.
