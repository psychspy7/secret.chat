import test from 'node:test';
import assert from 'node:assert/strict';

const env = new Map([
  ['SUPABASE_URL', 'https://fixture.supabase.co'],
  ['SUPABASE_ANON_KEY', 'public-fixture'],
  ['SUPABASE_SERVICE_ROLE_KEY', 'server-fixture'],
]);
let registered;
const pending = [];
globalThis.Deno = { env: { get: key => env.get(key) }, serve: fn => { registered = fn; } };
globalThis.EdgeRuntime = { waitUntil: promise => pending.push(promise) };
const shared = await import('../supabase/functions/_shared/mobile.ts');
await import('../supabase/functions/mobile-send/index.ts');
const send = registered;
await import('../supabase/functions/mobile-device/index.ts');
const device = registered;
await import('../supabase/functions/mobile-presence/index.ts');
const presence = registered;
await import('../supabase/functions/mobile-release/index.ts');
const release = registered;
const actor = 'c5f58182-46c7-4876-93db-690ee17b11ad';
const room = 'fbe4fae0-b734-4d1b-83de-0bd3866da4b9';
const message = '55d87f92-51a0-4d5e-93e5-a5db810f1d47';
const identity = { id: actor, email: 'fixture@example.invalid', email_confirmed_at: new Date().toISOString(), identities: [{ provider: 'google', identity_data: { email: 'fixture@example.invalid', email_verified: true } }] };
const response = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const request = (value, extra = {}) => new Request('https://fixture.test', { method: 'POST', headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(value) });

test('all Edge endpoints reject missing auth before contacting server', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network'); });
  for (const handler of [send, device, presence, release]) {
    const result = await handler(new Request('https://fixture.test', { method: 'POST', body: '{}' }));
    assert.equal(result.status, 403);
    assert.match((await result.json()).error, /Google/);
  }
});
test('editable metadata cannot substitute for a verified Google identity', async t => {
  t.mock.method(globalThis, 'fetch', async () => response({ ...identity, identities: [], user_metadata: { email_verified: true, provider: 'google', is_admin: true } }));
  assert.equal((await send(request({}))).status, 403);
});
test('confirmed email identity is accepted without Google; unconfirmed and mismatched identities are rejected', async t => {
  let candidate = { ...identity, identities: [{ provider: 'email', identity_data: { email: identity.email } }] };
  t.mock.method(globalThis, 'fetch', async () => response(candidate));
  assert.equal((await shared.identify(request({}))).userId, actor);
  candidate = { ...candidate, email_confirmed_at: null };
  await assert.rejects(() => shared.identify(request({})), /verified/);
  candidate = { ...identity, identities: [{ provider: 'email', identity_data: { email: 'other@example.invalid' } }] };
  await assert.rejects(() => shared.identify(request({})), /verified/);
});
test('message relay uses validated server identity and private ephemeral REST Broadcast', async t => {
  const envelope = { id: message, room_id: room, user_id: actor, display_name: 'Verified', payload: { v: 1 } };
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/auth/v1/user')) return response(identity);
    if (url.endsWith('/rpc/mobile_send_message')) return response(envelope);
    return response({});
  });
  const result = await send(request({ room_id: room, message_id: message, user_id: 'attacker', payload: { v: 1 } }));
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), envelope);
  const relay = calls.find(c => c.url.includes('/api/broadcast'));
  assert.deepEqual(JSON.parse(relay.options.body).messages, [{ topic: `mobile-room:${room}`, event: 'message', payload: envelope, private: true }]);
  assert.equal(calls.some(c => c.url.includes('/realtime.messages')), false);
});
test('failed membership RPC never reaches Broadcast', async t => {
  t.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/auth/v1/user')) return response(identity);
    assert.ok(url.endsWith('/rpc/mobile_send_message'));
    return new Response(JSON.stringify({ message: 'This room is unavailable.' }), { status: 403 });
  });
  const result = await send(request({ room_id: room, message_id: message, payload: {} }));
  assert.notEqual(result.status, 200);
});
test('device owner and IP originate from verified request context', async t => {
  let captured;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.endsWith('/auth/v1/user')) return response(identity);
    if (url.endsWith('/rpc/mobile_profile')) return response({ user_id: actor });
    captured = JSON.parse(options.body); return response({ registered: true });
  });
  const result = await device(request({ token: 't'.repeat(40), user_id: 'other', ip: '198.51.100.200' }, { 'X-Forwarded-For': '192.0.2.1' }));
  assert.equal(result.status, 200);
  assert.equal(captured.p_user_id, actor);
  assert.equal(captured.p_ip, '192.0.2.1');
  assert.equal((await result.json()).push_configured, false);
});
test('request body bound applies even without Content-Length', async () => {
  await assert.rejects(() => shared.body(request({ text: 'x'.repeat(19000) })), /too large/);
  assert.equal(shared.headers(new Request('https://fixture.test', { headers: { Origin: 'https://evil.example' } }))['Access-Control-Allow-Origin'], undefined);
});
test('presence reports unavailable push accurately without server credential', async t => {
  t.mock.method(globalThis, 'fetch', async url => url.endsWith('/auth/v1/user') ? response(identity) : response([{ user_id: actor }]));
  const result = await presence(request({ room_id: room }));
  assert.deepEqual(await result.json(), { online: [{ user_id: actor }], push_configured: false });
  await Promise.all(pending.splice(0));
});
test('FCM payload is generic, account-scoped, private and uses the radio channel', async t => {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pkcs8 = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  env.set('FCM_SERVICE_ACCOUNT_JSON', JSON.stringify({ project_id: 'fixture-project', client_email: 'fixture@fixture-project.iam.gserviceaccount.com', private_key: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----` }));
  let pushed;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.includes('oauth2.googleapis.com')) return response({ access_token: 'fixture-access', expires_in: 3600 });
    if (url.endsWith('/rpc/mobile_edge_claim_push')) return response({ id: message, devices: [{ token: 'device-fixture', user_id: actor }] });
    if (url.includes('fcm.googleapis.com')) { pushed = JSON.parse(options.body).message; return response({ name: 'fixture-message' }); }
    if (url.endsWith('/rpc/mobile_edge_finish_push')) return response(null);
    throw new Error(`Unexpected URL ${url}`);
  });
  const { dispatchPresence } = await import('../supabase/functions/_shared/push.ts');
  await dispatchPresence('other-member', room);
  assert.equal(pushed.notification.body, 'Someone joined the room.');
  assert.equal(pushed.data.user_id, actor);
  assert.equal(pushed.android.notification.channel_id, 'secretchat_room_v15');
  assert.equal(pushed.android.notification.sound, 'secretchat_ping_v15');
  assert.equal(pushed.android.notification.visibility, 'PRIVATE');
  assert.equal(pushed.data.message, undefined);
  env.delete('FCM_SERVICE_ACCOUNT_JSON');
});

test('release publication requires the database administrator check before notifying',async t=>{
  t.mock.method(globalThis,'fetch',async url=>{
    if(url.endsWith('/auth/v1/user')) return response(identity);
    assert.ok(url.endsWith('/rpc/mobile_admin_publish_release'));
    return new Response(JSON.stringify({message:'Administrator access required.'}),{status:403});
  });
  const result=await release(request({p_version_code:7}));
  assert.equal(result.status,403);
  await Promise.all(pending.splice(0));
});
test('FCM message and update alerts exclude plaintext and finish the update outbox',async t=>{
  // Prior test populated the short-lived OAuth cache with a disposable fixture.
  env.set('FCM_SERVICE_ACCOUNT_JSON',JSON.stringify({project_id:'fixture-project',private_key:'unused-cached-fixture'}));
  const sent=[]; let batchCalls=0, finished;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(url.endsWith('/rpc/mobile_edge_claim_push')) return response({id:message,type:'room_message',devices:[{token:'device-fixture',user_id:actor}]});
    if(url.endsWith('/rpc/mobile_edge_finish_push')) return response(null);
    if(url.endsWith('/rpc/mobile_edge_release_batch')) {
      batchCalls++; finished=JSON.parse(options.body).p_finish;
      return response(batchCalls===1 ? [{token:'device-fixture',user_id:actor,version_code:7}] : []);
    }
    if(url.includes('fcm.googleapis.com')) {sent.push(JSON.parse(options.body).message); return response({name:'fixture'});}
    throw new Error('Unexpected endpoint');
  });
  const {dispatchPresence,dispatchRelease}=await import('../supabase/functions/_shared/push.ts');
  await dispatchPresence('other-member',room); await dispatchRelease();
  assert.equal(sent[0].data.type,'room_message'); assert.equal(sent[0].notification.body,'A new message arrived in your room.');
  assert.equal(sent[1].data.type,'app_update'); assert.equal(sent[1].data.user_id,actor);
  assert.equal(sent[1].data.apk_url,undefined); assert.equal(sent[0].data.text,undefined);
  assert.deepEqual(finished,[{token:'device-fixture',version_code:7}]);
  env.delete('FCM_SERVICE_ACCOUNT_JSON');
});
