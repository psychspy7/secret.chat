import { LocalNotifications } from '@capacitor/local-notifications';
import { PushNotifications } from '@capacitor/push-notifications';
import { Device, native, localData } from './storage.js';
import { invoke } from './backend.js';
import { acceptAlert } from './alert-policy.js';

let notificationAudio;
let pushToken;
let registrationReady = false;
let currentUser;
let onOpenRoom;
let onUpdate;
let serverPushConfigured = false;
const seen = new Map();
export const notificationStatus = { enabled: false, pushConfigured: false, message: '' };
export function chirp() {
  try {
    notificationAudio ||= new Audio('./notification.mp3');
    notificationAudio.preload = 'none';
    notificationAudio.volume = 0.65;
    notificationAudio.currentTime = 0;
    void notificationAudio.play().catch(() => {});
  } catch { /* Audio is optional and may be disabled by the OS. */ }
}
export async function loadNotificationSettings(userId, openRoom, update) {
  currentUser = userId; onOpenRoom = openRoom; onUpdate = update;
  seen.clear();
  const saved = await localData.read(userId, 'preferences', {});
  notificationStatus.enabled = saved.notifications === true;
  if (native) {
    const capabilities = await Device.getCapabilities();
    notificationStatus.pushConfigured = capabilities.pushConfigured === true;
    const permission = await LocalNotifications.checkPermissions();
    if (permission.display !== 'granted') notificationStatus.enabled = false;
    if (!registrationReady) {
      registrationReady = true;
      await LocalNotifications.addListener('localNotificationActionPerformed', event => {
        if (event.notification.extra?.type === 'app_update' && event.notification.extra?.user_id === currentUser) { onUpdate?.(true); return; }
        const roomId = event.notification.extra?.room_id;
        if (roomId && currentUser && event.notification.extra?.user_id === currentUser) onOpenRoom?.(roomId);
      });
      await PushNotifications.addListener('registration', ({ value }) => {
        pushToken = value;
        if (currentUser && notificationStatus.enabled) void registerToken(value).catch(() => { notificationStatus.message = 'Background alerts could not be registered. Turn alerts off and on to retry.'; });
      });
      await PushNotifications.addListener('registrationError', () => { notificationStatus.message = 'Background alerts are unavailable. Room alerts still work while the app is open.'; });
      await PushNotifications.addListener('pushNotificationActionPerformed', event => {
        if (event.notification.data?.type === 'app_update' && event.notification.data?.user_id === currentUser) { onUpdate?.(true); return; }
        const roomId = event.notification.data?.room_id;
        if (roomId && currentUser && event.notification.data?.user_id === currentUser) onOpenRoom?.(roomId);
      });
      await PushNotifications.addListener('pushNotificationReceived', event => {
        const data = event.data;
        if (!currentUser || !notificationStatus.enabled || data?.user_id !== currentUser) return;
        if (data.type === 'app_update') { onUpdate?.(false); return; }
        if (!['room_join','room_message'].includes(data.type)) return;
        void notifyActivity(data.type, data, data.room_id, currentUser).catch(() => {});
      });
    }
    if (notificationStatus.enabled && notificationStatus.pushConfigured) await PushNotifications.register();
  }
}
async function registerToken(token) {
  const result = await invoke('mobile-device', { token });
  serverPushConfigured = result.push_configured === true;
  notificationStatus.message = serverPushConfigured ? 'Room alerts are on. Android controls sound and delivery.' : 'Room alerts are on while the app is open. The background push service is not configured yet.';
}
export async function enableNotifications() {
  if (!currentUser) throw new Error('Sign in before enabling room alerts.');
  if (native) {
    const permission = await LocalNotifications.requestPermissions();
    if (permission.display !== 'granted') throw new Error('Allow SecretChat notifications in Android Settings, then try again.');
    await LocalNotifications.createChannel({ id: 'secretchat_room_v15', name: 'Room activity', description: 'SecretChat room arrival alerts.', importance: 4, visibility: 0, vibration: true, sound: 'secretchat_ping_v15.mp3' });
  }
  notificationStatus.enabled = true;
  await localData.update(currentUser, 'preferences', {}, prefs => ({ ...prefs, notifications: true }));
  chirp();
  if (native && notificationStatus.pushConfigured) {
    const permission = await PushNotifications.requestPermissions();
    if (permission.receive === 'granted') await PushNotifications.register();
  }
  notificationStatus.message = native && !notificationStatus.pushConfigured ? 'Room alerts are on while the app is open. Background push is not configured in this build.' : native && serverPushConfigured ? 'Room alerts are on. Android controls sound and delivery.' : native ? 'Room alerts are on. Registering background notifications…' : 'Preview sound is on. Android notifications are available in the APK.';
}
export async function disableNotifications() {
  notificationStatus.enabled = false;
  if (currentUser) await localData.update(currentUser, 'preferences', {}, prefs => ({ ...prefs, notifications: false }));
  const token = pushToken;
  pushToken = undefined;
  let removalError;
  if (token) await invoke('mobile-device', { token, remove: true }).catch(error => { removalError = error; });
  if (native) {
    if (notificationStatus.pushConfigured) await PushNotifications.unregister();
    await LocalNotifications.removeAllDeliveredNotifications(); await PushNotifications.removeAllDeliveredNotifications();
  }
  if (removalError && !native) throw removalError;
}
export async function clearNotificationSession() {
  const token = pushToken;
  pushToken = undefined;
  if (token && currentUser) await invoke('mobile-device', { token, remove: true }).catch(() => {});
  if (native && notificationStatus.pushConfigured) await PushNotifications.unregister().catch(() => {});
  currentUser = null; notificationStatus.enabled = false; seen.clear();
  if (native) { await LocalNotifications.removeAllDeliveredNotifications().catch(() => {}); await PushNotifications.removeAllDeliveredNotifications().catch(() => {}); }
}
export async function announcePresence(room, event, userId) {
  if (!notificationStatus.enabled || event?.online !== true || event?.notify !== true || !event?.user_id || event.user_id === userId || currentUser !== userId) return;
  const timestamp = Date.parse(event.created_at);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 15000) return;
  await notifyActivity('room_join',event,room.id,userId);
}
async function notifyActivity(type, event, roomId, userId) {
  if (!notificationStatus.enabled || currentUser !== userId || !acceptAlert(seen,type,event,roomId)) return;
  const body = type === 'room_message' ? 'A new message arrived in your room.' : type === 'app_update' ? 'A SecretChat update is available. Tap to install.' : 'Someone joined the room.';
  if (native) {
    await LocalNotifications.schedule({ notifications: [{ id: Math.floor(Math.random() * 2000000000) + 1, title: type === 'app_update' ? 'SecretChat · Update ready' : 'SecretChat · Room activity', body, channelId: 'secretchat_room_v15', sound: 'secretchat_ping_v15.mp3', extra: { type, room_id: roomId, user_id: userId }, smallIcon: 'ic_stat_sidechat' }] });
  } else chirp();
}
export async function announceMessage(room, envelope, userId) {
  if (room.watched === false || envelope.user_id === userId) return;
  await notifyActivity('room_message',envelope,room.id,userId);
}
export async function announceUpdate(release, userId) {
  if (!notificationStatus.enabled || currentUser !== userId) return;
  const preferences = await localData.read(userId,'preferences',{});
  if (Number(preferences.notifiedRelease || 0) >= release.version_code) return;
  await notifyActivity('app_update',{event_id:String(release.version_code)},null,userId);
  await localData.update(userId,'preferences',{},old=>({...old,notifiedRelease:release.version_code}));
}
