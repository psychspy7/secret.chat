import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { normalizePreferences, normalizeRoomTools, selectRooms, searchHistory, createDraftStore } from '../src/organizer.js';

const id = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const defer = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
function memoryDriver() {
  const records = new Map(), writes = [];
  const key = (account, record) => JSON.stringify([account, record]);
  return {
    records, writes, key,
    read: async (account, record, fallback) => records.get(key(account, record)) ?? fallback,
    write: async (account, record, text) => { writes.push([account, record, text]); records.set(key(account, record), text); },
  };
}

test('experience preferences keep explicit opt-outs and reject malformed stored values', () => {
  assert.deepEqual(normalizePreferences(), { theme: 'dark', motion: true, haptics: true });
  assert.deepEqual(normalizePreferences({ theme: 'system', motion: false, haptics: false }), { theme: 'system', motion: false, haptics: false });
  assert.deepEqual(normalizePreferences({ theme: 'light', motion: 'false', haptics: 0, invitation: 'private' }), { theme: 'light', motion: true, haptics: true });
  assert.deepEqual(normalizePreferences(Object.create({ theme: 'light', motion: false })), { theme: 'dark', motion: true, haptics: true });
  assert.deepEqual(normalizePreferences(['light', false]), { theme: 'dark', motion: true, haptics: true });
});

test('room tools sanitize duplicate IDs, malformed counts and prototype properties', () => {
  const unread = JSON.parse(`{"${id(1)}":4.9,"${id(2)}":120,"${id(3)}":-5,"${id(4)}":"7","__proto__":{"polluted":true},"constructor":99}`);
  unread[id(5)] = Infinity;
  Object.setPrototypeOf(unread, { [id(6)]: 8 });
  const tools = normalizeRoomTools({ pinned: [id(1), ` ${id(1)} `, id(2).toUpperCase(), '__proto__', '', null], unread });
  assert.deepEqual(tools.pinned, [id(1), id(2)]);
  assert.deepEqual(tools.unread, { [id(1)]: 4, [id(2)]: 99, [id(3)]: 0 });
  assert.equal(Object.prototype.polluted, undefined);
  assert.deepEqual(normalizeRoomTools(null), { pinned: [], unread: {} });
});

test('room tools bound total room metadata and pins without altering the source', () => {
  const source = { pinned: Array.from({ length: 30 }, (_, i) => id(i + 1)), unread: Object.fromEntries(Array.from({ length: 220 }, (_, i) => [id(i + 20), 1])) };
  const before = structuredClone(source), tools = normalizeRoomTools(source);
  assert.equal(tools.pinned.length, 12);
  assert.equal(new Set([...tools.pinned, ...Object.keys(tools.unread)]).size, 200);
  assert.deepEqual(source, before);
});

test('room selection searches only labels and preserves stable pin and room order', () => {
  const rooms = Object.freeze([
    Object.freeze({ id: id(1), label: 'Alpha', code: 'KTSECRET', member_name: 'Hidden Alice' }),
    Object.freeze({ id: id(2), label: 'Beta planning' }),
    Object.freeze({ id: id(3), label: 'Alpha archive', closed_at: '2026-10-12T00:00:00Z' }),
    Object.freeze({ id: id(4), label: 'Alpha friends' }),
  ]);
  const pinned = Object.freeze([id(4), id(3)]), unread = Object.freeze({ [id(2)]: 1, [id(4)]: 2 });
  assert.deepEqual(selectRooms(rooms, { pinned }).map(room => room.id), [id(3), id(4), id(1), id(2)]);
  assert.deepEqual(selectRooms(rooms, { query: ' ALPHA ', pinned }).map(room => room.id), [id(3), id(4), id(1)]);
  assert.deepEqual(selectRooms(rooms, { query: 'ktsecret' }), []);
  assert.deepEqual(selectRooms(rooms, { query: 'alice' }), []);
  assert.deepEqual(selectRooms(rooms, { filter: 'unread', pinned, unread }).map(room => room.id), [id(4), id(2)]);
  assert.deepEqual(selectRooms(rooms, { filter: 'pinned', pinned }).map(room => room.id), [id(3), id(4)]);
  assert.deepEqual(selectRooms(rooms, { filter: 'closed' }).map(room => room.id), [id(3)]);
  assert.deepEqual(selectRooms(rooms, { filter: 'invalid' }).map(room => room.id), rooms.map(room => room.id));
  assert.equal(selectRooms(rooms)[0], rooms[0]);
});

test('room selection handles absent and malformed local collections', () => {
  assert.deepEqual(selectRooms(null), []);
  assert.deepEqual(selectRooms([null, false, { id: id(1), label: null }], { query: 'hello' }), []);
  assert.deepEqual(selectRooms([{ id: id(1), label: 'Room' }], { filter: 'unread', unread: Object.create({ [id(1)]: 10 }) }), []);
});

test('history search finds sender or text, trims queries and stays inside the latest 500', () => {
  const messages = Object.freeze([
    Object.freeze({ id: 'one', display_name: 'Alice', text: 'The launch is tomorrow', code: 'INVITE-SECRET' }),
    Object.freeze({ id: 'two', sender: 'Bob', text: 'Planning lunch' }),
    Object.freeze({ id: 'three', display_name: 'Carol', text: 'ALICE approved' }),
  ]);
  assert.deepEqual(searchHistory(messages, ' ALIce ').map(message => message.id), ['one', 'three']);
  assert.deepEqual(searchHistory(messages, ' bob ').map(message => message.id), ['two']);
  assert.deepEqual(searchHistory(messages, 'lunch').map(message => message.id), ['two']);
  assert.deepEqual(searchHistory(messages, 'invite-secret'), []);
  const all = searchHistory(messages, ' ');
  assert.deepEqual(all, messages);
  assert.notEqual(all, messages);
  const history = [{ text: 'outdated hit' }, ...Array.from({ length: 500 }, (_, i) => ({ text: `current ${i}` }))];
  assert.equal(searchHistory(history, '').length, 500);
  assert.deepEqual(searchHistory(history, 'outdated'), []);
  assert.deepEqual(searchHistory(null, 'hello'), []);
});

test('draft load uses the encrypted-driver contract, caps text and coalesces repeated reads', async () => {
  const gate = defer(), reads = [];
  const store = createDraftStore({ read: (...args) => { reads.push(args); return gate.promise; }, write: async () => {}, maxLength: 5 });
  const first = store.load('account', 'room'), second = store.load('account', 'room');
  await tick();
  assert.deepEqual(reads, [['account', 'draft:room', '']]);
  gate.resolve('  hello world  ');
  assert.deepEqual(await Promise.all([first, second]), ['  hel', '  hel']);
  assert.equal(await store.load('account', 'room'), '  hel');
  assert.equal(reads.length, 1);
  await store.dispose();
});

test('typing bursts debounce to the latest capped text and explicit flush cancels the timer', async () => {
  const driver = memoryDriver(), store = createDraftStore({ ...driver, maxLength: 5, delayMs: 40 });
  store.set('a', 'r', 'one');
  store.set('a', 'r', 'two');
  store.set('a', 'r', 'latest text');
  assert.deepEqual(driver.writes, []);
  assert.equal(await store.load('a', 'r'), 'lates');
  await store.flush('a', 'r');
  assert.deepEqual(driver.writes, [['a', 'draft:r', 'lates']]);
  await pause(65);
  assert.equal(driver.writes.length, 1);
  await store.dispose();
});

test('an idle draft is saved by the debounce timer', async () => {
  const saved = defer();
  const store = createDraftStore({ read: async () => '', write: async (...args) => saved.resolve(args), delayMs: 5 });
  store.set('a', 'r', 'keep this');
  assert.deepEqual(await saved.promise, ['a', 'draft:r', 'keep this']);
  await store.dispose();
});

test('account and room scopes stay isolated, including delimiter collisions', async () => {
  const driver = memoryDriver(), store = createDraftStore({ ...driver, delayMs: 10000 });
  store.set('a:b', 'c', 'first account');
  store.set('a', 'b:c', 'second account');
  store.set('a', 'other', 'another room');
  await store.flush('a', 'b:c');
  assert.deepEqual(driver.writes, [['a', 'draft:b:c', 'second account']]);
  assert.equal(await store.load('a:b', 'c'), 'first account');
  await store.flush('a');
  assert.equal(driver.writes.length, 2);
  await store.dispose();
  assert.equal(driver.records.size, 3);
});

test('an older load cannot overwrite typing or a cleared draft', async () => {
  const first = defer(), second = defer();
  const driver = memoryDriver(), store = createDraftStore({ ...driver, read: (_, record) => record === 'draft:typed' ? first.promise : second.promise, delayMs: 10000 });
  const typed = store.load('a', 'typed'), cleared = store.load('a', 'cleared');
  await tick();
  store.set('a', 'typed', 'new text');
  await store.clear('a', 'cleared');
  first.resolve('stale typed text');
  second.resolve('stale cleared text');
  assert.equal(await typed, 'new text');
  assert.equal(await cleared, '');
  await store.dispose();
  assert.equal(driver.records.get(driver.key('a', 'draft:cleared')), '');
});

test('typing during an in-flight save serializes one latest follow-up write', async () => {
  const gate = defer(), writes = [];
  const store = createDraftStore({ read: async () => '', write: async (_, __, text) => { writes.push(text); if (writes.length === 1) await gate.promise; }, delayMs: 10000 });
  store.set('a', 'r', 'first');
  const pending = store.flush('a', 'r');
  await tick();
  store.set('a', 'r', 'second');
  store.set('a', 'r', 'latest');
  const joined = store.flush('a', 'r');
  assert.deepEqual(writes, ['first']);
  gate.resolve();
  await Promise.all([pending, joined]);
  assert.deepEqual(writes, ['first', 'latest']);
  await store.dispose();
});

test('clearing an in-flight save writes the empty draft last and cancels pending typing', async () => {
  const gate = defer(), writes = []; let persisted = 'previous';
  const store = createDraftStore({ read: async () => persisted, write: async (_, __, text) => { writes.push(text); if (writes.length === 1) await gate.promise; persisted = text; }, delayMs: 10000 });
  store.set('a', 'r', 'old draft');
  const pending = store.flush('a', 'r');
  await tick();
  store.set('a', 'r', 'queued draft');
  const cleared = store.clear('a', 'r');
  assert.equal(await store.load('a', 'r'), '');
  assert.deepEqual(writes, ['old draft']);
  gate.resolve();
  await Promise.all([pending, cleared]);
  assert.deepEqual(writes, ['old draft', '']);
  assert.equal(persisted, '');
  await store.dispose();
});

test('clear supersedes an older failed save and persists the empty draft', async () => {
  const gate = defer(), writes = [], errors = [];
  const store = createDraftStore({ read: async () => '', write: async (_, __, text) => { writes.push(text); if (writes.length === 1) await gate.promise; }, delayMs: 10000, onError: error => errors.push(error.message) });
  store.set('a', 'r', 'old draft');
  const pending = store.flush('a', 'r');
  await tick();
  const cleared = store.clear('a', 'r');
  gate.reject(Error('old save failed'));
  await Promise.all([pending, cleared]);
  assert.deepEqual(writes, ['old draft', '']);
  assert.deepEqual(errors, ['old save failed']);
  await store.dispose();
});

test('a failed latest save remains available and retries only the newest draft', async () => {
  const writes = [], errors = []; let fail = true;
  const store = createDraftStore({ read: async () => '', write: async (_, __, text) => { writes.push(text); if (fail) throw Error('storage unavailable'); }, delayMs: 10000, onError: error => errors.push(error.message) });
  store.set('a', 'r', 'unsaved');
  await assert.rejects(store.flush('a', 'r'), /storage unavailable/);
  assert.equal(await store.load('a', 'r'), 'unsaved');
  store.set('a', 'r', 'latest retry');
  fail = false;
  await store.flush('a', 'r');
  assert.deepEqual(writes, ['unsaved', 'latest retry']);
  assert.deepEqual(errors, ['storage unavailable']);
  await store.dispose();
});

test('timer failures are reported without losing the draft or creating an unhandled rejection', async () => {
  const failed = defer(), writes = []; let fail = true;
  const store = createDraftStore({ read: async () => '', write: async (_, __, text) => { writes.push(text); if (fail) throw Error('locked'); }, delayMs: 5, onError: error => failed.resolve(error.message) });
  store.set('a', 'r', 'recover me');
  assert.equal(await failed.promise, 'locked');
  await tick();
  assert.equal(await store.load('a', 'r'), 'recover me');
  fail = false;
  await store.flush();
  assert.deepEqual(writes, ['recover me', 'recover me']);
  await store.dispose();
});

test('a failed clear remains an empty retryable draft', async () => {
  const driver = memoryDriver(); let fail = true;
  driver.records.set(driver.key('a', 'draft:r'), 'old stored draft');
  const store = createDraftStore({ ...driver, write: async (...args) => { if (fail) throw Error('clear failed'); await driver.write(...args); } });
  await assert.rejects(store.clear('a', 'r'), /clear failed/);
  assert.equal(await store.load('a', 'r'), '');
  fail = false;
  await store.flush();
  assert.equal(driver.records.get(driver.key('a', 'draft:r')), '');
  await store.dispose();
});

test('flush waits for every selected room even when one storage write fails', async () => {
  const gate = defer(), started = []; let settled = false;
  const store = createDraftStore({ read: async () => '', write: async (_, record) => { started.push(record); if (record === 'draft:bad') throw Error('failed'); await gate.promise; }, delayMs: 10000 });
  store.set('a', 'bad', 'bad');
  store.set('a', 'slow', 'slow');
  const flushing = store.flush().then(() => { settled = true; }, error => { settled = true; throw error; });
  await tick();
  assert.deepEqual(started, ['draft:bad', 'draft:slow']);
  assert.equal(settled, false);
  gate.resolve();
  await assert.rejects(flushing, /failed/);
  await assert.rejects(store.dispose(), /failed/);
});

test('dispose flushes drafts, cancels timers and prevents future mutation', async () => {
  const driver = memoryDriver(), store = createDraftStore({ ...driver, delayMs: 40 });
  store.set('a', 'r', 'save on exit');
  await store.dispose();
  assert.deepEqual(driver.writes, [['a', 'draft:r', 'save on exit']]);
  assert.throws(() => store.set('a', 'r', 'after exit'), /disposed/i);
  await assert.rejects(store.load('a', 'r'), /disposed/i);
  await assert.rejects(store.clear('a', 'r'), /disposed/i);
  await store.dispose();
  await pause(65);
  assert.equal(driver.writes.length, 1);
});

test('a failed dispose retains the latest draft for a later flush retry', async () => {
  const driver = memoryDriver(); let fail = true;
  const store = createDraftStore({ ...driver, write: async (...args) => { if (fail) throw Error('retry exit'); await driver.write(...args); }, delayMs: 10000 });
  store.set('a', 'r', 'must survive');
  await assert.rejects(store.dispose(), /retry exit/);
  fail = false;
  await store.flush();
  await store.dispose();
  assert.deepEqual(driver.writes, [['a', 'draft:r', 'must survive']]);
});

test('read failures are observable and a later load can retry', async () => {
  const errors = []; let fail = true;
  const store = createDraftStore({ read: async () => { if (fail) throw Error('read unavailable'); return 'recovered'; }, write: async () => {}, onError: error => { errors.push(error.message); throw Error('observer failed'); } });
  await assert.rejects(store.load('a', 'r'), /read unavailable/);
  fail = false;
  assert.equal(await store.load('a', 'r'), 'recovered');
  assert.deepEqual(errors, ['read unavailable']);
  await store.dispose();
});

test('clear cancels a draft still waiting on its debounce timer', async () => {
  const driver = memoryDriver(), store = createDraftStore({ ...driver, delayMs: 20 });
  store.set('a', 'r', 'queued typing');
  await store.clear('a', 'r');
  await pause(40);
  assert.deepEqual(driver.writes, [['a', 'draft:r', '']]);
  assert.equal(await store.load('a', 'r'), '');
  await store.dispose();
});

test('UUID casing and surrounding whitespace normalize to a single safe metadata key', () => {
  const lower = 'abcdef01-abcd-4abc-8def-0123456789ab', upper = lower.toUpperCase();
  const tools = normalizeRoomTools({ pinned: [` ${upper} `, lower], unread: { [` ${upper} `]: 3 } });
  assert.deepEqual(tools, { pinned: [lower], unread: { [lower]: 3 } });
  assert.deepEqual(selectRooms([{ id: lower, label: 'Room' }], { ...tools, filter: 'unread' }).map(room => room.id), [lower]);
});

test('successful room release flushes pending text and reloads encrypted storage next visit', async () => {
  let saved = '', reads = 0;
  const store = createDraftStore({ read: async () => { reads++; return saved; }, write: async (_a,_k,text) => { saved = text; }, delayMs: 60000 });
  store.set('account','room','keep this'); await store.release('account','room');
  assert.equal(saved,'keep this'); assert.equal(await store.load('account','room'),'keep this'); assert.equal(reads,1); await store.dispose();
});
test('failed cache release preserves the newest draft for retry', async () => {
  let fail=true, saved='';
  const store=createDraftStore({read:async()=>saved,write:async(_a,_k,text)=>{if(fail)throw Error('full');saved=text;},delayMs:60000});
  store.set('account','room','retry me');await assert.rejects(store.release('account'),/full/);
  assert.equal(await store.load('account','room'),'retry me');fail=false;await store.release('account');assert.equal(saved,'retry me');await store.dispose();
});


test('a delivery capture consumes an unchanged draft after encrypted release', async () => {
  const driver = memoryDriver(), store = createDraftStore({ ...driver, delayMs: 60000 });
  store.set('a', 'r', 'sent draft');
  const capture = store.capture('a', 'r');
  await store.release('a', 'r');
  assert.equal(driver.records.get(driver.key('a', 'draft:r')), 'sent draft');
  assert.equal(await store.consume(capture), true);
  store.releaseCapture(capture);
  assert.equal(await store.load('a', 'r'), '');
  await store.dispose();
});

test('delivery captures preserve newer revisions including returning to identical text', async () => {
  const driver = memoryDriver(), store = createDraftStore({ ...driver, delayMs: 60000 });
  store.set('a', 'r', 'sent draft'); const capture = store.capture('a', 'r');
  await store.release('a', 'r'); await store.load('a', 'r');
  store.set('a', 'r', 'new draft'); store.set('a', 'r', 'sent draft');
  assert.equal(await store.consume(capture), false);
  store.releaseCapture(capture);
  assert.equal(await store.load('a', 'r'), 'sent draft');
  await store.dispose();
});

test('consuming a delivery during blocked release serializes the empty write last', async () => {
  const driver = memoryDriver(), gate = defer();
  const store = createDraftStore({ ...driver, write: async (...args) => { if (args[2]) await gate.promise; await driver.write(...args); }, delayMs: 60000 });
  store.set('a', 'r', 'sent draft'); const capture = store.capture('a', 'r');
  const release = store.release('a', 'r'); await tick();
  const consume = store.consume(capture); gate.resolve();
  assert.equal(await consume, true); await release; store.releaseCapture(capture);
  assert.deepEqual(driver.writes, [['a', 'draft:r', 'sent draft'], ['a', 'draft:r', '']]);
  await store.dispose();
});

test('a failed conditional clear retains an empty retry without touching other scopes', async () => {
  const driver = memoryDriver(); let fail = false;
  const store = createDraftStore({ ...driver, write: async (...args) => { if (fail && args[2] === '') throw Error('consume unavailable'); await driver.write(...args); }, delayMs: 60000 });
  store.set('a', 'r', 'sent draft'); store.set('a', 'other', 'other room'); store.set('b', 'r', 'other account');
  const capture = store.capture('a', 'r'); await store.release('a', 'r'); fail = true;
  await assert.rejects(store.consume(capture), /consume unavailable/); store.releaseCapture(capture);
  assert.equal(await store.load('a', 'r'), '');
  assert.equal(await store.load('a', 'other'), 'other room'); assert.equal(await store.load('b', 'r'), 'other account');
  fail = false; await store.flush(); await store.dispose();
  assert.equal(driver.records.get(driver.key('a', 'draft:r')), '');
});

test('finishing an unsuccessful send releases its capture and reloads persisted text on next visit', async () => {
  let reads = 0, saved = '';
  const store = createDraftStore({ read: async () => { reads++; return saved; }, write: async (_a, _r, text) => { saved = text; }, delayMs: 60000 });
  store.set('a', 'r', 'keep failed send'); const capture = store.capture('a', 'r');
  await store.release('a', 'r'); store.releaseCapture(capture);
  assert.equal(await store.load('a', 'r'), 'keep failed send'); assert.equal(reads, 1);
  assert.equal(await store.consume(capture), false);
  await store.dispose();
});


test('typing during conditional clear keeps the newest revision and prevents visible composer consumption', async t => {
  const gate = defer(), driver = memoryDriver();
  const store = createDraftStore({ ...driver, write: async (...args) => { if (args[2] === '') await gate.promise; await driver.write(...args); }, delayMs: 60000 });
  t.after(() => store.dispose());
  store.set('a', 'r', 'sent draft'); const capture = store.capture('a', 'r');
  const pending = store.consume(capture); await tick();
  store.set('a', 'r', 'sent draft'); gate.resolve();
  assert.equal(await pending, false); store.releaseCapture(capture);
  assert.equal(await store.load('a', 'r'), 'sent draft');
});
