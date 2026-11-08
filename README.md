# Family Game Night

A party game app for playing together in the same room, each person on their own phone, iPad, or laptop. No accounts or logins.

**Games:**
- **Who Said It?** Everyone secretly answers a question, then everyone guesses who wrote each answer.
- **Blank Slate.** A card shows a word with a blank (SNOW ___). Everyone secretly writes one word to fill it in.

## How to play (for the family)

1. **One person hosts.** Open the app, tap **Host a game**, tap your name, then **Create room**. You'll see a 4-letter code.
2. **Everyone else joins.** Open the app on your own device, tap **Join a game**, type the code, tap your name (or **+ Guest**).
3. **Host taps Start** once everyone's in (you need at least 3 players).
4. **Answer in secret.** Everyone sees the same question. Type a short answer and tap **Lock it in**. The host can skip a question nobody likes.
5. **Match.** You'll see everyone's answers except yours. Tap an answer, then tap who you think wrote it. Each name is used once. Tap **Submit**.
6. **The reveal.** The host taps through each answer. Everyone shouts guesses, then the host reveals who said it. The author tells the story behind the answer.
7. **Points:** +1 for each answer you match correctly. +1 for each person who guessed wrong on your answer.
8. Season standings carry over between game nights. The host can start a new season from the ☰ menu.

**Same answers in Who Said It?** If two people write the same thing (or nearly: "pizza" / "Pizzas!", small typos), guessing either name counts as right.

### Blank Slate
1. Host picks **15, 25 or 35 points** in the lobby (25 is the official game).
2. Each card: everyone types one word and locks it in. The host can skip a card.
3. The host reveals the answers one group at a time. Words count as the same even with different capital letters, plurals ("dog"/"dogs"), spaces ("ice cream"/"icecream"), or the card word added ("snowman" on SNOW ___).
4. **Host check:** possible typos show up as "Same word? basball & baseball". The host taps **Yes, same** or **No**. The host can also tap a name and choose **Same as this** or **Split off**.
5. **Points:** match exactly one other person = **+3** each. Three or more people = **+1** each. Nobody matches you = 0.
6. First to the target wins. Tied at the top past the target? One more card. The race track shows everyone's progress; 🔥 means within 5 points.
7. Blank Slate has its own season leaderboard (wins, then points).

**Tips**
- Refreshing or closing the page is fine. Reopen it and you're back in.
- On a new phone? Join with the same name and tap **Yes, that's me**.
- Anyone can tap **✍️ Add a question** in the lobby or the ☰ menu. Family-written questions come up more often.
- Host tools are in the ☰ menu: remove a player, hand off host, end a round, new season.

## How it's built

- **Front end:** plain JavaScript + [Vite](https://vitejs.dev), hosted on Vercel.
- **Server:** two Vercel serverless functions in `api/`.
- **Database:** Neon Postgres, connected through Vercel's Storage tab (`DATABASE_URL`). Tables are created automatically on first use.
- **Live sync:** each device keeps a request open to `/api/wait`, which answers the moment the room changes (usually under half a second).
- **Security:** the browser never sees the database password. `/api/rpc` only runs an allow-list of `api_*` database functions. Each one checks the room code and the player's secret device token, and only returns what that player may see (nobody gets other answers before the reveal). Row Level Security is also on for every table.

```
api/
  rpc.js                  the allow-listed door into the database
  wait.js                 "tell me when this room changes"
  _lib/db.js              Neon connection + automatic migrations
src/
  main.js                 app shell: home, join, lobby, menus, add-a-question
  engine/api.js           calls to /api, device memory, live sync
  engine/ui.js            screen updates, colors, toasts
  games/index.js          game registry (add new games here)
  games/who-said-it/
    index.js              Who Said It? screens
    questions.json        question bank (edit freely)
  games/blank-slate/
    index.js              Blank Slate screens + race track
    cards.json            card deck ("snow ___", "___ ball"; edit freely)
db/
  migrations/             database: engine + one file per game (applied automatically)
tests/
  api-flow.mjs            full round through the database API + security checks
  blank-slate-flow.mjs    Blank Slate scoring/matching + Who Said It? same-answer rule
  e2e.mjs                 4 simulated phones play full rounds in real browsers
  e2e-blank-slate.mjs     4 simulated phones play Blank Slate
  local-server.mjs        local stand-in for Vercel (uses plain Postgres)
```

### Editing questions

Edit `src/games/who-said-it/questions.json` (one list per category). Push the change and Vercel redeploys. The database picks up the new list the next time someone creates a room. Questions don't repeat until the whole bank has been used.

### Adding a new game

Each game is a plug-in with two parts:

1. **Database rules:** a new numbered file in `db/migrations/` that adds a row to `games` and defines `game_<id>_start`, `game_<id>_action`, `game_<id>_view`, and `game_<id>_check`. Copy `002_game_who_said_it.sql` as a template, and add the file name to `MIGRATIONS` in `api/_lib/db.js`. The engine handles rooms, players, rounds, private submissions, scores, and seasons.
2. **Screens:** `src/games/<name>/index.js` with `render(ctx)` and `onAction(...)`. Register it in `src/games/index.js`.

Push, and the new tables/functions are applied automatically on the next request.

### Local development

See `CLAUDE.md` → Testing.
