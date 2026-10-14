import { validId, MAX_HISTORY, MAX_MESSAGE_LENGTH } from './crypto.js';

const own = (value, key) => Object.hasOwn(value, key) ? value[key] : undefined;
const record = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const roomId = value => typeof value === 'string' && validId(value.trim()) ? value.trim().toLowerCase() : null;
const queryText = value => typeof value === 'string' ? value.trim().toLowerCase() : '';

export function normalizePreferences(input) {
  const value = record(input), theme = own(value, 'theme');
  const motion = own(value, 'motion'), haptics = own(value, 'haptics');
  return {
    theme: ['dark', 'light', 'system'].includes(theme) ? theme : 'dark',
    motion: typeof motion === 'boolean' ? motion : true,
    haptics: typeof haptics === 'boolean' ? haptics : true,
  };
}

export function normalizeRoomTools(input) {
  const value = record(input), pins = own(value, 'pinned'), counts = record(own(value, 'unread'));
  const pinned = [], unread = {}, rooms = new Set();
  for (const candidate of Array.isArray(pins) ? pins : []) {
    const id = roomId(candidate);
    if (!id || rooms.has(id)) continue;
    pinned.push(id);
    rooms.add(id);
    if (pinned.length === 12) break;
  }
  for (const [candidate, count] of Object.entries(counts)) {
    const id = roomId(candidate);
    if (!id || typeof count !== 'number' || !Number.isFinite(count)) continue;
    if (!rooms.has(id) && rooms.size >= 200) continue;
    rooms.add(id);
    unread[id] = Math.max(0, Math.min(99, Math.floor(count)));
  }
  return { pinned, unread };
}

export function selectRooms(rooms, options = {}) {
  const settings = record(options), query = queryText(own(settings, 'query'));
  const { pinned, unread } = normalizeRoomTools(settings), pins = new Set(pinned);
  const requested = own(settings, 'filter');
  const filter = ['unread', 'pinned', 'closed'].includes(requested) ? requested : 'all';
  const first = [], rest = [];
  for (const room of Array.isArray(rooms) ? rooms : []) {
    if (!room || typeof room !== 'object') continue;
    const id = roomId(room.id), isPinned = pins.has(id);
    if (query && (typeof room.label !== 'string' || !room.label.toLowerCase().includes(query))) continue;
    if (filter === 'unread' && !(unread[id] > 0)) continue;
    if (filter === 'pinned' && !isPinned) continue;
    if (filter === 'closed' && !room.closed_at) continue;
    (isPinned ? first : rest).push(room);
  }
  return first.concat(rest);
}

export function searchHistory(messages, query) {
  const needle = queryText(query), history = Array.isArray(messages) ? messages.slice(-MAX_HISTORY) : [];
  return history.filter(message => {
    if (!message || typeof message !== 'object') return false;
    return !needle || [message.display_name, message.sender, message.text]
      .some(value => typeof value === 'string' && value.toLowerCase().includes(needle));
  });
}

export function createDraftStore({ read, write, maxLength = MAX_MESSAGE_LENGTH, delayMs = 300, onError } = {}) {
  if (typeof read !== 'function' || typeof write !== 'function') throw new TypeError('Draft storage needs read and write drivers.');
  const limit = Number.isSafeInteger(maxLength) && maxLength >= 0 ? maxLength : MAX_MESSAGE_LENGTH;
  const delay = Number.isFinite(delayMs) && delayMs >= 0 ? Math.min(Math.floor(delayMs), 60000) : 300;
  const accounts = new Map(), captures = new WeakMap();
  let disposed = false, disposing;
  const bound = text => typeof text === 'string' ? text.slice(0, limit) : '';
  const active = () => { if (disposed) throw new Error('The draft store is disposed.'); };
  function report(error, entry, operation) {
    try { onError?.(error, { account: entry.account, room: entry.room, operation }); } catch { /* A reporting callback must not discard a retryable draft. */ }
  }
  function entryFor(account, room) {
    if (typeof account !== 'string' || !account.trim() || typeof room !== 'string' || !room.trim()) throw new TypeError('Draft storage needs an account and room.');
    let rooms = accounts.get(account);
    if (!rooms) { rooms = new Map(); accounts.set(account, rooms); }
    let entry = rooms.get(room);
    if (!entry) {
      entry = { account, room, text: '', version: 0, loaded: false, pending: false, timer: null, task: null, loading: null, captures: 0, released: false };
      rooms.set(room, entry);
    }
    return entry;
  }
  function dropReleased(entry) {
    const rooms = accounts.get(entry.account);
    if (!entry.released || entry.captures || entry.pending || entry.task || entry.loading || entry.timer !== null || rooms?.get(entry.room) !== entry) return;
    rooms.delete(entry.room);
    if (!rooms.size) accounts.delete(entry.account);
  }
  function cancelTimer(entry) {
    if (entry.timer !== null) { clearTimeout(entry.timer); entry.timer = null; }
  }
  function persist(entry) {
    cancelTimer(entry);
    if (entry.task) return entry.task;
    if (!entry.pending) return Promise.resolve();
    const task = (async () => {
      // Yield once so the task is registered before the driver can settle or call back.
      await Promise.resolve();
      try {
        while (entry.pending) {
          cancelTimer(entry);
          const version = entry.version, text = entry.text;
          entry.pending = false;
          try { await write(entry.account, `draft:${entry.room}`, text); }
          catch (error) {
            report(error, entry, 'write');
            // A newer edit or clear owns the next write even if the older write failed.
            if (entry.version !== version) continue;
            entry.pending = true;
            throw error;
          }
        }
      } finally { if (entry.task === task) entry.task = null; }
    })();
    entry.task = task;
    return task;
  }
  function schedule(entry) {
    cancelTimer(entry);
    entry.timer = setTimeout(() => { entry.timer = null; void persist(entry).catch(() => {}); }, delay);
  }
  async function flush(account, room) {
    const entries = [];
    for (const [owner, rooms] of accounts) {
      if (account !== undefined && owner !== account) continue;
      for (const [id, entry] of rooms) if (room === undefined || id === room) entries.push(entry);
    }
    const results = await Promise.allSettled(entries.map(persist));
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
  return {
    async load(account, room) {
      active();
      const entry = entryFor(account, room);
      entry.released = false;
      if (entry.loaded) return entry.text;
      if (!entry.loading) {
        const version = entry.version;
        const loading = (async () => {
          await Promise.resolve();
          try {
            const value = await read(account, `draft:${room}`, '');
            active();
            if (!entry.loaded && entry.version === version) { entry.text = bound(value); entry.loaded = true; }
            return entry.text;
          } catch (error) { report(error, entry, 'read'); throw error; }
          finally { if (entry.loading === loading) entry.loading = null; }
        })();
        entry.loading = loading;
      }
      return entry.loading;
    },
    set(account, room, text) {
      active();
      const entry = entryFor(account, room), value = bound(text);
      if (!entry.loaded || entry.text !== value) {
        entry.text = value;
        entry.version++;
        entry.loaded = true;
        entry.pending = true;
      }
      if (entry.pending) schedule(entry);
      return value;
    },
    flush,
    capture(account, room) {
      active();
      const entry = entryFor(account, room);
      if (!entry.loaded) throw new Error('Load a draft before capturing delivery.');
      const capture = Object.freeze({ account, room, text: entry.text, version: entry.version });
      entry.captures++;
      captures.set(capture, entry);
      return capture;
    },
    async consume(capture) {
      active();
      const entry = captures.get(capture);
      if (!entry || entry.version !== capture.version || entry.text !== capture.text) return false;
      entry.text = '';
      const version = ++entry.version;
      entry.loaded = true; entry.pending = true;
      await persist(entry);
      return entry.version === version;
    },
    releaseCapture(capture) {
      const entry = captures.get(capture);
      if (!entry) return;
      captures.delete(capture);
      entry.captures--;
      dropReleased(entry);
    },
    async clear(account, room) {
      active();
      const entry = entryFor(account, room);
      entry.text = '';
      const version = ++entry.version;
      entry.loaded = true;
      entry.pending = true;
      await persist(entry);
      return entry.version === version;
    },
    async release(account, room) {
      active();
      const rooms = accounts.get(account);
      if (!rooms) return;
      const entries = room === undefined ? [...rooms.values()] : [rooms.get(room)].filter(Boolean);
      await Promise.all(entries.map(entry => entry.loading || Promise.resolve()));
      await flush(account, room);
      for (const entry of entries) { entry.released = true; dropReleased(entry); }
    },
    async dispose() {
      disposed = true;
      if (!disposing) {
        for (const rooms of accounts.values()) for (const entry of rooms.values()) cancelTimer(entry);
        const task = flush().then(() => { accounts.clear(); });
        disposing = task;
        task.then(() => { if (disposing === task) disposing = null; }, () => { if (disposing === task) disposing = null; });
      }
      await disposing;
    },
  };
}
