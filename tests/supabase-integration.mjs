import assert from 'node:assert/strict';
import {createClient} from '@supabase/supabase-js';
import {decrypt,deriveVaultKey,encrypt,importRoomKey,randomAccessCode,roomKeyFromAccessCode,randomKey,sha256,importAdminPublicKey,importAdminPrivateKey,wrapRoomKey,unwrapRoomKey} from '../src/crypto.js';
import {localConfig,clientOptions} from './local-config.mjs';

const config=localConfig();
const host=createClient(config.url,config.key,clientOptions);
const creator=createClient(config.url,config.key,clientOptions);
const guest=createClient(config.url,config.key,clientOptions);
const outsider=createClient(config.url,config.key,clientOptions);
const rooms=[];
const ok=result=>{assert.ifError(result.error);return result.data};
const failures=[];
async function check(label,fn){try{await fn();console.log('PASS: '+label)}catch(e){failures.push(label);throw e}}
async function create(client,publicKey,vault){
  const code=publicKey?randomAccessCode():'QA'+crypto.randomUUID().replaceAll('-','').slice(0,12).toUpperCase();
  const raw=publicKey?await roomKeyFromAccessCode(code):randomKey(),key=await importRoomKey(raw);
  const args={p_code_hash:await sha256(code),p_key_hash:await sha256(raw),p_label_cipher:await encrypt(key,code),p_host_key_cipher:publicKey?await wrapRoomKey(publicKey,raw):await encrypt(vault,raw)};
  const result=await client.rpc('create_room',args);
  if(result.error)return {error:result.error};
  const room={...result.data[0],code,raw,key,args};rooms.push(room);return room;
}
try{
  ok(await host.auth.signInWithPassword({email:config.email,password:config.password}));
  const h=ok(await host.from('hosts').select('*').eq('host_id',config.id).single());
  const vault=await deriveVaultKey(config.password,h.vault_salt);
  const privateKey=await importAdminPrivateKey(JSON.parse(await decrypt(vault,h.private_key_cipher,'kitty-admin-private-key-v1')));
  for(const client of [creator,guest,outsider])assert.equal(ok(await client.auth.signInAnonymously()).user.is_anonymous,true);
  const publicKey=await importAdminPublicKey(ok(await creator.rpc('get_host_public_key')));
  const adminRoom=await create(host,null,vault);assert.ifError(adminRoom.error);
  assert.equal(adminRoom.expires_at,null);
  assert.equal(await decrypt(vault,adminRoom.host_key_cipher),adminRoom.raw);
  await check('concurrent public creation cannot exceed 3 active rooms',async()=>{
    const results=await Promise.all(Array.from({length:4},()=>create(creator,publicKey)));
    assert.equal(results.filter(r=>!r.error).length,3);
    assert.match(results.find(r=>r.error).error.message,/active room limit/);
  });
  const room=rooms.find(r=>r.is_public_created);
  await check('public room expiry and administrator key access',async()=>{
    assert.ok(Date.parse(room.expires_at)>Date.now()+23*3600000);
    assert.ok(Date.parse(room.expires_at)<Date.now()+25*3600000);
    assert.equal(await unwrapRoomKey(privateKey,room.host_key_cipher),room.raw);
    assert.equal(ok(await host.from('rooms').select('id').eq('id',room.id).single()).id,room.id);
  });
  await check('outsiders cannot read rooms, join with a wrong key, clear, or bypass quota by direct insert',async()=>{
    assert.deepEqual(ok(await outsider.from('rooms').select('id').eq('id',room.id)),[]);
    assert.ok((await outsider.rpc('join_room',{p_code_hash:await sha256(room.code),p_key_hash:await sha256(randomKey()),p_name_cipher:await encrypt(room.key,'Intruder')})).error);
    assert.ok((await outsider.rpc('clear_room_messages',{p_room_id:room.id})).error);
    assert.ok((await creator.from('rooms').insert({host_user_id:room.host_user_id,code_hash:room.code_hash,key_hash:room.key_hash,label_cipher:room.label_cipher,host_key_cipher:room.host_key_cipher})).error);
    assert.ok((await creator.rpc('set_host_keypair',{p_public_key_jwk:h.public_key_jwk,p_private_key_cipher:h.private_key_cipher})).error);
    assert.ok((await host.rpc('set_host_keypair',{p_public_key_jwk:h.public_key_jwk,p_private_key_cipher:h.private_key_cipher})).error);
  });
  await check('encrypted join, membership, messaging, and rate limiting',async()=>{
    const codeOnlyKey=await roomKeyFromAccessCode(room.code);
    assert.equal(codeOnlyKey,room.raw);
    const joined=ok(await guest.rpc('join_room',{p_code_hash:await sha256(room.code),p_key_hash:await sha256(codeOnlyKey),p_name_cipher:await encrypt(await importRoomKey(codeOnlyKey),'Integration Guest')}));
    assert.equal(joined[0].room_id,room.id);
    const body=await encrypt(room.key,'encrypted integration message',room.id);
    ok(await guest.rpc('send_message',{p_room_id:room.id,p_body_cipher:body}));
    const stored=ok(await host.from('messages').select('*').eq('room_id',room.id).single());
    assert.ok(!JSON.stringify(stored.body_cipher).includes('encrypted integration message'));
    assert.equal(await decrypt(room.key,stored.body_cipher,room.id),'encrypted integration message');
    const members=ok(await creator.from('room_members').select('*').eq('room_id',room.id));
    assert.equal(await decrypt(room.key,members[0].name_cipher),'Integration Guest');
    assert.deepEqual(ok(await outsider.from('messages').select('id').eq('room_id',room.id)),[]);
    const burst=await Promise.all(Array.from({length:7},()=>guest.rpc('send_message',{p_room_id:room.id,p_body_cipher:body})));
    assert.ok(burst.some(r=>r.error?.message.includes('slow down')));
    assert.ok((await guest.rpc('send_message',{p_room_id:room.id,p_body_cipher:{v:2}})).error);
  });
  await check('room creator and permanent administrator can clear and close',async()=>{
    ok(await creator.rpc('clear_room_messages',{p_room_id:room.id}));
    assert.deepEqual(ok(await guest.from('messages').select('id').eq('room_id',room.id)),[]);
    ok(await host.rpc('close_room',{p_room_id:room.id}));
    assert.equal(ok(await host.from('rooms').select('is_active').eq('id',room.id).single()).is_active,false);
    assert.ok((await guest.rpc('send_message',{p_room_id:room.id,p_body_cipher:await encrypt(room.key,'blocked',room.id)})).error);
    assert.equal(ok(await guest.from('rooms').select('id').eq('id',room.id)).length,1);
    assert.deepEqual(ok(await guest.from('messages').select('id').eq('room_id',room.id)),[]);
    assert.ok((await guest.from('room_members').update({is_active:true}).eq('room_id',room.id)).error);
  });
  console.log('PASS: live authorization, concurrency quotas, expiry, E2EE, public ownership, and admin management.');
} finally {
  for(const room of rooms)await host.rpc('close_room',{p_room_id:room.id});
  await Promise.allSettled([host,creator,guest,outsider].map(client=>client.auth.signOut()));
}
