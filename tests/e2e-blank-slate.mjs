// 4 simulated phones play Blank Slate in real browsers: lobby target picker,
// a card, the reveal, a host "same word" call, the race track, results.
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
let pw; try { pw = require('playwright'); } catch { pw = require(process.env.PW_PATH); }
const { chromium, devices } = pw;
const BASE = process.env.BASE || 'http://localhost:4173';
const SHOTS = process.env.SHOTS || 'shots';
fs.mkdirSync(SHOTS, { recursive: true });
let fails = 0; const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const browser = await chromium.launch();
const names = ['Dad', 'Mom', 'Gio', 'Valentino'];
const P = {};
for (const n of names) {
  const page = await (await browser.newContext({ ...devices['iPhone 13'] })).newPage();
  page.on('pageerror', (e) => { console.log(`[${n}] PAGE ERROR`, e.message); fails++; });
  P[n] = page;
}
const shot = (n, label) => P[n].screenshot({ path: `${SHOTS}/bs-${label}-${n}.png`, fullPage: true });
const tap = (n, sel) => P[n].locator(sel).first().click();
const waitAll = async (sel, ms = 8000) => { for (const n of names) await P[n].locator(sel).first().waitFor({ timeout: ms }); };

await P.Dad.goto(BASE);
await tap('Dad', '[data-act="go:host"]');
await tap('Dad', '[data-act="game:pick"][data-id="blank_slate"]');
await tap('Dad', '[data-act="name:pick"][data-name="Dad"]');
await tap('Dad', '[data-act="host:create"]');
await P.Dad.locator('.lc-code').waitFor();
const code = (await P.Dad.locator('.lc-code').innerText()).replace(/\s/g, '');
ok(await P.Dad.locator('.bs-rules').count() === 1, 'lobby shows the scoring rules');
ok(await P.Dad.locator('[data-act="addq:open"]').count() === 0, 'no "Add a question" in Blank Slate');
await tap('Dad', '[data-act="bs:target"][data-n="15"]');
await P.Dad.locator('[data-act="bs:target"][data-n="15"].on').waitFor();
ok(true, 'host picked 15 points');

for (const n of names.slice(1)) {
  await P[n].goto(`${BASE}/?code=${code}`);
  await tap(n, `[data-act="name:pick"][data-name="${n}"]`);
  await tap(n, '[data-act="join:go"]');
}
await waitAll('.lc-code');
ok((await P.Gio.locator('.bs-rules').innerText()).includes('First to 15'), 'players see "First to 15"');
ok(await P.Gio.locator('[data-act="bs:target"]').count() === 0, 'only host gets the target picker');
await shot('Gio', '01-lobby');

await tap('Dad', '[data-act="round:start"]');
await waitAll('.bs-word');
await shot('Mom', '02-card');
ok(await P.Mom.locator('.bs-track .lane').count() === 4, 'race track shows all 4 players');

// Dad & Mom match (+3), Gio misspells Valentino's word (host joins them)
const words = { Dad: 'Dogs', Mom: 'dog', Gio: 'basball', Valentino: 'baseball' };
for (const n of names) {
  await P[n].fill('#bs-answer', words[n]);
  await P[n].press('#bs-answer', 'Enter');   // Enter submits
}
await waitAll('.hint');
await shot('Gio', '03-reveal-start');
for (let i = 0; i < 3; i++) { await tap('Dad', '[data-act="bs:next"]'); await P.Mom.waitForTimeout(250); }
await P.Dad.locator('.bs-sugg').waitFor();
await P.Mom.waitForFunction(() => document.querySelectorAll('.bs-group').length === 3, null, { timeout: 8000 });
ok(true, 'all 3 groups revealed on Mom\'s phone');
await P.Dad.waitForTimeout(700);
ok(await P.Mom.locator('[data-act="bs:merge"]').count() === 0, 'non-host sees suggestion without buttons');
await shot('Dad', '04-host-check');
await tap('Dad', '[data-act="bs:merge"]');
await P.Gio.waitForFunction(() => document.querySelectorAll('.bs-group.size-2').length === 2, null, { timeout: 8000 });
ok(true, 'host joined basball/baseball; everyone sees two +3 pairs');
await P.Gio.waitForTimeout(700);
await shot('Gio', '05-after-join');
await tap('Dad', '[data-act="bs:next"]');
await waitAll('.lane .plus');
await P.Mom.waitForTimeout(1300);
await shot('Mom', '06-results');
const pts = await P.Mom.locator('.lane-pts').allInnerTexts();
ok(pts.every((t) => t.startsWith('3')), 'everyone at 3 points: ' + pts.join(' | ').replace(/\n/g, ''));

// Season standings sheet shows wins column
await tap('Gio', '[data-act="menu:open"]');
await tap('Gio', '.sheet [data-act="standings:open"]');
ok((await P.Gio.locator('.sheet .bdetail').first().innerText()).includes('win'), 'Blank Slate standings show wins');
await shot('Gio', '07-standings');
await tap('Gio', '.sheet-close');

console.log(fails ? `${fails} FAILED` : 'ALL PASSED');
await browser.close(); process.exit(fails ? 1 : 0);
