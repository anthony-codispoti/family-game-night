// Database access for the serverless functions (same pattern as our other
// apps: Neon Postgres via @neondatabase/serverless, DATABASE_URL from
// Vercel's Storage tab). Locally, LOCAL_PG=1 uses plain Postgres instead.
const fs = require('fs');
const path = require('path');

// Applied in order, once each. To change the database, add a new file here.
const MIGRATIONS = ['001_engine.sql', '002_game_who_said_it.sql'];
const migrationSql = (name) => fs.readFileSync(path.join(__dirname, '..', '..', 'db', 'migrations', name), 'utf8');

let db = null;
let ready = null;

function connect() {
  if (db) return db;
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL_UNPOOLED;
  if (!url) { const e = new Error('NO_DATABASE'); e.code = 'NO_DATABASE'; throw e; }
  if (process.env.LOCAL_PG) {
    const { Pool } = require(process.env.LOCAL_PG_MODULE || 'pg'); // local testing only
    const pool = new Pool({ connectionString: url });
    db = { query: async (text, params) => (await pool.query(text, params)).rows, pool: () => pool, local: true };
  } else {
    const { neon, neonConfig, Pool } = require('@neondatabase/serverless');
    if (typeof WebSocket === 'undefined') neonConfig.webSocketConstructor = require('ws');
    const sql = neon(url);
    db = { query: (text, params) => sql.query(text, params), pool: () => new Pool({ connectionString: url }) };
  }
  return db;
}

// Create/upgrade the tables automatically the first time the app runs.
async function migrate() {
  const d = connect();
  try {
    const rows = await d.query('select name from schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    if (MIGRATIONS.every((m) => done.has(m))) return;
  } catch { /* table doesn't exist yet */ }

  const pool = d.pool();
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock(727001)');
    await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name));
    for (const name of MIGRATIONS) {
      if (done.has(name)) continue;
      await client.query('begin');
      try {
        await client.query(migrationSql(name));
        await client.query('insert into schema_migrations (name) values ($1)', [name]);
        await client.query('commit');
        console.log('applied migration', name);
      } catch (e) { await client.query('rollback'); throw e; }
    }
    await client.query('select pg_advisory_unlock(727001)');
  } finally {
    client.release();
    if (!d.local) await pool.end();
  }
}

async function getDb() {
  const d = connect();
  if (!ready) ready = migrate().catch((e) => { ready = null; throw e; });
  await ready;
  return d;
}

module.exports = { getDb, MIGRATIONS };
