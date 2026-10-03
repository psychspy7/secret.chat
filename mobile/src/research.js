import { toB64, fromB64, isAccessCode } from './crypto.js';
const utf = new TextEncoder(), decoder = new TextDecoder();
async function passwordKey(password, salt) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('Use a research vault password with 12–256 characters.');
  const material = await crypto.subtle.importKey('raw', utf.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt:fromB64(salt),iterations:600000,hash:'SHA-256'}, material, {name:'AES-GCM',length:256}, false, ['encrypt','decrypt']);
}
export async function createResearchVault(password) {
  const keyPair = await crypto.subtle.generateKey({name:'RSA-OAEP',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['encrypt','decrypt']);
  const public_jwk = await crypto.subtle.exportKey('jwk',keyPair.publicKey), privateJwk = await crypto.subtle.exportKey('jwk',keyPair.privateKey);
  const salt = toB64(crypto.getRandomValues(new Uint8Array(16))), iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:utf.encode('secretchat-research-vault-v1')},await passwordKey(password,salt),utf.encode(JSON.stringify(privateJwk)));
  return {public_jwk,encrypted_private:{v:1,salt,iv:toB64(iv),data:toB64(data)}};
}
export async function unlockResearchVault(password, vault) {
  if (vault?.v !== 1) throw new Error('Research vault is not configured.');
  const bytes = await crypto.subtle.decrypt({name:'AES-GCM',iv:fromB64(vault.iv),additionalData:utf.encode('secretchat-research-vault-v1')},await passwordKey(password,vault.salt),fromB64(vault.data));
  return crypto.subtle.importKey('jwk',JSON.parse(decoder.decode(bytes)),{name:'RSA-OAEP',hash:'SHA-256'},false,['decrypt']);
}
export async function wrapResearchInvitation(publicJwk, code) {
  if (!isAccessCode(code)) throw new Error('Invalid invitation.');
  const key = await crypto.subtle.importKey('jwk',publicJwk,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
  return toB64(await crypto.subtle.encrypt({name:'RSA-OAEP'},key,utf.encode(code)));
}
export async function unwrapResearchInvitation(key, wrapped) {
  const code = decoder.decode(await crypto.subtle.decrypt({name:'RSA-OAEP'},key,fromB64(wrapped)));
  if (!isAccessCode(code)) throw new Error('Invalid research invitation.');
  return code;
}
// Prefix formula-like cells before quoting; exports must not execute spreadsheet formulas.
export function exportCsv(messages) {
  const cell = value => '"' + String(value ?? '').replace(/^[\s]*[=+@-]/, x => "'" + x).replaceAll('"','""') + '"';
  return [['Time','Member','Message'],...messages.map(m=>[m.created_at,m.display_name,m.text])].map(row=>row.map(cell).join(',')).join('\r\n');
}
