/**
 * Talking to the running DSH instance.
 *
 * Two things need it:
 *   · the DeepSeek balance, which only DSH can read (it holds the Platform grant)
 *   · the provider catalog, which says which providers this user actually has
 *
 * Both go through DSH's own RPC, authenticated with a signed session cookie:
 *   name  = "dsh-auth-" + base64url(sha256(authority))
 *   value = "v1." + base64url({version, authority, issuedAt, expiresAt}) + "." + sig
 * `issuedAt` / `expiresAt` are milliseconds and `version` must be the number 1 —
 * the wire codec rejects anything else, and a bad payload fails as 401 even
 * though the signature itself verifies.
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { URL } from 'node:url';
import { browserSessionSecret } from './credentials.js';

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/**
 * Every loopback port a DSH-named process is listening on.
 *
 * A single guess is not enough: DSH's helper processes also open debugging
 * ports, and picking one of those makes every RPC fail with 404.
 */
function candidatePorts() {
  const out = [];
  const explicit = process.env.DSH_RPC_BASE || process.env.QUOTA_PILL_DSH_BASE;
  if (explicit) out.push(explicit.replace(/\/$/, ''));
  if (process.env.QUOTA_PILL_DSH_PORT) out.push(`http://127.0.0.1:${process.env.QUOTA_PILL_DSH_PORT}`);
  try {
    const text = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {
      encoding: 'utf8',
      timeout: 4000,
    });
    for (const line of text.split('\n')) {
      if (!/DeepSeek|dsh/i.test(line)) continue;
      const m = /127\.0\.0\.1:(\d+)/.exec(line);
      if (!m) continue;
      const base = `http://127.0.0.1:${m[1]}`;
      if (!out.includes(base)) out.push(base);
    }
  } catch {
    /* lsof unavailable — env vars are the only path */
  }
  return out;
}

function signCookie(base, secretB64) {
  const authority = new URL(base).host;
  let raw;
  try {
    raw = Buffer.from(secretB64, 'base64url');
  } catch {
    raw = Buffer.from(secretB64, 'utf8');
  }
  const name = 'dsh-auth-' + b64u(crypto.createHash('sha256').update(authority).digest());
  const now = Date.now();
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 3600 * 1000 };
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac('sha256', raw).update(body).digest());
  return `${name}=v1.${body}.${sig}`;
}

/** POST one RPC to a specific base. */
async function rpcAt(base, method, args, cookie, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(base + '/api/' + method.replace(/\./g, '/'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Cookie: cookie },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: 'quota-pill-' + method,
        method,
        payload: { args },
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, status: res.status, error: `http ${res.status}` };
    let env;
    try {
      env = JSON.parse(text);
    } catch {
      return { ok: false, error: 'unparsable json' };
    }
    const result = (env && env.result) || {};
    if (result.ok === false) {
      const e = result.error || {};
      return { ok: false, error: `${e.code || 'rpc-failed'}: ${e.message || ''}`.trim() };
    }
    return { ok: true, value: result.value };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call one RPC against whichever candidate port actually answers.
 *
 * Ports are probed with a cheap, always-present RPC rather than trusted by
 * order, and the winner is remembered so we do not re-probe every call.
 */
let knownBase = null;

export async function dshRpc(method, args) {
  const secret = browserSessionSecret();
  if (!secret) return { ok: false, error: 'no browser-session secret in credentials' };

  const bases = [];
  if (knownBase) bases.push(knownBase);
  for (const b of candidatePorts()) if (!bases.includes(b)) bases.push(b);

  let lastError = 'no DSH port responded';
  for (const base of bases) {
    const cookie = signCookie(base, secret);
    const res = await rpcAt(base, method, args, cookie);
    // A 404 means this port is a different HTTP surface (a helper's debug port):
    // remember only ports that actually serve the RPC routes.
    if (res.ok || (res.status && res.status !== 404)) {
      knownBase = base;
      return res;
    }
    lastError = res.error || lastError;
  }
  return { ok: false, error: lastError };
}

/** Reset the remembered port (tests, or after DSH restarts on a new port). */
export function forgetDshBase() {
  knownBase = null;
}
