/**
 * Open Design (open-design.ai) — Cloud coding-plan allowance.
 *
 * Optional provider. Unlike the others it does **not** read an API key: the
 * allowance lives in the cloud console's own API and is authenticated with the
 * console's session cookie. Set it once:
 *
 *   ~/.dsh/.credentials.yaml
 *     refs:
 *       OPENDESIGN_SESSION_COOKIE: <__Secure-better-auth.session_token value>
 *
 * To get that value: open https://open-design.ai/cloud/dashboard while signed in,
 * then in the browser's devtools read the `__Secure-better-auth.session_token`
 * cookie (it is HttpOnly, so `document.cookie` will not show it).
 *
 * Two traps, both verified:
 *   · The inference gateway at amr-link.open-design.ai/v1 has NO balance
 *     endpoint — it is a chat proxy only. Probing it for quota always 404s.
 *   · amr-api sits behind Cloudflare, which rejects Node's TLS fingerprint with
 *     `error code: 1010`. The request therefore goes through system curl.
 *     That is the same request over a different TLS stack, not an auth bypass.
 */
import { readRef } from './credentials.js';
import { getJsonViaCurl } from './http.js';

const API = process.env.OPENDESIGN_API_BASE || 'https://amr-api.open-design.ai/api/v1';

const round2 = (n) => Math.round(n * 100) / 100;

function headers(cookie) {
  return {
    Cookie: '__Secure-better-auth.session_token=' + cookie,
    Origin: 'https://open-design.ai',
    Referer: 'https://open-design.ai/',
  };
}

/** Window label from its length: 18000s is the 5h cap, 604800s the weekly one. */
function windowKey(seconds) {
  const s = Number(seconds) || 0;
  if (s > 0 && s <= 6 * 3600) return '5h';
  if (s > 0 && s <= 8 * 86400) return 'weekly';
  if (s > 0) return 'monthly';
  return 'credits-all';
}

/**
 * The workspace id is discoverable, so the user only supplies a cookie.
 * `/workspaces/current` already resolves to the default workspace.
 */
async function currentWorkspace(cookie) {
  const res = await getJsonViaCurl(`${API}/workspaces/current`, { headers: headers(cookie) });
  if (!res.ok) return { error: res.error };
  const id = res.data && res.data.workspaceId;
  return id ? { id } : { error: 'no workspaceId in response' };
}

export async function opendesign() {
  const cookie = readRef('OPENDESIGN_SESSION_COOKIE');
  if (!cookie) {
    return {
      kind: 'none',
      provider: 'opendesign',
      error: 'no OPENDESIGN_SESSION_COOKIE in ~/.dsh/.credentials.yaml',
      setup: {
        kind: 'session-cookie',
        ref: 'OPENDESIGN_SESSION_COOKIE',
        hint: 'Copy the __Secure-better-auth.session_token cookie from the Open Design cloud dashboard.',
      },
    };
  }

  const ws = await currentWorkspace(cookie);
  if (ws.error) {
    return {
      kind: 'probe-failed',
      provider: 'opendesign',
      error: `workspace lookup failed: ${ws.error}`,
      hint: 'The console session cookie has probably expired — copy a fresh one.',
    };
  }

  const res = await getJsonViaCurl(
    `${API}/workspaces/${ws.id}/billing/coding-plan-usage`,
    { headers: headers(cookie), timeoutMs: 25000 },
  );
  if (!res.ok) {
    return {
      kind: 'probe-failed',
      provider: 'opendesign',
      error: `coding-plan-usage failed: ${res.error}`,
      hint: res.error && res.error.includes('40')
        ? 'The console session cookie has probably expired — copy a fresh one.'
        : undefined,
    };
  }

  const body = res.data || {};
  const windows = [];
  for (const w of body.windows || []) {
    const limit = Number(w.limitCredits);
    const remain = Number(w.remainingCredits);
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(remain)) continue;
    windows.push({
      key: windowKey(w.durationSeconds),
      remainPct: round2((remain / limit) * 100),
      resetAt: w.resetsAt || null,
      credits: { remain: round2(remain), total: round2(limit), unit: 'credits' },
    });
  }

  if (!windows.length) {
    return {
      kind: 'none',
      provider: 'opendesign',
      error: `coding-plan-usage returned no windows (tier ${body.tier || 'unknown'})`,
    };
  }

  // The tightest window is what blocks the next request, but the list itself
  // stays in canonical order (5h before weekly) so rows match every other
  // provider instead of reshuffling as the numbers move.
  const tight = windows.reduce((a, b) => (a.remainPct <= b.remainPct ? a : b));
  const ORDER = { '5h': 0, weekly: 1, monthly: 2, 'credits-all': 3 };
  windows.sort((a, b) => (ORDER[a.key] ?? 9) - (ORDER[b.key] ?? 9));
  const products = {};
  for (const w of windows) products[w.key] = round2(100 - w.remainPct);

  return {
    kind: 'subscription-quota',
    provider: 'opendesign',
    account: body.tier || null,
    remainingPct: tight.remainPct,
    usedPct: round2(100 - tight.remainPct),
    window: tight.key,
    resetAt: tight.resetAt,
    products,
    windows,
    raw: { source: 'coding-plan-usage (console session)', tier: body.tier },
  };
}
