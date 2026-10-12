import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRefreshQueue, createActivityHandler, captureChatView, restoreChatComposer } from '../src/runtime.js';
const defer = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('a burst of 100 resume requests shares one refresh', async () => {
  let calls=0; const refresh=createRefreshQueue(async()=>++calls);
  const requests=Array.from({length:100},()=>refresh());
  assert.ok(requests.every(p=>p===requests[0])); await Promise.all(requests); assert.equal(calls,1);
});
test('state changes during refresh reconcile once with the latest state', async () => {
  const gate=defer(), seen=[]; let state=0;
  const refresh=createRefreshQueue(async()=>{seen.push(state); if(seen.length===1) await gate.promise;});
  const first=refresh(); await tick();
  for(let i=1;i<=100;i++){state=i; assert.equal(refresh(),first);}
  gate.resolve(); await first; assert.deepEqual(seen,[0,100]);
});
test('a failed refresh releases its queue for retry', async () => {
  let calls=0; const refresh=createRefreshQueue(async()=>{if(++calls===1)throw Error('offline'); return 'recovered';});
  await assert.rejects(refresh(),/offline/); assert.equal(await refresh(),'recovered');
});
test('backgrounding during biometric unlock cannot restart auth or mark the app active', async () => {
  const gate=defer(), events=[];
  const activity=createActivityHandler({unlock:()=>gate.promise,start:()=>events.push('start'),stop:()=>events.push('stop'),onActive:v=>events.push(v)});
  const foreground=activity({isActive:true}); await activity({isActive:false}); gate.resolve(); await foreground;
  assert.deepEqual(events,['stop',false]);
});
test('the latest foreground event alone activates after unlock', async () => {
  const gate=defer(), events=[];
  const activity=createActivityHandler({unlock:()=>gate.promise,start:()=>events.push('start'),stop:()=>events.push('stop'),onActive:v=>events.push(v)});
  const one=activity({isActive:true}),two=activity({isActive:true}); gate.resolve(); await Promise.all([one,two]);
  assert.deepEqual(events,['start',true]);
});
test('backgrounding during auth restart prevents stale UI activation', async () => {
  const gate=defer(), events=[];
  const activity=createActivityHandler({unlock:async()=>{},start:()=>gate.promise,stop:()=>events.push('stop'),onActive:v=>events.push(v)});
  const foreground=activity({isActive:true}); await tick(); await activity({isActive:false}); gate.resolve(); await foreground;
  assert.deepEqual(events,['stop',false]);
});
test('chat capture restores caret without moving the page and does not cross rooms', () => {
  const list={dataset:{roomId:'room1'},scrollTop:300,scrollHeight:1500,clientHeight:600};
  const oldInput={selectionStart:4,selectionEnd:7}; let focused,selection;
  const doc={activeElement:oldInput,querySelector:id=>id==='#messages'?list:oldInput};
  const view=captureChatView(doc); assert.equal(view.nearBottom,false); assert.equal(view.scrollTop,300);
  const input={style:{},scrollHeight:150,focus:opts=>focused=opts,setSelectionRange:(a,b)=>selection=[a,b]};
  doc.querySelector=id=>id==='#messages'?list:input; restoreChatComposer(view,doc);
  assert.deepEqual(focused,{preventScroll:true});assert.deepEqual(selection,[4,7]);assert.equal(input.style.height,'130px');
  focused=null;list.dataset.roomId='room2';restoreChatComposer(view,doc);assert.equal(focused,null);
});
const source=readFileSync(new URL('../src/main.js',import.meta.url),'utf8');
function functionSource(from,to){return source.slice(source.indexOf(from),source.indexOf(to,source.indexOf(from)));}
test('incremental rendering formats only the new bubble and preserves a reader scroll position',()=>{
  let formats=0; const frames=[];
  const list={children:[],scrollTop:100,scrollHeight:20000,clientHeight:500,
    insertBefore(node,before){const prior=this.children.indexOf(node);if(prior>=0)this.children.splice(prior,1);const at=before?this.children.indexOf(before):-1;this.children.splice(at<0?this.children.length:at,0,node);},
    set innerHTML(_){this.children=[];}};
  const document={querySelector:()=>list,createElement:()=>{const template={content:{}};Object.defineProperty(template,'innerHTML',{set:html=>{const node={dataset:{},html,remove(){list.children.splice(list.children.indexOf(this),1);}};template.content.firstElementChild=node;}});return template;}};
  const state={messages:Array.from({length:500},(_,i)=>({id:'m'+i,user_id:'other',created_at:'2026-10-11T12:00:00Z',display_name:'Member',text:'test'}))};
  const sandbox={document,state,userId:()=> 'me',date:()=> '11 Oct',time:()=>{formats++;return '12:00';},esc:v=>String(v),icon:()=>'',requestAnimationFrame:f=>frames.push(f)};
  vm.createContext(sandbox);vm.runInContext(functionSource('function renderMessages(', 'function connectionLabel(')+';globalThis.draw=renderMessages;',sandbox);
  sandbox.draw(false,100);assert.equal(formats,500);const existing=list.children[2];
  state.messages=[...state.messages.slice(1),{id:'new',user_id:'other',created_at:'2026-10-11T12:01:00Z',display_name:'Member',text:'new'}];
  formats=0;sandbox.draw(false,100);assert.equal(formats,1);assert.ok(list.children.includes(existing));assert.equal(list.scrollTop,100);assert.equal(frames.length,0);assert.equal(list.children.length,501);
});
function updateSandbox(){
  const requests=[],opened=[];const state={session:{user:{id:'a'}},version:{version:'1.6.2',versionCode:9},offline:false};
  const context={state,accountGeneration:1,updateRequest:null,updateCheckAt:0,userId:()=>state.session?.user.id,rpc:()=>{const request=defer();requests.push(request);return request.promise;},native:true,announceUpdate:async()=>{},render:()=>{},openModal:v=>opened.push(v)};
  vm.createContext(context);vm.runInContext(functionSource('async function checkUpdate(', 'async function copy(')+';globalThis.check=checkUpdate;',context);
  return {context,state,requests,opened};
}
const release={version:'1.6.3',version_code:10,apk_url:'https://example.com/app.apk',sha256:'a'.repeat(64)};
test('an update response after sign-out does not create an install prompt',async()=>{
  const {context,state,requests,opened}=updateSandbox();const pending=context.check(false);state.session=null;context.accountGeneration++;
  requests[0].resolve(release);await pending;assert.equal(state.update,undefined);assert.deepEqual(opened,[]);
});
test('an older account check cannot overwrite or clear the new account check',async()=>{
  const {context,state,requests,opened}=updateSandbox();const old=context.check(false);state.session={user:{id:'b'}};context.accountGeneration++;
  const fresh=context.check(false);requests[0].resolve(release);await old;assert.ok(context.updateRequest);assert.deepEqual(opened,[]);
  requests[1].resolve(release);await fresh;assert.deepEqual(opened,['update']);assert.equal(context.updateRequest,null);
});

test('background/offline tears down bounded room and release channels, foreground restores them',async()=>{
  const removed=[],created=[];
  const rooms=Array.from({length:10},(_,i)=>({id:'r'+i,closed_at:null,watched:true}));
  const state={appActive:true,offline:false,backendReady:true,rooms,room:rooms[9],localRooms:Object.fromEntries(rooms.map(r=>[r.id,{code:'saved',last_opened:1}]))};
  const subscriptions=new Map();
  const supabase={removeChannel:async channel=>removed.push(channel.name),channel:name=>{created.push(name);const channel={name,on(){return this;},subscribe(callback){callback?.('SUBSCRIBED');return this;}};return channel;}};
  const sandbox={supabase,state,subscriptions,accountGeneration:1,releaseChannel:null,userId:()=> 'a',createRefreshQueue,queueMessage:()=>{},connectionLabel:()=>{},heartbeat:async()=>{},activityStarted:0};
  vm.createContext(sandbox);vm.runInContext(functionSource('const syncSubscriptions =', 'async function heartbeat(')+';globalThis.sync=syncSubscriptions;',sandbox);
  await sandbox.sync();assert.equal(subscriptions.size,4);assert.ok(subscriptions.has('r9'));assert.equal(created.length,5);
  state.appActive=false;await sandbox.sync();assert.equal(subscriptions.size,0);assert.equal(sandbox.releaseChannel,null);assert.equal(removed.length,5);assert.equal(state.connected,false);
  state.appActive=true;state.offline=true;await sandbox.sync();assert.equal(created.length,5);
  state.offline=false;await sandbox.sync();assert.equal(subscriptions.size,4);assert.equal(created.length,10);
});
