import './styles.css';
import qrcode from 'qrcode-generator';
import { configured, call, session, watchRoom, GameError } from './engine/api.js';
import { paint, esc, colorFor, toast, vibrate } from './engine/ui.js';
import { GAMES, gameById } from './games/index.js';

const app = document.getElementById('app');
const FALLBACK_ROSTER = ['Dad', 'Mom', 'Gio', 'Valentino'];

const S = {
  view: 'home',          // home | host | join | room
  overlay: null,         // menu | addq | standings | confirm-season
  game: GAMES[0].id,
  roster: FALLBACK_ROSTER,
  name: session.lastName(),
  custom: false,
  code: new URLSearchParams(location.search).get('code')?.toUpperCase().slice(0, 4) || '',
  room: null,            // latest api_state
  busy: false,
  reclaim: null,         // name waiting for "is that you?" confirmation
  familyQs: null,
  addq: { category: 'funny', text: '' },
};
let watcher = null;

// ------------------------------------------------------------ helpers

const me = () => S.room?.me;
const isHost = () => Boolean(S.room?.me?.is_host);
const playerMap = () => Object.fromEntries((S.room?.players || []).map((p) => [p.id, { ...p, color: colorFor(p.seat) }]));
function player(id) { return playerMap()[id] || { id, name: 'Someone', color: '#8a8fb5', seat: 99 }; }
function playerByName(name) {
  return (S.room?.players || []).map((p) => ({ ...p, color: colorFor(p.seat) })).find((p) => p.name.toLowerCase() === String(name).toLowerCase())
    || { name, color: '#8a8fb5' };
}
const host = () => (S.room?.players || []).find((p) => p.is_host);

async function busy(fn) {
  if (S.busy) return;
  S.busy = true; render();
  try { return await fn(); }
  catch (e) { toast(e instanceof GameError ? e.message : 'Something went wrong. Try again.', 'error'); console.error(e); }
  finally { S.busy = false; render(); }
}

// ------------------------------------------------------------ room sync

let refreshing = null, again = false;
async function refresh() {
  const s = session.get();
  if (!s) return;
  if (refreshing) { again = true; return refreshing; }
  refreshing = (async () => {
    try {
      const st = await call('api_state', { p_code: s.code, p_token: s.token });
      S.room = st; S.view = 'room';
      watcher?.setVersion(st.version);
      render();
    } catch (e) {
      if (['REMOVED', 'NOT_IN_ROOM', 'ROOM_NOT_FOUND'].includes(e.code)) {
        leaveLocal(e.code === 'REMOVED' ? 'The host removed you from the room.' : 'That room has ended.');
      }
    } finally {
      refreshing = null;
      if (again) { again = false; refresh(); }
    }
  })();
  return refreshing;
}

function enterRoom(res, name) {
  session.set({ code: res.code, token: res.token, player_id: res.player_id, name });
  watcher?.stop();
  watcher = watchRoom(res.code, refresh);
  history.replaceState(null, '', location.pathname);
  return refresh();
}

function leaveLocal(msg) {
  watcher?.stop(); watcher = null;
  session.clear();
  S.room = null; S.view = 'home'; S.overlay = null;
  if (msg) toast(msg);
  render();
}

async function act(action, args = {}) {
  const s = session.get();
  await busy(async () => {
    await call('api_action', { p_code: s.code, p_token: s.token, p_action: action, p_args: args });
    await refresh();
  });
}

async function engine(fn, args = {}) {
  const s = session.get();
  return busy(async () => {
    const r = await call(fn, { p_code: s.code, p_token: s.token, ...args });
    await refresh();
    return r;
  });
}

// ------------------------------------------------------------ screens

function render() {
  if (!configured) return paint(app, setupNeeded());
  let html = '';
  if (S.view === 'home') html = home();
  else if (S.view === 'host') html = hostSetup();
  else if (S.view === 'join') html = joinSetup();
  else if (S.view === 'room' && S.room) html = roomScreen();
  else html = `<div class="center muted pad">Loading…</div>`;
  if (S.overlay) html += overlay();
  paint(app, html);
  document.body.classList.toggle('busy', S.busy);
}

function setupNeeded() {
  return `<div class="screen center pad"><h1 class="logo">Game Night</h1>
    <p>This app isn't connected to its database yet.</p>
    <p class="muted small">Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in Vercel → Settings → Environment Variables, then redeploy.</p></div>`;
}

function logo() {
  return `<div class="marquee"><div class="logo-small">The</div><h1 class="logo">Family<br>Game Night</h1><div class="lights"></div></div>`;
}

function home() {
  return `<div class="screen home">
    ${logo()}
    <div class="stack">
      <button class="btn primary huge" data-act="go:join">Join a game</button>
      <button class="btn secondary huge" data-act="go:host">Host a game</button>
    </div>
    <p class="muted small center foot">One person hosts. Everyone else joins with the 4-letter code.</p>
  </div>`;
}

function namePicker() {
  const chips = S.roster.map((n) => `<button class="name-pick ${!S.custom && S.name === n ? 'on' : ''}" data-act="name:pick" data-name="${esc(n)}">${esc(n)}</button>`).join('');
  return `
    <div class="field-label">Who are you?</div>
    <div class="name-grid">${chips}
      <button class="name-pick guest ${S.custom ? 'on' : ''}" data-act="name:custom">+ Guest</button>
    </div>
    ${S.custom ? `<input id="custom-name" class="text-input" maxlength="20" placeholder="Type your name" value="${esc(S.name)}" autocomplete="off" autocapitalize="words" enterkeyhint="go">` : ''}`;
}

function hostSetup() {
  return `<div class="screen">
    <button class="back" data-act="go:home">‹ Back</button>
    <h1 class="screen-title">Host a game</h1>
    <div class="field-label">Pick a game</div>
    <div class="game-list">
      ${GAMES.map((g) => `<button class="game-pick ${S.game === g.id ? 'on' : ''}" data-act="game:pick" data-id="${g.id}">
        <b>${esc(g.name)}</b><span>${esc(g.tagline)}</span></button>`).join('')}
      <div class="game-pick soon"><b>More games coming</b><span>Would You Rather · Match It · Two Truths and a Lie</span></div>
    </div>
    ${namePicker()}
    <button class="btn primary huge" data-act="host:create" ${S.busy ? 'disabled' : ''}>Create room</button>
  </div>`;
}

function joinSetup() {
  return `<div class="screen">
    <button class="back" data-act="go:home">‹ Back</button>
    <h1 class="screen-title">Join a game</h1>
    <label class="field-label" for="join-code">Room code</label>
    <input id="join-code" class="code-input" maxlength="4" placeholder="ABCD" value="${esc(S.code)}" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" inputmode="text">
    ${namePicker()}
    <button class="btn primary huge" data-act="join:go" ${S.busy ? 'disabled' : ''}>Join</button>
    ${S.reclaim ? `<div class="confirm">
      <p><b>${esc(S.reclaim)}</b> is already in this room. Is that you on a new device?</p>
      <div class="row gap"><button class="btn ghost grow" data-act="join:noreclaim">No</button>
      <button class="btn primary grow" data-act="join:reclaim">Yes, that's me</button></div></div>` : ''}
  </div>`;
}

function topbar() {
  const r = S.room;
  return `<header class="topbar">
    <div class="tb-code" data-act="menu:open"><span class="tb-label">Room</span><span class="tb-value">${esc(r.room.code)}</span></div>
    <div class="tb-me" style="--c:${playerByName(r.me.name).color}">${esc(r.me.name)}${r.me.is_host ? ' <span class="crown">HOST</span>' : ''}</div>
    <button class="tb-menu" data-act="menu:open" aria-label="Menu">☰</button>
  </header>`;
}

function roomScreen() {
  const r = S.room;
  const game = gameById(r.room.game);
  let body;
  if (!r.round) body = lobby(game);
  else body = game.render(gameCtx());
  return `${topbar()}<main class="screen room phase-${r.round?.phase || 'lobby'}">${body}</main>`;
}

function joinUrl() { return `${location.origin}/?code=${S.room.room.code}`; }

function qrSvg(text) {
  try { const q = qrcode(0, 'M'); q.addData(text); q.make(); return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true }); }
  catch { return ''; }
}

function lobby(game) {
  const r = S.room;
  const n = r.players.length;
  const min = r.room.min_players || game.minPlayers;
  return `
    <div class="lobby-code">
      <div class="lc-label">Room code</div>
      <div class="lc-code">${r.room.code.split('').map((c) => `<span>${c}</span>`).join('')}</div>
      <div class="lc-url">Join at <b>${esc(location.host)}</b></div>
    </div>
    <div class="game-banner"><b>${esc(game.name)}</b><span>${esc(game.tagline)}</span></div>
    <div class="section-title">Players <span class="count">${n}</span></div>
    <div class="player-list">
      ${r.players.map((p) => `<div class="player-row" style="--c:${colorFor(p.seat)}">
        <span class="avatar">${esc(p.name[0])}</span><span class="pname">${esc(p.name)}</span>
        ${p.is_host ? '<span class="crown">HOST</span>' : ''}
        ${isHost() && p.id !== r.me.id ? `<button class="x" data-act="player:remove" data-id="${p.id}" data-name="${esc(p.name)}" aria-label="Remove">✕</button>` : ''}
      </div>`).join('')}
      ${n < min ? `<div class="player-row empty">Waiting for ${min - n} more…</div>` : ''}
    </div>
    ${isHost()
      ? `<button class="btn primary huge sticky-cta" data-act="round:start" ${n < min || S.busy ? 'disabled' : ''}>${n < min ? `Need ${min} players` : "Everyone's in — Start! ▶"}</button>`
      : `<div class="waiting-host">Waiting for ${esc(host()?.name || 'the host')} to start…</div>`}
    <div class="row gap wrap center-row">
      <button class="btn ghost" data-act="addq:open">✍️ Add a question</button>
      <button class="btn ghost" data-act="standings:open">🏆 Standings</button>
    </div>
    ${isHost() ? `<details class="qr"><summary>Show QR code to join</summary><div class="qr-box">${qrSvg(joinUrl())}</div></details>` : ''}`;
}

function standingsScreen({ title = 'Season Standings', next = false } = {}) {
  const r = S.room;
  const rows = r.standings || [];
  const medals = ['🥇', '🥈', '🥉'];
  return `
    <h1 class="screen-title">${esc(title)}</h1>
    <div class="season-name">${esc(r.season?.name || '')}</div>
    <div class="board">
      ${rows.length ? rows.map((s, i) => `<div class="board-row ${i === 0 ? 'winner' : ''}" style="--c:${playerByName(s.name).color}">
        <span class="rank">${medals[i] || i + 1}</span><span class="bname">${esc(s.name)}</span>
        <span class="bdetail">${s.rounds} round${s.rounds === 1 ? '' : 's'}</span><span class="bpoints">${s.points}</span></div>`).join('')
        : '<div class="muted center pad">No points yet this season.</div>'}
    </div>
    ${next ? (isHost()
      ? `<button class="btn primary huge" data-act="round:start" ${S.busy ? 'disabled' : ''}>Next round ▶</button>`
      : `<div class="waiting-host">Waiting for ${esc(host()?.name || 'the host')} to start the next round…</div>`) : ''}`;
}

function gameCtx() {
  return {
    state: S.room,
    me: S.room.me,
    isHost: isHost(),
    player, playerByName,
    act, toast, rerender: render,
    standingsScreen,
    hostButton(label, action) {
      return isHost()
        ? `<button class="btn primary huge sticky-cta" data-act="${action}" ${S.busy ? 'disabled' : ''}>${label}</button>`
        : `<div class="waiting-host">${esc(host()?.name || 'The host')} will tap to continue…</div>`;
    },
  };
}

// ------------------------------------------------------------ overlays

function overlay() {
  if (S.overlay === 'menu') return menuSheet();
  if (S.overlay === 'addq') return addQuestion();
  if (S.overlay === 'standings') return sheet(standingsScreen({ title: 'Season Standings' }) +
    `<button class="btn ghost" data-act="seasons:past">Past seasons</button><div id="past-seasons"></div>`);
  return '';
}

function sheet(inner) {
  return `<div class="overlay" data-act="overlay:close"><div class="sheet" data-stop="1">
    <button class="sheet-close" data-act="overlay:close" aria-label="Close">✕</button>${inner}</div></div>`;
}

function menuSheet() {
  const r = S.room;
  const inRound = r.round && !r.round.finished;
  return sheet(`
    <h2>Room ${esc(r.room.code)}</h2>
    <div class="menu-list">
      <button class="menu-item" data-act="addq:open">✍️ Add a question</button>
      <button class="menu-item" data-act="standings:open">🏆 Season standings</button>
    </div>
    ${isHost() ? `
      <div class="section-title">Host controls</div>
      <div class="player-list compact">
        ${r.players.map((p) => `<div class="player-row" style="--c:${colorFor(p.seat)}">
          <span class="avatar">${esc(p.name[0])}</span><span class="pname">${esc(p.name)}</span>
          ${p.is_host ? '<span class="crown">HOST</span>' : `
            <button class="mini" data-act="player:host" data-id="${p.id}" data-name="${esc(p.name)}">Make host</button>
            <button class="x" data-act="player:remove" data-id="${p.id}" data-name="${esc(p.name)}" aria-label="Remove">✕</button>`}
        </div>`).join('')}
      </div>
      <div class="menu-list">
        ${inRound ? `<button class="menu-item" data-act="round:cancel">⏹ End this round (no points)</button>` : ''}
        <button class="menu-item" data-act="season:new">🆕 Start a new season</button>
      </div>` : ''}
    <div class="menu-list"><button class="menu-item danger" data-act="room:leave">🚪 Leave room</button></div>
    <p class="muted small center">${esc(r.season?.name || '')} · ${esc(r.room.game_name)}</p>`);
}

const QUESTION_TIPS = [
  'Just one question — no "and why?"',
  'Something a 9-year-old can answer in a few words',
  "The answer shouldn't be someone in the family",
];

function questionWarnings(text) {
  const t = text.toLowerCase();
  const w = [];
  if (/\band why\b|\bwhy\?/.test(t)) w.push('Try dropping the "why" part — keep it to one question.');
  if (/\bwho\b/.test(t) && /(family|us|home|house|\bof us\b)/.test(t)) w.push("Careful — if the answer is a family member's name, the guessing breaks.");
  if ((t.match(/\?/g) || []).length > 1) w.push('That looks like two questions.');
  return w;
}

function addQuestion() {
  const game = gameById(S.room.room.game);
  const cats = Object.entries(game.categories || {}).filter(([k]) => k !== 'family');
  const warns = questionWarnings(S.addq.text);
  const list = S.familyQs;
  return sheet(`
    <h2>Add a question</h2>
    <p class="muted small">It goes into the game, tagged with your name (${esc(S.room.me.name)}). Family questions come up more often!</p>
    <div class="field-label">Category</div>
    <div class="cat-grid">${cats.map(([k, label]) => `<button class="cat ${S.addq.category === k ? 'on' : ''}" data-act="addq:cat" data-cat="${k}">${esc(label)}</button>`).join('')}</div>
    <label class="field-label" for="addq-text">Your question</label>
    <textarea id="addq-text" class="answer-input" maxlength="150" rows="3" placeholder="What's the weirdest dream you've had?">${esc(S.addq.text)}</textarea>
    <ul class="tips">${QUESTION_TIPS.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>
    <div id="addq-warn">${warns.map((w) => `<div class="warn">⚠️ ${esc(w)}</div>`).join('')}</div>
    <button class="btn primary big" data-act="addq:save" ${S.busy ? 'disabled' : ''}>Add it ✨</button>
    <div class="section-title">Family-made questions <span class="count">${list ? list.length : '…'}</span></div>
    <div class="fq-list">${(list || []).map((q) => `<div class="fq">
      <div class="fq-text">${esc(q.text)}</div>
      <div class="fq-meta">by ${esc(q.author || '?')} · used ${q.times_used}×
      ${isHost() || (q.author || '').toLowerCase() === S.room.me.name.toLowerCase() ? `<button class="mini" data-act="addq:delete" data-id="${q.id}">Delete</button>` : ''}</div>
    </div>`).join('') || (list ? '<div class="muted small">None yet — be the first!</div>' : '')}</div>`);
}

async function loadFamilyQs() {
  const s = session.get();
  try { S.familyQs = await call('api_family_questions', { p_code: s.code, p_token: s.token }); } catch { S.familyQs = []; }
  render();
}

// ------------------------------------------------------------ events

function currentName() {
  if (S.custom) return (document.getElementById('custom-name')?.value || S.name || '').trim();
  return S.name;
}

const handlers = {
  'go:home': () => { S.view = 'home'; S.reclaim = null; },
  'go:host': () => { S.view = 'host'; },
  'go:join': () => { S.view = 'join'; },
  'game:pick': (el) => { S.game = el.dataset.id; },
  'name:pick': (el) => { S.name = el.dataset.name; S.custom = false; vibrate(); },
  'name:custom': () => { if (!S.custom) { S.custom = true; S.name = ''; } setTimeout(() => document.getElementById('custom-name')?.focus(), 50); },

  'host:create': () => {
    const name = currentName();
    if (!name) return toast('Pick your name first!');
    return busy(async () => {
      const game = gameById(S.game);
      const res = await call('api_create_room', { p_name: name, p_game: game.id, p_bank: game.bank || null });
      await enterRoom(res, name);
    });
  },
  'join:go': () => join(false),
  'join:reclaim': () => join(true),
  'join:noreclaim': () => { S.reclaim = null; toast('Pick a different name, or add a letter (like "Gio B").'); },

  'menu:open': () => { S.overlay = 'menu'; },
  'overlay:close': () => { S.overlay = null; },
  'standings:open': () => { S.overlay = 'standings'; },
  'addq:open': () => { S.overlay = 'addq'; S.familyQs = null; loadFamilyQs(); },
  'addq:cat': (el) => { S.addq.category = el.dataset.cat; },
  'addq:save': () => {
    const text = (document.getElementById('addq-text')?.value || '').trim();
    if (text.length < 5) return toast('Write a question first!');
    const s = session.get();
    return busy(async () => {
      await call('api_add_question', { p_code: s.code, p_token: s.token, p_category: S.addq.category, p_text: text });
      S.addq.text = '';
      const ta = document.getElementById('addq-text'); if (ta) ta.value = '';
      toast('Question added! 🎉', 'good'); vibrate(30);
      await loadFamilyQs();
    });
  },
  'addq:delete': (el) => {
    if (!confirm('Delete this question?')) return;
    const s = session.get();
    return busy(async () => { await call('api_delete_question', { p_code: s.code, p_token: s.token, p_id: Number(el.dataset.id) }); await loadFamilyQs(); });
  },
  'seasons:past': async () => {
    const s = session.get();
    const past = await call('api_past_seasons', { p_code: s.code, p_token: s.token }).catch(() => []);
    const box = document.getElementById('past-seasons');
    if (box) box.innerHTML = past.length ? past.map((p) => `<div class="past"><b>${esc(p.name)}</b> — ${p.standings.map((x, i) => `${i === 0 ? '👑 ' : ''}${esc(x.name)} ${x.points}`).join(' · ') || 'no points'}</div>`).join('') : '<p class="muted small">No past seasons yet.</p>';
  },

  'round:start': () => engine('api_start_round'),
  'round:cancel': () => { if (confirm('End this round? Nobody gets points for it.')) { S.overlay = null; return engine('api_cancel_round'); } },
  'season:new': () => {
    const name = prompt('Name the new season (optional):', '');
    if (name === null) return;
    S.overlay = null;
    return engine('api_new_season', { p_name: name }).then(() => toast('New season started! Scores reset to 0.', 'good'));
  },
  'player:remove': (el) => { if (confirm(`Remove ${el.dataset.name} from the room?`)) return engine('api_remove_player', { p_player: el.dataset.id }); },
  'player:host': (el) => { if (confirm(`Make ${el.dataset.name} the host?`)) { S.overlay = null; return engine('api_make_host', { p_player: el.dataset.id }); } },
  'room:leave': () => {
    if (!confirm('Leave this room?')) return;
    const s = session.get();
    return busy(async () => { await call('api_leave_room', { p_code: s.code, p_token: s.token }).catch(() => {}); leaveLocal(); });
  },
};

function join(reclaim) {
  const code = (document.getElementById('join-code')?.value || S.code || '').trim().toUpperCase();
  const name = currentName();
  S.code = code;
  if (code.length !== 4) return toast('Enter the 4-letter room code');
  if (!name) return toast('Pick your name first!');
  return busy(async () => {
    try {
      const res = await call('api_join_room', { p_code: code, p_name: name, p_reclaim: reclaim });
      S.reclaim = null;
      await enterRoom(res, name);
    } catch (e) {
      if (e.code === 'NAME_TAKEN') { S.reclaim = name; return; }
      throw e;
    }
  });
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  // clicks inside a sheet shouldn't close it via the backdrop
  if (el.classList.contains('overlay') && e.target.closest('[data-stop]')) return;
  const a = el.dataset.act;
  const [ns, name] = a.split(':');
  if (handlers[a]) {
    const r = handlers[a](el, e);
    render();
    await r;
    return;
  }
  const game = S.room && gameById(S.room.room.game);
  if (game && ns === game.prefix) {
    try { await game.onAction(name, el, gameCtx()); } catch (err) { toast(err.message || 'Oops', 'error'); }
    render();
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'join-code') { el.value = el.value.toUpperCase().replace(/[^A-Z]/g, ''); S.code = el.value; }
  else if (el.id === 'custom-name') S.name = el.value;
  else if (el.id === 'addq-text') {
    S.addq.text = el.value;
    const box = document.getElementById('addq-warn');
    if (box) box.innerHTML = questionWarnings(el.value).map((w) => `<div class="warn">⚠️ ${esc(w)}</div>`).join('');
  } else if (S.room) gameById(S.room.room.game)?.onInput?.(el);
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey) return;
  const id = e.target.id;
  if (id === 'wsi-answer') { e.preventDefault(); document.querySelector('[data-act="wsi:submit-answer"]')?.click(); }
  if (id === 'join-code' || (id === 'custom-name' && S.view === 'join')) { e.preventDefault(); join(false); }
  if (id === 'custom-name' && S.view === 'host') { e.preventDefault(); handlers['host:create'](); }
});

// ------------------------------------------------------------ boot

async function boot() {
  render();
  if (!configured) return;
  call('api_roster').then((r) => { if (Array.isArray(r) && r.length) { S.roster = r; render(); } }).catch(() => {});
  const s = session.get();
  if (s) {
    S.view = 'loading'; render();
    watcher = watchRoom(s.code, refresh);
    await refresh();
    if (!S.room) { S.view = S.code ? 'join' : 'home'; render(); }
  } else if (S.code) {
    S.view = 'join'; render();
  }
}
boot();
