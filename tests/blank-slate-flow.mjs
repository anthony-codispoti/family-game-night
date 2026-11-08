// Blank Slate through the public API: grouping, host same/not-same calls,
// scoring (pair +3, crowd +1, alone 0), race to the target, tie, winner,
// per-game standings. Also: Who Said It? same answers count either way.
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173';
const cards = JSON.parse(fs.readFileSync(new globalThis.URL('../src/games/blank-slate/cards.json', import.meta.url)));
const wsiBank = JSON.parse(fs.readFileSync(new globalThis.URL('../src/games/who-said-it/questions.json', import.meta.url)));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const post = async (fn, args) => { const r = await fetch(BASE + '/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fn, args }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); return j.data; };
const tryRpc = async (fn, args) => { try { await post(fn, args); return null; } catch (e) { return e.message; } };

async function room(game, bank, names) {
  const host = await post('api_create_room', { p_name: names[0], p_game: game, p_bank: bank });
  const P = { [names[0]]: host };
  for (const n of names.slice(1)) P[n] = await post('api_join_room', { p_code: host.code, p_name: n });
  const st = (n) => post('api_state', { p_code: host.code, p_token: P[n].token });
  const act = (n, a, args = {}) => post('api_action', { p_code: host.code, p_token: P[n].token, p_action: a, p_args: args });
  return { code: host.code, P, st, act, host: names[0] };
}

const W = await room('who_said_it', wsiBank, ['Dad', 'Mom', 'Gio', 'Valentino']);
await post('api_new_season', { p_code: W.code, p_token: W.P.Dad.token, p_name: 'Blank Slate test' });
const wsiDad = async () => ((await W.st('Dad')).standings.find((x) => x.name === 'Dad') || { points: 0 }).points;
const wsiDadBefore = await wsiDad();

// ---------------- Blank Slate ----------------
const names = ['Dad', 'Mom', 'Gio', 'Valentino', 'Nonna'];
const R = await room('blank_slate', cards, names);
const { P, st, act } = R;
const id = (n) => P[n].player_id;
let s = await st('Mom');
ok(s.standings.length === 0, 'Blank Slate has its own (empty) leaderboard');
ok((await tryRpc('api_room_setting', { p_code: R.code, p_token: P.Mom.token, p_key: 'target', p_value: 15 })) === 'HOST_ONLY', 'only host sets target');
ok((await tryRpc('api_room_setting', { p_code: R.code, p_token: P.Dad.token, p_key: 'target', p_value: 9999 })) === 'BAD_SETTING', 'silly target rejected');
await post('api_room_setting', { p_code: R.code, p_token: P.Dad.token, p_key: 'target', p_value: 15 });
s = await st('Mom'); ok(s.room.settings.target === 15, 'target set to 15');

await post('api_start_round', { p_code: R.code, p_token: P.Dad.token });
s = await st('Gio');
ok(s.round.phase === 'answering' && s.round.question.includes('___') && s.round.game.target === 15, 'card dealt: ' + s.round.question);
const q1 = s.round.question;
await act('Dad', 'skip');
s = await st('Gio'); ok(s.round.question !== q1, 'skip deals a new card');
const word = s.round.question.replace('___', '').trim();

// Round 1: Dad "Dogs" + Mom "dog" = pair (+3); Gio, Val, Nonna "basball"/"baseball"/"cats" -> host joins the typo pair
const r1 = { Dad: 'Dogs', Mom: 'the dog', Gio: 'basball', Valentino: 'Baseball', Nonna: 'cats' };
for (const n of names.slice(0, 4)) await act(n, 'answer', { text: r1[n] });
s = await st('Dad');
ok(s.round.phase === 'answering' && !JSON.stringify(s).includes('basball'), "answers stay secret until everyone's in");
await act('Nonna', 'answer', { text: r1.Nonna });
s = await st('Mom');
ok(s.round.phase === 'reveal' && s.round.game.groups.length === 0 && s.round.game.total_groups === 4, 'reveal starts hidden, 4 groups');
ok(!JSON.stringify(s.round.game).includes('basball'), 'nothing shown before host reveals');
ok((await tryRpc('api_action', { p_code: R.code, p_token: P.Mom.token, p_action: 'next' })) === 'HOST_ONLY', 'only host reveals');
ok((await tryRpc('api_action', { p_code: R.code, p_token: P.Dad.token, p_action: 'merge', p_args: { a: id('Gio'), b: id('Valentino') } })) === 'WRONG_PHASE', 'no merging before everything is revealed');
for (let i = 0; i < 4; i++) await act('Dad', 'next');
s = await st('Mom');
const sizes = s.round.game.groups.map((g) => g.size);
ok(s.round.game.revealed && JSON.stringify(sizes) === '[1,1,1,2]', 'all revealed: singles first, pair last ' + JSON.stringify(sizes));
ok(s.round.game.suggestions.length === 1 && ['basball', 'Baseball'].includes(s.round.game.suggestions[0].ta), 'typo suggestion: basball / Baseball');
await act('Dad', 'merge', { a: s.round.game.suggestions[0].a, b: s.round.game.suggestions[0].b });
s = await st('Mom');
ok(s.round.game.groups.filter((g) => g.size === 2).length === 2 && s.round.game.suggestions.length === 0, 'host joined the typo: now 2 pairs');
await act('Dad', 'next');
s = await st('Gio');
const g1 = s.round.game.gained;
ok(s.round.phase === 'results' && g1.Dad === 3 && g1.Mom === 3 && g1.Gio === 3 && g1.Valentino === 3 && g1.Nonna === 0, 'round 1: pairs +3, alone 0 ' + JSON.stringify(g1));

// Round 2: 3 people say "cat" (+1 each), plus split test
await post('api_start_round', { p_code: R.code, p_token: P.Dad.token });
const r2 = { Dad: 'cat', Mom: 'Cats', Gio: 'CAT', Valentino: 'house', Nonna: 'horse' };
for (const n of names) await act(n, 'answer', { text: r2[n] });
for (let i = 0; i < 3; i++) await act('Dad', 'next');
s = await st('Dad');
ok(s.round.game.revealed && s.round.game.groups.find((g) => g.size === 3), 'cat/Cats/CAT grouped automatically');
ok(s.round.game.suggestions.length === 1, 'house/horse offered as a maybe');
await act('Dad', 'dismiss', { a: s.round.game.suggestions[0].a, b: s.round.game.suggestions[0].b });
s = await st('Dad'); ok(s.round.game.suggestions.length === 0, 'host says not the same: suggestion gone');
// host splits Gio off, then moves him back
await act('Dad', 'split', { a: id('Gio') });
s = await st('Dad'); ok(s.round.game.groups.find((g) => g.size === 2), 'split: cat group now 2');
await act('Dad', 'move', { a: id('Gio'), b: id('Dad') });
await act('Dad', 'next');
s = await st('Dad');
const g2 = s.round.game.gained;
ok(g2.Dad === 1 && g2.Mom === 1 && g2.Gio === 1 && g2.Valentino === 0, 'round 2: crowd of 3 gets +1 each ' + JSON.stringify(g2));
const tot = (st) => Object.fromEntries(st.round.game.totals.map((t) => [t.name, t.points]));
ok(JSON.stringify(tot(s)) === JSON.stringify({ Dad: 4, Gio: 4, Mom: 4, Nonna: 0, Valentino: 3 }) || (tot(s).Dad === 4 && tot(s).Valentino === 3 && tot(s).Nonna === 0), 'running totals ' + JSON.stringify(tot(s)));

// Rounds until someone wins: Dad+Nonna pair every time; then Dad alone with Mom tie check
async function playPair(a, b) {
  await post('api_start_round', { p_code: R.code, p_token: P.Dad.token });
  let i = 0;
  for (const n of names) await act(n, 'answer', { text: n === a || n === b ? 'zebra' : `solo${i++}x${n}` });
  for (let k = 0; k < 10; k++) { s = await st('Dad'); if (s.round.game.revealed) break; await act('Dad', 'next'); }
  await act('Dad', 'next');
  return st('Gio');
}
s = await playPair('Dad', 'Mom');  // Dad 7, Mom 7
s = await playPair('Dad', 'Mom');  // 10, 10
s = await playPair('Dad', 'Mom');  // 13, 13
s = await playPair('Dad', 'Mom');  // 16, 16 -> tie at the top
ok(s.round.game.tie && !s.round.game.winner, 'tie at the top over 15: keep playing');
s = await playPair('Dad', 'Gio');  // Dad 19, Mom 16, Gio 7
ok(s.round.game.winner === 'Dad', 'Dad wins the game: ' + JSON.stringify(tot(s)));
const match1 = s.round.game.match;
s = await st('Dad');
ok(s.standings[0].name === 'Dad' && s.standings[0].wins === 1, 'season standings count the win');

// New game starts from zero with the room's target
await post('api_room_setting', { p_code: R.code, p_token: P.Dad.token, p_key: 'target', p_value: 25 });
await post('api_start_round', { p_code: R.code, p_token: P.Dad.token });
s = await st('Mom');
ok(s.round.game.match === match1 + 1 && s.round.game.target === 25 && s.round.game.card_no === 1, 'new game: target 25, card 1');
ok(s.round.game.totals.every((t) => t.points === 0), 'new game: everyone back to 0');
// answers capped and required
ok((await tryRpc('api_action', { p_code: R.code, p_token: P.Mom.token, p_action: 'answer', p_args: { text: '   ' } })) === 'ANSWER_REQUIRED', 'blank answer rejected');

// someone leaves mid-reveal: the round still finishes
for (const n of names) await act(n, 'answer', { text: n === 'Gio' || n === 'Nonna' ? 'pizza' : 'x' + n });
await act('Dad', 'next');
await post('api_remove_player', { p_code: R.code, p_token: P.Dad.token, p_player: id('Valentino') });
for (let k = 0; k < 10; k++) { s = await st('Dad'); if (s.round.game.revealed) break; await act('Dad', 'next'); }
await act('Dad', 'next');
s = await st('Gio');
ok(s.round.phase === 'results' && !('Valentino' in s.round.game.gained) && s.round.game.gained.Gio === 3, 'removed player skipped; round still scores');

// Who Said It? standings are separate
ok((await wsiDad()) === wsiDadBefore, 'Who Said It? leaderboard ignores Blank Slate points');

// ---------------- Who Said It?: same answers ----------------
await post('api_start_round', { p_code: W.code, p_token: W.P.Dad.token });
const wa = { Dad: 'Pizza', Mom: 'pizzas!', Gio: 'Touchdown dance', Valentino: 'A long nap' };
for (const n of Object.keys(wa)) await W.act(n, 'answer', { text: wa[n] });
// Gio guesses the two pizzas swapped (should both count), Val gets the pizzas right
const wid = (n) => W.P[n].player_id;
const textOf = (t) => Object.keys(wa).find((n) => wa[n] === t);
for (const n of Object.keys(wa)) {
  s = await W.st(n); const map = {};
  const items = s.round.game.answers;
  const truth = items.map((a) => textOf(a.text));
  let assign = [...truth];
  if (n === 'Gio' || n === 'Valentino') {
    const iP = truth.indexOf('Dad'), iM = truth.indexOf('Mom');
    if (n === 'Gio') { assign[iP] = 'Mom'; assign[iM] = 'Dad'; }
  }
  items.forEach((a, i) => { map[a.key] = wid(assign[i]); });
  await W.act(n, 'guesses', { map });
}
for (let i = 0; i < 8; i++) await W.act('Dad', 'next');
s = await W.st('Dad');
const res = Object.fromEntries(s.round.game.results.map((r) => [r.name, r]));
ok(res.Gio.correct === 3 && res.Dad.fooled === 0 && res.Mom.fooled === 0, 'swapped twin guesses both count as right ' + JSON.stringify(res.Gio));
const pizzaItem = s.round.game.items.find((it) => it.text === 'Pizza');
ok(pizzaItem.twins.length === 1 && pizzaItem.twins[0] === wid('Mom'), 'reveal lists the twin answer');

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
