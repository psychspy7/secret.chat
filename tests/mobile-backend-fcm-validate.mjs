// Exercises the real FCM credential and payload in validate-only mode. It never
// delivers a notification and never prints credentials, JWTs or access tokens.
import { readFile } from 'node:fs/promises';
import { createPrivateKey, sign } from 'node:crypto';
import assert from 'node:assert/strict';
const account = JSON.parse(await readFile(process.env.FCM_CREDENTIAL_FILE || '.mobile-secrets/fcm-service-account.json', 'utf8'));
const base64url = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const content = `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url({
  iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
  aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
})}`;
const signature = sign('RSA-SHA256', Buffer.from(content), createPrivateKey(account.private_key)).toString('base64url');
const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${content}.${signature}` }),
  signal: AbortSignal.timeout(20000),
});
assert.equal(tokenResponse.ok, true, `FCM credential exchange returned HTTP ${tokenResponse.status}.`);
const token = await tokenResponse.json();
assert.ok(token.access_token);
const checked = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
  method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ validate_only: true, message: {
    topic: 'sidechat-validation-only', notification: { title: 'SideChat · Room activity', body: 'Someone joined the room' },
    data: { type: 'room_join', room_id: 'validation-only', event_id: 'validation-only', user_id: 'validation-only' },
    android: { priority: 'HIGH', ttl: '60s', collapse_key: 'room:validation-only', notification: { channel_id: 'sidechat_radio_v1', sound: 'radio_chirp', tag: 'room:validation-only', visibility: 'PRIVATE' } },
  } }), signal: AbortSignal.timeout(20000),
});
assert.equal(checked.ok, true, `FCM validate-only returned HTTP ${checked.status}. Check the notification service account role and Cloud Messaging API.`);
console.log('PASS: real FCM credential exchange and validate-only notification payload. No notification sent.');
