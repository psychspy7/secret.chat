import test from 'node:test';
import assert from 'node:assert/strict';
import {createResearchVault,unlockResearchVault,wrapResearchInvitation,unwrapResearchInvitation,exportCsv} from '../src/research.js';
import {randomAccessCode,roomKey,encryptMessage,decryptMessage} from '../src/crypto.js';
import {acceptAlert} from '../src/alert-policy.js';
test('research private key is password encrypted; invitation unwrap requires the correct vault',async()=>{
  const bundle=await createResearchVault('correct test password 123');
  assert.equal(bundle.public_jwk.d,undefined);
  const key=await unlockResearchVault('correct test password 123',bundle.encrypted_private);
  const code=randomAccessCode(), wrapped=await wrapResearchInvitation(bundle.public_jwk,code);
  assert.equal(wrapped.length,342); assert.ok(!JSON.stringify(bundle).includes(code));
  assert.equal(await unwrapResearchInvitation(key,wrapped),code);
  await assert.rejects(unlockResearchVault('wrong test password 456',bundle.encrypted_private));
});
test('chat epoch is authenticated and cannot be changed to replay an old message',async()=>{
  const key=await roomKey(randomAccessCode()), roomId=crypto.randomUUID(), userId=crypto.randomUUID(), id=crypto.randomUUID();
  const payload=await encryptMessage(key,{roomId,userId,id,text:'Reset boundary',epoch:2});
  const envelope={id,room_id:roomId,user_id:userId,payload,created_at:payload.sent_at};
  assert.equal((await decryptMessage(key,envelope,roomId)).text,'Reset boundary');
  await assert.rejects(decryptMessage(key,{...envelope,payload:{...payload,epoch:3}},roomId));
  await assert.rejects(encryptMessage(key,{roomId,userId,id,text:'invalid',epoch:0}));
});
test('live and FCM message alerts deduplicate; join alert cooldown and memory are bounded',()=>{
  const seen=new Map(), now=1000000;
  assert.ok(acceptAlert(seen,'room_message',{id:'message1'},'room',now));
  assert.equal(acceptAlert(seen,'room_message',{event_id:'message1'},'room',now+1),false);
  assert.ok(acceptAlert(seen,'room_join',{user_id:'actor'},'room',now));
  assert.equal(acceptAlert(seen,'room_join',{actor_id:'actor'},'room',now+1000),false);
  for(let i=0;i<1000;i++) acceptAlert(seen,'room_message',{id:'m'+i},'room',now+2000);
  assert.ok(seen.size<=600);
});
test('research export quotes cells, preserves unicode, and blocks spreadsheet formulas',()=>{
  const csv=exportCsv([{created_at:'now',display_name:'=1+1',text:' @SUM(1,2)\n你好 "yes"'}]);
  assert.match(csv,/"'=1\+1"/); assert.match(csv,/"' @SUM/); assert.match(csv,/""yes""/);
});
