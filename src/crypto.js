const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const toB64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
export const fromB64 = value => Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/') + '==='.slice((value.length+3)%4)), c=>c.charCodeAt(0));
export const randomKey = () => toB64(crypto.getRandomValues(new Uint8Array(32)));
const ACCESS_ALPHABET='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const isAccessCode = value => /^KT[A-HJ-NP-Z2-9]{30}$/.test(value);
export const randomAccessCode = () => 'KT'+[...crypto.getRandomValues(new Uint8Array(30))].map(byte=>ACCESS_ALPHABET[byte&31]).join('');
export async function roomKeyFromAccessCode(code) {
  if(!isAccessCode(code))throw new Error('Invalid room access code.');
  return toB64(await crypto.subtle.digest('SHA-256',encoder.encode('kitty-room-access-v1:'+code)));
}
export async function sha256(value) {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  return [...hash].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export async function importRoomKey(encoded) {
  return crypto.subtle.importKey('raw', fromB64(encoded), 'AES-GCM', false, ['encrypt','decrypt']);
}
export async function encrypt(key, value, aad='kitty-meeting-v2') {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:encoder.encode(aad)},key,encoder.encode(value));
  return {v:2,iv:toB64(iv),data:toB64(data)};
}
export async function decrypt(key, payload, aad='kitty-meeting-v2') {
  if (!payload || payload.v !== 2) throw new Error('Unsupported encrypted data.');
  const data = await crypto.subtle.decrypt({name:'AES-GCM',iv:fromB64(payload.iv),additionalData:encoder.encode(aad)},key,fromB64(payload.data));
  return decoder.decode(data);
}
export async function deriveVaultKey(password, salt) {
  const material=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt:fromB64(salt),iterations:600000,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}

export async function generateAdminKeyPair() {
  const pair=await crypto.subtle.generateKey(
    {name:'RSA-OAEP',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},
    true,
    ['encrypt','decrypt'],
  );
  return {
    publicJwk:await crypto.subtle.exportKey('jwk',pair.publicKey),
    privateJwk:await crypto.subtle.exportKey('jwk',pair.privateKey),
  };
}

export const importAdminPublicKey=jwk=>crypto.subtle.importKey(
  'jwk',jwk,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt'],
);

export const importAdminPrivateKey=jwk=>crypto.subtle.importKey(
  'jwk',jwk,{name:'RSA-OAEP',hash:'SHA-256'},false,['decrypt'],
);

export async function wrapRoomKey(publicKey,encodedRoomKey) {
  const data=await crypto.subtle.encrypt({name:'RSA-OAEP'},publicKey,encoder.encode(encodedRoomKey));
  return {v:3,alg:'RSA-OAEP-256',data:toB64(data)};
}

export async function unwrapRoomKey(privateKey,payload) {
  if(!payload||payload.v!==3||payload.alg!=='RSA-OAEP-256')throw new Error('Unsupported wrapped room key.');
  const data=await crypto.subtle.decrypt({name:'RSA-OAEP'},privateKey,fromB64(payload.data));
  return decoder.decode(data);
}
