// AFTER HOURS — company-wide leaderboard (Cloudflare Worker + KV namespace bound as BOARD).
// GET  /            -> health
// GET  /top?scope=all|week&n=25
// POST /submit {name, district, score, hour, kills, cid}
// One row per player (name+district, case-insensitive) keeps their BEST score.
// Rank is computed from the board we just wrote (not a re-read), so KV lag can't return rank 0.
const MAX_ROWS = 300;
const MAX_SCORE = 5000000;
const DISTRICTS = ['North Side', 'South Side', 'East Side', 'West Side', 'Big South'];
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};
const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {
  status, headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, CORS, extra),
});

function weekKey(d = new Date()) {
  // ISO-style week starting Monday, in US Central time (stores are in IL/IN/TN)
  const c = new Date(d.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const day = (c.getDay() + 6) % 7; // Mon=0
  c.setHours(0, 0, 0, 0); c.setDate(c.getDate() - day);
  return 'week:' + c.getFullYear() + '-' + String(c.getMonth() + 1).padStart(2, '0') + '-' + String(c.getDate()).padStart(2, '0');
}
function cleanName(s) {
  return String(s || '').replace(/[^A-Za-z0-9 ._'-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 14);
}
async function readBoard(env, key) {
  try { const v = await env.BOARD.get(key, 'json'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
function upsert(rows, entry) {
  const id = (entry.name + '|' + entry.district).toLowerCase();
  const i = rows.findIndex((r) => (r.name + '|' + r.district).toLowerCase() === id);
  let improved = true;
  if (i >= 0) {
    if (rows[i].score >= entry.score) improved = false;
    else rows[i] = entry;
  } else rows.push(entry);
  rows.sort((a, b) => b.score - a.score || a.ts - b.ts);
  if (rows.length > MAX_ROWS) rows.length = MAX_ROWS;
  const rank = rows.findIndex((r) => (r.name + '|' + r.district).toLowerCase() === id) + 1;
  return { rows, rank, improved };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/' || url.pathname === '/health') {
      return json({ ok: true, game: 'after-hours', version: '1.0.0', kv: !!env.BOARD, week: weekKey(), time: new Date().toISOString() });
    }
    if (url.pathname === '/top' && request.method === 'GET') {
      const scope = url.searchParams.get('scope') === 'week' ? 'week' : 'all';
      const n = Math.max(1, Math.min(100, parseInt(url.searchParams.get('n') || '25', 10) || 25));
      const rows = await readBoard(env, scope === 'week' ? weekKey() : 'all:v1');
      return json({
        ok: true, scope, generated: new Date().toISOString(),
        rows: rows.slice(0, n).map((r, i) => ({ rank: i + 1, name: r.name, district: r.district, score: r.score, hour: r.hour, kills: r.kills, ts: r.ts })),
      }, 200, { 'cache-control': 'no-store' });
    }
    if (url.pathname === '/submit' && request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'bad json' }, 400); }
      const name = cleanName(body.name);
      const district = DISTRICTS.includes(body.district) ? body.district : '';
      const score = Math.floor(Number(body.score));
      const hour = Math.max(0, Math.min(9, parseInt(body.hour, 10) || 0));
      const kills = Math.max(0, Math.min(100000, parseInt(body.kills, 10) || 0));
      if (name.length < 2) return json({ ok: false, error: 'name must be 2-14 letters' }, 400);
      if (!Number.isFinite(score) || score < 0 || score > MAX_SCORE) return json({ ok: false, error: 'bad score' }, 400);
      const entry = { name, district, score, hour, kills, ts: Date.now(), cid: String(body.cid || '').slice(0, 24) };
      const wk = weekKey();
      const [all, week] = await Promise.all([readBoard(env, 'all:v1'), readBoard(env, wk)]);
      const A = upsert(all, entry), Wk = upsert(week, entry);
      const writes = [];
      if (A.improved) writes.push(env.BOARD.put('all:v1', JSON.stringify(A.rows)));
      if (Wk.improved) writes.push(env.BOARD.put(wk, JSON.stringify(Wk.rows), { expirationTtl: 60 * 60 * 24 * 60 }));
      await Promise.all(writes);
      return json({ ok: true, rank: A.rank, weekRank: Wk.rank, improved: A.improved });
    }
    return json({ ok: false, error: 'not found' }, 404);
  },
};
