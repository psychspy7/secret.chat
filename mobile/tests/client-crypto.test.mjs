import test from 'node:test';
import assert from 'node:assert/strict';
import { randomAccessCode, normalizeAccessCode, isAccessCode, formatAccessCode, accessCodeHash, roomKey, encryptMessage, decryptMessage, mergeHistory, MAX_HISTORY, toB64, fromB64 } from '../src/crypto.js';
import { serialized } from '../src/storage.js';

const makeIdentity = () => ({ roomId: crypto.randomUUID(), userId: crypto.randomUUID(), id: crypto.randomUUID(), text: 'A private hello 🌿 你好 مرحبا' });
async function fixture() {
  const key = await roomKey(randomAccessCode()), identity = makeIdentity();
  const payload = await encryptMessage(key, identity);
  return { key, identity, envelope: { id: identity.id, room_id: identity.roomId, user_id: identity.userId, payload, created_at: payload.sent_at, display_name: 'Test <member>', is_creator: true } };
}

test('150-bit invitations normalize spaces and preserve all entropy', async () => {
  const codes = new Set(Array.from({ length: 200 }, randomAccessCode));
  assert.equal(codes.size, 200);
  for (const code of codes) {
    assert.equal(code.length, 32);
    assert.ok(isAccessCode(code));
    assert.equal(normalizeAccessCode(formatAccessCode(code).toLowerCase()), code);
    assert.equal(normalizeAccessCode(`https://example.test/#code=${code}`), code);
  }
  assert.equal(isAccessCode('KT' + 'O'.repeat(30)), false);
  assert.equal(isAccessCode('KT' + 'I'.repeat(30)), false);
  await assert.rejects(accessCodeHash('short'));
  const code = [...codes][0];
  assert.match(await accessCodeHash(code), /^[0-9a-f]{64}$/);
  assert.equal(await accessCodeHash(code), await accessCodeHash(code));
});

test('authenticated encryption round trips unicode without exposing plaintext', async () => {
  const { key, envelope, identity } = await fixture();
  const result = await decryptMessage(key, envelope, identity.roomId);
  assert.equal(result.text, identity.text);
  assert.equal(result.user_id, identity.userId);
  assert.equal(result.display_name, 'Test <member>');
  assert.equal(result.is_creator, true);
  assert.equal(JSON.stringify(envelope.payload).includes(identity.text), false);
});

test('ciphertexts use a fresh nonce and cannot decrypt with another invitation', async () => {
  const { key, identity, envelope } = await fixture();
  const second = await encryptMessage(key, identity);
  assert.notEqual(second.iv, envelope.payload.iv);
  assert.notEqual(second.data, envelope.payload.data);
  await assert.rejects(decryptMessage(await roomKey(randomAccessCode()), envelope, identity.roomId));
});

test('message identity, sender, room and client timestamp are authenticated', async () => {
  const { key, envelope, identity } = await fixture();
  for (const change of [
    { id: crypto.randomUUID() },
    { user_id: crypto.randomUUID() },
    { room_id: crypto.randomUUID() },
    { payload: { ...envelope.payload, sent_at: new Date(Date.now() - 1000).toISOString() } },
  ]) await assert.rejects(decryptMessage(key, { ...envelope, ...change }, identity.roomId));
  await assert.rejects(decryptMessage(key, envelope, crypto.randomUUID()));
});

test('invalid timestamps, malformed and modified encrypted payloads are rejected', async () => {
  const { key, envelope, identity } = await fixture();
  const data = envelope.payload.data;
  for (const change of [
    { created_at: 'invalid' },
    { created_at: new Date(Date.now() + 3600000).toISOString() },
    { payload: { ...envelope.payload, v: 9 } },
    { payload: { ...envelope.payload, iv: 'AAAA' } },
    { payload: { ...envelope.payload, data: 'x'.repeat(14001) } },
    { payload: { ...envelope.payload, data: 'not valid!' } },
    { payload: { ...envelope.payload, data: (data[0] === 'A' ? 'B' : 'A') + data.slice(1) } },
  ]) await assert.rejects(decryptMessage(key, { ...envelope, ...change }, identity.roomId));
});

test('message length and identity validation happens before encryption', async () => {
  const { key, identity } = await fixture();
  await assert.rejects(encryptMessage(key, { ...identity, text: '  ' }));
  await assert.rejects(encryptMessage(key, { ...identity, text: 'a'.repeat(2001) }));
  await assert.rejects(encryptMessage(key, { ...identity, userId: 'forged-sender' }));
});

test('bounded history deduplicates race-delivered messages and sorts by time', () => {
  const now = Date.now();
  const messages = Array.from({ length: MAX_HISTORY + 20 }, (_, index) => ({ id: `message-${index}`, text: String(index), created_at: new Date(now + index * 1000).toISOString() }));
  const history = mergeHistory(messages.slice(0, 100), [...messages].reverse());
  assert.equal(history.length, MAX_HISTORY);
  assert.equal(history[0].id, 'message-20');
  assert.equal(history.at(-1).id, 'message-519');
  assert.equal(mergeHistory(history, history.at(-1)).length, MAX_HISTORY);
});

test('storage writes serialize per account/room while different accounts are independent', async () => {
  const events = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const first = serialized('account-a:room-a', async () => { events.push('first-start'); await gate; events.push('first-end'); });
  const second = serialized('account-a:room-a', async () => { events.push('second'); });
  await serialized('account-b:room-a', async () => { events.push('other-account'); });
  assert.deepEqual(events, ['first-start', 'other-account']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first-start', 'other-account', 'first-end', 'second']);
});

test('one failed storage write does not deadlock later operations', async () => {
  await assert.rejects(serialized('test:failed', () => { throw new Error('disk-full'); }));
  assert.equal(await serialized('test:failed', () => 42), 42);
});

test('large local history encoding does not exceed the JavaScript argument limit', () => {
  const bytes = new Uint8Array(1024 * 1024).fill(137);
  assert.deepEqual(fromB64(toB64(bytes)), bytes);
});
