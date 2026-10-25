// Full-round test through the public API, plus security checks.
// Talks to the app's /api endpoints exactly like the browser does.
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://localhost:4173';
const post = async (fn, args) => { const r = await fetch(BASE + '/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fn, args }) }); const j = await r.json(); return r.ok ? { data: j.data } : { error: { message: j.error } }; };
const sb = { rpc: post };
const bank = JSON.parse(fs.readFileSync(new globalThis.URL('../src/games/who-said-it/questions.json', import.meta.url)));
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const rpc = async (fn, args) => { const { data, error } = await sb.rpc(fn, args); if (error) throw new Error(error.message); return data; };
const tryRpc = async (fn, args) => { const { error } = await sb.rpc(fn, args); return error?.message || null; };

// security: only allow-listed functions can be called
for (const fn of ['game_who_said_it_view', '_pick_question', '_standings', 'pg_sleep']) {
  ok((await tryRpc(fn, {})) === 'UNKNOWN_FUNCTION', `${fn} not callable from the browser`);
}
ok((await (await fetch(BASE + '/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fn: 'api_state', args: { p_code: 'ABCD', p_token: "x'); drop table rooms; --" } }) })).json()).error === 'NOT_IN_ROOM', 'injection attempt rejected');

const host = await rpc('api_create_room', { p_name: 'Dad', p_game: 'who_said_it', p_bank: bank });
ok(/^[A-Z]{4}$/.test(host.code), 'room code ' + host.code);
const code = host.code;
const P = { Dad: host };
for (const n of ['Mom', 'Gio', 'Valentino']) P[n] = await rpc('api_join_room', { p_code: code.toLowerCase(), p_name: n });
ok((await tryRpc('api_join_room', { p_code: code, p_name: 'gio' })) === 'NAME_TAKEN', 'duplicate name rejected');
const st = (n) => rpc('api_state', { p_code: code, p_token: P[n].token });
let s = await st('Mom');
ok(s.players.length === 4, '4 players in lobby');
ok((await tryRpc('api_start_round', { p_code: code, p_token: P.Mom.token })) === 'HOST_ONLY', 'non-host cannot start');
ok((await tryRpc('api_state', { p_code: code, p_token: '11111111-1111-1111-1111-111111111111' })) === 'NOT_IN_ROOM', 'bad token rejected');

// guest joins then gets removed
const guest = await rpc('api_join_room', { p_code: code, p_name: 'Aunt Lu' });
await rpc('api_remove_player', { p_code: code, p_token: P.Dad.token, p_player: guest.player_id });
ok((await tryRpc('api_state', { p_code: code, p_token: guest.token })) === 'REMOVED', 'removed player locked out');

await rpc('api_start_round', { p_code: code, p_token: P.Dad.token });
s = await st('Dad'); const q1 = s.round.question;
ok(s.round.phase === 'answering' && q1, 'round 1 question: ' + q1);
await rpc('api_action', { p_code: code, p_token: P.Dad.token, p_action: 'skip' });
s = await st('Dad'); ok(s.round.question !== q1, 'skip gives new question: ' + s.round.question);

const answers = { Dad: 'Grilled cheese', Mom: 'A long nap', Gio: 'Touchdown dance', Valentino: 'Pizza with pineapple' };
for (const n of ['Dad', 'Mom', 'Gio']) await rpc('api_action', { p_code: code, p_token: P[n].token, p_action: 'answer', p_args: { text: answers[n] } });
s = await st('Mom');
ok(s.round.phase === 'answering' && s.round.submitted.answer.length === 3, 'shows 3 answered, still waiting');
ok(!JSON.stringify(s).includes('Grilled cheese'), "Mom can't see Dad's answer");
await rpc('api_action', { p_code: code, p_token: P.Valentino.token, p_action: 'answer', p_args: { text: answers.Valentino } });
s = await st('Gio');
ok(s.round.phase === 'matching', 'auto-advanced to matching');
ok(s.round.game.answers.length === 3 && !s.round.game.answers.some(a => a.text === answers.Gio), 'Gio sees 3 answers, not his own');
ok(!JSON.stringify(s.round.game.answers).match(/pid|author/), 'no author info in matching');

// everyone guesses: Dad & Mom guess perfectly, Gio & Valentino guess using a rotation
const ids = Object.fromEntries(Object.entries(P).map(([n, p]) => [n, p.player_id]));
const textToName = Object.fromEntries(Object.entries(answers).map(([n, t]) => [t, n]));
const expected = { Dad: 0, Mom: 0, Gio: 0, Valentino: 0 };
for (const n of ['Dad', 'Mom', 'Gio', 'Valentino']) {
  const v = await st(n); const map = {};
  const items = v.round.game.answers;
  const perfect = n === 'Dad' || n === 'Mom';
  const truth = items.map(a => textToName[a.text]);
  const assigned = perfect ? truth : [...truth.slice(1), truth[0]]; // rotation = all wrong (3 items)
  items.forEach((a, i) => { map[a.key] = ids[assigned[i]]; if (assigned[i] === truth[i]) expected[n]++; else expected[truth[i]]++; });
  if (n === 'Gio') {
    const bad = { ...map }; bad[items[0].key] = ids.Gio;
    ok((await tryRpc('api_action', { p_code: code, p_token: P.Gio.token, p_action: 'guesses', p_args: { map: bad } })) !== null, 'cannot assign own name');
  }
  await rpc('api_action', { p_code: code, p_token: P[n].token, p_action: 'guesses', p_args: { map } });
}
s = await st('Dad');
ok(s.round.phase === 'reveal' && s.round.game.items.length === 1 && !s.round.game.items[0].author, 'reveal: first answer shown, author hidden');
ok((await tryRpc('api_action', { p_code: code, p_token: P.Mom.token, p_action: 'next' })) === 'HOST_ONLY', 'only host taps next');
for (let i = 0; i < 8; i++) {
  await rpc('api_action', { p_code: code, p_token: P.Dad.token, p_action: 'next' });
  s = await st('Mom');
  if (i === 0) ok(s.round.game.items[0].author && s.round.game.items[0].guesses, 'author + guesses revealed');
}
ok(s.round.phase === 'results', 'reached results');
const got = Object.fromEntries(s.round.game.results.map(r => [r.name, r.points]));
ok(JSON.stringify(got, Object.keys(expected).sort()) === JSON.stringify(expected, Object.keys(expected).sort()), `scores ${JSON.stringify(got)} == expected ${JSON.stringify(expected)}`);
await rpc('api_action', { p_code: code, p_token: P.Dad.token, p_action: 'next' });
s = await st('Gio'); ok(s.round.phase === 'standings' && s.standings.length >= 4, 'standings shown');

// questions don't repeat
const seen = new Set();
await rpc('api_start_round', { p_code: code, p_token: P.Dad.token });
for (let i = 0; i < 30; i++) { s = await st('Dad'); seen.add(s.round.question); await rpc('api_action', { p_code: code, p_token: P.Dad.token, p_action: 'skip' }); }
ok(seen.size === 30, '30 skips, 30 unique questions');

// family questions come up often, but never back-to-back
await rpc('api_add_question', { p_code: code, p_token: P.Valentino.token, p_category: 'funny', p_text: 'What would your robot sidekick be called?' });
const picks = [];
for (let i = 0; i < 60; i++) { await rpc('api_action', { p_code: code, p_token: P.Dad.token, p_action: 'skip' }); picks.push((await st('Dad')).round.question); }
const famIdx = picks.map((q, i) => (q === 'What would your robot sidekick be called?' ? i : -1)).filter((i) => i >= 0);
ok(famIdx.length >= 1 && famIdx.length <= 3 && famIdx.every((v, i) => i === 0 || v - famIdx[i - 1] > 20), `family question asked ${famIdx.length}x in 60 picks, spaced >20 apart (at ${famIdx.join(', ')})`);
ok(famIdx[0] < 15, 'new family question comes up soon (pick #' + (famIdx[0] + 1) + ')');

// family question
await rpc('api_add_question', { p_code: code, p_token: P.Gio.token, p_category: 'funny', p_text: 'What is the weirdest sound your stomach has made? #' + Date.now() });
const fq = await rpc('api_family_questions', { p_code: code, p_token: P.Dad.token });
ok(fq.some((q) => q.author === 'Gio' && q.text.startsWith('What is the weirdest sound')), 'family question saved with author');

// refresh rejoin = same token works; reclaim on new device
const re = await rpc('api_join_room', { p_code: code, p_name: 'Mom', p_reclaim: true });
ok(re.player_id === P.Mom.player_id, 'reclaim keeps the same player');
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
