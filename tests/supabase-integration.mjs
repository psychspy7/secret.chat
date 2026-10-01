import assert from 'node:assert/strict';
import {createClient} from '@supabase/supabase-js';
import {decrypt,deriveVaultKey,encrypt,importRoomKey,randomAccessCode,roomKeyFromAccessCode,randomKey,sha256,importAdminPublicKey,importAdminPrivateKey,wrapRoomKey,unwrapRoomKey} from '../src/crypto.js';
import {localConfig,clientOptions} from './local-config.mjs';

const config=localConfig();
const host=createClient(config.url,config.key,clientOptions);
const creator=createClient(config.url,config.key,clientOptions);
const guest=createClient(config.url,config.key,clientOptions);
const outsider=createClient(config.url,config.key,clientOptions);
const publicReader=createClient(config.url,config.key,clientOptions);
const rooms=[];
let noticeId;
const ok=result=>{assert.ifError(result.error);return result.data};
const failures=[];
async function check(label,fn){try{await fn();console.log('PASS: '+label)}catch(e){failures.push(label);throw e}}
async function create(client,publicKey,vault){
  const code=publicKey?randomAccessCode():'QA'+crypto.randomUUID().replaceAll('-','').slice(0,12).toUpperCase();
  const raw=publicKey?await roomKeyFromAccessCode(code):randomKey(),key=await importRoomKey(raw);
  const args={p_code_hash:await sha256(code),p_key_hash:await sha256(raw),p_label_cipher:await encrypt(key,code),p_host_key_cipher:publicKey?await wrapRoomKey(publicKey,raw):await encrypt(vault,raw)};
  const result=await client.rpc('create_room_v15',{...args,p_duration_hours:2});
  if(result.error)return {error:result.error};
  ok(await client.rpc('join_room',{p_code_hash:await sha256(code),p_key_hash:await sha256(raw),p_name_cipher:await encrypt(key,'Creator')}));
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
    assert.ok(Date.parse(room.expires_at)>Date.now()+1.9*3600000);
    assert.ok(Date.parse(room.expires_at)<Date.now()+2.1*3600000);
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
    assert.ok((await Promise.all(members.map(member=>decrypt(room.key,member.name_cipher)))).includes('Integration Guest'));
    assert.deepEqual(ok(await outsider.from('messages').select('id').eq('room_id',room.id)),[]);
    const burst=await Promise.all(Array.from({length:7},()=>guest.rpc('send_message',{p_room_id:room.id,p_body_cipher:body})));
    assert.ok(burst.some(r=>r.error?.message.includes('slow down')));
    assert.ok((await guest.rpc('send_message',{p_room_id:room.id,p_body_cipher:{v:2}})).error);
  });
  await check('timed room extension is creator-requested and administrator-approved',async()=>{
    assert.ok((await creator.rpc('create_room_v15',{...room.args,p_duration_hours:25})).error);
    assert.ok((await guest.rpc('request_room_extension',{p_room_id:room.id,p_hours:2})).error);
    assert.ok((await creator.rpc('extend_room_time',{p_room_id:room.id,p_hours:2})).error);
    const requestId=ok(await creator.rpc('request_room_extension',{p_room_id:room.id,p_hours:3}));
    assert.equal(ok(await creator.rpc('request_room_extension',{p_room_id:room.id,p_hours:2})),requestId);
    assert.ok(ok(await host.rpc('list_room_extension_requests')).some(r=>r.id===requestId));
    assert.ok((await creator.rpc('review_room_extension',{p_request_id:requestId,p_approve:true})).error);
    ok(await host.rpc('review_room_extension',{p_request_id:requestId,p_approve:true}));
    const latest=ok(await creator.from('rooms').select('expires_at').eq('id',room.id).single());
    assert.equal(Date.parse(latest.expires_at),Date.parse(room.expires_at)+3*3600000);
    assert.ok((await host.rpc('review_room_extension',{p_request_id:requestId,p_approve:true})).error);
    ok(await host.rpc('extend_room_time',{p_room_id:room.id,p_hours:1}));
    assert.equal(Date.parse(ok(await host.from('rooms').select('expires_at').eq('id',room.id).single()).expires_at),Date.parse(latest.expires_at)+3600000);
  });
  await check('only the administrator can clear, close, and approve creator deletion requests',async()=>{
    ok(await creator.rpc('touch_room',{p_room_id:room.id,p_leave:true}));
    assert.deepEqual(ok(await creator.from('messages').select('id').eq('room_id',room.id)),[]);
    assert.ok((await creator.rpc('clear_room_messages',{p_room_id:room.id})).error);
    assert.ok((await creator.rpc('close_room',{p_room_id:room.id})).error);
    assert.ok((await guest.rpc('request_room_deletion',{p_room_id:room.id})).error);
    const first=ok(await creator.rpc('request_room_deletion',{p_room_id:room.id}));
    assert.equal(ok(await creator.rpc('request_room_deletion',{p_room_id:room.id})),first);
    assert.ok(ok(await host.rpc('list_room_deletion_requests')).some(request=>request.id===first));
    assert.ok((await creator.rpc('review_room_deletion',{p_request_id:first,p_approve:true})).error);
    ok(await host.rpc('review_room_deletion',{p_request_id:first,p_approve:false}));
    assert.ok(!ok(await host.rpc('list_room_deletion_requests')).some(request=>request.id===first));
    const second=ok(await creator.rpc('request_room_deletion',{p_room_id:room.id}));
    assert.notEqual(first,second);
    ok(await host.rpc('clear_room_messages',{p_room_id:room.id}));
    assert.deepEqual(ok(await guest.from('messages').select('id').eq('room_id',room.id)),[]);
    ok(await host.rpc('review_room_deletion',{p_request_id:second,p_approve:true}));
    assert.equal(ok(await host.from('rooms').select('is_active').eq('id',room.id).single()).is_active,false);
    assert.ok((await guest.rpc('send_message',{p_room_id:room.id,p_body_cipher:await encrypt(room.key,'blocked',room.id)})).error);
    assert.equal(ok(await guest.from('rooms').select('id').eq('id',room.id)).length,1);
    assert.deepEqual(ok(await guest.from('messages').select('id').eq('room_id',room.id)),[]);
    assert.ok((await guest.from('room_members').update({is_active:true}).eq('room_id',room.id)).error);
  });
  await check('only the administrator can publish notices; visitors see published ones',async()=>{
    const title='SideChat QA '+crypto.randomUUID().slice(0,8);
    assert.ok((await creator.from('site_notices').insert({title,body:'Unauthorized'})).error);
    noticeId=ok(await host.from('site_notices').insert({title,body:'Public test notice',is_active:true}).select('id').single()).id;
    assert.equal(ok(await publicReader.from('site_notices').select('title').eq('id',noticeId).single()).title,title);
    const unauthorized=await creator.from('site_notices').update({body:'Changed'}).eq('id',noticeId).select('id');
    assert.ok(unauthorized.error||unauthorized.data.length===0);
    ok(await host.from('site_notices').update({is_active:false}).eq('id',noticeId));
    assert.deepEqual(ok(await publicReader.from('site_notices').select('id').eq('id',noticeId)),[]);
    assert.equal(ok(await host.from('site_notices').select('id').eq('id',noticeId).single()).id,noticeId);
    ok(await host.from('site_notices').delete().eq('id',noticeId));noticeId=null;
  });
  console.log('PASS: live authorization, quotas, encrypted chat, admin-only controls, deletion approvals, and notices.');
} finally {
  if(noticeId)await host.from('site_notices').delete().eq('id',noticeId);
  for(const room of rooms)await host.rpc('close_room',{p_room_id:room.id});
  await Promise.allSettled([host,creator,guest,outsider].map(client=>client.auth.signOut()));
}
