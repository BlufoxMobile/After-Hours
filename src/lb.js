// Company-wide leaderboard client for AFTER HOURS (Cloudflare Worker + KV).
// Promises never reject. Failed submits are queued on this device and retried on the next call.
export const LB_URL = 'https://c3-after-hours.jeff-bilbrey-jb.workers.dev';
const QKEY = 'c3-after-hours-lb-queue-v1';
const TIMEOUT = 9000;

function withTimeout(url, init) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const t = setTimeout(() => { try { ctl && ctl.abort(); } catch (e) { /* */ } }, TIMEOUT);
  return fetch(url, Object.assign({}, init, ctl ? { signal: ctl.signal } : {})).finally(() => clearTimeout(t));
}
function loadQ() { try { const q = JSON.parse(localStorage.getItem(QKEY) || '[]'); return Array.isArray(q) ? q : []; } catch (e) { return []; } }
function saveQ(q) { try { localStorage.setItem(QKEY, JSON.stringify(q.slice(-20))); } catch (e) { /* */ } }
function clientId() {
  try {
    let c = localStorage.getItem('c3-after-hours-cid');
    if (!c) { c = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); localStorage.setItem('c3-after-hours-cid', c); }
    return c;
  } catch (e) { return 'anon'; }
}

export function createLB(url = LB_URL) {
  let flushing = false;
  async function post(entry) {
    const r = await withTimeout(url + '/submit', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(Object.assign({ cid: clientId(), v: 3 }, entry)),
    });
    const j = await r.json();
    if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
    return j;
  }
  async function flush() {
    if (flushing) return; flushing = true;
    try {
      const q = loadQ(); const left = [];
      for (const e of q) { try { await post(e); } catch (err) { left.push(e); } }
      saveQ(left);
    } finally { flushing = false; }
  }
  return {
    url,
    async top(scope = 'all') {
      try {
        const r = await withTimeout(`${url}/top?scope=${scope === 'week' ? 'week' : 'all'}&n=25`, { method: 'GET' });
        const j = await r.json();
        if (!j || !Array.isArray(j.rows)) throw new Error('bad response');
        flush();
        return { rows: j.rows.map((x, i) => ({ rank: x.rank || i + 1, name: x.name, score: x.score, hour: x.hour, district: x.district || '' })) };
      } catch (err) {
        return { rows: [], error: 'Leaderboard is offline right now. Your scores are saved and will post later.' };
      }
    },
    async submit(entry) {
      const e = {
        name: String(entry.name || '').slice(0, 14), district: String(entry.district || '').slice(0, 24),
        score: Math.max(0, Math.floor(+entry.score || 0)), hour: Math.max(0, Math.min(9, entry.hour | 0)), kills: Math.max(0, entry.kills | 0),
      };
      try {
        const j = await post(e);
        flush();
        return { ok: true, rank: j.rank, weekRank: j.weekRank };
      } catch (err) {
        const q = loadQ(); q.push(e); saveQ(q);
        return { ok: false, error: 'Could not reach the leaderboard — saved on this phone, it will post next time you are online.' };
      }
    },
  };
}
