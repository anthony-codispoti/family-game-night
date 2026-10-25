// The one door into the database. The browser may only call the functions
// listed here; each checks the room code + player token itself.
const { getDb } = require('./_lib/db');

const T = 'text', U = 'uuid', J = 'jsonb', B = 'boolean', N = 'bigint';
const API = {
  api_roster: [],
  api_create_room: [['p_name', T], ['p_game', T], ['p_bank', J]],
  api_join_room: [['p_code', T], ['p_name', T], ['p_reclaim', B]],
  api_state: [['p_code', T], ['p_token', U]],
  api_version: [['p_code', T]],
  api_start_round: [['p_code', T], ['p_token', U]],
  api_action: [['p_code', T], ['p_token', U], ['p_action', T], ['p_args', J]],
  api_cancel_round: [['p_code', T], ['p_token', U]],
  api_remove_player: [['p_code', T], ['p_token', U], ['p_player', U]],
  api_leave_room: [['p_code', T], ['p_token', U]],
  api_make_host: [['p_code', T], ['p_token', U], ['p_player', U]],
  api_new_season: [['p_code', T], ['p_token', U], ['p_name', T]],
  api_past_seasons: [['p_code', T], ['p_token', U]],
  api_add_question: [['p_code', T], ['p_token', U], ['p_category', T], ['p_text', T]],
  api_family_questions: [['p_code', T], ['p_token', U]],
  api_delete_question: [['p_code', T], ['p_token', U], ['p_id', N]],
};

async function callApi(fn, args = {}) {
  const spec = API[fn];
  if (!spec) { const e = new Error('UNKNOWN_FUNCTION'); e.code = 'P0001'; throw e; }
  const parts = [], params = [];
  for (const [name, type] of spec) {
    if (args[name] === undefined) continue; // use the SQL default
    let v = args[name];
    if (type === J) v = v === null ? null : JSON.stringify(v);
    params.push(v);
    parts.push(`${name} => $${params.length}::${type}`);
  }
  const db = await getDb();
  const rows = await db.query(`select public.${fn}(${parts.join(', ')}) as r`, params);
  return rows[0] ? rows[0].r : null;
}

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const { fn, args } = req.body || {};
  try {
    const data = await callApi(fn, args || {});
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ data });
  } catch (e) {
    if (e.code === 'P0001') return res.status(400).json({ error: e.message });
    if (e.code === '22P02') return res.status(400).json({ error: 'NOT_IN_ROOM' }); // malformed token
    if (e.code === 'NO_DATABASE') return res.status(503).json({ error: 'NO_DATABASE' });
    console.error(fn, e);
    return res.status(500).json({ error: 'SERVER_ERROR' });
  }
}

module.exports = handler;
module.exports.callApi = callApi;
