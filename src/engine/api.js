// Talks to Supabase. Only the public "anon" key is used here; the database
// only lets it call the api_* functions, which check the room code + token.
import { createClient } from '@supabase/supabase-js';

const URL = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;
export const configured = Boolean(URL && KEY);
export const sb = configured ? createClient(URL, KEY, { auth: { persistSession: false } }) : null;

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
};
export class GameError extends Error {
  constructor(code) { super(ERRORS[code] || code); this.code = code; }
}

export async function call(fn, args = {}) {
  const { data, error } = await sb.rpc(fn, args);
  if (error) {
    const code = (error.message || '').trim();
    throw new GameError(ERRORS[code] ? code : (navigator.onLine ? code : 'You seem to be offline.'));
  }
  return data;
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

// ---- live sync: Realtime ping + polling fallback ----
export function watchRoom(code, onChange) {
  let channel = null, stopped = false, lastVersion = null, timer = null;
  const check = async () => {
    try {
      const v = await call('api_version', { p_code: code });
      if (v !== lastVersion) { lastVersion = v; onChange(); }
    } catch {}
  };
  if (sb) {
    channel = sb.channel('room-' + code, { config: { private: false } })
      .on('broadcast', { event: 'changed' }, () => onChange())
      .subscribe();
  }
  const loop = () => { if (stopped) return; timer = setTimeout(async () => { await check(); loop(); }, document.hidden ? 6000 : 2500); };
  loop();
  const vis = () => { if (!document.hidden) onChange(); };
  document.addEventListener('visibilitychange', vis);
  return {
    setVersion(v) { lastVersion = v; },
    stop() { stopped = true; clearTimeout(timer); document.removeEventListener('visibilitychange', vis); if (channel) sb.removeChannel(channel); },
  };
}
