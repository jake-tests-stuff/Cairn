import { sendPush } from './push.js';
import { verifyIdToken } from './auth.js';
import { dueReminders } from './due.js';

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...extra } });

function cors(env, req){
  const origin = req.headers.get('Origin') || '';
  const ok = origin === env.ALLOWED_ORIGIN || /^http:\/\/localhost(:\d+)?$/.test(origin);
  return { 'Access-Control-Allow-Origin': ok ? origin : env.ALLOWED_ORIGIN, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Max-Age': '86400', 'Vary': 'Origin' };
}

export default {
  async fetch(req, env){
    const headers = cors(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    const url = new URL(req.url);
    if (url.pathname === '/health') return json({ ok: true }, 200, headers);
    if (req.method !== 'POST') return json({ error: 'not found' }, 404, headers);
    let claims;
    try{ claims = await verifyIdToken((req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, ''), env); }
    catch(e){ return json({ error: 'unauthorized' }, 401, headers); }
    let body = {}; try{ body = await req.json(); }catch(e){}
    const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName('main'));
    const res = await stub.fetch('https://do' + url.pathname, { method: 'POST', body: JSON.stringify({ ...body, uid: claims.sub }) });
    return new Response(await res.text(), { status: res.status, headers: { 'Content-Type': 'application/json', ...headers } });
  },
  async scheduled(event, env){
    const stub = env.SCHEDULER.get(env.SCHEDULER.idFromName('main'));
    await stub.fetch('https://do/cron', { method: 'POST', body: '{}' });
  }
};

// One Durable Object holds every subscription, pending alert and reminder record in its own SQLite database.
export class Scheduler {
  constructor(ctx, env){
    this.ctx = ctx; this.env = env; this.sql = ctx.storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, sub TEXT, uid TEXT, prefs TEXT, updated INTEGER)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS jobs (id TEXT, endpoint TEXT, at INTEGER, title TEXT, body TEXT, tag TEXT, PRIMARY KEY (id, endpoint))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS sent (key TEXT PRIMARY KEY, at INTEGER)');
  }
  rows(q, ...args){ return this.sql.exec(q, ...args).toArray(); }
  sub(endpoint){ const r = this.rows('SELECT * FROM subs WHERE endpoint = ?', endpoint)[0]; return r ? { ...r, sub: JSON.parse(r.sub), prefs: JSON.parse(r.prefs || '{}') } : null; }

  async fetch(req){
    const path = new URL(req.url).pathname; const b = await req.json().catch(() => ({}));
    if (path === '/cron'){ await this.cron(); return json({ ok: true }); }
    if (path === '/subscribe'){
      if (!b.sub || !b.sub.endpoint || !b.sub.keys) return json({ error: 'bad subscription' }, 400);
      this.sql.exec('INSERT OR REPLACE INTO subs (endpoint, sub, uid, prefs, updated) VALUES (?, ?, ?, ?, ?)', b.sub.endpoint, JSON.stringify(b.sub), b.uid, JSON.stringify(b.prefs || {}), Date.now());
      return json({ ok: true });
    }
    if (path === '/unsubscribe'){
      this.sql.exec('DELETE FROM subs WHERE endpoint = ? AND uid = ?', b.endpoint, b.uid); this.sql.exec('DELETE FROM jobs WHERE endpoint = ?', b.endpoint);
      return json({ ok: true });
    }
    const s = this.sub(b.endpoint);
    if (!s || s.uid !== b.uid) return json({ error: 'unknown subscription' }, 404);
    if (path === '/prefs'){
      this.sql.exec('UPDATE subs SET prefs = ? WHERE endpoint = ?', JSON.stringify(b.prefs || {}), b.endpoint);
      return json({ ok: true });
    }
    if (path === '/test'){
      const r = await sendPush(s.sub, { title: 'Cairn', body: 'Notifications are working.', tag: 'test' }, this.env);
      if (r.gone) this.sql.exec('DELETE FROM subs WHERE endpoint = ?', b.endpoint);
      return json({ ok: r.ok, status: r.status });
    }
    if (path === '/schedule'){
      const at = Number(b.at); if (!b.id || !(at > 0)) return json({ error: 'bad job' }, 400);
      this.sql.exec('INSERT OR REPLACE INTO jobs (id, endpoint, at, title, body, tag) VALUES (?, ?, ?, ?, ?, ?)', String(b.id).slice(0, 40), b.endpoint, at, String(b.title || 'Cairn').slice(0, 80), String(b.body || '').slice(0, 160), String(b.tag || b.id).slice(0, 40));
      await this.rearm();
      return json({ ok: true });
    }
    if (path === '/cancel'){
      this.sql.exec('DELETE FROM jobs WHERE id = ? AND endpoint = ?', String(b.id), b.endpoint); await this.rearm();
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  }

  async rearm(){
    const next = this.rows('SELECT MIN(at) AS at FROM jobs')[0];
    if (next && next.at) await this.ctx.storage.setAlarm(Math.max(Date.now() + 200, next.at)); else await this.ctx.storage.deleteAlarm();
  }

  async alarm(){
    const due = this.rows('SELECT * FROM jobs WHERE at <= ?', Date.now() + 500);
    for (const j of due){
      this.sql.exec('DELETE FROM jobs WHERE id = ? AND endpoint = ?', j.id, j.endpoint);
      const s = this.sub(j.endpoint); if (!s) continue;
      try{
        const r = await sendPush(s.sub, { title: j.title, body: j.body, tag: j.tag }, this.env, { ttl: 90 });
        if (r.gone) this.sql.exec('DELETE FROM subs WHERE endpoint = ?', j.endpoint);
      }catch(e){ console.log('push failed', String(e)); }
    }
    await this.rearm();
  }

  // Called by the 15-minute cron: morning check-in and Sunday review reminders.
  async cron(){
    const now = Date.now();
    for (const r of this.rows('SELECT * FROM subs')){
      const s = this.sub(r.endpoint);
      for (const d of dueReminders(s.prefs, now)){
        const key = r.endpoint + '|' + d.key;
        if (this.rows('SELECT 1 FROM sent WHERE key = ?', key).length) continue;
        this.sql.exec('INSERT INTO sent (key, at) VALUES (?, ?)', key, now);
        try{
          const res = await sendPush(s.sub, { title: d.title, body: d.body, tag: d.tag }, this.env, { ttl: 3600, urgency: 'normal' });
          if (res.gone) this.sql.exec('DELETE FROM subs WHERE endpoint = ?', r.endpoint);
        }catch(e){ console.log('reminder failed', String(e)); }
      }
    }
    this.sql.exec('DELETE FROM sent WHERE at < ?', now - 10 * 86400e3);
  }
}
