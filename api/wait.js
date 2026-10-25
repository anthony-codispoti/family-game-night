// Live sync without a push service: each device asks "tell me when room
// ABCD changes past version N". We hold the request open for up to ~9s,
// checking the database a few times a second, and answer the moment
// something changes.
const { getDb } = require('./_lib/db');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function handler(req, res) {
  const code = String((req.query && req.query.code) || '').toUpperCase().slice(0, 4);
  const known = String((req.query && req.query.v) || '');
  res.setHeader('Cache-Control', 'no-store');
  if (!/^[A-Z]{4}$/.test(code)) return res.status(400).json({ error: 'BAD_CODE' });
  try {
    const db = await getDb();
    const deadline = Date.now() + 9000;
    for (;;) {
      const rows = await db.query('select public.api_version($1::text) as v', [code]);
      const v = rows[0] && rows[0].v != null ? String(rows[0].v) : null;
      if (v === null) return res.status(200).json({ v: null, gone: true });
      if (v !== known || Date.now() > deadline) return res.status(200).json({ v });
      await sleep(350);
    }
  } catch (e) {
    console.error('wait', e);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
};
