// ============================================================
// RMA Blaster: who is asking?
//
// The whole site sits behind one Cloudflare Access application.
// Access handles the login screen and stamps every request with a
// signed token. This file checks that token again inside the Worker,
// so a request that somehow arrives without passing through Access
// is refused instead of trusted by accident.
//
// Same approach as Interlocutor's src/auth.ts.
// ============================================================

const JWKS_TTL_MS = 60 * 60 * 1000;
let jwksCache = null;   // { teamDomain, keys, fetchedAt }

async function accessKeys(teamDomain, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && jwksCache && jwksCache.teamDomain === teamDomain &&
      now - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Could not fetch Access signing keys (${res.status})`);
  const data = await res.json();
  jwksCache = { teamDomain, keys: data.keys || [], fetchedAt: now };
  return jwksCache.keys;
}

function base64UrlToBytes(text) {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(segment) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

// Throws with a reason if the token is not a valid Access login for this app.
export async function verifyAccessJwt(token, teamDomain, audience) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed Access token');
  const [headerB64, payloadB64, signatureB64] = parts;

  let header, payload;
  try {
    header = decodeJson(headerB64);
    payload = decodeJson(payloadB64);
  } catch (_) {
    throw new Error('Malformed Access token');
  }
  if (header.alg !== 'RS256') throw new Error('Unexpected signing algorithm');

  // Access rotates its signing key. A key id we have not seen means the
  // cached set is stale, so fetch once more before rejecting.
  let jwk = (await accessKeys(teamDomain)).find(k => k.kid === header.kid);
  if (!jwk) jwk = (await accessKeys(teamDomain, true)).find(k => k.kid === header.kid);
  if (!jwk) throw new Error('Signed with an unknown key');

  const key = await crypto.subtle.importKey(
    'jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, base64UrlToBytes(signatureB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`));
  if (!valid) throw new Error('Signature is invalid');

  const now = Math.floor(Date.now() / 1000);
  // A token with no expiry is not one Access would issue. Refuse it.
  if (typeof payload.exp !== 'number' || now >= payload.exp) throw new Error('Token has expired');
  if (typeof payload.nbf === 'number' && now < payload.nbf) throw new Error('Token is not yet valid');
  if (payload.iss !== `https://${teamDomain}`) throw new Error('Issuer does not match the team domain');

  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(audience)) throw new Error('Token is for a different application');
  if (typeof payload.email !== 'string' || !payload.email) throw new Error('Token has no email');

  return { email: payload.email, sub: typeof payload.sub === 'string' ? payload.sub : null };
}

function accessCookie(request) {
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === 'CF_Authorization') return rest.join('=') || null;
  }
  return null;
}

function isLocalhost(request) {
  const host = new URL(request.url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

// Returns { email } for a signed-in team member, or null. Never throws:
// anything unexpected counts as "not signed in".
export async function requireSession(request, env) {
  // Local development only. `wrangler dev` is not behind Access, so there is
  // no token to check. DEV_USER lives in .dev.vars, which is never deployed,
  // and even if it were set in production by mistake the hostname test keeps
  // it from doing anything there.
  if (env.DEV_USER && isLocalhost(request)) return { email: env.DEV_USER, sub: null };

  // Not configured yet: refuse everyone rather than let everyone in.
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;

  const token = request.headers.get('Cf-Access-Jwt-Assertion') || accessCookie(request);
  if (!token) return null;
  try {
    return await verifyAccessJwt(token, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
  } catch (err) {
    console.warn('Access token rejected:', String(err && err.message || err));
    return null;
  }
}
