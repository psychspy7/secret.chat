import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { fromB64, toB64, mergeHistory } from '../src/crypto.js';

const source = readFileSync(new URL('../src/storage.js', import.meta.url), 'utf8');
const databaseName = 'sidechat-mobile-preview';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const defer = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const plain = value => JSON.parse(JSON.stringify(value));

// Evaluate the complete storage implementation with only its imports/exports wired
// into each VM. Its caches and queues are separate; IndexedDB and WebCrypto are real.
function browserContext(indexedDB, { crypto = webcrypto, locks, native = false, device = {} } = {}) {
  const context = vm.createContext({
    indexedDB, crypto, TextEncoder, TextDecoder, fromB64, toB64, mergeHistory,
    Capacitor: { isNativePlatform: () => native }, registerPlugin: () => device,
    ...(locks ? { navigator: { locks } } : {}),
  });
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '') +
    '\nglobalThis.storage = { secureStorage, localData, serialized, native, Device };', context,
    { filename: 'storage.js' });
  return context.storage;
}

function controlledCrypto({ generateKey, encrypt } = {}) {
  return {
    getRandomValues: value => webcrypto.getRandomValues(value),
    subtle: {
      generateKey: (...args) => generateKey ? generateKey(...args) : webcrypto.subtle.generateKey(...args),
      encrypt: (...args) => encrypt ? encrypt(...args) : webcrypto.subtle.encrypt(...args),
      decrypt: (...args) => webcrypto.subtle.decrypt(...args),
    },
  };
}

async function vaultRequest(indexedDB, mode, work) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('vault');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('vault', mode);
      const request = work(tx.objectStore('vault'));
      let result;
      request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}
const rawRead = (indexedDB, name) => vaultRequest(indexedDB, 'readonly', store => store.get(name));
const rawWrite = (indexedDB, name, value) => vaultRequest(indexedDB, 'readwrite', store => store.put(value, name));
const makeKey = () => webcrypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
async function legacyRecord(key, name, value) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const data = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(name) }, key, encoder.encode(value));
  return { iv: toB64(iv), data: toB64(data) };
}
async function decryptRecord(key, name, record) {
  return decoder.decode(await webcrypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(record.iv), additionalData: encoder.encode(name) }, key, fromB64(record.data)));
}

// A shared same-origin LockManager test double with the browser's exclusive FIFO
// contract. Only the lock API is simulated; record transactions and crypto are not.
class SharedLockManager {
  pending = new Map();
  requests = [];
  queued = defer();
  request(name, callback) {
    const previous = this.pending.get(name) || Promise.resolve();
    const blocked = this.pending.has(name);
    this.requests.push({ name, blocked });
    if (blocked) this.queued.resolve(name);
    const task = previous.catch(() => {}).then(() => callback({ name, mode: 'exclusive' }));
    this.pending.set(name, task);
    task.finally(() => { if (this.pending.get(name) === task) this.pending.delete(name); }).catch(() => {});
    return task;
  }
}

function pausedEncryption() {
  const entered = defer(), release = defer();
  let first = true;
  const crypto = controlledCrypto({ encrypt: async (...args) => {
    if (first) { first = false; entered.resolve(); await release.promise; }
    return webcrypto.subtle.encrypt(...args);
  } });
  return { crypto, entered, release };
}

test('concurrent first-use tabs and a reload decrypt records written by either tab', { timeout: 5000 }, async () => {
  const indexedDB = new IDBFactory();
  const candidatesReady = defer();
  let generated = 0;
  const crypto = controlledCrypto({ generateKey: async (...args) => {
    const candidate = await webcrypto.subtle.generateKey(...args);
    if (++generated === 2) candidatesReady.resolve();
    await candidatesReady.promise;
    return candidate;
  } });
  const first = browserContext(indexedDB, { crypto }), second = browserContext(indexedDB, { crypto });
  await Promise.all([
    first.secureStorage.setItem('tab-a-session', 'first private value'),
    second.secureStorage.setItem('tab-b-session', 'second private value'),
  ]);
  assert.equal(generated, 2, 'both independent contexts reached first-use key generation');
  const reload = browserContext(indexedDB);
  for (const tab of [first, second, reload]) {
    assert.equal(await tab.secureStorage.getItem('tab-a-session'), 'first private value');
    assert.equal(await tab.secureStorage.getItem('tab-b-session'), 'second private value');
  }
  const storedKey = await rawRead(indexedDB, '__key');
  assert.equal(storedKey.extractable, false);
  await assert.rejects(webcrypto.subtle.exportKey('raw', storedKey));
  assert.deepEqual(await indexedDB.databases(), [{ name: databaseName, version: 1 }]);
});

test('existing vault key, legacy ciphertext and account-bound AAD remain compatible', { timeout: 5000 }, async () => {
  const indexedDB = new IDBFactory(), originalKey = await makeKey();
  const account = 'existing-account', name = `sidechat:${account}:rooms`;
  const rooms = { oldRoom: { code: 'retained invitation', last_opened: 123 } };
  const originalRecord = await legacyRecord(originalKey, name, JSON.stringify(rooms));
  await rawWrite(indexedDB, '__key', originalKey);
  await rawWrite(indexedDB, name, originalRecord);
  await rawWrite(indexedDB, 'legacy-auth-session', await legacyRecord(originalKey, 'legacy-auth-session', 'retained auth session'));
  const first = browserContext(indexedDB), second = browserContext(indexedDB);
  assert.deepEqual(plain(await first.localData.read(account, 'rooms', {})), rooms);
  assert.equal(await second.secureStorage.getItem('legacy-auth-session'), 'retained auth session');
  await first.localData.write(account, 'preferences', { theme: 'light' });
  const newName = `sidechat:${account}:preferences`;
  assert.equal(await decryptRecord(originalKey, newName, await rawRead(indexedDB, newName)), '{"theme":"light"}');
  const storedKey = await rawRead(indexedDB, '__key');
  assert.equal(await decryptRecord(storedKey, name, originalRecord), JSON.stringify(rooms));
  assert.equal(storedKey.extractable, false);
  assert.deepEqual(await rawRead(indexedDB, name), originalRecord);
  assert.deepEqual(plain(await second.localData.read('other-account', 'rooms', {})), {});
  await rawWrite(indexedDB, 'sidechat:other-account:rooms', originalRecord);
  await assert.rejects(second.localData.read('other-account', 'rooms', {}));
  const reload = browserContext(indexedDB);
  assert.deepEqual(plain(await reload.localData.read(account, 'preferences', {})), { theme: 'light' });
});

test('shared browser locks prevent cross-tab lost updates and keep accounts independent', { timeout: 5000 }, async () => {
  const indexedDB = new IDBFactory(), key = await makeKey(), locks = new SharedLockManager();
  await rawWrite(indexedDB, '__key', key);
  await rawWrite(indexedDB, 'sidechat:account-a:preferences', await legacyRecord(key, 'sidechat:account-a:preferences', '{"alpha":0,"beta":0}'));
  const paused = pausedEncryption();
  const first = browserContext(indexedDB, { crypto: paused.crypto, locks });
  const second = browserContext(indexedDB, { locks });
  const updateA = first.localData.update('account-a', 'preferences', {}, old => ({ ...old, alpha: old.alpha + 1 }));
  await paused.entered.promise;
  const updateB = second.localData.update('account-a', 'preferences', {}, old => ({ ...old, beta: old.beta + 1 }));
  // Old code completes B while A is paused, overwriting B when A resumes. With
  // Web Locks, B queues instead. Either schedule is released without a timer.
  await Promise.race([updateB, locks.queued.promise]);
  await second.localData.write('account-b', 'preferences', { independent: true });
  paused.release.resolve();
  await Promise.all([updateA, updateB]);
  const reload = browserContext(indexedDB, { locks });
  assert.deepEqual(plain(await reload.localData.read('account-a', 'preferences', {})), { alpha: 1, beta: 1 });
  assert.deepEqual(plain(await reload.localData.read('account-b', 'preferences', {})), { independent: true });
  assert.ok(locks.requests.some(request => request.blocked), 'the second context waited on the shared record lock');
});

test('cross-tab history removal waits for an in-flight update instead of resurrecting history', { timeout: 5000 }, async () => {
  const indexedDB = new IDBFactory(), key = await makeKey(), locks = new SharedLockManager();
  await rawWrite(indexedDB, '__key', key);
  const paused = pausedEncryption();
  const first = browserContext(indexedDB, { crypto: paused.crypto, locks });
  const second = browserContext(indexedDB, { locks });
  const update = first.localData.update('account-a', 'history:room-a', [], old => [...old, { id: 'retained message' }]);
  await paused.entered.promise;
  const remove = second.localData.clearHistory('account-a', 'room-a');
  await Promise.race([remove, locks.queued.promise]);
  paused.release.resolve();
  await Promise.all([update, remove]);
  assert.equal(await browserContext(indexedDB).secureStorage.getItem('sidechat:account-a:history:room-a'), null);
});

test('browser queues recover after failure with and without a navigator', { timeout: 5000 }, async () => {
  for (const locks of [undefined, new SharedLockManager()]) {
    const tab = browserContext(new IDBFactory(), { locks });
    await tab.localData.write('account-a', 'preferences', { count: 0 });
    const failed = tab.localData.update('account-a', 'preferences', {}, () => { throw Error('update failed'); });
    const next = tab.localData.update('account-a', 'preferences', {}, old => ({ count: old.count + 1 }));
    await assert.rejects(failed, /update failed/);
    assert.deepEqual(plain(await next), { count: 1 });
    assert.deepEqual(plain(await tab.localData.read('account-a', 'preferences', {})), { count: 1 });
    await tab.secureStorage.removeItem('sidechat:account-a:preferences');
    assert.equal(await tab.secureStorage.getItem('sidechat:account-a:preferences'), null);
  }
});

test('native storage still uses Device methods and bypasses browser locks and crypto', async () => {
  const values = new Map(), calls = [];
  const device = {
    secureGet: async ({ key }) => { calls.push(['get', key]); return { value: values.get(key) }; },
    secureSet: async ({ key, value }) => { calls.push(['set', key]); values.set(key, value); },
    secureRemove: async ({ key }) => { calls.push(['remove', key]); values.delete(key); },
  };
  const forbidden = () => { throw Error('browser API used on native'); };
  const tab = browserContext({ open: forbidden }, { native: true, device, locks: { request: forbidden }, crypto: { getRandomValues: forbidden, subtle: { generateKey: forbidden } } });
  assert.equal(tab.native, true);
  assert.equal(tab.Device, device);
  await tab.secureStorage.setItem('native-session', 'native value');
  assert.equal(await tab.secureStorage.getItem('native-session'), 'native value');
  await tab.localData.write('native-account', 'preferences', { count: 1 });
  assert.deepEqual(plain(await tab.localData.update('native-account', 'preferences', {}, old => ({ count: old.count + 1 }))), { count: 2 });
  await tab.secureStorage.removeItem('native-session');
  assert.equal(await tab.secureStorage.getItem('native-session'), null);
  assert.ok(calls.some(([method, name]) => method === 'set' && name === 'sidechat:native-account:preferences'));
});
