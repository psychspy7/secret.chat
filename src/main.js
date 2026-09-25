import {createClient} from '@supabase/supabase-js';
import {decrypt,deriveVaultKey,encrypt,importAdminPrivateKey,importAdminPublicKey,importRoomKey,isAccessCode,randomAccessCode,roomKeyFromAccessCode,sha256,unwrapRoomKey,wrapRoomKey} from './crypto.js';
import './style.css';
import './privacy.css';
import {installPrivacyShield} from './privacy.js';
const shield=installPrivacyShield();

const app=document.querySelector('#app');
const url=import.meta.env.VITE_SUPABASE_URL;
const publishableKey=import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const supabase=url&&publishableKey?createClient(url,publishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}}):null;
const state={session:null,host:null,vaultKey:null,adminPrivateKey:null,room:null,roomKey:null,channel:null,heartbeat:null,names:new Map(),messages:new Map(),members:new Map(),generation:0,renderFrame:null,soundEnabled:false};
const BTC='bc1qvn36dkzq7wjq634j6yszg87yy252h7tx97pluc';
const USDT='0x5fa72e223cF8F270aC7bb329ceADBC2b4610d098';
const MAX_CLIENT_MESSAGES=500;
const esc=s=>String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const fmt=d=>new Date(d).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
const err=e=>{const box=document.querySelector('[data-error]');if(box)box.textContent=e?.message||String(e||'')};
const busy=(button,on,label)=>{if(on)button.dataset.original=button.textContent;button.disabled=on;button.textContent=on?(label||button.textContent):(button.dataset.original||button.textContent)};
const one=data=>Array.isArray(data)?data[0]:data;
const header=()=>`<header class="top"><a data-nav href="/" class="brand"><span class="gem">◇</span><span>PRIVATE MEETING</span></a><div class="managed">Managed by <a href="https://kittycorp.vercel.app" target="_blank" rel="noopener noreferrer">Kitty Corp.</a></div></header>`;
const privacy=`<p class="privacy">Messages are encrypted in your browser. Keep room codes private. During beta, Kitty Corp. may access room content for support, training, and research. Websites cannot block screenshots.</p>`;

function configured(){
  if(supabase)return true;
  app.innerHTML=`${header()}<main class="center"><section class="card setup"><div class="kicker">SETUP REQUIRED</div><h1>Connect your private backend.</h1><p>This build is missing <code>VITE_SUPABASE_URL</code> or <code>VITE_SUPABASE_PUBLISHABLE_KEY</code>. On Vercel, set both as Config variables and redeploy. For local use, add them to <code>.env.local</code> and restart.</p><a class="button" href="https://supabase.com/dashboard" rel="noreferrer">Open Supabase</a></section></main>`;
  return false;
}
async function session(){const {data,error}=await supabase.auth.getSession();if(error)throw error;state.session=data.session;return data.session}
async function anonymousSession(){const current=await session();if(current)return current;const {data,error}=await supabase.auth.signInAnonymously();if(error)throw error;state.session=data.session;return data.session}
function route(){return location.pathname.replace(/\/+$/,'')||'/'}
function go(path){history.pushState({},'',path);render()}
async function copyText(text){
  if(navigator.clipboard?.writeText)return navigator.clipboard.writeText(text);
  const area=document.createElement('textarea');area.value=text;area.className='clipboard-fallback';document.body.append(area);area.select();const copied=document.execCommand('copy');area.remove();if(!copied)throw new Error('Copy unavailable. Select and copy the invitation manually.');
}
function inviteText(room){return `${location.origin}/r#k=${room.rawKey}\nRoom code: ${room.label}`}

window.addEventListener('popstate',render);
document.addEventListener('click',e=>{const a=e.target.closest('a[data-nav]');if(a){e.preventDefault();go(new URL(a.href).pathname)}});

function supportMarkup(){
  return `<section class="support" id="support"><div class="support-copy"><div class="kicker">SUPPORT SIDECHAT</div><h2>Help keep private rooms available.</h2><p>Donations support hosting, maintenance, and new privacy features. Always verify the network before sending.</p></div><div class="wallet-grid"><article><div><b>Bitcoin</b><span>BTC · BITCOIN</span></div><code>${BTC}</code><button class="small" data-wallet="${BTC}">Copy BTC address</button></article><article><div><b>Tether</b><span>USDT · ETHEREUM</span></div><code>${USDT}</code><button class="small" data-wallet="${USDT}">Copy USDT address</button></article></div></section>`;
}
function bindWallets(){document.querySelectorAll('[data-wallet]').forEach(button=>button.onclick=async()=>{await copyText(button.dataset.wallet);const before=button.textContent;button.textContent='Copied ✓';setTimeout(()=>button.textContent=before,1800)})}

async function loadPublicNotices(){
  const target=document.querySelector('#public-notices');if(!target)return;
  const {data,error}=await supabase.from('site_notices').select('title,body,link_url,created_at').eq('is_active',true).order('created_at',{ascending:false}).limit(3);
  if(error||!target.isConnected||!data?.length)return;
  target.hidden=false;target.innerHTML=`<div class='kicker'>KITTY CORP. UPDATES</div><h2>Latest notices</h2><div class='notice-grid'>${data.map(notice=>`<article class='card'><small>${new Date(notice.created_at).toLocaleDateString()}</small><h3>${esc(notice.title)}</h3><p>${esc(notice.body)}</p>${notice.link_url?`<a href='${esc(notice.link_url)}' target='_blank' rel='noopener noreferrer'>Read more ↗</a>`:''}</article>`).join('')}</div>`;
}
function landing(){
  app.innerHTML=`${header()}<main><section class="landing"><section class="hero"><div class="kicker">PRIVATE · INVITE ONLY</div><h1>The room for conversations that matter.</h1><p>Live encrypted chat with no participant accounts, no public directory, and no tracking.</p><div class="facts"><span>01 &nbsp; Browser encryption</span><span>02 &nbsp; Temporary names</span><span>03 &nbsp; Host controlled</span></div></section><section class="card join-card"><div class="lock">▣</div><div class="kicker">START OR JOIN</div><h2>Your private meeting space</h2><p>Create a temporary room for free, or enter one with a private invitation.</p><div class="cta-stack"><a class="button" data-nav href="/create">Create a room</a><a class="ghost" data-nav href="/r">Enter a room</a></div><p class="limit-note">Public rooms expire after 24 hours. Up to 3 active rooms and 10 rooms per day per browser identity.</p></section></section><section class="public-notices" id="public-notices" hidden></section>${supportMarkup()}</main><footer>${privacy}<span>© ${new Date().getFullYear()} Kitty Corp.</span></footer>`;
  bindWallets();loadPublicNotices().catch(()=>{});
}

function join(){
  const encodedKey=new URLSearchParams(location.hash.slice(1)).get('k')||'';
  app.innerHTML=`${header()}<main class="center"><section class="card join-card"><div class="lock">▣</div><div class="kicker">PRIVATE · END-TO-END ENCRYPTED</div><h1>Join private room</h1><p>Enter the private access code. Older rooms still need their complete invitation link.</p><p class="beta-note">Beta privacy: Kitty Corp. may access room content for support, training, and research. Join only if you are comfortable with this.</p><form id="join"><label>ROOM CODE<input name="code" maxlength="32" autocomplete="off" autocapitalize="characters" placeholder="Paste your private access code" required></label><label>DISPLAY NAME<input name="name" maxlength="32" autocomplete="off" placeholder="Temporary name" required></label><button class="button">Join room</button><p class="error" data-error role="alert"></p></form><a class="host-link" data-nav href="/">← Home</a></section></main><footer>${privacy}</footer>`;
  document.querySelector('#join').onsubmit=async e=>{
    e.preventDefault();const button=e.submitter;err('');const code=e.target.elements.namedItem('code').value.trim().toUpperCase(),name=e.target.elements.namedItem('name').value.trim();
    if(!/^[A-Z0-9][A-Z0-9_-]{3,31}$/.test(code))return err(new Error('Enter the room code from your host.'));
    if(!encodedKey&&!isAccessCode(code))return err(new Error('This older room needs its complete invitation link. Ask the host to copy it.'));
    if(!name||[...name].length>32)return err(new Error('Choose a display name with 1–32 characters.'));
    busy(button,true,'Joining…');
    try{
      const rawKey=encodedKey||await roomKeyFromAccessCode(code),roomKey=await importRoomKey(rawKey);await anonymousSession();
      const {data,error}=await supabase.rpc('join_room',{p_code_hash:await sha256(code),p_key_hash:await sha256(rawKey),p_name_cipher:await encrypt(roomKey,name)});
      if(error)throw new Error(error.message.includes('full')?'This room is full. Please try again later.':'Room unavailable. Check the invitation and room code, or ask whether it expired.');
      const joined=one(data),isCreator=state.session.user.is_anonymous===true&&joined.host_user_id===state.session.user.id,isAdmin=Boolean(state.host&&state.adminPrivateKey);state.room={...joined,label:await decrypt(roomKey,joined.label_cipher),displayName:isCreator?`Host (${name})`:name,rawKey,isCreator,isAdmin,returnPath:isAdmin?'/SECRET':'/'};state.roomKey=roomKey;await openChat();
    }catch(ex){err(ex)}finally{busy(button,false)}
  };
}

function publicCreate(){
  const suggested=randomAccessCode();
  app.innerHTML=`${header()}<main class="center create-page"><section class="card create-card"><div class="lock">◇</div><div class="kicker">FREE · TEMPORARY · ENCRYPTED</div><h1>Create a private room</h1><p>Your browser creates a strong private access code. Choose a temporary name, then share the code only with people you trust. Beta room content may be reviewed by Kitty Corp. for service improvement and research.</p><form id="public-create"><label>YOUR NAME<input name="name" maxlength="32" autocomplete="off" placeholder="Temporary name" required></label><label>ROOM CODE<input name="code" maxlength="32" autocomplete="off" autocapitalize="characters" value="${suggested}" readonly required></label><button class="button">Create encrypted room</button><p class="error" data-error role="alert"></p></form><div class="creation-limits"><b>Fair-use limits</b><span>3 active rooms</span><span>10 rooms per 24 hours</span><span>Rooms expire after 24 hours</span><span>Latest 1,000 messages retained</span><span>20 people online per room</span><span>Capacity limits keep hosting manageable</span></div><a class="host-link" data-nav href="/">← Home</a></section></main><footer>${privacy}</footer>`;
  document.querySelector('#public-create').onsubmit=async e=>{
    e.preventDefault();const button=e.submitter;err('');const code=e.target.elements.namedItem('code').value.trim().toUpperCase(),name=e.target.elements.namedItem('name').value.trim();
    if(!name||[...name].length>32)return err(new Error('Choose a display name with 1–32 characters.'));
    if(!isAccessCode(code))return err(new Error('Use the generated private access code.'));
    busy(button,true,'Securing room…');
    try{
      await anonymousSession();const publicResult=await supabase.rpc('get_host_public_key');if(publicResult.error)throw publicResult.error;
      const publicKey=await importAdminPublicKey(publicResult.data),raw=await roomKeyFromAccessCode(code),key=await importRoomKey(raw);const created=await createRoomRecord(code,raw,key,await wrapRoomKey(publicKey,raw));
      state.room={...created,room_id:created.id,label:code,rawKey:raw,isCreator:true,isAdmin:false,displayName:`Host (${name})`,returnPath:'/'};state.roomKey=key;history.replaceState({},'',`/r#k=${raw}`);try{await copyText(inviteText(state.room))}catch{}await openChat();
    }catch(ex){
      const message=ex.message||'';
      if(message.includes('active room limit'))err(new Error('You already have 3 active rooms. Ask the admin to close one before creating another.'));
      else if(message.includes('daily room limit'))err(new Error('This browser reached the limit of 10 rooms in 24 hours.'));
      else if(message.includes('capacity'))err(new Error('All available room capacity is in use. Please try again later.'));
      else if(message.includes('already active')||ex.code==='23505')err(new Error('That room code is already active. Choose another.'));
      else err(ex);
    }finally{busy(button,false)}
  };
}

async function createRoomRecord(code,raw,key,hostKeyCipher){
  const {data,error}=await supabase.rpc('create_room',{p_code_hash:await sha256(code),p_key_hash:await sha256(raw),p_label_cipher:await encrypt(key,code),p_host_key_cipher:hostKeyCipher});if(error)throw error;return one(data);
}

async function host(){
  const current=await session();if(!current||current.user.is_anonymous===true)return hostLogin();
  const {data,error}=await supabase.from('hosts').select('*').eq('user_id',current.user.id).maybeSingle();if(error||!data){await supabase.auth.signOut();return hostLogin('This account is not an authorized host.')}state.host=data;
  if(!state.vaultKey||!state.adminPrivateKey)return hostLogin('Enter your host password to unlock room keys.');await dashboard();
}
function hostLogin(message=''){
  app.innerHTML=`${header()}<main class="center"><section class="card auth-card"><div class="lock">▣</div><div class="kicker">AUTHORIZED HOST ONLY</div><h1>Host control center</h1><p>Sign in with the Host ID and password provisioned in Supabase.</p><form id="login"><label>HOST ID<input name="id" maxlength="32" autocomplete="username" required></label><label>PASSWORD<input name="password" type="password" minlength="12" maxlength="256" autocomplete="current-password" required></label><button class="button">Sign in securely</button><p class="error" data-error role="alert">${esc(message)}</p></form><a class="host-link" data-nav href="/">← Participant home</a></section></main><footer>${privacy}</footer>`;
  document.querySelector('#login').onsubmit=async e=>{
    e.preventDefault();const button=e.submitter;err('');const id=e.target.elements.namedItem('id').value.trim().toLowerCase(),password=e.target.elements.namedItem('password').value;
    if(!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(id))return err(new Error('Host ID must be 3–32 letters, numbers, dots, hyphens or underscores.'));
    busy(button,true,'Verifying…');
    try{
      if(state.session?.user?.is_anonymous)await supabase.auth.signOut();const signed=await supabase.auth.signInWithPassword({email:`${id}@kittycorp.invalid`,password});if(signed.error)throw new Error('Incorrect Host ID or password.');state.session=signed.data.session;
      const result=await supabase.from('hosts').select('*').eq('user_id',signed.data.user.id).eq('host_id',id).single();if(result.error)throw new Error('This account is not authorized as a host.');state.host=result.data;state.vaultKey=await deriveVaultKey(password,state.host.vault_salt);
      if(!state.host.private_key_cipher)throw new Error('Host encryption key is not provisioned. Run the setup command from the README.');const jwk=JSON.parse(await decrypt(state.vaultKey,state.host.private_key_cipher,'kitty-admin-private-key-v1'));state.adminPrivateKey=await importAdminPrivateKey(jwk);await dashboard();
    }catch(ex){err(ex);await supabase.auth.signOut();state.session=null;state.host=null;state.vaultKey=null;state.adminPrivateKey=null}finally{busy(button,false)}
  };
}

async function roomKeyFor(room){
  let raw;if(room.host_key_cipher?.v===2)raw=await decrypt(state.vaultKey,room.host_key_cipher);else if(room.host_key_cipher?.v===3)raw=await unwrapRoomKey(state.adminPrivateKey,room.host_key_cipher);else throw new Error('Unsupported room key.');return {key:await importRoomKey(raw),raw};
}
let dashboardPage=0;
async function dashboard(){
  stopRealtime();const {data:rooms,error}=await supabase.from('rooms').select('*').order('created_at',{ascending:false}).range(dashboardPage*50,dashboardPage*50+49);if(error)throw error;const decoded=[];
  for(const room of rooms){try{const unlocked=await roomKeyFor(room);decoded.push({...room,label:await decrypt(unlocked.key,room.label_cipher),key:unlocked.key,rawKey:unlocked.raw})}catch{decoded.push({...room,label:'Locked room',key:null,rawKey:null})}}
  const [requestResult,noticeResult]=await Promise.all([supabase.rpc('list_room_deletion_requests'),supabase.from('site_notices').select('*').order('created_at',{ascending:false}).limit(20)]);
  if(requestResult.error)throw requestResult.error;if(noticeResult.error)throw noticeResult.error;
  const requests=requestResult.data||[],notices=noticeResult.data||[];
  const requestCards=requests.length?requests.map(request=>{const room=decoded.find(item=>item.id===request.room_id);return `<article class='admin-list-item'><div><b>${esc(room?.label||'Room '+request.room_id.slice(0,8))}</b><small>Requested ${new Date(request.created_at).toLocaleString()}</small></div><div class='admin-row-actions'><button class='small primary' data-review='approve' data-request='${request.id}'>Approve</button><button class='small' data-review='reject' data-request='${request.id}'>Decline</button></div></article>`}).join(''):'<p class="muted-small">No pending requests.</p>';
  const noticeCards=notices.length?notices.map(notice=>`<article class='admin-list-item'><div><b>${esc(notice.title)}</b><small>${notice.is_active?'Published':'Hidden'} · ${new Date(notice.created_at).toLocaleString()}</small><p>${esc(notice.body)}</p></div><div class='admin-row-actions'><button class='small' data-notice-edit='${notice.id}'>Edit</button><button class='small' data-notice-toggle='${notice.id}'>${notice.is_active?'Hide':'Publish'}</button><button class='small danger' data-notice-delete='${notice.id}'>Delete</button></div></article>`).join(''):'<p class="muted-small">No notices yet.</p>';
  const adminPanels=`<section class='admin-panels'><section class='card admin-card'><div class='kicker'>APPROVAL QUEUE</div><h2>Room deletion requests</h2>${requestCards}</section><section class='card admin-card'><div class='kicker'>SITE UPDATES</div><h2>Notices</h2><p>Publish updates on the homepage.</p><form id='notice-form'><label>TITLE<input name='title' maxlength='100' required></label><label>MESSAGE<textarea name='body' maxlength='1000' rows='3' required></textarea></label><label>OPTIONAL HTTPS LINK<input name='link_url' type='url' maxlength='500' placeholder='https://'></label><button class='button'>Publish notice</button><p class='error' data-notice-error role='alert'></p></form><div class='admin-notice-list'>${noticeCards}</div></section></section>`;
  app.innerHTML=`${header()}<main class="dashboard"><section class="dash-head"><div><div class="kicker">HOST CONTROL CENTER</div><h1>Welcome, ${esc(state.host.host_id)}.</h1><p>Manage every private room from one encrypted workspace.</p></div><div class="head-actions"><button class="ghost" id="signout">Sign out</button><button class="button" id="new-room">+ New room</button></div></section><section class="stats"><article><b>${decoded.filter(r=>r.is_active&&(!r.expires_at||new Date(r.expires_at)>new Date())).length}</b><span>Active on this page</span></article><article><b>${decoded.length}</b><span>Rooms on this page</span></article><article><b>${decoded.filter(r=>r.is_public_created).length}</b><span>Community rooms</span></article></section>${adminPanels}<section><div class="section-title"><h2>All rooms</h2><span>Page ${dashboardPage+1}</span></div><div class="room-grid">${decoded.length?decoded.map(roomCard).join(''):`<div class="empty"><span class="gem">◇</span><h3>No rooms yet.</h3><p>Create the first encrypted room.</p></div>`}</div><div class="pagination"><button class="ghost" id="previous-page" ${dashboardPage===0?'disabled':''}>Previous</button><button class="ghost" id="next-page" ${rooms.length<50?'disabled':''}>Next</button></div></section></main><dialog id="create"><form method="dialog" id="create-form"><div class="kicker">NEW PERMANENT HOST ROOM</div><h2>Create a room</h2><label>ROOM CODE<input name="code" maxlength="32" autocomplete="off" autocapitalize="characters" value="${randomAccessCode()}" readonly required></label><div class="dialog-actions"><button class="ghost" value="cancel" formnovalidate>Cancel</button><button class="button" value="default">Create room</button></div><p class="error" data-error role="alert"></p></form></dialog><footer>${privacy}</footer>`;
  document.querySelector('#previous-page').onclick=()=>{dashboardPage--;dashboard().catch(err)};
  document.querySelector('#next-page').onclick=()=>{dashboardPage++;dashboard().catch(err)};
  const byId=id=>decoded.find(r=>r.id===id);
  document.querySelector('#signout').onclick=async()=>{await supabase.auth.signOut();state.session=state.host=state.vaultKey=state.adminPrivateKey=null;hostLogin()};document.querySelector('#new-room').onclick=()=>document.querySelector('#create').showModal();
  document.querySelectorAll('[data-open]').forEach(button=>button.onclick=async()=>{const room=byId(button.dataset.open);state.room={...room,room_id:room.id,isCreator:false,isAdmin:true,displayName:'Kitty Corp. Admin',returnPath:'/SECRET'};state.roomKey=room.key;await openChat()});document.querySelectorAll('[data-copy]').forEach(button=>button.onclick=()=>copyInvite(byId(button.dataset.copy),button));
  document.querySelectorAll('[data-review]').forEach(button=>button.onclick=async()=>{const approve=button.dataset.review==='approve';if(approve&&!confirm('Approve this request and close the room for everyone?'))return;busy(button,true,'Saving…');const {error}=await supabase.rpc('review_room_deletion',{p_request_id:button.dataset.request,p_approve:approve});if(error){alert(error.message);busy(button,false)}else await dashboard()});
  const noticeForm=document.querySelector('#notice-form');
  noticeForm.onsubmit=async e=>{e.preventDefault();const button=e.submitter,title=noticeForm.elements.namedItem('title').value.trim(),body=noticeForm.elements.namedItem('body').value.trim(),link=noticeForm.elements.namedItem('link_url').value.trim();const errorBox=noticeForm.querySelector('[data-notice-error]');errorBox.textContent='';if(!title||!body)return errorBox.textContent='Add a title and message.';if(link&&!/^https:\/\/[A-Za-z0-9]/.test(link))return errorBox.textContent='Use a complete HTTPS link.';busy(button,true,'Saving…');const payload={title,body,link_url:link||null,is_active:noticeForm.dataset.edit?Boolean(notices.find(item=>item.id===noticeForm.dataset.edit)?.is_active):true},result=noticeForm.dataset.edit?await supabase.from('site_notices').update(payload).eq('id',noticeForm.dataset.edit):await supabase.from('site_notices').insert(payload);if(result.error){errorBox.textContent=result.error.message;busy(button,false)}else await dashboard()};
  document.querySelectorAll('[data-notice-edit]').forEach(button=>button.onclick=()=>{const notice=notices.find(item=>item.id===button.dataset.noticeEdit);if(!notice)return;noticeForm.dataset.edit=notice.id;noticeForm.elements.namedItem('title').value=notice.title;noticeForm.elements.namedItem('body').value=notice.body;noticeForm.elements.namedItem('link_url').value=notice.link_url||'';noticeForm.querySelector('button').textContent='Save notice';noticeForm.scrollIntoView({behavior:'smooth',block:'center'})});
  document.querySelectorAll('[data-notice-toggle]').forEach(button=>button.onclick=async()=>{const notice=notices.find(item=>item.id===button.dataset.noticeToggle);if(!notice)return;const {error}=await supabase.from('site_notices').update({is_active:!notice.is_active}).eq('id',notice.id);if(error)alert(error.message);else await dashboard()});
  document.querySelectorAll('[data-notice-delete]').forEach(button=>button.onclick=async()=>{if(!confirm('Delete this notice permanently?'))return;const {error}=await supabase.from('site_notices').delete().eq('id',button.dataset.noticeDelete);if(error)alert(error.message);else await dashboard()});
  document.querySelector('#create-form').onsubmit=async e=>{
    e.preventDefault();const button=e.submitter;if(button.value==='cancel'){document.querySelector('#create').close();return}const code=e.target.elements.namedItem('code').value.trim().toUpperCase();if(!/^[A-Z0-9][A-Z0-9_-]{3,31}$/.test(code))return err(new Error('Use 4–32 letters, numbers, hyphens or underscores.'));busy(button,true,'Creating…');
    try{const raw=await roomKeyFromAccessCode(code),key=await importRoomKey(raw);await createRoomRecord(code,raw,key,await encrypt(state.vaultKey,raw));document.querySelector('#create').close();await dashboard();alert('Room created. Use Copy invite on its room card to share it.')}catch(ex){err(ex.message?.includes('already active')||ex.code==='23505'?new Error('That room code is already active.'):ex)}finally{busy(button,false)}
  };
}
function roomCard(r){
  const expired=r.expires_at&&new Date(r.expires_at)<=new Date(),status=r.is_active&&!expired?'LIVE':'CLOSED',source=r.is_public_created?'Community room':'Host room',expiry=r.expires_at?` · Expires ${new Date(r.expires_at).toLocaleString()}`:'';
  return `<article class="room-card ${status==='LIVE'?'':'closed'}"><div class="status"><i></i>${status} · ${source.toUpperCase()}</div><h3>${esc(r.label)}</h3><p>Created ${new Date(r.created_at).toLocaleString()}${expiry}</p><div class="room-buttons">${status==='LIVE'&&r.key?`<button class="small primary" data-open="${r.id}">Open room</button><button class="small" data-copy="${r.id}">Copy invite</button>`:'<span class="closed-note">Chat unavailable or room closed</span>'}</div></article>`;
}
async function copyInvite(room,button){if(!room.rawKey)return alert('This room key cannot be unlocked with the current password.');try{await copyText(inviteText(room));const before=button.textContent;button.textContent='Copied ✓';setTimeout(()=>button.textContent=before,1800)}catch(error){alert(error.message)}}

async function openChat(){
  stopRealtime();shield.reset();state.messages.clear();state.names.clear();state.members.clear();
  const roomId=state.room.room_id||state.room.id;await joinCurrentRoom();
  const {data:room,error}=await supabase.from('rooms').select('*').eq('id',roomId).single();if(error||!room.is_active||room.expires_at&&new Date(room.expires_at)<=new Date())return closed();state.room={...state.room,...room,room_id:roomId};
  const inviteTools=`<label class='invite-label' for='room-invite'>Private invitation</label><textarea id='room-invite' readonly rows='3'></textarea><p class='limit-note'>The access code alone opens new rooms. Keep it private and save it to return later.</p><button id='copy-room'>Copy invitation</button>`;
  const roomTools=state.room.isAdmin?`<div class='host-tools'><div class='kicker'>ADMIN ACTIONS</div>${inviteTools}<button id='export'>Export retained chat</button><button id='clear'>Clear chat</button><button id='close' class='danger'>Close room</button><button id='back'>← All rooms</button></div>`:state.room.isCreator?`<div class='host-tools'><div class='kicker'>YOUR ROOM</div>${inviteTools}<button id='request-delete' class='danger'>Request room deletion</button><button id='leave'>Leave room</button></div>`:`<button id='leave' class='ghost wide'>Leave room</button>`;
  app.innerHTML=`${header()}<main class='chat'><section class='chat-main'><div class='chat-head'><div><div class='kicker'>PRIVATE · BROWSER ENCRYPTED</div><h2>${esc(state.room.label||'Private room')}</h2></div><div class='chat-head-actions'><div class='online' role='status'>Connecting…</div><button class='small sound-toggle' id='sound-toggle' type='button'>Sound ${state.soundEnabled?'on':'off'}</button></div></div><div class='messages' id='messages'><div class='empty-message'><span class='lock'>▣</span><h3>The room is ready.</h3><p>Messages are encrypted before they leave this browser.</p></div></div><form class='composer' id='send'><textarea name='message' maxlength='2000' rows='2' placeholder='Write an encrypted message…' required></textarea><button class='button'>Send ↑</button><p class='error' data-error role='alert'></p></form></section><aside><button class='ghost wide' id='hide-chat'>Hide chat · Esc</button><div class='kicker'>IN THIS ROOM</div><h3 id='person-count'>0 people</h3><ul id='people'></ul>${roomTools}<div class='security-note'><b>Private access</b><p>Messages are encrypted in your browser. Keep your room code private. During beta, Kitty Corp. may access room content for support, training, and research.</p><p>Use Hide chat when stepping away. Your device controls screenshots and screen recording.</p>${state.room.expires_at?`<p>Expires ${new Date(state.room.expires_at).toLocaleString()}.</p>`:''}</div></aside></main>`;
  if(state.room.isAdmin||state.room.isCreator)document.querySelector('#room-invite').value=inviteText(state.room);
  document.querySelector('#hide-chat').onclick=shield.hide;
  document.querySelector('#send').onsubmit=sendMessage;document.querySelector('[name=message]').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();e.target.form.requestSubmit()}};
  document.querySelector('#sound-toggle').onclick=async e=>{state.soundEnabled=!state.soundEnabled;e.currentTarget.textContent=`Sound ${state.soundEnabled?'on':'off'}`;if(state.soundEnabled)await ensureAudioContext()};
  if(state.room.isAdmin){
    document.querySelector('#back').onclick=()=>go('/SECRET');document.querySelector('#export').onclick=exportChat;document.querySelector('#copy-room').onclick=e=>copyInvite(state.room,e.currentTarget);
    document.querySelector('#clear').onclick=async()=>{if(confirm('Clear every message in this room?')){const {error}=await supabase.rpc('clear_room_messages',{p_room_id:roomId});if(error)alert(error.message);else if(state.room?.room_id===roomId){state.messages.clear();renderMessages();await syncRoom()}}};
    document.querySelector('#close').onclick=async()=>{if(confirm('Close this room, clear chat, and disconnect everyone?')){const {error}=await supabase.rpc('close_room',{p_room_id:roomId});if(error)alert(error.message);else go('/SECRET')}};
  }else{
    document.querySelector('#leave').onclick=async()=>{await markLeft(roomId);stopRealtime();go('/')};
    if(state.room.isCreator){document.querySelector('#copy-room').onclick=e=>copyInvite(state.room,e.currentTarget);document.querySelector('#request-delete').onclick=async e=>{const button=e.currentTarget;if(!confirm('Send a deletion request to the Kitty Corp. admin? The room remains open until approved.'))return;busy(button,true,'Sending…');const {error}=await supabase.rpc('request_room_deletion',{p_room_id:roomId});if(error){alert(error.message);busy(button,false)}else{button.textContent='Request pending admin approval';button.disabled=true}}}
  }
  subscribeRoom();
  state.heartbeat=setInterval(async()=>{if(document.hidden||state.room?.room_id!==roomId)return;if(state.room.expires_at&&new Date(state.room.expires_at)<=new Date())return closed();const {data,error}=await supabase.from('rooms').select('is_active,chat_epoch').eq('id',roomId).maybeSingle();if(error)return;if(!data?.is_active)return closed();if(data.chat_epoch!==state.room.chat_epoch)await syncRoom();await supabase.rpc('touch_room',{p_room_id:roomId});renderPeople()},45000);
}

async function joinCurrentRoom(){
  const room=state.room,key=state.roomKey;
  const {error}=await supabase.rpc('join_room',{p_code_hash:await sha256(room.label),p_key_hash:await sha256(room.rawKey),p_name_cipher:await encrypt(key,room.displayName)});
  if(error)throw error;
}
async function updateMember(member,generation=state.generation){
  if(!member?.user_id)return;
  const previous=state.members.get(member.user_id);
  let name=previous?.name;
  if(!name||JSON.stringify(previous.name_cipher)!==JSON.stringify(member.name_cipher)){
    try{name=await decrypt(state.roomKey,member.name_cipher)}catch{name='Participant'}
  }
  if(generation!==state.generation)return;
  state.members.set(member.user_id,{...member,name});state.names.set(member.user_id,name);
}
async function refreshMembers(){
  const generation=state.generation;
  const {data,error}=await supabase.from('room_members').select('*').eq('room_id',state.room.room_id).limit(110);
  if(error)throw error;if(generation!==state.generation)return;
  for(const member of data)await updateMember(member,generation);
  renderPeople();renderMessages();
}
async function refreshMessages(){
  const generation=state.generation,epoch=state.room.chat_epoch;
  const {data,error}=await supabase.from('messages').select('*').eq('room_id',state.room.room_id).order('id',{ascending:false}).limit(MAX_CLIENT_MESSAGES);
  if(error)throw error;if(generation!==state.generation||epoch!==state.room?.chat_epoch)return;
  // Merge with events received during the fetch; never replace a newer event snapshot.
  for(const message of data)await addMessage(message,generation,epoch);
  renderMessages();
}
async function syncRoom(){
  const generation=state.generation,id=state.room?.room_id;if(!id)return;
  const {data,error}=await supabase.from('rooms').select('is_active,expires_at,chat_epoch').eq('id',id).maybeSingle();
  if(generation!==state.generation)return;if(error)throw error;
  if(!data?.is_active||data.expires_at&&new Date(data.expires_at)<=new Date())return closed();
  if(state.room.chat_epoch!==data.chat_epoch){state.messages.clear();state.room.chat_epoch=data.chat_epoch}
  await Promise.all([refreshMembers(),refreshMessages()]);
}
function setConnection(label){const badge=document.querySelector('.online');if(badge)badge.textContent=label}
let audioContext;
async function ensureAudioContext(){
  try{const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)return;if(!audioContext)audioContext=new Audio();await audioContext.resume()}catch{}
}
function playChime(){
  if(!state.soundEnabled||document.hidden||audioContext?.state!=='running')return;
  const oscillator=audioContext.createOscillator(),gain=audioContext.createGain(),start=audioContext.currentTime;
  oscillator.type='sine';oscillator.frequency.setValueAtTime(740,start);gain.gain.setValueAtTime(0.0001,start);gain.gain.exponentialRampToValueAtTime(0.025,start+0.01);gain.gain.exponentialRampToValueAtTime(0.0001,start+0.16);oscillator.connect(gain).connect(audioContext.destination);oscillator.start(start);oscillator.stop(start+0.17);
}
function subscribeRoom(){
  const id=state.room.room_id,generation=state.generation;
  state.channel=supabase.channel(`room-${id}-${crypto.randomUUID()}`)
    .on('postgres_changes',{event:'INSERT',schema:'public',table:'messages',filter:`room_id=eq.${id}`},async payload=>{
      await addMessage(payload.new,generation);if(generation===state.generation){if(payload.new.sender_id!==state.session?.user?.id&&state.messages.has(payload.new.id))playChime();renderMessages()}
    })
    .on('postgres_changes',{event:'*',schema:'public',table:'room_members',filter:`room_id=eq.${id}`},async payload=>{
      if(generation!==state.generation)return;
      if(payload.eventType==='DELETE'){state.members.delete(payload.old.user_id);state.names.delete(payload.old.user_id)}
      else await updateMember(payload.new,generation);
      renderPeople();renderMessages();
    })
    .on('postgres_changes',{event:'UPDATE',schema:'public',table:'rooms',filter:`id=eq.${id}`},payload=>{
      if(generation!==state.generation)return;
      if(!payload.new.is_active)return closed();
      if(payload.new.chat_epoch!==state.room.chat_epoch){state.room.chat_epoch=payload.new.chat_epoch;state.messages.clear();renderMessages()}
    }).subscribe(status=>{
      if(generation!==state.generation)return;
      setConnection(status==='SUBSCRIBED'?'Live · encrypted':'Reconnecting…');
      if(status==='SUBSCRIBED')syncRoom().catch(err);
    });
}
function stopRealtime(){
  state.generation++;
  if(state.channel){supabase.removeChannel(state.channel);state.channel=null}
  clearInterval(state.heartbeat);state.heartbeat=null;
  cancelAnimationFrame(state.renderFrame);state.renderFrame=null;
}
async function addMessage(row,generation=state.generation,epoch=state.room?.chat_epoch){
  if(generation!==state.generation||!state.room||state.messages.has(row.id))return;
  const key=state.roomKey,id=state.room.room_id;
  try{
    const text=await decrypt(key,row.body_cipher,id);
    if(generation!==state.generation||epoch!==state.room?.chat_epoch)return;
    state.messages.set(row.id,{...row,text});
    if(state.messages.size>MAX_CLIENT_MESSAGES)state.messages.delete(Math.min(...state.messages.keys()));
  }catch{}
}
function renderMessages(){
  if(state.renderFrame)return;
  state.renderFrame=requestAnimationFrame(()=>{
    state.renderFrame=null;const box=document.querySelector('#messages');if(!box)return;
    const atBottom=box.scrollHeight-box.scrollTop-box.clientHeight<100;
    const rows=[...state.messages.values()].sort((a,b)=>a.id-b.id);
    if(!rows.length){box.innerHTML='<div class="empty-message"><span class="lock">▣</span><h3>No messages yet.</h3><p>Start the encrypted conversation.</p></div>';return}
    box.querySelector('.empty-message')?.remove();
    const present=new Map([...box.querySelectorAll('[data-message]')].map(node=>[Number(node.dataset.message),node]));
    for(const [id,node] of present)if(!state.messages.has(id))node.remove();
    for(const row of rows){
      let article=present.get(row.id);
      if(!article){article=document.createElement('article');article.dataset.message=row.id;article.className='message';const meta=document.createElement('div'),name=document.createElement('strong'),time=document.createElement('time'),text=document.createElement('p');time.textContent=fmt(row.created_at);text.textContent=row.text;meta.append(name,time);article.append(meta,text)}
      article.querySelector('strong').textContent=row.sender_id===state.session.user.id?state.room.displayName:(state.names.get(row.sender_id)||'Participant');
      box.append(article);
    }
    if(atBottom)box.scrollTop=box.scrollHeight;
  });
}
function renderPeople(){
  const list=document.querySelector('#people');if(!list)return;
  const people=[...state.members.values()].filter(m=>m.is_active&&Date.parse(m.last_seen)>Date.now()-105000);
  document.querySelector('#person-count').textContent=`${people.length} ${people.length===1?'person':'people'}`;
  list.replaceChildren(...people.map(member=>{const li=document.createElement('li'),avatar=document.createElement('span');avatar.textContent=[...member.name][0]?.toUpperCase()||'?';li.append(avatar,document.createTextNode(member.name));return li}));
}

async function sendMessage(e){e.preventDefault();const field=e.target.message,text=field.value.trim();if(!text)return;const button=e.submitter;button.disabled=true;err('');try{const body=await encrypt(state.roomKey,text,state.room.room_id);const {error}=await supabase.rpc('send_message',{p_room_id:state.room.room_id,p_body_cipher:body});if(error)throw error;field.value=''}catch(ex){err(ex.message?.includes('slow')?new Error('Please slow down: up to 5 messages every 5 seconds.'):ex)}finally{button.disabled=false;field.focus()}}
async function exportChat(){
  const room=state.room,key=state.roomKey,button=document.querySelector('#export');busy(button,true,'Preparing export…');
  try{
    const {data,error}=await supabase.from('messages').select('*').eq('room_id',room.room_id).order('id',{ascending:false}).limit(1000);
    if(error)throw error;
    const quote=value=>{const raw=String(value),safe=/^[\t\r ]*[=+\-@]/.test(raw)?`'${raw}`:raw;return `"${safe.replaceAll('"','""')}"`};
    const lines=['Time,Display name,Message'];
    for(const row of data.reverse()){
      const text=await decrypt(key,row.body_cipher,room.room_id);
      lines.push([new Date(row.created_at).toISOString(),state.names.get(row.sender_id)||'Participant',text].map(quote).join(','));
    }
    const {data:latest,error:latestError}=await supabase.from('rooms').select('is_active,chat_epoch').eq('id',room.room_id).single();
    if(latestError||!latest.is_active||latest.chat_epoch!==room.chat_epoch)throw new Error('Chat changed during export. Please try again.');
    const blob=new Blob([lines.join('\r\n')],{type:'text/csv;charset=utf-8'}),a=document.createElement('a');
    a.href=URL.createObjectURL(blob);a.download=`${room.label||'private-room'}-${new Date().toISOString().slice(0,10)}.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
  }catch(error){err(error)}finally{busy(button,false)}
}

async function markLeft(roomId){return supabase.rpc('touch_room',{p_room_id:roomId,p_leave:true})}
function closed(){stopRealtime();shield.reset();state.roomKey=null;state.room=null;state.messages.clear();state.names.clear();app.innerHTML=`${header()}<main class="center"><section class="card closed-card"><div class="lock">▣</div><div class="kicker">MEETING ENDED</div><h1>This room is closed.</h1><p>The host closed it or its time limit ended. New messages and access are disabled.</p><a class="button" data-nav href="/">Return home</a></section></main>`}
async function render(){if(state.room&&state.session)markLeft(state.room.room_id);stopRealtime();shield.reset();state.room=null;state.roomKey=null;state.messages.clear();state.names.clear();state.members.clear();if(!configured())return;try{if(route()==='/SECRET')await host();else if(route()==='/create')publicCreate();else if(route().startsWith('/r'))join();else landing()}catch(ex){app.innerHTML=`${header()}<main class="center"><section class="card"><h1>Something went wrong.</h1><p class="error">${esc(ex.message)}</p><a class="button" href="/">Try again</a></section></main>`}}
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.room){syncRoom().then(()=>state.room&&joinCurrentRoom()).catch(err)}});
window.addEventListener('focus',()=>{if(state.room)syncRoom().catch(err)});
window.addEventListener('online',()=>{if(state.room)syncRoom().catch(err)});
window.addEventListener('offline',()=>setConnection('Offline · reconnecting'));
window.addEventListener('pagehide',()=>{if(state.room&&state.session)markLeft(state.room.room_id)});
render();
