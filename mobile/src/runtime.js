// Coalesce bursts while still reconciling state changed during an active refresh.
export function createRefreshQueue(work) {
  let pending, requested = false;
  return function refresh() {
    requested = true;
    if (pending) return pending;
    const task = Promise.resolve().then(async () => {
      let result;
      try {
        do { requested = false; result = await work(); } while (requested);
        return result;
      } finally { if (pending === task) pending = null; }
    });
    pending = task;
    return task;
  };
}

// A delayed biometric unlock must never reactivate a backgrounded app.
export function createActivityHandler({ unlock, start, stop, onActive }) {
  let revision = 0;
  return async function activity({ isActive }) {
    const current = ++revision;
    if (!isActive) { stop(); onActive(false); return; }
    await unlock();
    if (current !== revision) return;
    await start();
    if (current === revision) onActive(true);
  };
}

export function captureChatView(document) {
  const list = document.querySelector('#messages'), input = document.querySelector('#message-input');
  if (!list) return null;
  return { roomId: list.dataset.roomId, scrollTop: list.scrollTop,
    nearBottom: list.scrollHeight - list.scrollTop - list.clientHeight < 100,
    focused: !!input && document.activeElement === input,
    start: input?.selectionStart, end: input?.selectionEnd };
}
export function restoreChatComposer(view, document) {
  const list = document.querySelector('#messages'), input = document.querySelector('#message-input');
  if (!view?.focused || !input || list?.dataset.roomId !== view.roomId) return;
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 130)}px`;
  input.focus({ preventScroll: true });
  input.setSelectionRange(view.start, view.end);
}
