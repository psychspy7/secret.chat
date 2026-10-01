import { createClient } from '@supabase/supabase-js';
import { App } from '@capacitor/app';
import { Browser } from '@capacitor/browser';
import { Device, native, secureStorage } from './storage.js';

export const authRedirect = 'com.kittycorp.sidechat://auth/callback';
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
export const configured = Boolean(url?.startsWith('https://') && key && !key.includes('your-'));
export const supabase = configured ? createClient(url, key, {
  auth: { flowType: 'pkce', storage: secureStorage, persistSession: true, detectSessionInUrl: !native, autoRefreshToken: true },
  realtime: { params: { eventsPerSecond: 10 } },
}) : null;

export async function rpc(name, args = {}) {
  if (!supabase) throw new Error('The app backend has not been configured.');
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message || 'The server could not complete this request.');
  return data;
}
export async function invoke(name, body) {
  if (!supabase) throw new Error('The app backend has not been configured.');
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (error) {
    let detail;
    try { const parsed = await error.context?.json(); detail = parsed?.error; } catch { /* A network failure has no JSON response. */ }
    throw new Error(typeof detail === 'string' ? detail : error.message || 'Could not connect. Try again.');
  }
  if (data?.error) throw new Error(String(data.error));
  return data;
}
export async function signInWithGoogle() {
  if (!supabase) throw new Error('Google sign-in is unavailable until the app backend is configured.');
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: native ? authRedirect : window.location.origin, skipBrowserRedirect: true, queryParams: { prompt: 'select_account' } },
  });
  if (error) throw error;
  if (!data?.url) throw new Error('Google did not return a sign-in page.');
  if (native) await Browser.open({ url: data.url, presentationStyle: 'popover' });
  else window.location.assign(data.url);
}
export async function signInWithEmail(value) {
  if (!supabase) throw new Error('Email sign-in is unavailable until the app backend is configured.');
  const email = String(value || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: true, emailRedirectTo: native ? authRedirect : window.location.origin },
  });
  if (error) {
    if (/email_address_not_authorized|email.*not.*authorized/i.test(`${error.code} ${error.message}`)) throw new Error('Email delivery is not ready for this address yet. Continue with Google while the owner connects an email sender.');
    if (/over_email_send_rate_limit|over_request_rate_limit|rate.*limit/i.test(`${error.code} ${error.message}`)) throw new Error('Please wait before requesting another sign-in email, or continue with Google.');
    throw error;
  }
}
export async function initializeAuth(onSession, onError, onActive) {
  if (!supabase) { onSession(null); return; }
  const seenCodes = new Set();
  async function waitForUnlock() {
    if (!native) return;
    let complete;
    const unlocked = new Promise(resolve => { complete = resolve; });
    const listener = await Device.addListener('deviceUnlocked', complete);
    try { if ((await Device.getBiometricStatus()).locked) await unlocked; }
    finally { await listener.remove(); }
  }
  async function consumeUrl(raw) {
    const target = new URL(raw);
    if (target.protocol !== 'com.kittycorp.sidechat:' || target.hostname !== 'auth' || target.pathname !== '/callback') return;
    const error = target.searchParams.get('error_description') || target.searchParams.get('error');
    if (error) { onError(new Error(error.slice(0, 250))); return; }
    const code = target.searchParams.get('code');
    if (!code || seenCodes.has(code)) return;
    seenCodes.add(code);
    try {
      await waitForUnlock();
      const result = await supabase.auth.exchangeCodeForSession(code);
      await Browser.close().catch(() => {});
      if (result.error) throw result.error;
    } catch (error) { seenCodes.delete(code); throw error; }
  }
  if (native) {
    await App.addListener('appUrlOpen', ({ url: callback }) => consumeUrl(callback).catch(onError));
    await App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) void waitForUnlock().then(() => supabase.auth.startAutoRefresh()).catch(onError);
      else supabase.auth.stopAutoRefresh();
      onActive(isActive);
    });
    const launch = await App.getLaunchUrl();
    if (launch?.url) await consumeUrl(launch.url).catch(onError);
  }
  supabase.auth.onAuthStateChange((_event, session) => { setTimeout(() => onSession(session), 0); });
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  onSession(data.session);
}
