// Verifies a Firebase ID token (RS256) without any library, using Google's published signing keys.
import { b64u } from './push.js';
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let cache = { keys: null, at: 0 };

async function getKeys(fetchFn){
  if (cache.keys && Date.now() - cache.at < 3600e3) return cache.keys;
  const res = await fetchFn(JWKS_URL);
  if (!res.ok) throw new Error('could not load signing keys');
  cache = { keys: (await res.json()).keys || [], at: Date.now() };
  return cache.keys;
}
export function resetKeyCache(){ cache = { keys: null, at: 0 }; }

export async function verifyIdToken(token, env, fetchFn = fetch){
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('bad token');
  const dec = new TextDecoder();
  const header = JSON.parse(dec.decode(b64u.dec(parts[0])));
  const claims = JSON.parse(dec.decode(b64u.dec(parts[1])));
  if (header.alg !== 'RS256') throw new Error('bad alg');
  const jwk = (await getKeys(fetchFn)).find(k => k.kid === header.kid);
  if (!jwk) throw new Error('unknown key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name:'RSASSA-PKCS1-v1_5', hash:'SHA-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u.dec(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  if (!ok) throw new Error('bad signature');
  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== env.FIREBASE_PROJECT) throw new Error('wrong audience');
  if (claims.iss !== 'https://securetoken.google.com/' + env.FIREBASE_PROJECT) throw new Error('wrong issuer');
  if (!(claims.exp > now) || claims.iat > now + 120) throw new Error('expired');
  if (!claims.sub) throw new Error('no subject');
  const allowed = String(env.ALLOWED_EMAILS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  if (allowed.length && !(claims.email_verified && allowed.includes(String(claims.email || '').toLowerCase()))) throw new Error('not allowed');
  return claims;
}
