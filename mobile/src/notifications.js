import { LocalNotifications } from '@capacitor/local-notifications';
import { PushNotifications } from '@capacitor/push-notifications';
import { Device, native, localData } from './storage.js';
import { invoke } from './backend.js';

let notificationAudio;
let pushToken;
let registrationReady = false;
let currentUser;
let onOpenRoom;
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
export async function loadNotificationSettings(userId, openRoom) {
  currentUser = userId; onOpenRoom = openRoom;
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
        const roomId = event.notification.extra?.room_id;
        if (roomId && currentUser && event.notification.extra?.user_id === currentUser) onOpenRoom?.(roomId);
      });
      await PushNotifications.addListener('registration', ({ value }) => {
        pushToken = value;
        if (currentUser && notificationStatus.enabled) void registerToken(value).catch(() => { notificationStatus.message = 'Background alerts could not be registered. Turn alerts off and on to retry.'; });
      });
      await PushNotifications.addListener('registrationError', () => { notificationStatus.message = 'Background alerts are unavailable. Room alerts still work while the app is open.'; });
      await PushNotifications.addListener('pushNotificationActionPerformed', event => {
        const roomId = event.notification.data?.room_id;
        if (roomId && currentUser && event.notification.data?.user_id === currentUser) onOpenRoom?.(roomId);
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
  const key = `${room.id}:${event.user_id}`;
  if (Date.now() - (seen.get(key) || 0) < 90000) return;
  seen.set(key, Date.now());
  for (const [item, at] of seen) if (Date.now() - at > 300000) seen.delete(item);
  if (native) {
    await LocalNotifications.schedule({ notifications: [{ id: Math.floor(Math.random() * 2000000000) + 1, title: 'SecretChat · Room activity', body: 'Someone joined the room.', channelId: 'secretchat_room_v15', sound: 'secretchat_ping_v15.mp3', extra: { room_id: room.id, user_id: userId }, smallIcon: 'ic_stat_sidechat' }] });
  } else chirp();
}
