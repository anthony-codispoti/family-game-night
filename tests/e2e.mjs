// 4 simulated phones play a full round of Who Said It? in real browsers.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require(process.env.PW_PATH); }
const { chromium, devices } = pw;
const BASE = process.env.BASE || 'http://localhost:4173';
const SHOTS = process.env.SHOTS || 'shots';
import fs from 'node:fs'; fs.mkdirSync(SHOTS, { recursive: true });
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const browser = await chromium.launch();
const phone = devices['iPhone 13'];
const names = ['Dad', 'Mom', 'Gio', 'Nonna'];
const P = {};
for (const n of names) {
  const ctx = await browser.newContext({ ...phone });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log(`[${n}] PAGE ERROR`, e.message); fails++; });
  P[n] = page;
}
const shot = (n, label) => P[n].screenshot({ path: `${SHOTS}/${label}-${n}.png`, fullPage: true });
const tap = (n, sel) => P[n].locator(sel).first().click();
const t0 = Date.now();
const waitAll = async (sel, ms = 8000) => { for (const n of names) await P[n].locator(sel).first().waitFor({ timeout: ms }); };

// Host
await P.Dad.goto(BASE);
await shot('Dad', '00-home');
await tap('Dad', '[data-act="go:host"]');
await tap('Dad', '[data-act="name:pick"][data-name="Dad"]');
await tap('Dad', '[data-act="host:create"]');
await P.Dad.locator('.lc-code').waitFor();
const code = (await P.Dad.locator('.lc-code').innerText()).replace(/\s/g, '');
ok(/^[A-Z]{4}$/.test(code), 'host created room ' + code);

// Joiners: Mom & Gio via roster, Nonna as guest via link
for (const n of ['Mom', 'Gio']) {
  await P[n].goto(BASE);
  await tap(n, '[data-act="go:join"]');
  await P[n].fill('#join-code', code.toLowerCase());
  await tap(n, `[data-act="name:pick"][data-name="${n}"]`);
  await tap(n, '[data-act="join:go"]');
}
await P.Nonna.goto(`${BASE}/?code=${code}`);
await tap('Nonna', '[data-act="name:custom"]');
await P.Nonna.fill('#custom-name', 'Nonna');
await tap('Nonna', '[data-act="join:go"]');
await waitAll('.lc-code');
await P.Dad.waitForFunction(() => document.querySelectorAll('.player-list .player-row:not(.empty)').length === 4, null, { timeout: 8000 });
ok(true, 'host sees all 4 players live');
await shot('Dad', '01-lobby'); await shot('Gio', '01-lobby');

// Duplicate name on another device -> reclaim prompt
const extra = await (await browser.newContext({ ...phone })).newPage();
await extra.goto(`${BASE}/?code=${code}`);
await extra.locator('[data-act="name:pick"][data-name="Gio"]').click();
await extra.locator('[data-act="join:go"]').click();
await extra.locator('.confirm').waitFor();
ok(true, 'second "Gio" device gets "is that you?" prompt');
await extra.context().close();

// Start
await tap('Dad', '[data-act="round:start"]');
await waitAll('.qcard .qtext');
const qs = await Promise.all(names.map((n) => P[n].locator('.qtext').innerText()));
ok(new Set(qs).size === 1, 'everyone sees the same question: ' + qs[0]);
await tap('Dad', '[data-act="wsi:skip"]');
await P.Gio.waitForFunction((q) => document.querySelector('.qtext')?.innerText !== q, qs[0], { timeout: 8000 });
const q2 = await P.Gio.locator('.qtext').innerText();
ok(q2 !== qs[0], 'skip updates every screen: ' + q2);
await shot('Mom', '02-question');

const ans = { Dad: 'Grilled cheese at midnight', Mom: 'A beach with no phones', Gio: 'Scoring a touchdown', Nonna: 'Making fresh pasta' };
for (const n of ['Dad', 'Mom', 'Gio']) {
  await P[n].fill('#wsi-answer', ans[n]);
  await tap(n, '[data-act="wsi:submit-answer"]');
}
await P.Nonna.waitForFunction(() => document.querySelectorAll('.status-row .chip.done').length === 3, null, { timeout: 8000 });
ok(true, 'Nonna sees 3/4 answered (typing not interrupted)');
// Nonna types slowly while updates arrive, then refreshes mid-round
await P.Nonna.fill('#wsi-answer', 'Making fresh');
await P.Nonna.reload();
await P.Nonna.locator('#wsi-answer').waitFor();
ok(true, 'refresh mid-round rejoins as same player');
await P.Nonna.fill('#wsi-answer', ans.Nonna);
await shot('Nonna', '03-answering');
await tap('Nonna', '[data-act="wsi:submit-answer"]');
await waitAll('.answer-card');
ok(true, 'all devices auto-advanced to matching');
await shot('Gio', '04-matching');

// Matching: Dad & Mom perfect, Gio & Nonna rotate (all wrong)
const truthByText = Object.fromEntries(Object.entries(ans).map(([n, t]) => [t, n]));
const expected = { Dad: 0, Mom: 0, Gio: 0, Nonna: 0 };
for (const n of names) {
  const page = P[n];
  const cards = await page.locator('.answer-card').all();
  const texts = await Promise.all(cards.map((c) => c.locator('.answer-text').innerText()));
  ok(texts.length === 3 && !texts.some((t) => t.includes(ans[n])), `${n} sees 3 answers, not own`);
  const truth = texts.map((t) => truthByText[t.replace(/[“”]/g, '')]);
  const pick = n === 'Dad' || n === 'Mom' ? truth : [...truth.slice(1), truth[0]];
  for (let i = 0; i < cards.length; i++) {
    if (pick[i] === truth[i]) expected[n]++; else expected[truth[i]]++;
    await cards[i].click();
    await page.locator(`.name-btn:text-is("${pick[i]}")`).click();
  }
  ok(await page.locator(`.name-btn:text-is("${n}")`).count() === 0, `${n} has no button for own name`);
  if (n === 'Gio') await shot('Gio', '05-matched');
  await page.locator('[data-act="wsi:submit-guesses"]').click();
}
await waitAll('.reveal-card');
ok(true, 'everyone in reveal');
await shot('Mom', '06-reveal-answer');
for (let i = 0; i < 8; i++) {
  if (i === 0) ok(await P.Mom.locator('[data-act="wsi:next"]').count() === 0, 'non-host has no Next button');
  await tap('Dad', '[data-act="wsi:next"]');
  if (i === 0) {
    await waitAll('.author-name');
    const authors = await Promise.all(names.map((n) => P[n].locator('.author-name').innerText()));
    ok(new Set(authors).size === 1, 'author revealed in sync on all screens: ' + authors[0]);
    const story = await P.Gio.locator('.story').innerText();
    ok(story.includes(authors[0]) && story.includes('tell the story'), 'story prompt: ' + story);
    await shot('Gio', '07-reveal-author');
  }
  await P.Dad.waitForTimeout(300);
}
await waitAll('.board-row');
const rows = await P.Gio.locator('.board-row').evaluateAll((els) => els.map((e) => [e.querySelector('.bname').innerText, Number(e.querySelector('.bpoints').innerText.replace('+', ''))]));
const got = Object.fromEntries(rows);
ok(names.every((n) => got[n] === expected[n]), `round scores ${JSON.stringify(got)} match expected ${JSON.stringify(expected)}`);
await shot('Gio', '08-results');
await tap('Dad', '[data-act="wsi:next"]');
await waitAll('.season-name');
await shot('Mom', '09-standings');
ok(await P.Dad.locator('[data-act="round:start"]').count() === 1, 'host gets Next round button');

// Add a question as Gio
await tap('Gio', '[data-act="menu:open"]');
await tap('Gio', '.sheet [data-act="addq:open"]');
await P.Gio.fill('#addq-text', 'What would you name a robot butler?');
await tap('Gio', '[data-act="addq:save"]');
await P.Gio.locator('.fq-text:text-is("What would you name a robot butler?")').waitFor();
ok(true, 'Gio added a question, shown with his name');
await shot('Gio', '10-addq');
await tap('Gio', '.sheet-close');

// Host removes Nonna, starts round 2
await tap('Dad', '[data-act="menu:open"]');
P.Dad.once('dialog', (d) => d.accept());
await tap('Dad', '.sheet [data-act="player:remove"][data-name="Nonna"]');
await P.Nonna.locator('.home').waitFor({ timeout: 8000 });
ok(true, 'removed player sent back to home screen');
await tap('Dad', '.sheet-close');
await tap('Dad', '[data-act="round:start"]');
await P.Mom.locator('.qcard').waitFor();
ok(await P.Mom.locator('.status-row .chip').count() === 3, 'round 2 has 3 players');
await shot('Dad', '11-round2-host');
console.log(`\nfinished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
await browser.close(); process.exit(fails ? 1 : 0);
