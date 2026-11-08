# Notes for Claude

## Default stack for this account's apps
- Code on GitHub, hosted on Vercel.
- **Database: Neon Postgres**, added through the Vercel project's **Storage** tab (leave "Custom Prefix" blank so the variable is `DATABASE_URL`). Use `@neondatabase/serverless` from Vercel serverless functions in `api/*.js` (CommonJS).
- **Do not use Supabase for new apps** (the older apps hit its free-tier limit).
- The browser never gets database credentials; it only calls `/api/*`.

## This app
- Game rules live in Postgres functions (`db/migrations/*.sql`). `api/rpc.js` is an allow-list of `api_*` functions; add new ones there.
- Migrations run automatically on the first request after deploy (`api/_lib/db.js`, list `MIGRATIONS`). Add a new numbered file + list entry; never edit an applied migration.
- Live sync: `api/wait.js` long-poll on `rooms.version` (no push service).
- User is not a developer: give setup steps one at a time, in plain language.

## Testing
- `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:16-alpine`
- `npm run build && npm run serve:local` (serves dist/ + api/ on :4173 against local Postgres)
- `npm run test:api` and `PW_PATH=$(npm root -g)/playwright npm run test:e2e` (4 simulated phones)

## Save durable work to Anthony's AI Brain (standing rule, Nov 8 2026)

Before a session ends, if it produced a decision, finished work, a plan or a status change worth keeping, save one note per item to Anthony's AI Brain inbox. Skip sessions with nothing new, and never write a note just to say nothing changed.

- Where: the Google Drive folder "AI Brain Inbox" (folder ID 14ouRhzZ8EbEQcs7ZCANSqNwYCyoa3t05) in the anthony@addbackbenefits.com Drive. Use the Google Drive connector's create_file with parentId set to that ID, contentMimeType "text/markdown" and disableConversionToGoogleType true. Name the file "YYYY-MM-DD short title.md".
- Format: the first line is "Project: <brain project name>", the second line is "Title: <short title>", then a blank line, then the note in plain words: what was decided or done, why, links (commit, PR, live page) and what comes next. Use "Project: Idea Inbox" if no project clearly fits.
- Never include passwords, tokens, keys or account numbers.
- If the Google Drive connector is not available in the session, put the same note at the end of your final message under the heading "AI Brain note".
