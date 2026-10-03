import { serviceRpc, pushConfigured } from './mobile.ts';
let cachedAccess: { token: string; expires: number } | undefined;
const encode = (data: Uint8Array) => btoa(String.fromCharCode(...data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const utf = (value: string) => new TextEncoder().encode(value);
async function accessToken() {
  const account = JSON.parse(Deno.env.get('FCM_SERVICE_ACCOUNT_JSON')!);
  if (!/^[a-z][a-z0-9-]{4,62}$/.test(account.project_id) || typeof account.private_key !== 'string') throw new Error('Push configuration invalid.');
  if (cachedAccess && cachedAccess.expires > Date.now() + 60000) return { token: cachedAccess.token, project: account.project_id };
  const now = Math.floor(Date.now() / 1000);
  const header = encode(utf(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = encode(utf(JSON.stringify({
    iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
  })));
  const pem = account.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), c => c.charCodeAt(0)),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, utf(`${header}.${claims}`));
  const result = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${header}.${claims}.${encode(new Uint8Array(signature))}` }),
    signal: AbortSignal.timeout(15000),
  });
  if (!result.ok) throw new Error('Push authorization unavailable.');
  const value = await result.json();
  cachedAccess = { token: value.access_token, expires: Date.now() + value.expires_in * 1000 };
  return { token: cachedAccess.token, project: account.project_id };
}
export async function dispatchPresence(actorId: string, roomId: string) {
  if (!pushConfigured()) return;
  const credentials = await accessToken();
  const event = await serviceRpc('mobile_edge_claim_push', { p_actor_id: actorId, p_room_id: roomId });
  if (!event) return;
  const invalid: string[] = [];
  let temporaryFailure = false;
  const devices = event.devices as { token: string; user_id: string }[];
  // Bound concurrency and TTL to avoid delayed join alerts and network bursts.
  for (let start = 0; start < devices.length; start += 8) {
    await Promise.all(devices.slice(start, start + 8).map(async ({token, user_id}) => {
      try {
        const result = await fetch(`https://fcm.googleapis.com/v1/projects/${credentials.project}/messages:send`, {
          method: 'POST', headers: { Authorization: `Bearer ${credentials.token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: {
            token, notification: { title: 'SecretChat · Room activity', body: event.type === 'room_message' ? 'A new message arrived in your room.' : 'Someone joined the room.' },
            data: { type: event.type || 'room_join', room_id: roomId, event_id: event.id, actor_id: actorId, user_id },
            android: { priority: 'HIGH', ttl: '60s', collapse_key: `room:${roomId}`,
              notification: { channel_id: 'secretchat_room_v15', sound: 'secretchat_ping_v15', tag: `room:${roomId}`, visibility: 'PRIVATE' } },
          } }), signal: AbortSignal.timeout(15000),
        });
        if (!result.ok) {
          const error = await result.json().catch(() => ({}));
          if (error.error?.details?.some((d: {errorCode?:string}) => d.errorCode === 'UNREGISTERED')) invalid.push(token);
          else temporaryFailure = true;
        }
      } catch { temporaryFailure = true; }
    }));
  }
  // Retry on a later heartbeat if FCM is temporarily unavailable. A per-room
  // collapse key and event_id allow devices to suppress duplicate alerts.
  if (!temporaryFailure) await serviceRpc('mobile_edge_finish_push', { p_event_id: event.id, p_invalid_tokens: invalid });
}

export async function dispatchRelease() {
  if (!pushConfigured()) return;
  const credentials = await accessToken();
  let finish: {token:string;version_code:number}[] = [];
  const deadline=Date.now()+45000;
  // Persistent per-device outbox; later foreground activity resumes unfinished batches.
  while (Date.now()<deadline) {
    const batch=await serviceRpc('mobile_edge_release_batch',{p_finish:finish}) as {token:string;version_code:number;user_id:string}[];
    finish=[];
    if (!batch.length) break;
    for (let start=0;start<batch.length;start+=8) {
      await Promise.all(batch.slice(start,start+8).map(async item=>{
        try {
          const response=await fetch(`https://fcm.googleapis.com/v1/projects/${credentials.project}/messages:send`,{
            method:'POST',headers:{Authorization:`Bearer ${credentials.token}`,'Content-Type':'application/json'},
            body:JSON.stringify({message:{token:item.token,notification:{title:'SecretChat · Update ready',body:'A new SecretChat update is available. Open the app to install.'},
              data:{type:'app_update',event_id:String(item.version_code),version_code:String(item.version_code),user_id:item.user_id},
              android:{priority:'HIGH',ttl:'86400s',collapse_key:'secretchat-update',notification:{channel_id:'secretchat_room_v15',sound:'secretchat_ping_v15',tag:'secretchat-update',visibility:'PRIVATE'}}}}),signal:AbortSignal.timeout(10000)});
          const error=response.ok ? null : await response.json().catch(()=>null);
          if(response.ok || error?.error?.details?.some((d:{errorCode?:string})=>d.errorCode==='UNREGISTERED')) finish.push({token:item.token,version_code:item.version_code});
        } catch { /* Transient failures stay in the outbox for retry. */ }
      }));
    }
  }
  // Finish the last batch without claiming more work than this invocation can send.
  if(finish.length) await serviceRpc('mobile_edge_release_finish',{p_finish:finish});
}
