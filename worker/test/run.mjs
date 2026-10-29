import { encryptPayload, vapidHeader, b64u } from '../src/push.js';
import { verifyIdToken, resetKeyCache } from '../src/auth.js';
import { dueReminders, localParts } from '../src/due.js';
import assert from 'node:assert/strict';
const enc = new TextEncoder(), dec = new TextDecoder();
let n = 0; const ok = (m) => console.log('ok', ++n, m);
const concat = (...p) => { const o = new Uint8Array(p.reduce((a, b) => a + b.length, 0)); let i = 0; p.forEach(x => { o.set(x, i); i += x.length; }); return o; };
async function hkdf(salt, ikm, info, len){ const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']); return new Uint8Array(await crypto.subtle.deriveBits({ name:'HKDF', hash:'SHA-256', salt, info }, k, len * 8)); }

// 1. Encrypted payload round trip, decrypted the way a browser does (RFC 8291 section 3.4)
{
  const ua = await crypto.subtle.generateKey({ name:'ECDH', namedCurve:'P-256' }, true, ['deriveBits']);
  const uaPub = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const sub = { endpoint:'https://example.push/abc', keys:{ p256dh: b64u.enc(uaPub), auth: b64u.enc(auth) } };
  const msg = JSON.stringify({ title:'Rest done', body:'Deadlift · next set', tag:'rest' });
  const blob = await encryptPayload(sub, msg);
  const salt = blob.slice(0, 16), rs = new DataView(blob.buffer, blob.byteOffset + 16, 4).getUint32(0), idlen = blob[20];
  assert.equal(rs, 4096); assert.equal(idlen, 65);
  const asPub = blob.slice(21, 21 + idlen), ct = blob.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', asPub, { name:'ECDH', namedCurve:'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name:'ECDH', public: asKey }, ua.privateKey, 256));
  const ikm = await hkdf(auth, shared, concat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16), nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name:'AES-GCM', iv: nonce }, key, ct));
  assert.equal(plain[plain.length - 1], 2);
  assert.equal(dec.decode(plain.slice(0, -1)), msg);
  ok('payload encrypts and decrypts like a browser would');
}

// 2. VAPID header verifies with the public key
{
  const kp = await crypto.subtle.generateKey({ name:'ECDSA', namedCurve:'P-256' }, true, ['sign', 'verify']);
  const priv = await crypto.subtle.exportKey('jwk', kp.privateKey), pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const env = { VAPID_PRIVATE_JWK: JSON.stringify(priv), VAPID_PUBLIC: b64u.enc(pubRaw), VAPID_SUBJECT: 'https://example.com/' };
  const h = await vapidHeader('https://web.push.apple.com/xyz', env);
  const m = /^vapid t=([^,]+), k=(.+)$/.exec(h); assert.ok(m); assert.equal(m[2], env.VAPID_PUBLIC);
  const [hd, cl, sg] = m[1].split('.');
  const claims = JSON.parse(dec.decode(b64u.dec(cl)));
  assert.equal(claims.aud, 'https://web.push.apple.com'); assert.ok(claims.exp > Date.now() / 1000 && claims.exp < Date.now() / 1000 + 13 * 3600);
  assert.equal(b64u.dec(sg).length, 64);
  const v = await crypto.subtle.verify({ name:'ECDSA', hash:'SHA-256' }, kp.publicKey, b64u.dec(sg), enc.encode(hd + '.' + cl));
  assert.ok(v); ok('VAPID signature verifies');
}

// 3. Firebase token verification (signing keys mocked)
{
  const kp = await crypto.subtle.generateKey({ name:'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash:'SHA-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid:'k1', alg:'RS256', use:'sig' };
  const fetchFn = async () => ({ ok: true, json: async () => ({ keys: [jwk] }) });
  const env = { FIREBASE_PROJECT:'cairn-8a059', ALLOWED_EMAILS:'jake@example.com' };
  const mk = async (over = {}, kid = 'k1') => {
    const now = Math.floor(Date.now() / 1000);
    const claims = { aud:'cairn-8a059', iss:'https://securetoken.google.com/cairn-8a059', sub:'uid1', iat: now - 5, exp: now + 3600, email:'jake@example.com', email_verified:true, ...over };
    const h = b64u.enc(enc.encode(JSON.stringify({ alg:'RS256', kid, typ:'JWT' }))), c = b64u.enc(enc.encode(JSON.stringify(claims)));
    const s = b64u.enc(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', kp.privateKey, enc.encode(h + '.' + c)));
    return h + '.' + c + '.' + s;
  };
  resetKeyCache();
  assert.equal((await verifyIdToken(await mk(), env, fetchFn)).sub, 'uid1'); ok('valid token accepted');
  for (const [name, over] of [['wrong project', { aud:'other' }], ['expired', { exp: 10 }], ['other email', { email:'x@example.com' }], ['unverified email', { email_verified:false }], ['wrong issuer', { iss:'https://evil.example' }]]){
    await assert.rejects(async () => verifyIdToken(await mk(over), env, fetchFn)); ok('rejected: ' + name);
  }
  await assert.rejects(async () => verifyIdToken(await mk({}, 'nokey'), env, fetchFn)); ok('rejected: unknown key');
  const t = await mk(); await assert.rejects(() => verifyIdToken(t.slice(0, -4) + 'AAAA', env, fetchFn)); ok('rejected: tampered signature');
}

// 4. Reminder timing in the user's time zone
{
  const tz = 'America/Detroit';
  const at = (iso) => Date.parse(iso);
  // 6:35 a.m. EDT on Thursday Oct 29 2026 = 10:35 UTC
  assert.deepEqual(dueReminders({ morning:true, tz }, at('2026-10-29T10:35:00Z')).map(d => d.tag), ['morning']);
  assert.equal(dueReminders({ morning:true, tz }, at('2026-10-29T10:50:00Z')).length, 0); // 6:50, outside the window
  assert.equal(dueReminders({ morning:true, tz }, at('2026-10-29T10:20:00Z')).length, 0); // 6:20, too early
  // after clocks fall back (Nov 1 2026) the same local time moves to 11:35 UTC
  assert.equal(dueReminders({ morning:true, tz }, at('2026-11-02T11:35:00Z')).length, 1);
  assert.equal(dueReminders({ morning:true, tz }, at('2026-11-02T10:35:00Z')).length, 0);
  // Sunday review at 7 p.m. local: Nov 1 2026 is a Sunday, 19:05 EST = 00:05 UTC Nov 2
  assert.deepEqual(dueReminders({ weekly:true, tz }, at('2026-11-02T00:05:00Z')).map(d => d.tag), ['weekly']);
  assert.equal(dueReminders({ weekly:true, tz }, at('2026-11-03T00:05:00Z')).length, 0); // that is Monday evening
  assert.equal(dueReminders({ morning:true, morningTime:'07:15', tz }, at('2026-10-29T11:20:00Z')).length, 1);
  assert.equal(localParts(at('2026-10-29T10:35:00Z'), tz).date, '2026-10-29');
  ok('reminder windows follow local time, including the November clock change');
}
// 5. The scheduler (Durable Object) against a real SQLite database, with push sending mocked
{
  const { DatabaseSync } = await import('node:sqlite');
  const { Scheduler } = await import('../src/index.js');
  const db = new DatabaseSync(':memory:');
  let alarm = null;
  const ctx = { storage: { sql: { exec(q, ...a){ const s = db.prepare(q); const rows = /^\s*(SELECT)/i.test(q) ? s.all(...a) : (s.run(...a), []); return { toArray: () => rows }; } }, setAlarm: async (t) => { alarm = t; }, deleteAlarm: async () => { alarm = null; } } };
  const kp = await crypto.subtle.generateKey({ name:'ECDSA', namedCurve:'P-256' }, true, ['sign', 'verify']);
  const env = { VAPID_PRIVATE_JWK: JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey)), VAPID_PUBLIC: b64u.enc(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey))), VAPID_SUBJECT:'https://example.com/' };
  const ua = await crypto.subtle.generateKey({ name:'ECDH', namedCurve:'P-256' }, true, ['deriveBits']);
  const sub = { endpoint:'https://push.example/s1', keys:{ p256dh: b64u.enc(new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey))), auth: b64u.enc(crypto.getRandomValues(new Uint8Array(16))) } };
  const sent = []; const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => { sent.push({ u, h: o.headers, len: o.body.length }); return { ok:true, status:201 }; };
  const so = new Scheduler(ctx, env);
  const call = async (path, body) => (await so.fetch(new Request('https://do' + path, { method:'POST', body: JSON.stringify(body) }))).json();
  assert.deepEqual(await call('/subscribe', { sub, uid:'u1', prefs:{ morning:true, tz:'America/Detroit' } }), { ok:true });
  assert.equal((await call('/schedule', { endpoint: sub.endpoint, uid:'u2', id:'rest', at: Date.now() + 1000 })).error, 'unknown subscription'); ok('other users cannot schedule on my subscription');
  const at = Date.now() + 5000;
  await call('/schedule', { endpoint: sub.endpoint, uid:'u1', id:'rest', at, title:'Rest done', body:'Deadlift' });
  await call('/schedule', { endpoint: sub.endpoint, uid:'u1', id:'rest', at: at + 60000, title:'Rest done', body:'Deadlift' }); // replaces
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 1); assert.ok(alarm >= at); ok('scheduling the same id replaces it and arms the alarm');
  await call('/cancel', { endpoint: sub.endpoint, uid:'u1', id:'rest' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0); assert.equal(alarm, null); ok('cancel removes it and clears the alarm');
  await call('/schedule', { endpoint: sub.endpoint, uid:'u1', id:'rest', at: Date.now() - 10, title:'Rest done', body:'Deadlift' });
  await so.alarm();
  assert.equal(sent.length, 1); assert.equal(sent[0].u, sub.endpoint); assert.match(sent[0].h.Authorization, /^vapid t=/); assert.equal(sent[0].h['Content-Encoding'], 'aes128gcm');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0); ok('a due alert is sent once and removed');
  // cron: force the morning window using a fake clock
  const realNow = Date.now; Date.now = () => Date.parse('2026-10-29T10:35:00Z');
  await so.cron(); await so.cron();
  Date.now = realNow;
  assert.equal(sent.length, 2); ok('morning reminder sends once per day even if cron runs twice');
  globalThis.fetch = async () => ({ ok:false, status:410 });
  await call('/test', { endpoint: sub.endpoint, uid:'u1' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM subs').get().n, 0); ok('a dead subscription (410) is removed');
  globalThis.fetch = realFetch;
}
console.log('all passed');
