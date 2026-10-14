import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createDraftStore, normalizePreferences, normalizeRoomTools, selectRooms } from '../src/organizer.js';
import { createRefreshQueue } from '../src/runtime.js';

const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const fragment = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
const roomId = '00000000-0000-4000-8000-000000000001';
const session = account => ({ user: { id: account }, access_token: account + '-token' });
function memoryDrafts(writeGate) {
  const records = new Map(), writes = [];
  const key = (account, record) => JSON.stringify([account, record]);
  const store = createDraftStore({
    read: async (account, record, fallback) => records.get(key(account, record)) ?? fallback,
    write: async (account, record, text) => {
      writes.push([account, record, text]);
      if (writeGate) await writeGate.promise;
      records.set(key(account, record), text);
    },
    delayMs: 60000,
  });
  return { store, records, writes, key };
}
function sender() {
  const gate = deferred(), fields = [], drafts = memoryDrafts();
  const state = { room: { id: roomId, closed_at: null }, session: session('account'), draft: 'first message', connected: true, offline: false };
  drafts.store.set('account', roomId, state.draft);
  const context = {
    state, accountGeneration: 1, sending: false, userId: () => state.session?.user.id,
    crypto: { randomUUID: () => 'id' }, keyFor: async () => 'key', encryptMessage: async () => ({}),
    invoke: () => gate.promise, receiveMessage: async () => {}, draftStore: drafts.store,
    document: { querySelector: () => ({ set value(value) { fields.push(value); }, style: {}, focus() {} }) },
    connectionLabel() {}, renderMessages() {}, toast() {}, friendly: error => error.message,
  };
  vm.createContext(context);
  const cleanupStart = source.includes('async function cleanupSession(') ? 'async function cleanupSession(' : 'function cleanupSession(';
  vm.runInContext(fragment('async function sendMessage(', cleanupStart) + ';globalThis.send=sendMessage;', context);
  return { context, state, gate, drafts, fields };
}
const confirm = fixture => fixture.gate.resolve({ message: { id: 'id', created_at: '2026-10-13' } });

test('confirmed delivery preserves a second draft typed while sending', async () => {
  const f = sender(), pending = f.context.send();
  await tick();
  f.state.draft = 'second message'; f.drafts.store.set('account', roomId, f.state.draft);
  confirm(f); await pending;
  assert.equal(f.state.draft, 'second message'); assert.equal(await f.drafts.store.load('account', roomId), 'second message'); assert.equal(f.fields.length, 0);
  await f.drafts.store.dispose();
});

test('confirmed delivery clears the sent draft in encrypted storage', async () => {
  const f = sender(), pending = f.context.send(); await tick(); confirm(f); await pending;
  assert.equal(f.state.draft, ''); assert.equal(await f.drafts.store.load('account', roomId), '');
  await f.drafts.store.dispose();
});

test('delivery after leaving consumes the captured persisted draft', async () => {
  const f = sender(), pending = f.context.send(); await tick();
  await f.drafts.store.release('account', roomId);
  f.state.room = null; f.state.draft = ''; confirm(f); await pending;
  const restored = await f.drafts.store.load('account', roomId);
  await f.drafts.store.dispose();
  assert.equal(restored, '');
  assert.equal(f.fields.length, 0);
});

test('leave and reopen while sending retains a newer draft even if its text is identical', async () => {
  const f = sender(), pending = f.context.send(); await tick();
  await f.drafts.store.release('account', roomId); f.state.room = null; f.state.draft = '';
  await f.drafts.store.load('account', roomId);
  f.state.room = { id: roomId }; f.drafts.store.set('account', roomId, 'replacement');
  f.drafts.store.set('account', roomId, 'first message'); f.state.draft = 'first message';
  confirm(f); await pending;
  const restored = await f.drafts.store.load('account', roomId);
  await f.drafts.store.dispose();
  assert.equal(restored, 'first message'); assert.equal(f.state.draft, 'first message'); assert.equal(f.fields.length, 0);
});

test('an account change while sending cannot clear the next account draft', async () => {
  const f = sender(), pending = f.context.send(); await tick();
  f.state.session = session('next'); f.context.accountGeneration++; f.state.draft = 'new account draft';
  f.drafts.store.set('next', roomId, f.state.draft); confirm(f); await pending;
  const restored = await f.drafts.store.load('next', roomId); await f.drafts.store.dispose();
  assert.equal(f.state.draft, 'new account draft'); assert.equal(restored, 'new account draft');
  assert.equal(f.fields.length, 0);
});

function authFixture({ current = 'a', drafts = memoryDrafts(), readGate, screenshotGate } = {}) {
  const state = {
    session: current ? session(current) : null, profile: current ? { display_name: 'Old member', is_admin: true } : null,
    rooms: current ? [{ id: roomId }] : [], localRooms: current ? { [roomId]: { code: 'invitation' } } : {},
    room: current ? { id: roomId } : null, messages: current ? [{ text: 'old private message' }] : [],
    draft: current ? 'old private draft' : '', online: [], preferences: normalizePreferences(), roomTools: normalizeRoomTools(),
    screen: current ? 'chat' : 'home', appActive: true, booting: false, modal: null, offline: false,
  };
  const renders = [], screenshots = [], realtimeTokens = [], events = new Map(), reads = [], profiles = [];
  const context = {
    state, accountGeneration: current ? 1 : 0, authUserId: current, authLoading: false,
    latestRequestedSession: state.session, sessionRevision: 0, sessionCleanups: [],
    researchKey: null, updateCheckAt: 0, releaseChannel: null, heartbeatTimer: 7,
    subscriptions: new Map(), keyCache: new Map(), messageQueues: new Map(), sending: false,
    draftStore: drafts.store, userId: () => state.session?.user.id,
    native: true, Device: { setScreenshotSession: async ({ accessToken }) => { screenshots.push(accessToken); if (screenshotGate) await screenshotGate.promise; } },
    clearInterval() {}, clearNotificationSession: async () => {}, normalizePreferences, normalizeRoomTools,
    applyAppearance() {}, render: () => renders.push({ room: state.room, profile: state.profile, draft: state.draft, messages: [...state.messages] }),
    localData: {
      read: async (account, record, fallback) => {
        reads.push([account, record]);
        if (readGate && record === 'profile') await readGate.promise;
        return record === 'profile' ? { display_name: account, is_admin: true } : fallback;
      },
      write: async () => {},
    },
    supabase: { removeChannel: async () => {}, realtime: { setAuth: async token => { realtimeTokens.push(token); } } },
    rpc: async () => { const account = state.session.user.id; profiles.push(account); return { display_name: account, is_admin: false }; },
    refreshRooms: async () => { state.backendReady = true; },
    invoke: async () => ({}), loadNotificationSettings: async () => {}, notificationStatus: {},
    syncSubscriptions: async () => {}, checkUpdate: async () => {}, friendly: error => error.message,
    createRefreshQueue, app: { addEventListener: (type, callback) => events.set(type, callback) },
    renderRoomList() {}, document: { querySelector: () => null }, searchResultsMarkup() {},
  };
  vm.createContext(context);
  const cleanupStart = source.includes('function cleanupSession(') ? (source.includes('async function cleanupSession(') ? 'async function cleanupSession(' : 'function cleanupSession(') : '';
  vm.runInContext(fragment(cleanupStart, 'async function checkUpdate(') + ';globalThis.auth=onSession;', context);
  vm.runInContext(fragment("function ownsComposer(", "app.addEventListener('keydown',"), context);
  return { context, state, drafts, renders, screenshots, realtimeTokens, events, reads, profiles };
}

test('identity change hides old private UI before blocked draft cleanup and rejects old composer input', async () => {
  const writeGate = deferred(), drafts = memoryDrafts(writeGate), f = authFixture({ drafts });
  drafts.store.set('a', roomId, f.state.draft);
  const flush = drafts.store.flush('a', roomId); await tick();
  const oldInput = { id: 'message-input', value: 'old composer edited', dataset: { account: 'a', roomId, generation: '1' }, style: {}, scrollHeight: 10 };
  const pending = f.context.auth(session('b'));
  const hidden = !f.state.profile && !f.state.room && !f.state.messages.length && !f.state.draft;
  f.events.get('input')({ target: oldInput });
  const afterInput = f.state.draft;
  writeGate.resolve(); await flush; await pending; await drafts.store.dispose();
  assert.equal(hidden, true);
  assert.equal(afterInput, '');
  assert.equal(f.renders[0].profile, null);
  assert.equal(drafts.records.has(drafts.key('b', 'draft:' + roomId)), false);
  assert.equal(drafts.records.get(drafts.key('a', 'draft:' + roomId)), 'old private draft');
});

test('overlapping identity callbacks settle only the latest account and native session', async () => {
  const screenshotGate = deferred(), f = authFixture({ current: null, screenshotGate });
  const a = f.context.auth(session('a')); await tick();
  const b = f.context.auth(session('b')), c = f.context.auth(session('c'));
  screenshotGate.resolve(); await Promise.all([a, b, c]);
  assert.equal(f.state.session.user.id, 'c'); assert.equal(f.state.profile.display_name, 'c');
  assert.equal(f.context.authUserId, 'c'); assert.equal(f.context.authLoading, false);
  assert.equal(f.screenshots.at(-1), 'c-token');
  assert.deepEqual([...new Set(f.profiles)], ['c']);
  await f.drafts.store.dispose();
});

test('same-account token refresh during initial load retains its generation and finishes authentication', async () => {
  const readGate = deferred(), f = authFixture({ current: null, readGate });
  const first = f.context.auth(session('a')); await tick();
  const generation = f.context.accountGeneration;
  const next = f.context.auth({ ...session('a'), access_token: 'a-refreshed-token' }); await tick();
  readGate.resolve(); await Promise.all([first, next]);
  assert.equal(f.context.accountGeneration, generation);
  assert.equal(f.context.authLoading, false); assert.equal(f.state.profile.display_name, 'a');
  assert.equal(f.screenshots.at(-1), 'a-refreshed-token'); assert.equal(f.realtimeTokens.at(-1), 'a-refreshed-token');
  await f.drafts.store.dispose();
});

test('a stale failing profile load cannot erase the next account or leave authentication loading', async () => {
  const gate = deferred(), f = authFixture({ current: null });
  f.context.rpc = async () => { if (f.state.session.user.id === 'a') { await gate.promise; throw Error('old load failed'); } return { display_name: 'b' }; };
  const a = f.context.auth(session('a')); await tick(); const b = f.context.auth(session('b')); gate.resolve();
  await Promise.all([a, b]);
  assert.equal(f.state.profile.display_name, 'b'); assert.equal(f.state.authError, ''); assert.equal(f.context.authLoading, false);
  await f.drafts.store.dispose();
});

test('offline cached profiles never restore administrator authority', async () => {
  const f = authFixture({ current: null });
  f.context.rpc = async () => { throw Error('offline'); };
  await f.context.auth(session('a'));
  assert.equal(f.state.profile.is_admin, false); assert.equal(f.state.backendReady, false);
  assert.equal(f.context.authLoading, false); await f.drafts.store.dispose();
});

function unreadFixture({ screen = 'rooms', filter = 'all', gate } = {}) {
  const state = { rooms: [{ id: roomId, label: 'Alpha', chat_epoch: 1 }], room: null, appActive: true, screen,
    localRooms: {}, roomTools: normalizeRoomTools(), roomQuery: 'Al', roomFilter: filter };
  const search = { value: 'Al' }, list = { innerHTML: '' }, count = { textContent: '' }, recent = { innerHTML: '' };
  let history = [], tools = {}, alerts = 0, writes = 0, pending = Promise.resolve();
  const context = {
    state, accountGeneration: 1, userId: () => state.session?.user.id || 'account', selectRooms, normalizeRoomTools,
    keyFor: async () => 'key', decryptMessage: async () => ({ id: 'id', user_id: 'other', text: 'hello' }),
    mergeHistory: (old, message) => old.some(value => value.id === message.id) ? old : [...old, message],
    localData: { update: async (account, record, fallback, modify) => {
      if (record.startsWith('history:')) return history = modify(history);
      const task = pending.then(async () => {
        if (gate && writes++ === 0) await gate.promise;
        return tools = modify(tools);
      });
      pending = task.catch(() => {}); return task;
    } },
    document: { activeElement: search, querySelector: selector => ({ '#room-list': screen === 'rooms' ? list : null, '#room-count': count, '#home-room-list': screen === 'home' ? recent : null, '#room-search': search }[selector] ?? null) },
    roomCard: room => room.label + ':' + (state.roomTools.unread[room.id] || 0), emptyRooms: () => 'empty',
    renderMessages() {}, announceMessage: async () => { alerts++; }, syncRoomState: async () => {},
    render: () => { throw Error('A room-list update must retain the focused search element.'); },
  };
  vm.createContext(context);
  vm.runInContext(fragment('async function persistRoomTools(', 'function searchResultsMarkup(') +
    fragment('async function receiveMessage(', 'function queueMessage(') +
    ';globalThis.receive=receiveMessage;globalThis.readRoom=markRoomRead;', context);
  return { context, state, search, list, recent, count, tools: () => tools, alerts: () => alerts, history: () => history };
}

test('broadcast and send confirmation duplicates add one unread count and one alert', async () => {
  const f = unreadFixture();
  await f.context.receive({ payload: {} }, roomId, 'account', 1); await f.context.receive({ payload: {} }, roomId, 'account', 1);
  assert.equal(f.history().length, 1); assert.equal(f.state.roomTools.unread[roomId], 1); assert.equal(f.alerts(), 1);
});

for (const filter of ['all', 'unread']) {
  test('incoming unread messages refresh visible Rooms with ' + filter + ' filter and preserve search focus', async () => {
    const f = unreadFixture({ filter });
    f.context.renderRoomList();
    await f.context.receive({ payload: {} }, roomId, 'account', 1);
    assert.equal(f.list.innerHTML, 'Alpha:1'); assert.equal(f.count.textContent, '1 conversation');
    assert.equal(f.context.document.activeElement, f.search); assert.equal(f.search.value, 'Al');
  });
}

test('incoming unread messages refresh Home recent conversations', async () => {
  const f = unreadFixture({ screen: 'home' });
  await f.context.receive({ payload: {} }, roomId, 'account', 1);
  assert.equal(f.recent.innerHTML, 'Alpha:1');
  assert.match(fragment('function homeMarkup(', 'function emptyRooms('), /id="home-room-list"/);
});

test('opening a room queues a read marker after an unread write blocked with zero cached count', async () => {
  const gate = deferred(), f = unreadFixture({ gate });
  const incoming = f.context.receive({ payload: {} }, roomId, 'account', 1); await tick();
  f.state.room = { id: roomId };
  const reading = f.context.readRoom(roomId); gate.resolve(); await Promise.all([incoming, reading]);
  assert.equal(f.tools().unread?.[roomId] || 0, 0); assert.equal(f.state.roomTools.unread[roomId] || 0, 0);
});

test('an account change during an unread write cannot increment its old or new account', async () => {
  const gate = deferred(), f = unreadFixture({ gate });
  f.state.session = session('account');
  const incoming = f.context.receive({ payload: {} }, roomId, 'account', 1); await tick();
  f.state.session = session('next'); f.context.accountGeneration++; f.state.roomTools = normalizeRoomTools();
  gate.resolve(); await incoming;
  assert.equal(f.tools().unread?.[roomId] || 0, 0); assert.equal(f.state.roomTools.unread[roomId] || 0, 0); assert.equal(f.alerts(), 0);
});

test('draft storage failure during navigation keeps the composer and presence heartbeat', async () => {
  const state = { room: { id: roomId }, draft: 'keep my draft', connected: true, online: [{ user_id: 'other' }], messages: [{ text: 'history' }] };
  let stopped = false, left = false;
  const context = { state, accountGeneration: 1, userId: () => 'account', heartbeatTimer: 7,
    clearInterval: () => { stopped = true; }, draftStore: { release: async () => { throw Error('storage unavailable'); } },
    rpc: async () => { left = true; }, syncSubscriptions: async () => {} };
  vm.createContext(context);
  vm.runInContext(fragment('async function leaveView(', 'async function navigate(') + ';globalThis.leave=leaveView;', context);
  await assert.rejects(context.leave(), /storage unavailable/);
  assert.equal(state.room.id, roomId); assert.equal(state.draft, 'keep my draft'); assert.equal(state.connected, true);
  assert.equal(stopped, false); assert.equal(left, false);
});


function actionFixture({ historyGate, writeGate } = {}) {
  const f = unreadFixture(), drafts = memoryDrafts(writeGate), histories = new Map(), toolRecords = new Map();
  const second = '00000000-0000-4000-8000-000000000002', other = '00000000-0000-4000-8000-000000000003';
  const key = (account, id) => JSON.stringify([account, id]);
  const state = f.state;
  Object.assign(state, { session: session('account'), profile: { is_admin: false }, room: { id: roomId }, screen: 'chat',
    draft: 'keep my draft', messages: [{ text: 'saved history' }], connected: true, offline: false, busy: '',
    rooms: [{ id: roomId, label: 'Alpha' }, { id: second, label: 'Remote only' }], localRooms: { [roomId]: { code: 'invitation' } } });
  for (const account of ['account', 'next']) {
    for (const id of [roomId, second, other]) { histories.set(key(account, id), [{ text: account + ':' + id }]); drafts.store.set(account, id, account + ' draft ' + id); }
    toolRecords.set(account, normalizeRoomTools({ unread: { [roomId]: 2, [second]: 3, [other]: 4 } }));
  }
  drafts.store.set('account', roomId, state.draft);
  state.roomTools = toolRecords.get('account');
  let stopped = 0, left = 0;
  const alerts = [];
  Object.assign(f.context, {
    draftStore: drafts.store, native: false, heartbeatTimer: 7, clearInterval: () => { stopped++; },
    render() {}, toast: message => alerts.push(message), friendly: error => error.message,
    rpc: async () => { left++; }, syncSubscriptions: async () => {},
    localData: {
      clearHistory: async (account, id) => { if (historyGate) await historyGate.promise; histories.set(key(account, id), []); },
      update: async (account, record, fallback, modify) => {
        const result = modify(toolRecords.get(account) || fallback); toolRecords.set(account, result); return result;
      },
    },
  });
  vm.runInContext(fragment('async function run(', 'async function applyRoomEpoch(') +
    fragment('async function leaveView(', 'async function loadAdmin(') +
    fragment('async function dispatch(', "app.addEventListener('click',") +
    ';globalThis.action=dispatch;', f.context);
  return { ...f, drafts, histories, toolRecords, key, second, other, alerts, stopped: () => stopped, left: () => left };
}

test('clear-room confirmation dispatch clears only this account conversation, draft and unread marker', async t => {
  const f = actionFixture(); t.after(() => f.drafts.store.dispose());
  await f.context.action('clear-room', { dataset: {} });
  assert.equal(f.state.modal.type, 'confirm');
  await f.context.action('confirm', { dataset: {} });
  assert.equal(f.histories.get(f.key('account', roomId)).length, 0);
  assert.equal(await f.drafts.store.load('account', roomId), ''); assert.equal(f.toolRecords.get('account').unread[roomId], 0);
  assert.equal(await f.drafts.store.load('account', f.second), 'account draft ' + f.second);
  assert.equal(await f.drafts.store.load('next', roomId), 'next draft ' + roomId);
  assert.equal(f.state.messages.length, 0); assert.equal(f.state.draft, '');
});

test('clear-all confirmation dispatch includes remotely indexed rooms and preserves other accounts', async t => {
  const f = actionFixture(); t.after(() => f.drafts.store.dispose());
  await f.context.action('clear-all', { dataset: {} }); await f.context.action('confirm', { dataset: {} });
  for (const id of [roomId, f.second]) {
    assert.equal(f.histories.get(f.key('account', id)).length, 0);
    assert.equal(await f.drafts.store.load('account', id), '');
    assert.equal(f.histories.get(f.key('next', id)).length, 1);
    assert.equal(await f.drafts.store.load('next', id), 'next draft ' + id);
  }
  assert.equal(Object.keys(f.toolRecords.get('account').unread).length, 0);
  assert.equal(f.histories.get(f.key('account', f.other)).length, 1);
  assert.equal(f.state.messages.length, 0); assert.equal(f.state.draft, '');
});

for (const action of ['clear-room', 'clear-all']) {
  test(action + ' pending completion preserves the next account composer, modal and unread data', async t => {
    const gate = deferred(), f = actionFixture({ historyGate: gate }); t.after(() => f.drafts.store.dispose());
    await f.context.action(action, { dataset: {} });
    const pending = f.context.action('confirm', { dataset: {} }); await tick();
    f.state.session = session('next'); f.context.accountGeneration++;
    f.state.roomTools = f.toolRecords.get('next'); f.state.draft = 'next visible draft'; f.state.messages = [{ text: 'next visible message' }];
    f.state.modal = { type: 'join' }; f.state.busy = 'new account action';
    gate.resolve(); await pending;
    assert.equal(f.state.draft, 'next visible draft'); assert.equal(f.state.messages[0].text, 'next visible message');
    assert.equal(f.state.modal.type, 'join'); assert.equal(f.state.busy, 'new account action');
    assert.equal(f.toolRecords.get('next').unread[roomId], 2); assert.equal(f.toolRecords.get('next').unread[f.second], 3);
  });
}

test('Back action surfaces a failed draft save and its retry preserves then releases the conversation', async t => {
  const gate = deferred(), f = actionFixture({ writeGate: gate }); t.after(() => f.drafts.store.dispose());
  const pending = f.context.action('back', { dataset: {} }); await tick(); gate.reject(Error('draft storage unavailable')); await pending;
  assert.equal(f.state.screen, 'chat'); assert.equal(f.state.room.id, roomId); assert.equal(f.state.draft, 'keep my draft');
  assert.equal(f.state.connected, true); assert.equal(f.stopped(), 0); assert.equal(f.left(), 0);
  assert.equal(f.state.error, 'draft storage unavailable'); assert.equal(f.alerts.at(-1), 'draft storage unavailable');
  gate.promise = Promise.resolve();
  await f.context.action('back', { dataset: {} });
  assert.equal(f.state.screen, 'rooms'); assert.equal(f.state.room, null); assert.equal(f.stopped(), 1); assert.equal(f.left(), 1);
  assert.equal(await f.drafts.store.load('account', roomId), 'keep my draft'); assert.equal(f.state.error, '');
});

test('failed old-account draft cleanup retains its retryable draft while the new identity completes', async t => {
  const gate = deferred(), drafts = memoryDrafts(gate), f = authFixture({ drafts }); t.after(() => drafts.store.dispose());
  drafts.store.set('a', roomId, 'old retryable draft');
  const pending = f.context.auth(session('b')); await tick(); gate.reject(Error('old storage failure')); await pending;
  assert.equal(f.state.profile.display_name, 'b'); assert.equal(f.context.authLoading, false);
  assert.equal(await drafts.store.load('a', roomId), 'old retryable draft');
  assert.equal(drafts.records.has(drafts.key('b', 'draft:' + roomId)), false);
  gate.promise = Promise.resolve();
});


function roomSubmissionFixture({ type = 'create', blocked, research = false, inviteResearch = false } = {}) {
  const gate = deferred(), reached = deferred(), records = new Map(), steps = [];
  const code = 'KT' + 'A'.repeat(30), createdRoom = { id: roomId, label: 'Created room' };
  const state = { session: session('a'), profile: { display_name: 'Alice' }, rooms: [], localRooms: {}, room: null,
    messages: [], draft: '', screen: 'rooms', modal: null, busy: '', error: '' };
  const key = (account, record) => JSON.stringify([account, record]);
  async function step(stage) {
    steps.push({ stage, account: state.session.user.id });
    if (stage === blocked) { reached.resolve(); await gate.promise; }
  }
  class FormData {
    constructor(form) { this.values = form.values; }
    get(name) { return this.values[name] ?? null; }
  }
  const context = {
    state, accountGeneration: 1, userId: () => state.session?.user.id, FormData,
    render() {}, toast() {}, friendly: error => error.message,
    randomAccessCode: () => code, normalizeAccessCode: value => String(value).trim().toUpperCase(),
    isAccessCode: value => value === code,
    accessCodeHash: async () => { await step('hash'); return 'test invitation hash'; },
    rpc: async () => { await step('save-name-server'); return { display_name: 'Alice' }; },
    v16: async action => {
      await step(action);
      if (action === 'invite') return { research: inviteResearch };
      if (action === 'public-key') return 'public key placeholder';
      return createdRoom;
    },
    wrapResearchInvitation: async () => { await step('wrap'); return { wrapped: 'test envelope' }; },
    localData: {
      write: async (account, record, value) => { await step('save-name-storage'); records.set(key(account, record), value); },
      update: async (account, record, fallback, modify) => {
        await step('remember');
        const value = modify(records.get(key(account, record)) || fallback);
        records.set(key(account, record), value);
        return value;
      },
    },
    refreshRooms: async () => {
      const account = state.session.user.id; await step('refresh');
      if (account === state.session.user.id) state.rooms = [createdRoom];
    },
    enterRoom: async room => {
      const account = state.session.user.id; await step('enter');
      if (account === state.session.user.id) { state.room = room; state.screen = 'chat'; }
    },
  };
  vm.createContext(context);
  vm.runInContext(fragment('async function run(', 'async function applyRoomEpoch(') +
    fragment('async function rememberRoom(', 'async function keyFor(') +
    fragment('async function saveName(', 'async function sendMessage(') +
    ';globalThis.submit=submitRoom;', context);
  const form = { dataset: { type }, values: { displayName: 'Alice', label: 'Project', duration: '24', code, research: research ? 'on' : null } };
  function switchAccount() {
    state.session = session('b'); context.accountGeneration++;
    state.profile = { display_name: 'Bob' }; state.localRooms = {}; state.rooms = [];
    state.room = { id: 'b-room' }; state.screen = 'chat'; state.messages = [{ text: 'B message' }];
    state.draft = 'B draft'; state.modal = { type: 'b-modal' }; state.busy = 'b-action';
  }
  return { context, state, form, gate, reached, records, steps, key, switchAccount };
}

const submissionBoundaries = [
  { type: 'create', blocked: 'save-name-server' },
  { type: 'create', blocked: 'save-name-storage' },
  { type: 'create', blocked: 'hash' },
  { type: 'create', blocked: 'public-key', research: true },
  { type: 'create', blocked: 'wrap', research: true },
  { type: 'create', blocked: 'create' },
  { type: 'create', blocked: 'remember' },
  { type: 'create', blocked: 'refresh' },
  { type: 'create', blocked: 'enter' },
  { type: 'join', blocked: 'save-name-storage' },
  { type: 'join', blocked: 'hash' },
  { type: 'join', blocked: 'invite' },
  { type: 'join', blocked: 'invite', inviteResearch: true },
  { type: 'join', blocked: 'join' },
  { type: 'join', blocked: 'remember' },
  { type: 'join', blocked: 'refresh' },
];
for (const boundary of submissionBoundaries) {
  test(boundary.type + ' account change during ' + boundary.blocked + (boundary.inviteResearch ? ' consent lookup' : '') + ' prevents later room operations', async () => {
    const f = roomSubmissionFixture(boundary), pending = f.context.submit(f.form);
    await f.reached.promise;
    const started = f.steps.length;
    f.switchAccount(); f.gate.resolve(); await pending;
    assert.equal(f.steps.length, started, 'No later server, storage or room-view operation should start.');
    assert.equal(f.records.has(f.key('b', 'rooms')), false);
    assert.equal(f.records.has(f.key('b', 'profile')), false);
    assert.equal(f.state.room.id, 'b-room'); assert.equal(f.state.screen, 'chat');
    assert.equal(f.state.draft, 'B draft'); assert.equal(f.state.messages[0].text, 'B message');
    assert.equal(f.state.modal.type, 'b-modal'); assert.equal(f.state.busy, 'b-action');
  });
}
