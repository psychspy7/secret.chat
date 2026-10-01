// The key below is supplied by the Edge runtime; never bundle this file into the APK.
const projectUrl = Deno.env.get('SUPABASE_URL')!;
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const allowedOrigins = new Set(['https://localhost', 'http://localhost', 'capacitor://localhost', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:5174', 'http://127.0.0.1:5174']);
export function headers(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  return {
    ...(allowedOrigins.has(origin) ? { 'Access-Control-Allow-Origin': origin } : {}),
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
}
export function json(req: Request, data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: headers(req) });
}
export function preflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: headers(req) });
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed.' }, 405);
  return null;
}
export async function body(req: Request, max = 18000): Promise<Record<string, unknown>> {
  const reader = req.body?.getReader();
  if (!reader) throw new Error('Request body required.');
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > max) { await reader.cancel(); throw new Error('Request is too large.'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  const parsed = JSON.parse(new TextDecoder().decode(data));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid request.');
  return parsed;
}
export async function identify(req: Request) {
  const authorization = req.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) throw new Error('Sign in with Google or email.');
  const result = await fetch(`${projectUrl}/auth/v1/user`, {
    headers: { Authorization: authorization, apikey: anonKey }, signal: AbortSignal.timeout(15000),
  });
  if (!result.ok) throw new Error('Your session expired. Sign in again.');
  const user = await result.json();
  if (!user.email_confirmed_at || !user.identities?.some((i: {provider:string;identity_data?:{email?:string;email_verified?:boolean}}) =>
    (i.provider === 'email' || (i.provider === 'google' && i.identity_data?.email_verified === true)) && i.identity_data?.email?.toLowerCase() === user.email?.toLowerCase())) {
    throw new Error('A verified Google or email account is required.');
  }
  return { userId: user.id as string, authorization };
}
export async function rpc(name: string, args: Record<string, unknown>, authorization: string) {
  const result = await fetch(`${projectUrl}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: anonKey, Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify(args), signal: AbortSignal.timeout(15000),
  });
  const data = await result.json().catch(() => null);
  if (!result.ok) throw new Error(data?.message || 'The request could not be completed.');
  return data;
}
export async function serviceRpc(name: string, args: Record<string, unknown>) {
  const result = await fetch(`${projectUrl}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args), signal: AbortSignal.timeout(15000),
  });
  if (!result.ok) throw new Error('Server operation unavailable.');
  return await result.json().catch(() => null);
}
export async function broadcast(roomId: string, payload: unknown) {
  const result = await fetch(`${projectUrl}/realtime/v1/api/broadcast`, {
    method: 'POST', headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ topic: `mobile-room:${roomId}`, event: 'message', payload, private: true }] }),
    signal: AbortSignal.timeout(15000),
  });
  if (!result.ok) throw new Error('Message could not be delivered. Try again.');
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error('Invalid identifier.');
  return value;
}
export function errorResponse(req: Request, error: unknown) {
  const message = error instanceof Error ? error.message : 'Request unavailable.';
  // Do not emit payloads, bearer tokens, device tokens or IP addresses in logs.
  const status = /sign in|session|Google|disabled|access required|unavailable.*room/i.test(message) ? 403 : 400;
  return json(req, { error: message }, status);
}
export function pushConfigured() { return Boolean(Deno.env.get('FCM_SERVICE_ACCOUNT_JSON')); }
export function observedIp(req: Request) {
  // The Supabase gateway supplies this proxy header. It is a network observation,
  // not proof of a physical device/person: VPNs, proxies and upstream header
  // handling can affect it. Never accept an IP field from the JSON body.
  const chain = req.headers.get('x-forwarded-for')?.split(',').map(x => x.trim());
  const ip = chain?.[0] ?? null;
  return { ip: ip && /^[0-9a-fA-F:.]{3,64}$/.test(ip) ? ip : null, source: 'gateway-forwarded (proxy observation)' };
}
