// Read-only probes against deployed mobile endpoints; no account or room created.
import assert from 'node:assert/strict';
const base = process.env.MOBILE_SUPABASE_URL || 'https://zpeadphldseifbfxpkaa.supabase.co';
for (const name of ['mobile-send', 'mobile-device', 'mobile-presence', 'mobile-release']) {
  const url = `${base}/functions/v1/${name}`;
  const rejected = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(20000) });
  assert.equal(rejected.status, 403, `${name}: unauthenticated request was not rejected`);
  assert.match((await rejected.json()).error, /Google/);
  const preflight = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'http://127.0.0.1:5174', 'Access-Control-Request-Method': 'POST' }, signal: AbortSignal.timeout(20000) });
  assert.equal(preflight.status, 204, `${name}: preflight failed`);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), 'http://127.0.0.1:5174');
  console.log(`PASS: ${name} live auth rejection and preview CORS`);
}
