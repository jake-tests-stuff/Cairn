// Web Push for Cloudflare Workers: VAPID signing (RFC 8292) and aes128gcm payload encryption (RFC 8291).
const enc = new TextEncoder();

export const b64u = {
  enc(buf){
    const u = new Uint8Array(buf); let s = '';
    for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str){
    let s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s); const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
};

function concat(...parts){
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0;
  for (const p of parts){ out.set(p, o); o += p.length; }
  return out;
}

async function hkdf(salt, ikm, info, len){
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name:'HKDF', hash:'SHA-256', salt, info }, key, len * 8));
}

export async function encryptPayload(sub, text){
  const uaPub = b64u.dec(sub.keys.p256dh), authSecret = b64u.dec(sub.keys.auth);
  const asKeys = await crypto.subtle.generateKey({ name:'ECDH', namedCurve:'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name:'ECDH', namedCurve:'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name:'ECDH', public: uaKey }, asKeys.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const body = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv: nonce }, aes, concat(enc.encode(text), new Uint8Array([2]))));
  const header = concat(salt, new Uint8Array([0, 0, 0x10, 0]), new Uint8Array([asPub.length]), asPub); // record size 4096
  return concat(header, body);
}

export async function vapidHeader(endpoint, env){
  const aud = new URL(endpoint).origin;
  const head = b64u.enc(enc.encode(JSON.stringify({ typ:'JWT', alg:'ES256' })));
  const claims = b64u.enc(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT })));
  const key = await crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE_JWK), { name:'ECDSA', namedCurve:'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name:'ECDSA', hash:'SHA-256' }, key, enc.encode(head + '.' + claims)));
  return `vapid t=${head}.${claims}.${b64u.enc(sig)}, k=${env.VAPID_PUBLIC}`;
}

// Returns { ok, status, gone }. gone = the subscription no longer exists and should be dropped.
export async function sendPush(sub, payload, env, opts = {}){
  const body = await encryptPayload(sub, JSON.stringify(payload));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': await vapidHeader(sub.endpoint, env),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': String(opts.ttl ?? 120),
      'Urgency': opts.urgency || 'high'
    },
    body
  });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
