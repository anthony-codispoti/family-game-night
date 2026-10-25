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
