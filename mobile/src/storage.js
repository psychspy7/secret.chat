import { Capacitor, registerPlugin } from '@capacitor/core';
import { fromB64, toB64, mergeHistory } from './crypto.js';

export const Device = registerPlugin('SideChatDevice');
export const native = Capacitor.isNativePlatform();
const locks = new Map();
let databasePromise;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function transact(db, mode, work) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('vault', mode), store = tx.objectStore('vault');
    let result;
    const request = work(store);
    request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('Local storage is unavailable.'));
    tx.onabort = () => reject(tx.error || new Error('Local storage was interrupted.'));
  });
}
async function browserDatabase() {
  if (!databasePromise) databasePromise = (async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('sidechat-mobile-preview', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('vault');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    let key = await transact(db, 'readonly', store => store.get('__key'));
    if (!key) {
      key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await transact(db, 'readwrite', store => store.put(key, '__key'));
    }
    return { db, key };
  })();
  return databasePromise;
}
async function readRaw(key) {
  if (native) return (await Device.secureGet({ key })).value ?? null;
  const vault = await browserDatabase(), record = await transact(vault.db, 'readonly', store => store.get(key));
  if (!record) return null;
  const data = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(record.iv), additionalData: encoder.encode(key) }, vault.key, fromB64(record.data));
  return decoder.decode(data);
}
async function writeRaw(key, value) {
  if (native) return Device.secureSet({ key, value });
  const vault = await browserDatabase(), iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(key) }, vault.key, encoder.encode(value));
  await transact(vault.db, 'readwrite', store => store.put({ iv: toB64(iv), data: toB64(data) }, key));
}
export function serialized(key, operation) {
  const previous = locks.get(key) || Promise.resolve();
  const task = previous.catch(() => {}).then(operation);
  locks.set(key, task);
  task.finally(() => { if (locks.get(key) === task) locks.delete(key); }).catch(() => {});
  return task;
}
export const secureStorage = {
  getItem: key => serialized(key, () => readRaw(key)),
  setItem: (key, value) => serialized(key, () => writeRaw(key, value)),
  removeItem: key => serialized(key, async () => {
    if (native) return Device.secureRemove({ key });
    const { db } = await browserDatabase();
    return transact(db, 'readwrite', store => store.delete(key));
  }),
};
const accountKey = (userId, record) => `sidechat:${userId}:${record}`;
async function readJson(key, fallback) {
  const value = await readRaw(key);
  if (value === null) return fallback;
  return JSON.parse(value);
}
export const localData = {
  read: (userId, record, fallback) => serialized(accountKey(userId, record), () => readJson(accountKey(userId, record), fallback)),
  write: (userId, record, value) => serialized(accountKey(userId, record), () => writeRaw(accountKey(userId, record), JSON.stringify(value))),
  update: (userId, record, fallback, modify) => serialized(accountKey(userId, record), async () => {
    const value = modify(await readJson(accountKey(userId, record), fallback));
    await writeRaw(accountKey(userId, record), JSON.stringify(value));
    return value;
  }),
  saveMessages: (userId, roomId, messages) => localData.update(userId, `history:${roomId}`, [], old => mergeHistory(old, messages)),
  clearHistory: (userId, roomId) => secureStorage.removeItem(accountKey(userId, `history:${roomId}`)),
};
