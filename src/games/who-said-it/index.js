// GAME MODULE: Who Said It?
// The engine calls render(ctx) to draw the round, and onAction(...) for taps
// on elements with data-act="wsi:...". Game rules live in the database
// (supabase/migrations/*_game_who_said_it.sql) so nobody can peek.
import bank from './questions.json';
import { esc, vibrate } from '../../engine/ui.js';

const CATEGORIES = {
  'funny': 'Funny',
  'would-be-cool': 'Would Be Cool',
  'about-you': 'About You',
  'memories': 'Memories',
  'food': 'Food',
  'sports-football': 'Sports & Football',
  'school-work': 'School & Work',
  'imagination': 'Imagination',
  'family': 'Family-made',
};

// Local, per-device UI state (not shared). Reset when a new round starts.
let local = { roundId: null, draft: '', editing: false, map: {}, selected: null };
function sync(round) {
  if (local.roundId !== round.id) local = { roundId: round.id, draft: '', editing: false, map: {}, selected: null };
}

const MAX = 100;

export default {
  id: 'who_said_it',
  name: 'Who Said It?',
  tagline: 'Everyone answers in secret. Then guess who wrote what.',
  minPlayers: 3,
  bank,
  categories: CATEGORIES,

  render(ctx) {
    const { round } = ctx.state;
    sync(round);
    const g = round.game;
    const p = round.phase;
    if (p === 'answering') return answering(ctx, g);
    if (p === 'matching') return matching(ctx, g);
    if (p === 'reveal') return reveal(ctx, g);
    if (p === 'results') return results(ctx, g);
    if (p === 'standings') return ctx.standingsScreen({ title: 'Season Standings', next: true });
    return `<div class="center muted">Loading…</div>`;
  },

  async onAction(act, el, ctx) {
    const round = ctx.state.round;
    if (act === 'skip') return ctx.act('skip');
    if (act === 'submit-answer') {
      const text = (document.getElementById('wsi-answer')?.value || '').trim();
      if (!text) return ctx.toast('Type an answer first!');
      await ctx.act('answer', { text });
      local.editing = false; local.draft = '';
      vibrate(30);
      return;
    }
    if (act === 'edit-answer') { local.editing = true; local.draft = round.game.my_answer || ''; return ctx.rerender(); }
    if (act === 'pick-answer') { local.selected = el.dataset.key; vibrate(); return ctx.rerender(); }
    if (act === 'pick-name') {
      const pid = el.dataset.pid;
      const answers = round.game.answers || [];
      if (!local.selected) local.selected = answers.find((a) => !local.map[a.key])?.key || null;
      if (!local.selected) return ctx.toast('Tap an answer first');
      // a name can only be used once: move it if it was used elsewhere
      for (const k of Object.keys(local.map)) if (local.map[k] === pid) delete local.map[k];
      local.map[local.selected] = pid;
      vibrate();
      local.selected = answers.find((a) => !local.map[a.key])?.key || null;
      return ctx.rerender();
    }
    if (act === 'clear-matches') { local.map = {}; local.selected = null; return ctx.rerender(); }
    if (act === 'submit-guesses') { await ctx.act('guesses', { map: local.map }); vibrate(30); return; }
    if (act === 'next') { vibrate(); return ctx.act('next'); }
  },

  onInput(el) {
    if (el.id === 'wsi-answer') {
      local.draft = el.value;
      const c = document.getElementById('wsi-count');
      if (c) c.textContent = `${el.value.length}/${MAX}`;
    }
  },
};

// ---------------------------------------------------------------- screens

function questionCard(round, g, small = false) {
  const cat = CATEGORIES[g.category] || g.category || '';
  return `
  <div class="qcard ${small ? 'small' : ''}">
    <div class="qmeta"><span class="pill">${esc(cat)}</span><span class="round-no">Round ${round.number}</span></div>
    <div class="qtext">${esc(round.question)}</div>
    ${g.q_author ? `<div class="qauthor">✍️ Written by ${esc(g.q_author)}</div>` : ''}
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

function answering(ctx, g) {
  const { round, me } = ctx.state;
  const inRound = round.participants.includes(me.id);
  const answered = round.submitted.answer || [];
  let body;
  if (!inRound) {
    body = `<div class="notice">You joined mid-round — you'll be in the next one!</div>`;
  } else if (g.my_answer && !local.editing) {
    body = `
      <div class="locked">
        <div class="locked-label">🔒 Your secret answer</div>
        <div class="locked-text">“${esc(g.my_answer)}”</div>
        <button class="btn ghost small" data-act="wsi:edit-answer">Change it</button>
      </div>`;
  } else {
    const val = local.draft;
    body = `
      <label class="field-label" for="wsi-answer">Your secret answer</label>
      <textarea id="wsi-answer" class="answer-input" maxlength="${MAX}" rows="2" placeholder="Type it here… nobody can see" autocomplete="off" autocorrect="on" enterkeyhint="done">${esc(val)}</textarea>
      <div class="row between"><span class="muted small" id="wsi-count">${val.length}/${MAX}</span></div>
      <button class="btn primary big" data-act="wsi:submit-answer">Lock it in 🔒</button>`;
  }
  return `
    ${questionCard(round, g)}
    <div class="panel">${body}</div>
    ${statusChips(ctx, round.participants, answered, 'Answered')}
    ${ctx.isHost ? `<div class="host-bar"><button class="btn ghost" data-act="wsi:skip">⏭ Skip question</button></div>` : ''}`;
}

function matching(ctx, g) {
  const { round, me } = ctx.state;
  const inRound = round.participants.includes(me.id);
  const done = round.submitted.guesses || [];
  if (!inRound) {
    return `${questionCard(round, g, true)}<div class="notice">Everyone's matching answers. You'll be in the next round!</div>${statusChips(ctx, round.participants, done, 'Finished')}`;
  }
  if (done.includes(me.id)) {
    const waiting = round.participants.filter((id) => !done.includes(id));
    return `
      ${questionCard(round, g, true)}
      <div class="panel center">
        <div class="big-emoji">🕵️</div>
        <h2>Locked in!</h2>
        <p class="muted">${waiting.length ? 'Waiting for ' + waiting.map((id) => esc(ctx.player(id).name)).join(', ') : 'Revealing…'}</p>
      </div>
      ${statusChips(ctx, round.participants, done, 'Finished')}`;
  }
  const answers = g.answers || [];
  if (!local.selected || local.map[local.selected]) {
    local.selected = answers.find((a) => !local.map[a.key])?.key || local.selected;
  }
  const names = round.participants.filter((id) => id !== me.id);
  const usedBy = Object.fromEntries(Object.entries(local.map).map(([k, pid]) => [pid, k]));
  const complete = answers.length > 0 && answers.every((a) => local.map[a.key]);
  return `
    ${questionCard(round, g, true)}
    <p class="hint">Tap an answer, then tap who said it.</p>
    <div class="answers">
      ${answers.map((a, i) => {
        const pid = local.map[a.key];
        const pl = pid ? ctx.player(pid) : null;
        return `<button class="answer-card ${local.selected === a.key ? 'selected' : ''} ${pl ? 'assigned' : ''}" data-act="wsi:pick-answer" data-key="${a.key}" style="${pl ? `--c:${pl.color}` : ''}">
          <span class="answer-letter">${String.fromCharCode(65 + i)}</span>
          <span class="answer-text">“${esc(a.text)}”</span>
          <span class="answer-who">${pl ? esc(pl.name) : '?'}</span>
        </button>`;
      }).join('')}
    </div>
    <div class="tray">
      <div class="tray-names">
        ${names.map((id) => {
          const pl = ctx.player(id);
          const used = usedBy[id];
          return `<button class="name-btn ${used ? 'used' : ''}" data-act="wsi:pick-name" data-pid="${id}" style="--c:${pl.color}">${esc(pl.name)}</button>`;
        }).join('')}
      </div>
      <div class="row gap">
        <button class="btn ghost" data-act="wsi:clear-matches" ${Object.keys(local.map).length ? '' : 'disabled'}>Reset</button>
        <button class="btn primary grow" data-act="wsi:submit-guesses" ${complete ? '' : 'disabled'}>${complete ? 'Submit ✓' : `Match ${answers.length - Object.keys(local.map).length} more`}</button>
      </div>
    </div>
    ${statusChips(ctx, round.participants, done, 'Finished')}`;
}

function reveal(ctx, g) {
  const { round } = ctx.state;
  const item = (g.items || [])[g.index];
  if (!item) return `<div class="center muted">Get ready…</div>`;
  const dots = Array.from({ length: g.total }, (_, i) => `<span class="dot ${i < g.index ? 'past' : i === g.index ? 'now' : ''}"></span>`).join('');
  let who = '';
  if (g.author_shown && item.author) {
    const author = ctx.player(item.author);
    const guesses = item.guesses || {};
    const right = Object.entries(guesses).filter(([, pid]) => pid === item.author).map(([gid]) => gid);
    const wrong = Object.entries(guesses).filter(([, pid]) => pid !== item.author);
    who = `
      <div class="author-reveal" style="--c:${author.color}">
        <div class="said-by">said by</div>
        <div class="author-name">${esc(author.name)}</div>
      </div>
      <div class="guess-results">
        <div class="gr-row"><span class="gr-label good">Got it right</span>
          <span>${right.length ? right.map((id) => `<span class="chip done" style="--c:${ctx.player(id).color}">✓ ${esc(ctx.player(id).name)} +1</span>`).join('') : '<span class="muted">Nobody! 😱</span>'}</span></div>
        ${wrong.length ? `<div class="gr-row"><span class="gr-label bad">Fooled</span>
          <span>${wrong.map(([gid, pid]) => `<span class="chip miss">${esc(ctx.player(gid).name)} <small>guessed ${esc(ctx.player(pid).name)}</small></span>`).join('')}</span></div>
          <div class="muted small center">${esc(author.name)} gets +${wrong.length} for fooling ${wrong.length === 1 ? 'someone' : 'people'}</div>` : ''}
      </div>
      <div class="story" style="--c:${author.color}">🎤 <b>${esc(author.name)}</b>, tell the story behind your answer.</div>`;
  } else {
    who = `<div class="who-said-it pulse">Who said it?</div>`;
  }
  const last = g.index >= g.total - 1 && g.author_shown;
  const label = !g.author_shown ? 'Reveal who said it 🥁' : last ? 'See round results 🏆' : 'Next answer ▶';
  return `
    <div class="reveal-top"><span class="muted small">${esc(round.question)}</span><div class="dots">${dots}</div></div>
    <div class="reveal-card ${g.author_shown ? 'shown' : ''}" data-anim="${round.step}">
      <div class="reveal-answer">“${esc(item.text)}”</div>
      ${who}
    </div>
    ${ctx.hostButton(label, 'wsi:next')}`;
}

function results(ctx, g) {
  const res = g.results || [];
  const top = res[0]?.points ?? 0;
  return `
    <h1 class="screen-title">Round ${ctx.state.round.number} Results</h1>
    <div class="board">
      ${res.map((r, i) => {
        const pl = ctx.playerByName(r.name);
        return `<div class="board-row ${r.points === top && top > 0 ? 'winner' : ''}" style="--c:${pl.color}">
          <span class="rank">${i + 1}</span>
          <span class="bname">${esc(r.name)}</span>
          <span class="bdetail">${r.correct} right · fooled ${r.fooled}</span>
          <span class="bpoints">+${r.points}</span>
        </div>`;
      }).join('')}
    </div>
    ${ctx.hostButton('Season standings ▶', 'wsi:next')}`;
}
