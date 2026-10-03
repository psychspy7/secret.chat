const encoder = new TextEncoder();
const decoder = new TextDecoder();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_HISTORY = 500;
export const validId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function toB64(bytes) {
  const array = new Uint8Array(bytes);
  let binary = '';
  for (let start = 0; start < array.length; start += 32768) binary += String.fromCharCode(...array.subarray(start, start + 32768));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
export function fromB64(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encrypted data.');
  return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4)), c => c.charCodeAt(0));
}
export const isAccessCode = value => /^KT[A-HJ-NP-Z2-9]{30}$/.test(value);
export const randomAccessCode = () => 'KT' + [...crypto.getRandomValues(new Uint8Array(30))].map(byte => alphabet[byte & 31]).join('');
export function normalizeAccessCode(value) {
  let input = String(value || '').trim();
  if (/^https?:\/\//i.test(input) || /^com\.kittycorp\.sidechat:\/\//i.test(input)) {
    try { const url = new URL(input); input = new URLSearchParams(url.hash.slice(1)).get('code') || url.searchParams.get('code') || ''; } catch { input = ''; }
  }
  return input.replace(/[\s-]/g, '').toUpperCase();
}
export const formatAccessCode = code => code.match(/.{1,4}/g)?.join(' ') || '';
export async function accessCodeHash(code) {
  if (!isAccessCode(code)) throw new Error('Enter the complete 32-character room code.');
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode('sidechat-mobile-access-v1:' + code)))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export async function roomKey(code) {
  if (!isAccessCode(code)) throw new Error('This device needs the room invitation to unlock the chat.');
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode('sidechat-mobile-encryption-v1:' + code));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
function aad(roomId, userId, id, sentAt, epoch) { return encoder.encode(JSON.stringify(epoch ? ['secretchat-mobile-v2', roomId, userId, id, sentAt, epoch] : ['sidechat-mobile-v1', roomId, userId, id, sentAt])); }
export async function encryptMessage(key, { roomId, userId, id, text, sentAt = new Date().toISOString(), epoch }) {
  if (!validId(roomId) || !validId(userId) || !validId(id)) throw new Error('Invalid message identity.');
  const body = String(text || '').trim();
  if (!body || body.length > MAX_MESSAGE_LENGTH) throw new Error(`Messages must contain 1–${MAX_MESSAGE_LENGTH} characters.`);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  if (epoch !== undefined && (!Number.isSafeInteger(epoch) || epoch < 1)) throw new Error('Invalid chat epoch.');
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(roomId, userId, id, sentAt, epoch) }, key, encoder.encode(JSON.stringify({ text: body })));
  return { v: epoch ? 2 : 1, ...(epoch ? { epoch } : {}), iv: toB64(iv), data: toB64(data), sent_at: sentAt };
}
export async function decryptMessage(key, envelope, expectedRoomId) {
  const { id, room_id: roomId, user_id: userId, payload, created_at: createdAt } = envelope || {};
  if (!validId(id) || !validId(roomId) || !validId(userId) || roomId !== expectedRoomId || ![1, 2].includes(payload?.v) || typeof payload.data !== 'string' || payload.data.length > 14000) throw new Error('Invalid message envelope.');
  if (payload.v === 2 && (!Number.isSafeInteger(payload.epoch) || payload.epoch < 1)) throw new Error('Invalid chat epoch.');
  const sent = Date.parse(payload.sent_at), created = Date.parse(createdAt);
  if (!Number.isFinite(sent) || !Number.isFinite(created) || Math.abs(sent - created) > 300000 || created > Date.now() + 300000) throw new Error('Message timestamp could not be verified.');
  const iv = fromB64(payload.iv);
  if (iv.length !== 12) throw new Error('Invalid message nonce.');
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad(roomId, userId, id, payload.sent_at, payload.v === 2 ? payload.epoch : undefined) }, key, fromB64(payload.data));
  const body = JSON.parse(decoder.decode(plaintext));
  if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > MAX_MESSAGE_LENGTH) throw new Error('Invalid message content.');
  return { id, room_id: roomId, user_id: userId, text: body.text, created_at: createdAt, display_name: String(envelope.display_name || 'Member').slice(0, 48), is_creator: envelope.is_creator === true };
}
export function mergeHistory(history, incoming) {
  const merged = new Map(history.map(item => [item.id, item]));
  for (const item of Array.isArray(incoming) ? incoming : [incoming]) merged.set(item.id, item);
  return [...merged.values()].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.id.localeCompare(b.id)).slice(-MAX_HISTORY);
}
