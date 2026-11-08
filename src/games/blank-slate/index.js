// GAME MODULE: Blank Slate
// A card shows a word with a blank ("SNOW ___"). Everyone secretly writes one
// word. Match exactly one other person: +3 each. Match 2+ others: +1 each.
// First to the target score wins. Rules live in the database
// (db/migrations/004_game_blank_slate.sql) so nobody can peek.
import bank from './cards.json';
import { esc, vibrate } from '../../engine/ui.js';

const MAX = 30;
const TARGETS = [15, 25, 35];

// Local, per-device UI state (not shared). Reset when a new round starts.
let local = { roundId: null, draft: '', editing: false, sel: null };
function sync(round) {
  if (local.roundId !== round.id) local = { roundId: round.id, draft: '', editing: false, sel: null };
}

export default {
  id: 'blank_slate',
  name: 'Blank Slate',
  tagline: 'Fill in the blank. Match exactly one other person to score big.',
  minPlayers: 3,
  bank,
  allowAddQuestions: false,
  showWins: true,

  lobbyExtra(ctx) {
    const target = ctx.state.room.settings?.target || 25;
    return `${rulesCard(target)}${ctx.isHost ? targetPicker(target) : ''}`;
  },

  render(ctx) {
    const { round } = ctx.state;
    sync(round);
    const g = round.game;
    if (round.phase === 'answering') return answering(ctx, g);
    if (round.phase === 'reveal') return reveal(ctx, g);
    if (round.phase === 'results') return results(ctx, g);
    return `<div class="center muted">Loading…</div>`;
  },

  async onAction(act, el, ctx) {
    const round = ctx.state.round;
    if (act === 'target') { vibrate(); return ctx.setting('target', Number(el.dataset.n)); }
    if (act === 'skip') return ctx.act('skip');
    if (act === 'submit-answer') {
      const text = (document.getElementById('bs-answer')?.value || '').trim();
      if (!text) return ctx.toast('Type a word first!');
      await ctx.act('answer', { text });
      local.editing = false; local.draft = '';
      vibrate(30);
      return;
    }
    if (act === 'edit-answer') { local.editing = true; local.draft = round.game.my_answer || ''; return ctx.rerender(); }
    if (act === 'next') { vibrate(); return ctx.act('next'); }
    // host's "same / not the same" calls
    if (act === 'select') {
      local.sel = local.sel === el.dataset.pid ? null : el.dataset.pid;
      vibrate(); return ctx.rerender();
    }
    if (act === 'move') { const a = local.sel; local.sel = null; return ctx.act('move', { a, b: el.dataset.pid }); }
    if (act === 'split') { const a = local.sel; local.sel = null; return ctx.act('split', { a }); }
    if (act === 'merge') { local.sel = null; return ctx.act('merge', { a: el.dataset.a, b: el.dataset.b }); }
    if (act === 'dismiss') return ctx.act('dismiss', { a: el.dataset.a, b: el.dataset.b });
  },

  onInput(el) {
    if (el.id === 'bs-answer') local.draft = el.value;
  },
};

// ---------------------------------------------------------------- pieces

function rulesCard(target) {
  return `<div class="panel bs-rules">
    <div class="bs-rule"><span><b>Fill in the blank</b> with one word.</span></div>
    <div class="bs-rule"><span class="bs-pts p3">+3</span><span>You match exactly <b>one</b> other person</span></div>
    <div class="bs-rule"><span class="bs-pts p1">+1</span><span>You match <b>two or more</b> people</span></div>
    <div class="bs-rule"><span class="bs-pts p0">0</span><span>Nobody matches you</span></div>
    <div class="bs-rule"><span>First to <b>${target}</b> wins. No planning words together!</span></div>
  </div>`;
}

function targetPicker(target) {
  return `<div class="bs-target">
    <span class="field-label">Play to</span>
    <div class="row gap">${TARGETS.map((n) => `<button class="cat ${n === target ? 'on' : ''}" data-act="bs:target" data-n="${n}">${n} points</button>`).join('')}</div>
  </div>`;
}

function cardHtml(round, g, small = false) {
  const parts = String(round.question || '').split('___');
  const blank = '<span class="bs-blank"></span>';
  return `
  <div class="qcard bs-card ${small ? 'small' : ''}">
    <div class="qmeta"><span class="pill">Card ${g.card_no || 1}</span><span class="round-no">First to ${g.target}</span></div>
    <div class="bs-word">${parts.map((p) => esc(p.trim())).join(blank)}</div>
  </div>`;
}

// The race to the target score. Lanes keep their order (by seat) so the
// markers slide forward when points are added.
function tracker(ctx, g) {
  const target = g.target || 25;
  const totals = Object.fromEntries((g.totals || []).map((t) => [t.name.toLowerCase(), t.points]));
  const gained = g.gained || {};
  const players = [...ctx.state.players].sort((a, b) => a.seat - b.seat);
  const top = Math.max(0, ...Object.values(totals));
  return `<div class="bs-track" aria-label="Race to ${target}">
    ${players.map((p) => {
      const pl = ctx.player(p.id);
      const pts = totals[p.name.toLowerCase()] || 0;
      const pct = Math.min(100, (pts / target) * 100);
      const plus = gained[p.name];
      const close = pts > 0 && pts >= target - 5 && pts < target;
      return `<div class="lane ${close ? 'close' : ''} ${pts === top && pts > 0 ? 'lead' : ''}" id="lane-${p.id}" style="--c:${pl.color}">
        <span class="lane-name">${esc(p.name)}</span>
        <span class="lane-bar"><span class="lane-fill" style="width:${pct}%"><span class="lane-dot">${esc(p.name[0])}</span></span></span>
        <span class="lane-pts">${pts}${plus ? `<small class="plus">+${plus}</small>` : ''}</span>
      </div>`;
    }).join('')}
    <div class="lane-finish">🏁 ${target}${top >= target - 5 && top < target ? ' · someone is close!' : ''}</div>
  </div>`;
}

function statusChips(ctx, ids, doneIds, label) {
  const done = new Set(doneIds || []);
  return `<div class="status-row">
    <div class="status-label">${label} <b>${done.size}/${ids.length}</b></div>
    <div class="chips">${ids.map((id) => {
      const pl = ctx.player(id);
      return `<span class="chip ${done.has(id) ? 'done' : 'waiting'}" style="--c:${pl.color}">${done.has(id) ? '✓ ' : ''}${esc(pl.name)}</span>`;
    }).join('')}</div>
  </div>`;
}

function pointsBadge(size) {
  if (size === 2) return '<span class="bs-pts p3">+3 each</span>';
  if (size >= 3) return '<span class="bs-pts p1">+1 each</span>';
  return '<span class="bs-pts p0">0</span>';
}

// "Dogs / dog" when the group has different spellings
function groupLabel(grp) {
  return grp.members.map((m) => m.text).filter((t, i, a) => a.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i).join(' / ');
}

function groupCard(ctx, grp, tools) {
  const texts = [...new Set(grp.members.map((m) => m.text.toLowerCase()))];
  const label = groupLabel(grp);
  const selIn = grp.members.some((m) => m.pid === local.sel);
  return `<div class="bs-group size-${Math.min(grp.size, 3)} ${selIn ? 'has-sel' : ''}" id="grp-${grp.gid}">
    <div class="bs-group-top"><span class="bs-answer">${esc(label)}</span>${pointsBadge(grp.size)}</div>
    <div class="chips">${grp.members.map((m) => {
      const pl = ctx.player(m.pid);
      const showText = texts.length > 1 ? ` <small>${esc(m.text)}</small>` : '';
      return tools
        ? `<button class="chip done ${local.sel === m.pid ? 'sel' : ''}" data-act="bs:select" data-pid="${m.pid}" style="--c:${pl.color}">${esc(pl.name)}${showText}</button>`
        : `<span class="chip done" style="--c:${pl.color}">${esc(pl.name)}${showText}</span>`;
    }).join('')}</div>
    ${tools && local.sel && !selIn ? `<button class="btn ghost small" data-act="bs:move" data-pid="${grp.members[0].pid}">↪ Same as this</button>` : ''}
    ${tools && selIn && grp.size > 1 ? `<button class="btn ghost small" data-act="bs:split">✂️ Not the same — split off</button>` : ''}
  </div>`;
}

// ---------------------------------------------------------------- screens

function answering(ctx, g) {
  const { round, me } = ctx.state;
  const inRound = round.participants.includes(me.id);
  const answered = round.submitted.answer || [];
  let body;
  if (!inRound) {
    body = `<div class="notice">You joined mid-round — you'll be in on the next card!</div>`;
  } else if (g.my_answer && !local.editing) {
    body = `
      <div class="locked">
        <div class="locked-label">🔒 Your word</div>
        <div class="locked-text">${esc(g.my_answer)}</div>
        <button class="btn ghost small" data-act="bs:edit-answer">Change it</button>
      </div>`;
  } else {
    body = `
      <label class="field-label" for="bs-answer">Your word</label>
      <input id="bs-answer" class="text-input bs-input" maxlength="${MAX}" value="${esc(local.draft)}" placeholder="One word…" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="done" data-enter="bs:submit-answer">
      <button class="btn primary big" data-act="bs:submit-answer">Lock it in 🔒</button>`;
  }
  return `
    ${cardHtml(round, g)}
    <div class="panel">${body}</div>
    ${statusChips(ctx, round.participants, answered, 'Answered')}
    ${ctx.isHost ? `<div class="host-bar"><button class="btn ghost" data-act="bs:skip">⏭ Skip card</button></div>` : ''}
    ${tracker(ctx, g)}`;
}

function reveal(ctx, g) {
  const { round } = ctx.state;
  const groups = g.groups || [];
  const tools = ctx.isHost && g.revealed;
  const sugg = g.revealed ? (g.suggestions || []) : [];
  let top = '';
  if (!g.revealed) {
    top = `<p class="hint">${groups.length ? `${groups.length} of ${g.total_groups} revealed` : 'Answers are in! 🥁'}</p>`;
  } else if (ctx.isHost) {
    top = `<p class="hint">Any of these the same word? Tap a name, then “Same as this”.</p>`;
  } else {
    top = `<p class="hint">${esc(ctx.state.players.find((p) => p.is_host)?.name || 'The host')} is checking for matches…</p>`;
  }
  const suggHtml = sugg.length ? `<div class="bs-suggest">
    ${sugg.map((s) => `<div class="bs-sugg">
      <div>Same word? <b>${esc(s.ta)}</b> &amp; <b>${esc(s.tb)}</b></div>
      ${ctx.isHost ? `<div class="row gap"><button class="btn primary small" data-act="bs:merge" data-a="${s.a}" data-b="${s.b}">Yes, same</button>
      <button class="btn ghost small" data-act="bs:dismiss" data-a="${s.a}" data-b="${s.b}">No</button></div>` : ''}
    </div>`).join('')}</div>` : '';
  const label = !g.revealed ? (groups.length ? 'Reveal next 🥁' : 'Reveal first answer 🥁') : 'Looks right — score it ✓';
  return `
    ${cardHtml(round, g, true)}
    ${top}
    ${suggHtml}
    <div class="bs-groups">${groups.map((grp) => groupCard(ctx, grp, tools)).join('')}</div>
    ${ctx.hostButton(label, 'bs:next')}
    ${tracker(ctx, g)}`;
}

function results(ctx, g) {
  const { round } = ctx.state;
  const target = ctx.state.room.settings?.target || 25;
  let banner = '';
  if (g.winner) {
    const pl = ctx.playerByName(g.winner);
    banner = `<div class="bs-winner" style="--c:${pl.color}"><div class="big-emoji">🏆</div>
      <div class="said-by">winner</div><div class="author-name">${esc(g.winner)}</div>
      <div class="muted">first to ${g.target}!</div></div>`;
  } else if (g.tie) {
    banner = `<div class="notice">🤝 Tie at the top! One more card decides it.</div>`;
  }
  const pairs = (g.groups || []).filter((x) => x.size >= 2);
  const next = g.winner
    ? (ctx.isHost ? `${targetPicker(target)}<button class="btn primary huge" data-act="round:start">New game ▶</button>` : `<div class="waiting-host">Waiting for the host to start a new game…</div>`)
    : (ctx.isHost ? `<button class="btn primary huge sticky-cta" data-act="round:start">Next card ▶</button>` : `<div class="waiting-host">Waiting for the host to deal the next card…</div>`);
  return `
    ${banner}
    ${cardHtml(round, g, true)}
    <div class="bs-matches">${pairs.length
      ? pairs.map((x) => `<div class="bs-match"><b>${esc(groupLabel(x))}</b> ${pointsBadge(x.size)} <span class="muted small">${x.members.map((m) => esc(ctx.player(m.pid).name)).join(', ')}</span></div>`).join('')
      : '<div class="muted center">No matches this time!</div>'}</div>
    ${tracker(ctx, g)}
    ${next}`;
}
