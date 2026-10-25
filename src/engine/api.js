// Talks to our Vercel functions (/api/rpc, /api/wait). The browser never
// sees a database password; the server only runs allow-listed api_* calls.

export const configured = true;

const ERRORS = {
  ROOM_NOT_FOUND: "Can't find that room. Check the code?",
  NAME_TAKEN: 'That name is already in the room.',
  NAME_REQUIRED: 'Pick or type a name first.',
  NOT_ENOUGH_PLAYERS: 'Need at least 3 players to start.',
  HOST_ONLY: 'Only the host can do that.',
  REMOVED: 'You were removed from the room.',
  ASSIGN_ALL: 'Match every answer before submitting.',
  NAME_USED_TWICE: 'Each name can only be used once.',
  NOT_YOURSELF: "You can't pick yourself.",
  QUESTION_EXISTS: 'That question is already in the game!',
  QUESTION_TOO_SHORT: 'That question is a bit short.',
  ROOM_FULL: 'This room is full.',
  WRONG_PHASE: 'Too late — the game moved on.',
  TOO_LATE_TO_SKIP: 'Too late to skip this one.',
  NO_DATABASE: "The database isn't connected yet (Vercel → Storage → Neon).",
  SERVER_ERROR: 'The server hiccuped. Try again.',
  OFFLINE: 'You seem to be offline.',
};
export class GameError extends Error {
  constructor(code) { super(ERRORS[code] || code); this.code = code; }
}

export async function call(fn, args = {}) {
  let res;
  try {
    res = await fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fn, args }) });
  } catch { throw new GameError('OFFLINE'); }
  let body = {};
  try { body = await res.json(); } catch {}
  if (!res.ok) throw new GameError((body.error || 'SERVER_ERROR').trim());
  return body.data;
}

// ---- this device's identity (survives refresh) ----
const KEY_SESSION = 'fpg.session';
const KEY_NAME = 'fpg.lastName';
export const session = {
  get() { try { return JSON.parse(localStorage.getItem(KEY_SESSION)); } catch { return null; } },
  set(s) { try { localStorage.setItem(KEY_SESSION, JSON.stringify(s)); if (s?.name) localStorage.setItem(KEY_NAME, s.name); } catch {} },
  clear() { try { localStorage.removeItem(KEY_SESSION); } catch {} },
  lastName() { try { return localStorage.getItem(KEY_NAME) || ''; } catch { return ''; } },
};

// ---- live sync: ask the server to tell us when the room changes ----
// Pauses while the app is in the background, and slows down after 30 idle
// minutes, so a forgotten open tab doesn't keep the database awake.
export function watchRoom(code, onChange) {
  let stopped = false, known = '', ctrl = null, lastChange = Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = () => new Promise((r) => {
    if (!document.hidden) return r();
    const on = () => { if (!document.hidden) { document.removeEventListener('visibilitychange', on); r(); } };
    document.addEventListener('visibilitychange', on);
  });
  (async () => {
    while (!stopped) {
      await visible();
      if (stopped) break;
      if (Date.now() - lastChange > 30 * 60 * 1000) await sleep(20000);
      try {
        ctrl = new AbortController();
        const r = await fetch(`/api/wait?code=${encodeURIComponent(code)}&v=${encodeURIComponent(known)}`, { signal: ctrl.signal, cache: 'no-store' });
        const j = await r.json();
        if (!r.ok) { await sleep(2000); continue; }
        if (j.gone) { onChange(); await sleep(3000); continue; }
        if (j.v != null && String(j.v) !== known) { known = String(j.v); lastChange = Date.now(); onChange(); }
      } catch { if (!stopped) await sleep(2000); }
    }
  })();
  const vis = () => { if (!document.hidden) { lastChange = Date.now(); onChange(); } };
  document.addEventListener('visibilitychange', vis);
  return {
    setVersion(v) { known = String(v); },
    stop() { stopped = true; ctrl?.abort(); document.removeEventListener('visibilitychange', vis); },
  };
}
