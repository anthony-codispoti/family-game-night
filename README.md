# Family Game Night

A party game app for playing together in the same room, each person on their own phone, iPad, or laptop. No accounts or logins.

**First game: Who Said It?** Everyone secretly answers a question, then everyone guesses who wrote each answer.

## How to play (for the family)

1. **One person hosts.** Open the app, tap **Host a game**, tap your name, then **Create room**. You'll see a 4-letter code.
2. **Everyone else joins.** Open the app on your own device, tap **Join a game**, type the code, tap your name (or **+ Guest**).
3. **Host taps Start** once everyone's in (you need at least 3 players).
4. **Answer in secret.** Everyone sees the same question. Type a short answer and tap **Lock it in**. The host can skip a question nobody likes.
5. **Match.** You'll see everyone's answers except yours. Tap an answer, then tap who you think wrote it. Each name is used once. Tap **Submit**.
6. **The reveal.** The host taps through each answer. Everyone shouts guesses, then the host reveals who said it. The author tells the story behind the answer.
7. **Points:** +1 for each answer you match correctly. +1 for each person who guessed wrong on your answer.
8. Season standings carry over between game nights. The host can start a new season from the ☰ menu.

**Tips**
- Refreshing or closing the page is fine. Reopen it and you're back in.
- On a new phone? Join with the same name and tap **Yes, that's me**.
- Anyone can tap **✍️ Add a question** in the lobby or the ☰ menu. Family-written questions come up more often.
- Host tools are in the ☰ menu: remove a player, hand off host, end a round, new season.

## How it's built

- **Front end:** plain JavaScript + [Vite](https://vitejs.dev), hosted on Vercel.
- **Database + live sync:** Supabase (Postgres + Realtime broadcast, with a 2.5-second polling backup).
- **Security:** Row Level Security is on for every table with no policies, so the browser can't read or write tables directly. It can only call the `api_*` database functions. Each one checks the room code and the player's secret device token, and only returns what that player is allowed to see (nobody gets other answers before the reveal). Only the public anon/publishable key is used in the front end.

```
src/
  main.js                 app shell: home, join, lobby, menus, add-a-question
  engine/api.js           Supabase calls, device memory, live sync
  engine/ui.js            screen updates, colors, toasts
  games/index.js          game registry (add new games here)
  games/who-said-it/
    index.js              Who Said It? screens
    questions.json        question bank (edit freely)
supabase/
  migrations/             database: engine + one file per game
  setup.sql               all migrations in one file, to paste into Supabase
tests/
  api-flow.mjs            full round through the database API + security checks
  e2e.mjs                 4 simulated phones play a full round in real browsers
```

### Editing questions

Edit `src/games/who-said-it/questions.json` (one list per category). Push the change and Vercel redeploys. The database picks up the new list the next time someone creates a room. Questions don't repeat until the whole bank has been used.

### Adding a new game

Each game is a plug-in with two parts:

1. **Database rules:** a new file in `supabase/migrations/` that adds a row to `games` and defines `game_<id>_start`, `game_<id>_action`, `game_<id>_view`, and `game_<id>_check`. Copy `*_game_who_said_it.sql` as a template. The engine handles rooms, players, rounds, private submissions, scores, and seasons.
2. **Screens:** `src/games/<name>/index.js` with `render(ctx)` and `onAction(...)`. Register it in `src/games/index.js`.

Run the new SQL file in the Supabase SQL Editor, then push.

### Local development

```
npx supabase start          # local Supabase (needs Docker)
npx supabase db reset       # apply migrations
# .env.local: VITE_SUPABASE_URL=http://127.0.0.1:54321  VITE_SUPABASE_ANON_KEY=<local publishable key>
npm run dev
SB_URL=... SB_KEY=... npm run test:api
npm run build && npx vite preview --port 4173 & node tests/e2e.mjs
```
