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
import { deepseekGrant } from './credentials.js';
import { dshRpc } from './dsh.js';

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

  // The client metadata identifies the calling UI. `version` is a string here,
  // not a number — the strict wire codec rejects a numeric version.
  const res = await dshRpc('account/getBalance', {
    client: { version: '1', locale: 'zh-CN', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 },
  });

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
