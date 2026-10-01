import './style.css';
import { Browser } from '@capacitor/browser';
import { App } from '@capacitor/app';
import { configured, supabase, rpc, invoke, initializeAuth, signInWithGoogle, signInWithEmail } from './backend.js';
import { Device, native, localData } from './storage.js';
import { randomAccessCode, normalizeAccessCode, isAccessCode, formatAccessCode, accessCodeHash, roomKey, encryptMessage, decryptMessage, mergeHistory, MAX_MESSAGE_LENGTH } from './crypto.js';
import { notificationStatus, loadNotificationSettings, enableNotifications, disableNotifications, clearNotificationSession, announcePresence, chirp } from './notifications.js';

const app = document.querySelector('#app');
const state = { booting: true, session: null, profile: null, rooms: [], localRooms: {}, notices: [], screen: 'home', room: null, messages: [], online: [], connected: false, appActive: true, offline: !navigator.onLine, busy: '', modal: null, error: '', authError: '', admin: null, draft: '', version: { version: '1.5.0', versionCode: 6 }, biometric: { enabled: false, available: false }, update: null, updateStatus: '', launch: true, backendReady: false };
let accountGeneration = 0, authUserId = null, authLoading = false, heartbeatTimer, toastTimer, sending = false, heartbeatInFlight = false;
const subscriptions = new Map();
const keyCache = new Map();
const messageQueues = new Map();
const activityStarted = Date.now();

const paths = {
  shield: '<path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>', back: '<path d="M19 12H5m6-6-6 6 6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', hash: '<path d="m9 3-2 18M17 3l-2 18M4 9h16M3 15h16"/>',
  home: '<path d="m3 10 9-7 9 7v10H3V10Z"/><path d="M9 20v-7h6v7"/>',
  rooms: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  settings: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
  bell: '<path d="M5 16V9a7 7 0 0 1 14 0v7l2 2H3l2-2ZM10 21h4"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="3"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>', copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M15 8V3H3v12h5"/>',
  check: '<path d="m5 12 4 4L19 6"/>', send: '<path d="m3 3 18 9-18 9 4-9-4-9ZM7 12h14"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  radio: '<path d="M6 4v5M3 4h6M7 9h10v12H7V9Z"/><path d="M10 12h4M10 15h4M10 18h4M19 6c2 2 2 4 0 6M16 7c1 1 1 3 0 4"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6"/>',
  logout: '<path d="M9 4H3v16h6M10 12h11m-5-5 5 5-5 5"/>',
  heart: '<path d="M20 5c-3-3-6-1-8 1-2-2-5-4-8-1s-1 7 8 15C21 12 23 8 20 5Z"/>',
  notice: '<path d="m3 10 15-6v16L3 14v-4ZM6 15l2 6h3l-2-5M21 9v6"/>',
  trash: '<path d="M3 6h18M8 6V3h8v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>',
  wifi: '<path d="M3 8a14 14 0 0 1 18 0M6 12a9 9 0 0 1 12 0M9 16a4 4 0 0 1 6 0"/><circle cx="12" cy="20" r=".5"/>',
};
const icon = (name, extra = '') => `<svg class="icon ${extra}" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.shield}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const time = value => new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const date = value => new Date(value).toLocaleDateString([], { day: 'numeric', month: 'short' });
const expiryLabel = room => !room.expires_at || room.expires_at === 'infinity' ? 'No expiry · admin group' : `Until ${new Date(room.expires_at).toLocaleString([], {day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'})}`;
const durationOptions = (selected = 24) => Array.from({length:24}, (_,i) => `<option value="${i+1}" ${i+1===selected ? 'selected' : ''}>${i+1} ${i===0 ? 'hour' : 'hours'}</option>`).join('');
const initial = name => [...(name || 'S')][0].toUpperCase();
const userId = () => state.session?.user?.id;
const googleMark = '<svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-1.99 3.02v2.51h3.23c1.89-1.74 2.98-4.3 2.98-7.36Z"/><path fill="#34A853" d="M12 22c2.7 0 4.96-.89 6.62-2.41l-3.23-2.51c-.9.6-2.05.97-3.39.97-2.6 0-4.81-1.76-5.6-4.12H3.06v2.59A10 10 0 0 0 12 22Z"/><path fill="#FBBC05" d="M6.4 13.93A6 6 0 0 1 6.08 12c0-.67.11-1.32.32-1.93V7.48H3.06A10 10 0 0 0 2 12c0 1.61.38 3.14 1.06 4.52l3.34-2.59Z"/><path fill="#EA4335" d="M12 5.95c1.47 0 2.79.5 3.83 1.5l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.94 5.48l3.34 2.59A5.99 5.99 0 0 1 12 5.95Z"/></svg>';

function toast(message) {
  const element = document.querySelector('#toast');
  element.textContent = String(message); element.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => element.classList.remove('visible'), 4800);
}
function friendly(error) {
  const text = error?.message || 'Something went wrong. Please try again.';
  if (/provider.*disabled|unsupported provider|provider is not enabled/i.test(text)) return 'Google sign-in is not enabled for this app yet. The owner needs to enable Google in Supabase Authentication.';
  if (/function .* does not exist|Could not find the function|schema cache/i.test(text)) return 'The mobile backend needs its latest database update. Ask the app owner to finish mobile setup.';
  if (/Failed to fetch|NetworkError|network request failed|Failed to send a request/i.test(text)) return 'Could not reach SecretChat. Check your connection and try again.';
  return text.slice(0, 280);
}
const loading = label => `<span class="spinner" aria-hidden="true"></span>${esc(label)}`;
const button = (action, label, cls = 'primary', glyph = '', disabled = false) => `<button class="button ${cls}" data-action="${action}" ${disabled || state.busy ? 'disabled' : ''}>${state.busy === action ? loading('Please wait') : `${glyph ? icon(glyph) : ''}<span>${esc(label)}</span>`}</button>`;
function brand() { return `<span class="brand-mark"><img src="./secretchat-icon.jpg" width="31" height="31" alt="" /></span><span class="brand-word">SecretChat<span class="brand-dot">.</span></span>`; }
function launchMarkup() { return `<div class="launch" role="status"><div class="launch-grid"></div><div class="launch-orbit orbit-a"></div><div class="launch-orbit orbit-b"></div><div class="launch-center"><span class="launch-mark"><img src="./secretchat-icon.jpg" width="96" height="96" alt="SecretChat" /></span><h1>SecretChat<span>.</span></h1><p>A quieter place to connect.</p><div class="launch-line"></div><span class="eyebrow">KITTY CORP. / PRIVATE COMMS</span></div><button class="launch-skip" data-action="skip-launch">Enter ${icon('arrow')}</button></div>`; }
function footerBrand() { return `<button class="corp-link" data-action="kitty">Managed by <strong>Kitty Corp.</strong>${icon('arrow')}</button>`; }
function render() {
  const previousScroll = document.querySelector('.screen')?.scrollTop || 0;
  const previousForm = document.querySelector('.modal form');
  const formValues = previousForm ? [...new FormData(previousForm)] : [];
  const checkboxValues = previousForm ? [...previousForm.querySelectorAll('input[type="checkbox"]')].map(field => [field.name, field.checked]) : [];
  const previousFormId = previousForm?.id;
  app.innerHTML = `${state.session && state.profile ? shellMarkup() : welcomeMarkup()}${state.modal ? modalMarkup() : ''}${state.launch ? launchMarkup() : ''}`;
  if (state.screen === 'admin' && state.profile?.is_admin === true && state.admin) document.querySelector('.screen')?.insertAdjacentHTML('beforeend', `${adminLifetimeMarkup()}${releaseAdminMarkup()}`);
  if (state.screen === 'account' && state.profile) document.querySelector('.settings-group')?.insertAdjacentHTML('beforeend', `<button class="setting" data-action="fingerprint"><span class="square-icon">${icon('lock')}</span><span><strong>Fingerprint app lock</strong><small>${native ? state.biometric.enabled ? 'On · locks when you leave the app' : state.biometric.available ? 'Off · tap to enable' : 'Enrol a strong biometric in Android Settings' : 'Available in the Android app'}</small></span><span class="toggle ${state.biometric.enabled ? 'on' : ''}" aria-hidden="true"></span></button>${state.profile.is_admin ? '<p class="setting-detail">Your verified administrator session may capture screenshots while the app is unlocked. The app switcher remains protected.</p>' : ''}`);
  const replacementForm = document.querySelector('.modal form');
  if (replacementForm?.id === previousFormId) for (const [name, value] of formValues) { const field = replacementForm.elements.namedItem(name); if (field) field.value = value; }
  if (replacementForm?.id === previousFormId) for (const [name, checked] of checkboxValues) { const field = replacementForm.elements.namedItem(name); if (field) field.checked = checked; }
  const screen = document.querySelector('.screen');
  if (screen) screen.scrollTop = previousScroll;
  if (state.screen === 'chat') renderMessages(true);
  if (state.modal) setTimeout(() => document.querySelector('.modal input, .modal textarea, .modal button')?.focus(), 120);
}
function welcomeMarkup() {
  const pending = state.booting || authLoading;
  return `<div class="welcome"><header class="welcome-header">${brand()}<span class="beta">V1.5 · BETA</span></header>
    <main class="welcome-main"><div class="signal-scene" aria-hidden="true"><div class="signal-ring r1"></div><div class="signal-ring r2"></div><div class="signal-ring r3"></div><div class="signal-core"><img src="./secretchat-icon.jpg" width="72" height="72" alt="" /></div><span class="signal-dot d1"></span><span class="signal-dot d2"></span><span class="signal-label">SIGNAL ESTABLISHED</span></div>
    <span class="eyebrow mint">YOUR PEOPLE. YOUR SPACE.</span><h1>Off the noise.<br><span>On your frequency.</span></h1><p class="welcome-copy">Small rooms. Live conversation.<br>Encrypted chats that stay on your device.</p>
    <div class="trust-row"><span>${icon('lock')}Encrypted messages</span><span>${icon('settings')}Your verified account</span></div>
    ${!configured ? '<div class="error-card"><strong>Connection setup required</strong><p>The app owner needs to finish this build’s backend connection.</p></div>' : `<button class="google-button" data-action="google" ${pending || state.busy ? 'disabled' : ''}>${pending ? loading('Connecting securely') : `${googleMark}<span>Continue with Google</span>${icon('arrow')}`}</button><button class="button secondary full email-button" data-action="email" ${pending || state.busy ? 'disabled' : ''}>Continue with email ${icon('arrow')}</button>`}
    ${state.authError ? `<p class="inline-error" role="alert">${esc(state.authError)}</p>` : ''}<p class="welcome-fine">Your account keeps your identity and room membership. Chat history stays on this device and is not restored by signing in.</p><button class="text-button" data-action="privacy">How your privacy works ${icon('arrow')}</button></main>
    <footer>${footerBrand()}${!native ? '<span class="preview-label">Browser preview · Android features require the APK</span>' : ''}</footer></div>`;
}
function shellMarkup() {
  const chat = state.screen === 'chat';
  return `<div class="app-shell ${chat ? 'chat-shell' : ''}"><header class="topbar">${chat ? `<button class="icon-button" aria-label="Leave conversation view" data-action="back">${icon('back')}</button><div class="chat-heading"><strong>${esc(state.room?.label || 'Room')}</strong><span id="connection-label">${state.connected ? '<i class="status-dot"></i>Encrypted live channel' : 'Connecting to room…'}</span></div><button class="icon-button" aria-label="Room options" data-action="room-options">${icon('more')}</button>` : `<div class="brand">${brand()}</div><button class="avatar" data-action="account" aria-label="Your account">${esc(initial(state.profile.display_name))}</button>`}</header>${state.offline ? `<div class="offline-banner">${icon('wifi')}You are offline. Saved chats are still available.</div>` : ''}${state.error ? `<div class="error-banner" role="alert">${esc(state.error)}<button data-action="dismiss-error" aria-label="Dismiss">×</button></div>` : ''}<main class="screen ${chat ? 'chat-screen' : ''}">${state.screen === 'home' ? homeMarkup() : state.screen === 'rooms' ? roomsMarkup() : state.screen === 'account' ? accountMarkup() : state.screen === 'admin' ? adminMarkup() : chatMarkup()}</main>${!chat ? navMarkup() : ''}</div>`;
}
function navMarkup() {
  const items = [['home', 'Signal', 'home'], ['rooms', 'Rooms', 'rooms'], ['account', 'You', 'settings']];
  if (state.profile?.is_admin === true) items.push(['admin', 'Control', 'shield']);
  return `<nav class="bottom-nav" aria-label="Main navigation">${items.map(([name, label, glyph]) => `<button data-action="${name}" class="nav-item ${state.screen === name ? 'active' : ''}" ${state.screen === name ? 'aria-current="page"' : ''}>${icon(glyph)}<span>${label}</span></button>`).join('')}</nav>`;
}
function homeMarkup() {
  const count = state.rooms.filter(room => !room.closed_at).length;
  return `<div class="page-intro"><span class="eyebrow">YOUR PRIVATE FREQUENCY</span><h1>Welcome back,<br><span>${esc((state.profile.display_name || 'friend').split(' ')[0])}.</span></h1><p>A little space. For the people who matter.</p></div><section class="hero-card"><div class="hero-content"><span class="chip"><i class="status-dot"></i>READY TO CONNECT</span><h2>Start a<br>conversation.</h2><p>Create a room. Share its invitation.<br>Keep the moment between you.</p>${button('create', 'Create a room', 'primary', 'plus', !state.backendReady)}</div><div class="hero-art" aria-hidden="true"><div class="hero-circle"></div>${icon('radio')}</div><span class="hero-index">SC / 01</span></section><button class="join-card" data-action="join" ${!state.backendReady ? 'disabled' : ''}><span class="square-icon">${icon('hash')}</span><span><strong>Have an invitation?</strong><small>Enter your room code</small></span>${icon('arrow')}</button><div class="section-title"><h2>Your rooms <span>${count.toString().padStart(2, '0')}</span></h2><button class="text-button" data-action="rooms">View all ${icon('arrow')}</button></div>${state.rooms.length ? `<div class="room-list">${state.rooms.slice(0, 3).map(roomCard).join('')}</div>` : emptyRooms()}${noticesMarkup()}<div class="quiet-note">${icon('lock')}Your messages are encrypted before they leave your device.</div>${footerBrand()}`;
}
function emptyRooms() { return `<div class="empty-card"><span class="empty-icon">${icon('rooms')}</span><strong>Your next conversation starts here.</strong><p>Create a room or enter an invitation code.</p></div>`; }
function roomCard(room) {
  const remembered = state.localRooms[room.id];
  return `<button class="room-card ${room.closed_at ? 'closed' : ''}" data-action="open-room" data-id="${esc(room.id)}"><span class="room-avatar">${icon(room.closed_at || !remembered?.code ? 'lock' : 'hash')}</span><span class="room-info"><strong>${esc(room.label)}</strong><small>${room.closed_at ? 'Room closed · local history remains' : !remembered?.code ? 'Invitation needed on this device' : `${room.is_creator ? 'Created by you' : 'Joined room'} · ${room.member_count ?? 1} members`}</small>${!room.closed_at ? `<small>${esc(expiryLabel(room))}</small>` : ''}</span><span class="room-end">${room.online_count > 0 && !room.closed_at ? `<span class="room-online"><i class="status-dot"></i>${room.online_count}</span>` : ''}${icon('arrow')}</span></button>`;
}
function roomsMarkup() { return `<div class="page-intro compact"><span class="eyebrow">SAVED CONNECTIONS</span><h1>Your rooms<span>.</span></h1><p>Your memberships follow your account.<br>Invitations and messages stay on this device.</p></div><div class="paired-actions">${button('create', 'Create room', 'primary', 'plus', !state.backendReady)}${button('join', 'Join room', 'secondary', 'hash', !state.backendReady)}</div><div class="section-title"><h2>Conversations</h2><button class="text-button" data-action="refresh">Refresh</button></div><div class="room-list">${state.rooms.length ? state.rooms.map(roomCard).join('') : emptyRooms()}</div><p class="small-note">Up to four recent rooms are watched for live join alerts while the app is open. Background alerts require notification permission and a configured push service.</p>`; }
function noticesMarkup() { return state.notices.length ? `<div class="section-title"><h2>From Kitty Corp.</h2><span class="eyebrow">BULLETIN</span></div><div class="notice-list">${state.notices.slice(0, 5).map(item => `<article class="notice"><span class="notice-icon">${icon('notice')}</span><div><span class="eyebrow">${esc(date(item.created_at))}</span><h3>${esc(item.title)}</h3><p>${esc(item.body)}</p></div></article>`).join('')}</div>` : ''; }
function accountMarkup() {
  return `<div class="page-intro compact"><span class="eyebrow">YOUR IDENTITY</span><h1>Make it yours<span>.</span></h1></div><div class="profile-card"><span class="avatar large">${esc(initial(state.profile.display_name))}</span><div><strong>${esc(state.profile.display_name)}</strong><small>${esc(state.session.user.email || 'Verified account')}</small><span class="identity-pill">${state.profile.is_admin ? 'Administrator' : 'Member'} · Email verified</span></div><button class="text-button" data-action="edit-name">Edit</button></div><section class="settings-group"><h2>Experience</h2><button class="setting" data-action="notifications"><span class="square-icon">${icon('bell')}</span><span><strong>Room activity alerts</strong><small>${notificationStatus.enabled ? 'On · SecretChat notification sound' : 'Off · tap to enable'}</small></span><span class="toggle ${notificationStatus.enabled ? 'on' : ''}" aria-hidden="true"></span></button>${notificationStatus.message ? `<p class="setting-detail">${esc(notificationStatus.message)}</p>` : ''}<button class="setting" data-action="test-sound"><span class="square-icon">${icon('radio')}</span><span><strong>Preview notification sound</strong><small>Your chosen room arrival sound</small></span>${icon('arrow')}</button></section><section class="settings-group"><h2>App & device</h2><button class="setting" data-action="update"><span class="square-icon">${icon('download')}</span><span><strong>${state.busy === 'update' ? 'Checking for updates…' : 'Check for updates'}</strong><small>Version ${esc(state.version.version)} · build ${esc(state.version.versionCode)}</small></span>${icon('arrow')}</button>${state.updateStatus ? `<p class="setting-detail">${esc(state.updateStatus)}</p>` : ''}<button class="setting" data-action="privacy"><span class="square-icon">${icon('shield')}</span><span><strong>Privacy & local storage</strong><small>Understand what is stored where</small></span>${icon('arrow')}</button><button class="setting" data-action="clear-all"><span class="square-icon">${icon('trash')}</span><span><strong>Clear chats on this device</strong><small>Remove your saved message history</small></span>${icon('arrow')}</button></section><section class="settings-group"><button class="setting" data-action="support"><span class="square-icon">${icon('heart')}</span><span><strong>Support SecretChat</strong><small>Help us keep the conversation going</small></span>${icon('arrow')}</button><button class="setting" data-action="signout"><span class="square-icon">${icon('logout')}</span><span><strong>Sign out</strong><small>Encrypted history remains on this device</small></span>${icon('arrow')}</button></section>${footerBrand()}<p class="build-note">SECRETCHAT / ANDROID BETA ${esc(state.version.version)}${!native ? '<br>Browser preview · native security and updates require Android' : ''}</p>`;
}
function chatMarkup() {
  const closed = !!state.room?.closed_at;
  return `<div class="chat-context"><span>${icon('lock')}DEVICE-STORED CHAT</span><button class="text-button" data-action="members"><span id="online-count">${state.online.length} online</span>${icon('settings')}</button></div><div id="messages" class="messages" role="log" aria-label="Room messages" aria-live="polite" aria-relevant="additions"></div><div class="composer-area">${closed ? `<div class="closed-message">This room is closed. Your saved history is still on this device.</div>` : `<form id="message-form" class="composer"><textarea id="message-input" name="message" aria-label="Message" placeholder="Say something…" rows="1" maxlength="${MAX_MESSAGE_LENGTH}" enterkeyhint="send">${esc(state.draft)}</textarea><button id="message-send" class="send-button" type="submit" aria-label="Send encrypted message" ${sending || !state.connected || state.offline ? 'disabled' : ''}>${icon('send')}</button></form><div class="composer-caption">${icon('lock')}End-to-end encrypted · live delivery</div>`}</div>`;
}
function renderMessages(forceBottom = false) {
  const list = document.querySelector('#messages');
  if (!list) return;
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 100;
  if (!state.messages.length) list.innerHTML = `<div class="chat-empty"><span>${icon('radio')}</span><h2>You're on the same frequency.</h2><p>Messages arrive live and are saved on this device. Messages sent while you are offline are not available later.</p><span class="chat-empty-chip">A NEW CONVERSATION STARTS HERE</span></div>`;
  else {
    let lastDate = '';
    const desired = [];
    const existing = new Map([...list.children].map(node => [node.dataset.key, node]));
    const obtain = (key, html) => {
      let node = existing.get(key);
      if (!node) { const template = document.createElement('template'); template.innerHTML = html; node = template.content.firstElementChild; node.dataset.key = key; }
      desired.push(node);
    };
    for (const message of state.messages) {
      const day = date(message.created_at), dayKey = new Date(message.created_at).toLocaleDateString();
      if (dayKey !== lastDate) obtain(`day:${dayKey}`, `<div class="date-divider"><span>${esc(day)}</span></div>`);
      lastDate = dayKey;
      const self = message.user_id === userId();
      obtain(`message:${message.id}`, `<article class="message ${self ? 'self' : ''}"><div class="message-meta"><strong>${message.is_creator ? `Host (${esc(message.display_name)})` : esc(message.display_name)}</strong>${self ? '<span>YOU</span>' : ''}</div><div class="message-bubble"><p>${esc(message.text)}</p><span class="message-time">${esc(time(message.created_at))}${self ? icon('check') : ''}</span></div></article>`);
    }
    const retained = new Set(desired);
    for (const child of [...list.children]) if (!retained.has(child)) child.remove();
    desired.forEach((node, index) => { if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null); });
  }
  if (forceBottom || nearBottom) requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
}
function connectionLabel() {
  const target = document.querySelector('#connection-label');
  if (target) target.innerHTML = state.room?.closed_at ? 'Room closed · saved locally' : state.connected ? '<i class="status-dot"></i>Encrypted live channel' : state.offline ? 'Offline · saved locally' : 'Connecting to room…';
  const send = document.querySelector('#message-send');
  if (send) send.disabled = sending || !state.connected || state.offline;
  const count = document.querySelector('#online-count');
  if (count) count.textContent = `${state.online.length} online`;
}
function adminMarkup() {
  if (state.profile?.is_admin !== true) return '';
  const overview = state.admin;
  if (!overview) return `<div class="page-intro"><span class="eyebrow">KITTY CORP. / CONTROL</span><h1>Control room<span>.</span></h1><p>Loading administrator tools…</p></div>`;
  const requests = overview.deletion_requests.filter(item => item.status === 'pending');
  return `<div class="page-intro compact"><span class="eyebrow">KITTY CORP. / ADMINISTRATOR</span><h1>Control room<span>.</span></h1><p>Manage rooms, members, and announcements.</p></div><div class="admin-stats"><div><strong>${overview.profiles.length}</strong><span>Members</span></div><div><strong>${overview.rooms.filter(room => !room.closed_at).length}</strong><span>Open rooms</span></div><div><strong>${requests.length}</strong><span>Requests</span></div></div><div class="section-title"><h2>Deletion requests</h2><button class="text-button" data-action="refresh-admin">Refresh</button></div>${requests.length ? requests.map(item => `<article class="admin-card"><strong>${esc(item.room_label)}</strong><p>${esc(item.display_name)} requested room deletion.</p><div class="paired-actions"><button class="button danger" data-action="approve-delete" data-id="${esc(item.id)}" ${state.busy ? 'disabled' : ''}>Approve</button><button class="button secondary" data-action="reject-delete" data-id="${esc(item.id)}" ${state.busy ? 'disabled' : ''}>Decline</button></div></article>`).join('') : '<p class="empty-inline">No pending requests.</p>'}<div class="section-title"><h2>Notices</h2><button class="text-button" data-action="new-notice">Publish ${icon('plus')}</button></div>${overview.notices.map(item => `<article class="admin-card"><strong>${esc(item.title)}</strong><p>${esc(item.body)}</p><button class="text-button danger-text" data-action="remove-notice" data-id="${esc(item.id)}">Remove notice</button></article>`).join('') || '<p class="empty-inline">No notices published.</p>'}<div class="section-title"><h2>Rooms</h2></div>${overview.rooms.map(room => `<article class="admin-card"><strong>${esc(room.label)}</strong><p>${room.member_count} members · ${room.closed_at ? 'Closed' : 'Open'}</p>${!room.closed_at ? `<button class="text-button danger-text" data-action="admin-close-room" data-id="${esc(room.id)}">Close room</button>` : ''}</article>`).join('')}<div class="section-title"><h2>Members</h2></div>${overview.profiles.map(person => `<article class="admin-card"><div class="admin-person"><strong>${esc(person.display_name)}</strong><span class="eyebrow">${person.disabled ? 'DISABLED' : 'ACTIVE'}</span></div><p class="metadata">IP: ${esc(person.last_ip || 'Not recorded')}<br>Updated: ${esc(date(person.updated_at))}</p>${person.user_id !== userId() ? `<button class="text-button ${person.disabled ? '' : 'danger-text'}" data-action="toggle-member" data-id="${esc(person.user_id)}" data-disabled="${person.disabled ? 'false' : 'true'}">${person.disabled ? 'Enable member' : 'Disable member'}</button>` : ''}</article>`).join('')}<div class="quiet-note">${icon('lock')}These controls show account and room metadata. Mobile message contents are stored on participants’ devices.</div>`;
}
function releaseAdminMarkup() {
  const release = state.admin.release;
  return `<div class="section-title"><h2>Android releases</h2><button class="text-button" data-action="new-release">Publish ${icon('plus')}</button></div><article class="admin-card">${release ? `<strong>SecretChat ${esc(release.version)} · build ${esc(release.version_code)}</strong><p>${esc(release.notes || 'Latest published update')}</p>` : '<strong>No update published yet</strong><p>Upload your signed APK to a direct HTTPS download, then publish its version and SHA-256 checksum here.</p>'}<p class="small-note">Use the same Android signing key for every release and increase the build number. Publishing makes this update available through members’ Check for updates button.</p></article>`;
}
function adminLifetimeMarkup() {
  const requests = (state.admin.extension_requests || []).filter(item => item.status === 'pending');
  return `<div class="section-title"><h2>Room lifetimes</h2></div>${button('admin-create-group','Create a group with no expiry','primary full','plus')}
    <p class="small-note">Only administrators can create groups without an expiry. Capacity and member limits still apply.</p>
    <div class="section-title"><h2>Extension requests <span>${requests.length}</span></h2></div>
    ${requests.map(item => `<article class="admin-card"><strong>${esc(item.room_label)}</strong><p>${esc(item.display_name)} requests ${item.hours} extra hours.</p><div class="paired-actions"><button class="button primary" data-action="approve-extension" data-id="${esc(item.id)}" ${state.busy ? 'disabled' : ''}>Approve</button><button class="button secondary" data-action="reject-extension" data-id="${esc(item.id)}" ${state.busy ? 'disabled' : ''}>Decline</button></div></article>`).join('') || '<p class="empty-inline">No pending extension requests.</p>'}
    ${state.admin.rooms.filter(room => !room.closed_at && room.expires_at !== 'infinity').map(room => `<article class="admin-card"><strong>${esc(room.label)}</strong><p>${esc(expiryLabel(room))}</p><button class="text-button" data-action="admin-extend-room" data-id="${esc(room.id)}">Extend time ${icon('plus')}</button></article>`).join('')}`;
}
function modalMarkup() {
  const modal = state.modal;
  let content = '';
  if (modal.type === 'email') content = `<span class="modal-emblem">${icon('lock')}</span><span class="eyebrow">EMAIL SIGN-IN</span><h2>${modal.sent ? 'Check your inbox.' : 'Your email. Your space.'}</h2>${modal.sent ? '<p>Open the one-time sign-in link on this device to return to SecretChat. Check spam if needed. The link expires; request a new one if it no longer works.</p>' : '<p>We’ll send a one-time sign-in link. You don’t need a password.</p>'}<form id="email-form"><label>Email address<input type="email" name="email" autocomplete="email" maxlength="254" value="${esc(modal.email || '')}" required /></label><button class="button primary full" type="submit" ${state.busy || modal.sent ? 'disabled' : ''}>${state.busy ? loading('Sending sign-in link') : 'Send sign-in link'}</button></form><p class="small-note">If email delivery is unavailable, continue with Google. Your local history stays associated with your account.</p>`;
  if (modal.type === 'request-extension' || modal.type === 'admin-extension') {
    const admin = modal.type === 'admin-extension', room = admin ? modal.room : state.room;
    content = `<span class="modal-emblem">${icon('plus')}</span><span class="eyebrow">${admin ? 'ADMINISTRATOR CONTROL' : 'ROOM EXTENSION REQUEST'}</span><h2>Keep the conversation going.</h2><p>${esc(room.label)} · ${esc(expiryLabel(room))}</p><form id="extension-form" data-admin="${admin}" data-id="${esc(room.id)}"><label>Extra hours${admin ? '<input name="hours" type="number" min="1" max="8760" step="1" value="24" required />' : `<select name="hours">${durationOptions()}</select>`}</label><p class="small-note">${admin ? 'Adds time to the current expiry, or from now if the room already expired. Closed rooms stay closed.' : 'The administrator must approve your request before the expiry changes.'}</p><button class="button primary full" type="submit" ${state.busy ? 'disabled' : ''}>${state.busy ? loading('Saving') : admin ? 'Extend room' : 'Send request'}</button></form>`;
  }
  if (modal.type === 'create' || modal.type === 'join') content = `<span class="modal-emblem">${icon(modal.type === 'create' ? 'plus' : 'hash')}</span><span class="eyebrow">${modal.type === 'create' ? 'A NEW FREQUENCY' : 'WELCOME TO THE ROOM'}</span><h2>${modal.type === 'create' ? 'Make some space.' : 'Tune in.'}</h2><p>${modal.type === 'create' ? 'Share your invitation only with people you trust.' : 'Paste the complete invitation code to unlock this room.'}</p><form id="room-form" data-type="${modal.type}"><label>Your name<input name="displayName" autocomplete="nickname" maxlength="40" placeholder="How should we call you?" value="${esc(state.profile.display_name)}" required /></label>${modal.type === 'create' ? createRoomFields(modal) : `<label>Room invitation<textarea name="code" class="code-input" placeholder="KT…" rows="2" autocapitalize="characters" spellcheck="false" required>${esc(modal.code || '')}</textarea></label>`}<p class="small-note">${modal.type === 'create' ? 'A room creator is a regular participant. Only the app administrator can approve room deletion.' : 'An invitation unlocks this room. Never share it in a public post.'}</p><button class="button primary full" type="submit" ${state.busy ? 'disabled' : ''}>${state.busy ? loading('Connecting') : `${modal.type === 'create' ? 'Create room' : 'Join room'}${icon('arrow')}`}</button></form>`;
  if (modal.type === 'invite') content = `<span class="modal-emblem">${icon('lock')}</span><span class="eyebrow">YOUR INVITATION</span><h2>Let your people in.</h2><p>Anyone with this code can join and decrypt new messages. Share it privately.</p><div class="invite-code">${esc(formatAccessCode(modal.code))}</div>${button('copy-invite', 'Copy invitation', 'primary full', 'copy')}<p class="small-note">This is the encryption key for your mobile room. Web rooms use a separate system.</p>`;
  if (modal.type === 'privacy') content = `<span class="modal-emblem">${icon('shield')}</span><span class="eyebrow">PRIVACY, EXPLAINED</span><h2>Built for a smaller circle.</h2><div class="privacy-points"><div><strong>Encrypted between participants</strong><p>Messages are encrypted on your device using your room invitation. The mobile relay cannot read them.</p></div><div><strong>Your history lives here</strong><p>Up to 500 messages per room stay encrypted on this device. No chat cloud backup. Changing phones, clearing app data, or uninstalling can erase your history and saved invitations.</p></div><div><strong>Clear about metadata</strong><p>The backend keeps your account identity, display name, room memberships, and observed IP address. The Kitty Corp. administrator can view this metadata.</p></div><div><strong>A shared responsibility</strong><p>Keep invitations private. Participants can copy messages or photograph another screen. Android screen capture protection cannot prevent every form of capture.</p></div></div>${button('close-modal', 'Got it', 'primary full')}`;
  if (modal.type === 'room-options') { const room = state.room; content = `<span class="eyebrow">ROOM SETTINGS</span><h2>${esc(room.label)}</h2><div class="modal-actions">${!room.closed_at ? button('show-invite', 'Share invitation', 'secondary full', 'copy') : ''}${!room.closed_at ? button('toggle-watch', room.watched === false ? 'Watch room activity' : 'Stop watching room activity', 'secondary full', 'bell') : ''}${room.is_creator && !room.closed_at && room.expires_at !== 'infinity' ? button('request-extension', 'Request more time', 'secondary full', 'plus') : ''}${button('clear-room', 'Clear history on this device', 'secondary full', 'trash')}${room.is_creator && !room.closed_at ? button('request-delete', 'Request room deletion', 'secondary full', 'trash') : ''}${button('leave-view', 'Leave conversation', 'primary full', 'logout')}</div><p class="small-note">${esc(expiryLabel(room))}. Leaving this screen ends your online presence. Your saved conversation remains in Rooms.</p>`; }
  if (modal.type === 'members') content = `<span class="eyebrow">LIVE PRESENCE</span><h2>On this frequency.</h2><p>${state.online.length} ${state.online.length === 1 ? 'person' : 'people'} online right now</p><div class="member-list">${state.online.map(person => `<div><span class="avatar">${esc(initial(person.display_name))}</span><strong>${person.is_creator ? `Host (${esc(person.display_name)})` : esc(person.display_name)}${person.user_id === userId() ? ' · You' : ''}</strong><i class="status-dot"></i></div>`).join('') || '<p>No active participants.</p>'}</div>`;
  if (modal.type === 'edit-name') content = `<span class="eyebrow">YOUR CALL SIGN</span><h2>What should we call you?</h2><form id="name-form"><label>Display name<input name="displayName" value="${esc(state.profile.display_name)}" maxlength="40" autocomplete="nickname" required /></label><button class="button primary full" ${state.busy ? 'disabled' : ''}>Save name ${icon('check')}</button></form>`;
  if (modal.type === 'support') content = `<span class="modal-emblem">${icon('heart')}</span><span class="eyebrow">SUPPORT THE SIGNAL</span><h2>A little help.<br>A lot of possibility.</h2><p>Support hosting and future SecretChat improvements. Donations are optional.</p><div class="wallet"><strong>Bitcoin · BTC</strong><small>Network: BITCOIN</small><code>bc1qvn36dkzq7wjq634j6yszg87yy252h7tx97pluc</code><button class="text-button" data-action="copy-btc">Copy address ${icon('copy')}</button></div><div class="wallet"><strong>Tether · USDT</strong><small>Network: ETHEREUM</small><code>0x5fa72e223cF8F270aC7bb329ceADBC2b4610d098</code><button class="text-button" data-action="copy-usdt">Copy address ${icon('copy')}</button></div><p class="small-note">Use the matching coin and network.</p>`;
  if (modal.type === 'new-notice') content = `<span class="eyebrow">KITTY CORP. BULLETIN</span><h2>Share an update.</h2><form id="notice-form"><label>Title<input name="title" maxlength="100" required /></label><label>Notice<textarea name="body" rows="5" maxlength="2000" required></textarea></label><button class="button primary full" ${state.busy ? 'disabled' : ''}>Publish notice ${icon('notice')}</button></form>`;
  if (modal.type === 'new-release') content = `<span class="eyebrow">ANDROID UPDATE SERVICE</span><h2>Publish an app update.</h2><p>First upload the signed APK to a direct HTTPS download. Only signed builds using the existing app signing key can update this app.</p><form id="release-form"><div class="paired-actions"><label>Version<input name="version" placeholder="1.0.1" maxlength="30" required /></label><label>Build number<input name="versionCode" type="number" min="${Math.max(Number(state.version.versionCode), Number(state.admin?.release?.version_code || 0)) + 1}" step="1" placeholder="2" required /></label></div><label>Direct HTTPS APK URL<input name="url" type="url" placeholder="https://example.com/secretchat.apk" required /></label><label>APK SHA-256 checksum<input name="sha256" autocapitalize="none" spellcheck="false" minlength="64" maxlength="64" pattern="[a-fA-F0-9]{64}" placeholder="64 hexadecimal characters" required /></label><label>What’s new<textarea name="notes" rows="4" maxlength="2000" placeholder="Tell members what changed."></textarea></label><button class="button primary full" ${state.busy ? 'disabled' : ''}>Publish update ${icon('download')}</button></form>`;
  if (modal.type === 'confirm') content = `<span class="modal-emblem">${icon(modal.icon || 'shield')}</span><h2>${esc(modal.title)}</h2><p>${esc(modal.body)}</p><div class="paired-actions">${button('close-modal', 'Cancel', 'secondary')}${button('confirm', modal.label || 'Continue', modal.danger ? 'danger' : 'primary')}</div>`;
  if (modal.type === 'update') content = `<span class="modal-emblem">${icon('download')}</span><span class="eyebrow">FRESH ON THE FREQUENCY</span><h2>SecretChat ${esc(state.update.version)}</h2><p>${esc(state.update.notes || 'An update is ready for your device.')}</p><p class="small-note">Android will ask you to confirm installation. The APK checksum and signing certificate are checked before installation.</p>${button('install-update', 'Download & update', 'primary full', 'download')}`;
  return `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true" aria-label="${esc(modal.type.replaceAll('-', ' '))}"><div class="modal-handle"></div><button class="modal-close icon-button" data-action="close-modal" aria-label="Close dialog" ${state.busy ? 'disabled' : ''}>${icon('close')}</button>${content}${state.error ? `<p class="inline-error" role="alert">${esc(state.error)}</p>` : ''}</section></div>`;
}
function createRoomFields(modal) {
  return `<label>Room name<input name="label" maxlength="60" placeholder="e.g. The night shift" required /></label><label>Room duration<select name="duration">${durationOptions()}</select></label>${state.profile.is_admin ? `<label class="check-label"><input name="permanent" type="checkbox" ${modal.permanent ? 'checked' : ''} />Group with no expiry</label>` : ''}`;
}

async function run(action, task, fullRender = true) {
  if (state.busy) return;
  state.busy = action; state.error = '';
  if (fullRender) render();
  try { return await task(); }
  catch (error) { state.error = friendly(error); toast(state.error); }
  finally { state.busy = ''; if (fullRender) render(); }
}
function openModal(type, data = {}) { state.error = ''; state.modal = { type, ...data }; render(); }
function confirmAction(title, body, task, options = {}) { openModal('confirm', { title, body, task, ...options }); }
async function refreshRooms() {
  const account = userId(), generation = accountGeneration;
  const [rooms, notices] = await Promise.all([rpc('mobile_rooms'), rpc('mobile_notices')]);
  if (generation !== accountGeneration || account !== userId()) return;
  const remoteRooms = (Array.isArray(rooms) ? rooms : []).map(room => ({ ...room, closed_at: room.closed_at || (room.expires_at && Date.parse(room.expires_at) <= Date.now() ? room.expires_at : null) }));
  const remoteIds = new Set(remoteRooms.map(room => room.id));
  const archives = Object.entries(state.localRooms).filter(([id]) => !remoteIds.has(id)).map(([id, saved]) => ({ ...saved, id, label: saved.label || 'Archived room', closed_at: saved.closed_at || saved.expires_at || new Date().toISOString(), member_count: saved.member_count || 1 }));
  state.rooms = [...remoteRooms, ...archives];
  state.notices = Array.isArray(notices) ? notices : [];
  await localData.write(account, 'room-index', state.rooms);
  await localData.write(account, 'notices', state.notices);
  if (generation !== accountGeneration || account !== userId()) return;
  state.backendReady = true;
  await syncSubscriptions();
}
async function rememberRoom(room, code) {
  const account = userId(), generation = accountGeneration;
  const result = await localData.update(account, 'rooms', {}, old => ({ ...old, [room.id]: { code, label: room.label, created_by: room.created_by, created_at: room.created_at, expires_at: room.expires_at, closed_at: room.closed_at, is_creator: room.is_creator, member_count: room.member_count, last_opened: Date.now() } }));
  if (generation === accountGeneration && account === userId()) state.localRooms = result;
}
async function keyFor(roomId) {
  const code = state.localRooms[roomId]?.code;
  if (!isAccessCode(code)) throw new Error('Enter the room invitation to unlock this device.');
  if (!keyCache.has(roomId)) keyCache.set(roomId, roomKey(code));
  return keyCache.get(roomId);
}
async function receiveMessage(envelope, roomId, account, generation) {
  if (generation !== accountGeneration || account !== userId()) return;
  const decoded = await decryptMessage(await keyFor(roomId), envelope, roomId);
  if (generation !== accountGeneration || account !== userId()) return;
  const messages = await localData.saveMessages(account, roomId, decoded);
  if (state.room?.id === roomId && generation === accountGeneration) { state.messages = messages; renderMessages(); }
}
function queueMessage(envelope, roomId, account, generation) {
  const previous = messageQueues.get(roomId) || Promise.resolve();
  const task = previous.catch(() => {}).then(() => receiveMessage(envelope, roomId, account, generation));
  messageQueues.set(roomId, task);
  task.catch(() => { if (generation === accountGeneration && state.room?.id === roomId) toast('A message could not be verified and was not displayed.'); }).finally(() => { if (messageQueues.get(roomId) === task) messageQueues.delete(roomId); });
}
async function syncSubscriptions() {
  if (!supabase || !userId()) return;
  const account = userId(), generation = accountGeneration;
  const eligible = state.rooms.filter(room => !room.closed_at && state.localRooms[room.id]?.code);
  eligible.sort((a, b) => (state.localRooms[b.id]?.last_opened || 0) - (state.localRooms[a.id]?.last_opened || 0));
  const selected = new Map();
  if (state.room && !state.room.closed_at) selected.set(state.room.id, state.room);
  for (const room of eligible) { if (selected.size >= 4) break; if (room.watched !== false) selected.set(room.id, room); }
  for (const [roomId, entry] of subscriptions) if (!selected.has(roomId)) { subscriptions.delete(roomId); await supabase.removeChannel(entry.channel); }
  for (const [roomId, room] of selected) {
    if (subscriptions.has(roomId)) continue;
    const channel = supabase.channel(`mobile-room:${roomId}`, { config: { private: true, broadcast: { self: false } } });
    const entry = { channel, ready: false }; subscriptions.set(roomId, entry);
    channel.on('broadcast', { event: 'message' }, ({ payload }) => queueMessage(payload, roomId, account, generation));
    channel.on('broadcast', { event: 'presence' }, ({ payload }) => {
      if (generation !== accountGeneration || account !== userId()) return;
      if (state.room?.id === roomId) {
        const others = state.online.filter(person => person.user_id !== payload.user_id);
        state.online = payload.online === true ? [...others, { ...payload, is_creator: payload.user_id === state.room.created_by }] : others;
        connectionLabel();
      }
      const currentRoom = state.rooms.find(item => item.id === roomId) || room;
      if (state.appActive && currentRoom.watched !== false && Date.now() - activityStarted > 1000) void announcePresence(currentRoom, payload, account).catch(() => {});
    });
    channel.on('broadcast', { event: 'closed' }, () => {
      if (generation !== accountGeneration) return;
      const target = state.rooms.find(item => item.id === roomId);
      if (target) target.closed_at = new Date().toISOString();
      if (state.room?.id === roomId) { state.room.closed_at = new Date().toISOString(); state.connected = false; clearInterval(heartbeatTimer); render(); }
      void syncSubscriptions();
    });
    channel.subscribe(status => {
      if (generation !== accountGeneration || subscriptions.get(roomId) !== entry) return;
      entry.ready = status === 'SUBSCRIBED';
      if (state.room?.id === roomId) { state.connected = entry.ready; connectionLabel(); if (entry.ready && state.appActive) void heartbeat(); }
    });
  }
  if (state.room) { state.connected = subscriptions.get(state.room.id)?.ready === true; connectionLabel(); }
}
async function heartbeat() {
  const room = state.room, generation = accountGeneration;
  if (!room || room.closed_at || !state.appActive || state.offline || !state.connected || heartbeatInFlight) return;
  heartbeatInFlight = true;
  try {
    const result = await invoke('mobile-presence', { room_id: room.id });
    if (generation !== accountGeneration || state.room?.id !== room.id) return;
    state.online = Array.isArray(result.online) ? result.online : [];
    connectionLabel();
  } catch (error) { if (generation === accountGeneration && state.room?.id === room.id) { state.error = friendly(error); connectionLabel(); } }
  finally { heartbeatInFlight = false; }
}
async function enterRoom(room) {
  if (!state.localRooms[room.id]?.code) { openModal('join'); return; }
  const generation = accountGeneration, account = userId();
  await leaveView(false);
  const messages = await localData.read(account, `history:${room.id}`, []);
  if (generation !== accountGeneration) return;
  state.room = room; state.messages = mergeHistory([], messages); state.draft = ''; state.screen = 'chat'; state.modal = null; state.online = []; state.connected = false;
  await rememberRoom(room, state.localRooms[room.id].code);
  if (generation !== accountGeneration || account !== userId()) return;
  render();
  if (!room.closed_at && !state.offline) { await syncSubscriptions(); clearInterval(heartbeatTimer); heartbeatTimer = setInterval(heartbeat, 30000); await heartbeat(); }
}
async function leaveView(sync = true) {
  clearInterval(heartbeatTimer);
  const room = state.room;
  state.room = null; state.connected = false; state.online = []; state.messages = []; state.draft = '';
  if (room && !room.closed_at && !state.offline) await rpc('mobile_leave_room', { p_room_id: room.id }).catch(() => {});
  if (sync) await syncSubscriptions();
}
async function navigate(screen) {
  if (screen === 'admin' && state.profile?.is_admin !== true) return;
  await leaveView(false); state.screen = screen; state.modal = null; state.error = ''; render();
  await syncSubscriptions();
  if (screen === 'admin') await loadAdmin();
}
async function loadAdmin() { state.admin = await rpc('mobile_admin_overview'); render(); }
async function saveName(value) {
  const name = String(value || '').trim();
  if (name.length < 2 || name.length > 40) throw new Error('Choose a display name with 2–40 characters.');
  const account = userId(), generation = accountGeneration;
  const profile = await rpc('mobile_profile', { p_display_name: name });
  if (generation !== accountGeneration || account !== userId()) throw new Error('Your account changed. Please try again.');
  state.profile = profile;
  await localData.write(account, 'profile', { ...profile, is_admin: false });
}
async function submitRoom(form) {
  const data = new FormData(form), type = form.dataset.type;
  const name = String(data.get('displayName') || '').trim(), label = String(data.get('label') || '').trim();
  const code = type === 'create' ? randomAccessCode() : normalizeAccessCode(data.get('code'));
  if (!isAccessCode(code)) { state.error = 'Enter the complete 32-character room invitation starting with KT.'; render(); return; }
  await run('submit-room', async () => {
    await saveName(name);
    const hash = await accessCodeHash(code);
    const duration = Number(data.get('duration') || 24);
    if (!Number.isInteger(duration) || duration < 1 || duration > 24) throw new Error('Choose a room duration from 1 to 24 hours.');
    const result = type === 'create' ? await rpc('mobile_create_room_v15', { p_code_hash: hash, p_label: label, p_duration_hours: duration, p_permanent: data.get('permanent') === 'on' }) : await rpc('mobile_join_room', { p_code_hash: hash });
    const room = Array.isArray(result) ? result[0] : result;
    if (!room?.id) throw new Error('The room did not return a valid invitation. Please try again.');
    await rememberRoom(room, code);
    await refreshRooms();
    await enterRoom(state.rooms.find(item => item.id === room.id) || room);
    if (type === 'create') openModal('invite', { code });
  });
}
async function sendMessage() {
  const room = state.room, account = userId(), generation = accountGeneration, text = state.draft.trim();
  if (sending || !text || !room || room.closed_at || !state.connected || state.offline) return;
  sending = true; connectionLabel();
  try {
    const id = crypto.randomUUID();
    const payload = await encryptMessage(await keyFor(room.id), { roomId: room.id, userId: account, id, text });
    const result = await invoke('mobile-send', { room_id: room.id, message_id: id, payload });
    if (generation !== accountGeneration) return;
    const envelope = result.message || result;
    if (!envelope.id || !envelope.created_at) throw new Error('Delivery was not confirmed. Refresh the room before retrying.');
    await receiveMessage(envelope, room.id, account, generation);
    if (state.room?.id === room.id) {
      state.draft = ''; const field = document.querySelector('#message-input');
      if (field) { field.value = ''; field.style.height = ''; field.focus(); }
      renderMessages(true);
    }
  } catch (error) { toast(friendly(error)); }
  finally { sending = false; connectionLabel(); }
}
async function cleanupSession() {
  clearInterval(heartbeatTimer); accountGeneration++; authUserId = null; authLoading = false;
  const entries = [...subscriptions.values()]; subscriptions.clear();
  await Promise.allSettled(entries.map(({ channel }) => supabase.removeChannel(channel)));
  keyCache.clear(); messageQueues.clear();
  state.profile = null; state.rooms = []; state.localRooms = {}; state.messages = []; state.online = []; state.admin = null; state.notices = []; state.room = null; state.modal = null; state.draft = ''; state.screen = 'home'; state.backendReady = false; state.connected = false;
}
async function onSession(session) {
  const previous = authUserId;
  state.session = session;
  if (native) await Device.setScreenshotSession({ accessToken: session?.access_token || null }).catch(() => {});
  if (!session) { if (previous) { await clearNotificationSession(); await cleanupSession(); } state.booting = false; render(); return; }
  if (session.user.id === previous && (authLoading || state.profile)) return;
  if (previous && previous !== session.user.id) { await clearNotificationSession(); await cleanupSession(); render(); }
  authUserId = session.user.id; authLoading = true;
  const generation = ++accountGeneration, account = session.user.id;
  try {
    const [localRooms, rooms, notices, profile] = await Promise.all([localData.read(account, 'rooms', {}), localData.read(account, 'room-index', []), localData.read(account, 'notices', []), localData.read(account, 'profile', null)]);
    if (generation !== accountGeneration || account !== userId()) return;
    state.localRooms = localRooms; state.rooms = rooms; state.notices = notices; state.profile = profile;
    if (state.profile) state.profile.is_admin = false;
    try {
      const profile = await rpc('mobile_profile', { p_display_name: null });
      if (generation !== accountGeneration) return;
      state.profile = profile;
      await localData.write(account, 'profile', { ...profile, is_admin: false });
      await supabase.realtime.setAuth(session.access_token);
      await refreshRooms();
      void invoke('mobile-device', {}).catch(() => {});
    } catch (error) {
      if (!state.profile) throw error;
      state.error = friendly(error); state.backendReady = false;
    }
    await loadNotificationSettings(account, id => { const room = state.rooms.find(item => item.id === id); if (room) void run('open-room', () => enterRoom(room)); }).catch(error => { notificationStatus.message = friendly(error); });
    state.authError = ''; state.screen = 'home';
  } catch (error) { state.authError = friendly(error); state.profile = null; }
  finally { if (generation === accountGeneration) { authLoading = false; state.booting = false; render(); } }
}
async function checkUpdate() {
  state.updateStatus = '';
  const release = await rpc('mobile_latest_release');
  if (!release) { state.updateStatus = 'No Android release has been published to the update service yet.'; return; }
  if (release.version_code <= Number(state.version.versionCode)) { state.updateStatus = `You are up to date · ${state.version.version}`; return; }
  state.update = release;
  if (!native) { state.updateStatus = 'An update is available. APK installation works inside the Android app.'; return; }
  if (!/^https:\/\//i.test(release.apk_url) || !/^[a-f0-9]{64}$/i.test(release.sha256)) throw new Error('This update is missing valid download verification details.');
  openModal('update');
}
async function copy(text, label) {
  try { await navigator.clipboard.writeText(text); toast(label); }
  catch { toast('Clipboard access was unavailable. Select and copy the displayed text.'); }
}
async function dispatch(action, element) {
  if (action === 'skip-launch') { state.launch = false; document.querySelector('.launch')?.remove(); return; }
  if (action === 'close-modal') { if (state.busy) return; state.modal = null; state.error = ''; render(); return; }
  if (action === 'dismiss-error') { state.error = ''; render(); return; }
  if (['home', 'rooms', 'account', 'admin'].includes(action)) return run(action, () => navigate(action));
  if (action === 'google') return run('google', async () => { state.authError = ''; await signInWithGoogle(); });
  if (action === 'email') { openModal('email'); return; }
  if (action === 'fingerprint') return run(action, async () => {
    if (!native) throw new Error('Fingerprint lock is available inside the Android app.');
    state.biometric = await Device.setBiometricLock({ enabled: !state.biometric.enabled });
    toast(state.biometric.enabled ? 'Fingerprint lock enabled. Your device PIN can also unlock the app.' : 'Fingerprint lock disabled.');
  });
  if (action === 'kitty') return Browser.open({ url: 'https://kittycorp.vercel.app' });
  if (['create', 'join', 'privacy', 'support', 'edit-name', 'members', 'room-options', 'request-extension'].includes(action)) { openModal(action); return; }
  if (['new-notice', 'new-release'].includes(action) && state.profile?.is_admin === true) { openModal(action); return; }
  if (action === 'open-room') { const room = state.rooms.find(item => item.id === element.dataset.id); if (room) return run(action, () => enterRoom(room)); }
  if (action === 'back' || action === 'leave-view') return run(action, () => navigate('rooms'));
  if (action === 'refresh') return run(action, refreshRooms);
  if (action === 'refresh-admin') return run(action, loadAdmin);
  if (action === 'show-invite') { openModal('invite', { code: state.localRooms[state.room.id].code }); return; }
  if (action === 'copy-invite') return copy(state.modal.code, 'Invitation copied. Share it privately.');
  if (action === 'copy-btc') return copy('bc1qvn36dkzq7wjq634j6yszg87yy252h7tx97pluc', 'Bitcoin address copied.');
  if (action === 'copy-usdt') return copy('0x5fa72e223cF8F270aC7bb329ceADBC2b4610d098', 'USDT Ethereum address copied.');
  if (action === 'test-sound') { chirp(); return; }
  if (action === 'notifications') return run(action, async () => { if (notificationStatus.enabled) { await disableNotifications(); notificationStatus.message = 'Room activity alerts are off.'; } else await enableNotifications(); });
  if (action === 'update') return run(action, checkUpdate);
  if (action === 'install-update') return run(action, async () => { const result = await Device.installUpdate({ url: state.update.apk_url, sha256: state.update.sha256, versionCode: Number(state.update.version_code) }); state.modal = null; state.updateStatus = result.status === 'permission_required' ? 'Allow SecretChat to install updates in Android Settings, then tap Check for updates again.' : 'The Android installer is open. Confirm installation to finish updating.'; });
  if (action === 'toggle-watch') return run(action, async () => { await rpc('mobile_watch_room', { p_room_id: state.room.id, p_watched: state.room.watched === false }); state.room.watched = state.room.watched === false; await refreshRooms(); state.modal = null; toast(state.room.watched ? 'Room activity is being watched.' : 'Room activity alerts are muted.'); });
  if (action === 'request-delete') return confirmAction('Request room deletion?', 'The administrator will review your request. Your room stays open until it is approved. Saved copies on participants’ devices cannot be remotely erased.', async () => { await rpc('mobile_request_deletion', { p_room_id: state.room.id }); toast('Deletion request sent for review.'); }, { label: 'Send request', icon: 'trash' });
  if (action === 'clear-room') return confirmAction('Clear this conversation?', 'This permanently removes saved messages for this room from this device. Other participants keep their own copies.', async () => { await localData.clearHistory(userId(), state.room.id); state.messages = []; toast('Local conversation cleared.'); }, { label: 'Clear', danger: true, icon: 'trash' });
  if (action === 'clear-all') return confirmAction('Clear your local chats?', 'Your saved messages on this device will be permanently removed. Your account, room memberships, and saved invitations stay available.', async () => { await Promise.all(Object.keys(state.localRooms).map(id => localData.clearHistory(userId(), id))); state.messages = []; toast('Your local chat history was cleared.'); }, { label: 'Clear chats', danger: true, icon: 'trash' });
  if (action === 'signout') return confirmAction('Sign out of SecretChat?', 'Your history stays encrypted on this device. Sign in with this same account to access it again.', async () => { await leaveView(false); await clearNotificationSession(); const { error } = await supabase.auth.signOut({ scope: 'local' }); if (error) throw error; }, { label: 'Sign out', icon: 'logout' });
  if (action === 'confirm') { const task = state.modal.task; return run(action, async () => { await task(); state.modal = null; }); }
  if (state.profile?.is_admin !== true) return;
  if (action === 'admin-create-group') { openModal('create', { permanent: true }); return; }
  if (action === 'admin-extend-room') { const room = state.admin?.rooms.find(item => item.id === element.dataset.id); if (room) openModal('admin-extension', { room }); return; }
  if (action === 'approve-extension' || action === 'reject-extension') return run(action, async () => {
    await rpc('mobile_admin_review_extension', { p_request_id: element.dataset.id, p_approve: action === 'approve-extension' });
    await refreshRooms(); await loadAdmin(); toast(action === 'approve-extension' ? 'Room extension approved.' : 'Extension request declined.');
  });
  if (action === 'approve-delete' || action === 'reject-delete') { const id = element.dataset.id; return confirmAction(action === 'approve-delete' ? 'Approve room deletion?' : 'Decline this request?', action === 'approve-delete' ? 'The room will close for everyone. Participants’ existing local message copies remain on their devices.' : 'The room will remain available to its members.', async () => { await rpc('mobile_admin_review_deletion', { p_request_id: id, p_approve: action === 'approve-delete' }); await loadAdmin(); await refreshRooms(); }, { label: action === 'approve-delete' ? 'Approve' : 'Decline', danger: action === 'approve-delete' }); }
  if (action === 'admin-close-room') { const id = element.dataset.id; return confirmAction('Close this room?', 'All members will lose access to its live channel. Device-stored histories remain with their owners.', async () => { await rpc('mobile_admin_close_room', { p_room_id: id }); await loadAdmin(); await refreshRooms(); }, { label: 'Close room', danger: true }); }
  if (action === 'toggle-member') { const id = element.dataset.id, disabled = element.dataset.disabled === 'true'; return confirmAction(disabled ? 'Disable this member?' : 'Enable this member?', disabled ? 'This account will no longer be allowed to use mobile rooms.' : 'This account will be allowed to use mobile rooms again.', async () => { await rpc('mobile_admin_set_disabled', { p_user_id: id, p_disabled: disabled }); await loadAdmin(); }, { label: disabled ? 'Disable' : 'Enable', danger: disabled }); }
  if (action === 'remove-notice') { const id = element.dataset.id; return confirmAction('Remove this notice?', 'It will no longer appear on members’ home screens after they refresh.', async () => { await rpc('mobile_admin_remove_notice', { p_notice_id: id }); await loadAdmin(); await refreshRooms(); }, { label: 'Remove', danger: true }); }
}

app.addEventListener('click', event => {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  Promise.resolve(dispatch(target.dataset.action, target)).catch(error => { state.error = friendly(error); toast(state.error); render(); });
});
app.addEventListener('submit', event => {
  event.preventDefault(); const form = event.target;
  if (form.id === 'message-form') { void sendMessage(); return; }
  if (form.id === 'room-form') { void submitRoom(form); return; }
  const data = new FormData(form);
  if (form.id === 'email-form') void run('email-signin', async () => { await signInWithEmail(data.get('email')); state.modal = {type:'email', sent:true, email:String(data.get('email')).trim()}; toast('Sign-in link requested. Check your inbox.'); });
  if (form.id === 'extension-form') void run('extend', async () => {
    const admin = form.dataset.admin === 'true', hours = Number(data.get('hours'));
    if (!Number.isInteger(hours) || hours < 1 || hours > (admin ? 8760 : 24)) throw new Error('Choose a valid number of extra hours.');
    await rpc(admin ? 'mobile_admin_extend_room' : 'mobile_request_extension', {p_room_id:form.dataset.id, p_hours:hours});
    state.modal = null; await refreshRooms(); if (admin) await loadAdmin(); toast(admin ? 'Room time extended.' : 'Extension request sent for approval.');
  });
  if (form.id === 'name-form') void run('save-name', async () => { await saveName(data.get('displayName')); state.modal = null; toast('Your name has been updated.'); });
  if (form.id === 'notice-form') void run('save-notice', async () => { await rpc('mobile_admin_publish_notice', { p_title: String(data.get('title')).trim(), p_body: String(data.get('body')).trim() }); state.modal = null; await loadAdmin(); await refreshRooms(); toast('Notice published.'); });
  if (form.id === 'release-form' && state.profile?.is_admin === true) void run('save-release', async () => {
    const url = new URL(String(data.get('url')).trim()), versionCode = Number(data.get('versionCode')), sha256 = String(data.get('sha256')).trim().toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use a public HTTPS APK download URL without embedded credentials.');
    if (!Number.isSafeInteger(versionCode) || versionCode <= Number(state.admin?.release?.version_code || 0)) throw new Error('Use a build number higher than the current published release.');
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Enter the APK’s 64-character SHA-256 checksum.');
    await rpc('mobile_admin_publish_release', { p_version_code: versionCode, p_version: String(data.get('version')).trim(), p_apk_url: url.href, p_sha256: sha256, p_notes: String(data.get('notes')).trim() });
    state.modal = null; await loadAdmin(); toast('Android update published. Members can check for it in the app.');
  });
});
app.addEventListener('input', event => { if (event.target.id === 'message-input') { state.draft = event.target.value; event.target.style.height = 'auto'; event.target.style.height = `${Math.min(event.target.scrollHeight, 130)}px`; } });
app.addEventListener('keydown', event => {
  if (event.target.id === 'message-input' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void sendMessage(); }
  if (event.key === 'Escape' && state.modal && !state.busy) { state.modal = null; render(); }
  if (event.key === 'Tab' && state.modal) {
    const focusable = [...document.querySelectorAll('.modal button:not([disabled]), .modal input, .modal textarea, .modal select')];
    const first = focusable[0], last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
});
window.addEventListener('online', () => { state.offline = false; connectionLabel(); if (userId()) void refreshRooms().then(() => { render(); return heartbeat(); }).catch(error => toast(friendly(error))); else render(); });
window.addEventListener('offline', () => { state.offline = true; render(); });
function setActive(active) {
  state.appActive = active;
  document.body.classList.toggle('app-inactive', !active);
  if (active) { if (state.room) void heartbeat(); }
  else if (state.room && !state.room.closed_at) void rpc('mobile_leave_room', { p_room_id: state.room.id }).catch(() => {});
}
document.addEventListener('visibilitychange', () => setActive(!document.hidden));
window.visualViewport?.addEventListener('resize', () => { document.documentElement.style.setProperty('--viewport-height', `${window.visualViewport.height}px`); });
async function bootstrap() {
  render();
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  setTimeout(() => { state.launch = false; document.querySelector('.launch')?.remove(); }, reduceMotion ? 100 : 1600);
  if (native) {
    state.version = await Device.getVersion();
    let finishUnlock;
    const unlocked = new Promise(resolve => { finishUnlock = resolve; });
    const listener = await Device.addListener('deviceUnlocked', finishUnlock);
    state.biometric = await Device.getBiometricStatus();
    if (state.biometric.locked) await unlocked;
    await listener.remove();
    await App.addListener('backButton', ({ canGoBack }) => {
      if (state.modal) { if (!state.busy) { state.modal = null; render(); } }
      else if (state.screen !== 'home') void navigate('home').catch(error => toast(friendly(error)));
      else if (canGoBack) window.history.back();
      else void App.minimizeApp();
    });
  }
  await initializeAuth(session => { void onSession(session); }, error => { state.authError = friendly(error); state.booting = false; render(); }, setActive);
}
void bootstrap().catch(error => { state.booting = false; state.authError = friendly(error); render(); });
