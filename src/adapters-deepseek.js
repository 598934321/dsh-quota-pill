/**
 * DeepSeek Platform (the official account).
 *
 * The credential in ~/.dsh/.credentials.yaml is a **Platform login grant**, not
 * an api.deepseek.com API key. Two consequences, both verified:
 *
 *   1. Sending it to api.deepseek.com/user/balance returns 401 — those are
 *      different systems.
 *   2. Calling platform.deepseek.com/api/v0/users/get_user_summary directly
 *      returns 429 from Cloudflare (non-browser TLS).
 *
 * So the balance is read through DSH's own `account/getBalance` RPC, which
 * already holds the grant, derives the right headers, and projects the answer
 * down to just wallet currency + balance. That is also the most conservative
 * route: we never handle a Platform token ourselves.
 *
 * The RPC needs a signed session cookie:
 *   name  = "dsh-auth-" + base64url(sha256(authority))
 *   value = "v1." + base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, body))
 *   payload = { version: 1, authority, issuedAt, expiresAt }   ← milliseconds
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { URL } from 'node:url';
import { deepseekGrant, browserSessionSecret } from './credentials.js';

const RPC_PORT_GUESSES = [8319, 8080, 3000];
const DSH_BASE_ENV = process.env.DSH_RPC_BASE || process.env.QUOTA_PILL_DSH_BASE || null;

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/** Find the DSH web server port. macOS/Linux: ask lsof; otherwise try env then guesses. */
function findDshBase() {
  if (DSH_BASE_ENV) return DSH_BASE_ENV.replace(/\/$/, '');
  if (process.env.QUOTA_PILL_DSH_PORT) {
    return `http://127.0.0.1:${process.env.QUOTA_PILL_DSH_PORT}`;
  }
  try {
    const out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], {
      encoding: 'utf8',
      timeout: 4000,
    });
    for (const line of out.split('\n')) {
      // The DSH process shows up under its app name; match on the command column.
      if (!/DeepSeek|dsh/i.test(line)) continue;
      const m = /127\.0\.0\.1:(\d+)/.exec(line);
      if (m) return `http://127.0.0.1:${m[1]}`;
    }
  } catch {
    /* lsof missing or blocked — fall through */
  }
  return null;
}

/** Build the signed session cookie DSH expects. */
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
  const payload = {
    version: 1,
    authority,
    issuedAt: now,
    expiresAt: now + 3600 * 1000,
  };
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac('sha256', raw).update(body).digest());
  return { name, value: `v1.${body}.${sig}` };
}

/** POST one RPC to DSH and return its result payload. */
async function dshRpc(method, args, base) {
  const secret = browserSessionSecret();
  if (!secret) return { ok: false, error: 'no browser-session secret in credentials' };

  const { name, value } = signCookie(base, secret);
  const body = JSON.stringify({
    type: 'client-request',
    rpcId: 'quota-pill-' + method,
    method,
    payload: { args },
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(base + '/api/' + method.replace(/\./g, '/'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Cookie: `${name}=${value}`,
      },
      body,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, status: res.status, error: `dsh rpc http ${res.status}: ${text.slice(0, 120)}` };
    }
    let env;
    try {
      env = JSON.parse(text);
    } catch {
      return { ok: false, error: 'dsh rpc returned unparsable json' };
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
 * Official DeepSeek balance.
 *
 * Reported as a `payg` reading: it is a prepaid CNY wallet, not a percentage
 * against a ceiling. `remainingPct` is deliberately null — inventing a
 * percentage from a balance we cannot divide by anything would be a fake number.
 */
export async function deepseek() {
  const grant = deepseekGrant();
  if (!grant) {
    return {
      kind: 'none',
      provider: 'deepseek',
      error: 'not signed in to DeepSeek Platform '
        + '(no deepseek-account-platform/default grant in ~/.dsh/.credentials.yaml)',
      setup: { kind: 'dsh-account', hint: 'Sign in to DeepSeek Platform from the DSH account menu.' },
    };
  }

  const base = findDshBase();
  if (!base) {
    return {
      kind: 'none',
      provider: 'deepseek',
      error: 'cannot locate the DSH web server (needed to read Platform balance)',
      setup: { kind: 'dsh-account', hint: 'Set QUOTA_PILL_DSH_PORT or DSH_RPC_BASE.' },
    };
  }

  // The client metadata identifies the calling UI. `version` is a string here,
  // not a number — the strict wire codec rejects a numeric version.
  const res = await dshRpc('account/getBalance', {
    client: { version: '1', locale: 'zh-CN', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 },
  }, base);

  if (!res.ok) {
    return {
      kind: 'probe-failed',
      provider: 'deepseek',
      error: res.error,
      setup: { kind: 'dsh-account' },
    };
  }

  const value = res.value;
  // DSH returns {status:'ready', value:[{currency,balance}], bonusWallets:[...]}
  if (!value || value.status !== 'ready') {
    return {
      kind: 'none',
      provider: 'deepseek',
      error: 'Platform balance unavailable (status: '
        + ((value && value.status) || 'unknown') + ')',
    };
  }

  const wallets = Array.isArray(value.value) ? value.value : [];
  const bonus = Array.isArray(value.bonusWallets) ? value.bonusWallets : [];
  if (!wallets.length && !bonus.length) {
    return { kind: 'none', provider: 'deepseek', error: 'Platform returned no wallets' };
  }

  const primary = wallets[0] || bonus[0] || {};
  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const currency = primary.currency || 'CNY';
  const balance = toNum(primary.balance);
  const bonusTotal = bonus.reduce((sum, w) => {
    const n = toNum(w && w.balance);
    return n == null ? sum : sum + n;
  }, 0);

  return {
    kind: 'payg',
    provider: 'deepseek',
    account: currency,
    label: 'prepaid',
    note: `prepaid balance ${balance == null ? '?' : balance.toFixed(2)} ${currency}`
      + (bonusTotal > 0 ? ` (+${bonusTotal.toFixed(2)} bonus)` : ''),
    remainingPct: null,
    usedPct: null,
    // Amounts are kept separately so the UI can show a currency figure.
    credits: {
      remain: balance,
      total: null,
      unit: currency,
    },
    windows: balance == null ? [] : [{
      key: 'balance',
      remainPct: null,
      amount: balance,
      unit: currency,
      resetAt: null,
    }],
    bonus: bonusTotal > 0
      ? { amount: bonusTotal, unit: currency }
      : null,
    raw: {
      source: 'DSH account/getBalance (Platform grant)',
      wallets,
      bonusWallets: bonus,
    },
  };
}
