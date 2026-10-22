/**
 * Open Design (open-design.ai) — Cloud coding-plan allowance.
 *
 * Two ways in, in order:
 *
 *   1. **Control key** (preferred): `vela_ctrl_…` from an Open Design account
 *      sign-in. It is accepted by the Bearer-only control-plane endpoints
 *      `/billing/preflight` and `/wallet/balance`, alongside
 *      `x-vela-workspace-id`. This is the same credential the Open Design CLI
 *      (`vela login`) and the magpie/OpenCode provider use.
 *   2. **Console session cookie** (fallback): `__Secure-better-auth.session_token`
 *      from the Cloud console; it can read the browser-session-only
 *      `/billing/coding-plan-usage` route.
 *
 * Configure one of:
 *
 *   ~/.dsh/.credentials.yaml
 *     refs:
 *       OPENDESIGN_CONTROL_KEY: vela_ctrl_…
 *       OPENDESIGN_WORKSPACE_ID: br542…
 *       # or
 *       OPENDESIGN_SESSION_COOKIE: <__Secure-better-auth.session_token value>
 *
 * The workspace id is optional when a control key is set: the adapter resolves
 * it through `/workspaces/current`.
 *
 * Two traps, both verified:
 *   · The inference gateway at amr-link.open-design.ai/v1 has NO balance
 *     endpoint — it is a chat proxy only. Probing it for quota always 404s.
 *   · amr-api sits behind Cloudflare, which rejects Node's TLS fingerprint with
 *     `error code: 1010`. Requests therefore go through system curl. That is
 *     the same request over a different TLS stack, not an auth bypass.
 *
 * The control-plane endpoint accepts only the control key; an inference
 * `sk-amr-…` API key is a different credential and returns 401 here.
 */
import { readRef, readFirstRef } from './credentials.js';
import { getJsonViaCurl } from './http.js';

const API = process.env.OPENDESIGN_API_BASE || 'https://amr-api.open-design.ai/api/v1';
const ORIGIN = 'https://open-design.ai';
const CONTROL_REFS = ['OPENDESIGN_CONTROL_KEY', 'VELA_CONTROL_KEY'];
const WORKSPACE_REFS = ['OPENDESIGN_WORKSPACE_ID', 'VELA_WORKSPACE_ID', 'OPENDESIGN_WORKSPACE'];
const COOKIE_REF = 'OPENDESIGN_SESSION_COOKIE';

const round2 = (n) => Math.round(n * 100) / 100;

/** Headers both control-plane reads need. */
function controlHeaders(workspaceId) {
  return {
    'x-vela-workspace-id': workspaceId,
    Origin: ORIGIN,
    Referer: ORIGIN + '/',
  };
}

function cookieHeaders(cookie) {
  return {
    Cookie: '__Secure-better-auth.session_token=' + cookie,
    Origin: ORIGIN,
    Referer: ORIGIN + '/',
  };
}

/** Window label from its length: 18000s is the 5h cap, 604800s the weekly one. */
export function windowKey(seconds) {
  const s = Number(seconds) || 0;
  if (s > 0 && s <= 6 * 3600) return '5h';
  if (s > 0 && s <= 8 * 86400) return 'weekly';
  if (s > 0) return 'monthly';
  return 'credits-all';
}

/**
 * The workspace whose allowance is shown. A control key can resolve its own
 * active workspace; an explicit ref wins when the account has more than one.
 */
async function workspaceForControl(controlKey) {
  const configured = readFirstRef(WORKSPACE_REFS);
  if (configured) return { id: configured };
  const res = await getJsonViaCurl(API + '/workspaces/current', {
    token: controlKey,
    headers: { Origin: ORIGIN, Referer: ORIGIN + '/' },
  });
  if (!res.ok) return { error: res.error };
  const body = res.data || {};
  const id = body.activeWorkspaceId || body.workspaceId;
  return id ? { id } : { error: 'no activeWorkspaceId in /workspaces/current' };
}

/**
 * Turn the control-plane preflight's `codingPlan.windows` into the pill's
 * window rows. The preflight reports **used** credits; the pill renders
 * **remaining** percent, so the conversion happens once here.
 */
export function preflightWindows(body) {
  const plan = body && body.codingPlan;
  const out = [];
  for (const w of (plan && plan.windows) || []) {
    const limit = Number(w.limitCredits);
    const used = Number(w.usedCredits);
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used)) continue;
    const remain = Math.max(0, limit - used);
    out.push({
      key: windowKey(w.durationSeconds),
      remainPct: round2((remain / limit) * 100),
      resetAt: w.resetsAt || null,
      credits: { remain: round2(remain), total: round2(limit), unit: 'credits' },
    });
  }
  return out;
}

/** Shared result shape for both credential paths (and the tests). */
export function shapeReading({ windows, balanceUsd, tier = null, source }) {
  if (windows.length) {
    const tight = windows.reduce((a, b) => (a.remainPct <= b.remainPct ? a : b));
    const ORDER = { '5h': 0, weekly: 1, monthly: 2, 'credits-all': 3 };
    windows.sort((a, b) => (ORDER[a.key] ?? 9) - (ORDER[b.key] ?? 9));
    const products = {};
    for (const w of windows) products[w.key] = round2(100 - w.remainPct);
    return {
      kind: 'subscription-quota',
      provider: 'opendesign',
      account: tier || null,
      remainingPct: tight.remainPct,
      usedPct: round2(100 - tight.remainPct),
      window: tight.key,
      resetAt: tight.resetAt,
      products,
      windows,
      raw: { source, tier },
    };
  }

  const balance = Number(balanceUsd);
  if (Number.isFinite(balance)) {
    return {
      kind: 'payg',
      provider: 'opendesign',
      account: tier || null,
      note: 'wallet balance $' + balance.toFixed(2),
      remainingPct: null,
      usedPct: null,
      credits: { remain: round2(balance), total: null, unit: 'USD' },
      raw: { source, tier },
    };
  }

  return {
    kind: 'none',
    provider: 'opendesign',
    error: source + ' returned no allowance windows and no wallet balance',
  };
}

/** Control key: Bearer-only `/billing/preflight` plus the wallet balance. */
async function readWithControl(controlKey) {
  const ws = await workspaceForControl(controlKey);
  if (ws.error) {
    return {
      kind: 'probe-failed',
      provider: 'opendesign',
      error: 'workspace lookup failed: ' + ws.error,
      hint: 'A Control Key (vela_ctrl_…) is required; an inference sk-amr-… key cannot read the control plane.',
    };
  }

  const res = await getJsonViaCurl(
    API + '/workspaces/' + encodeURIComponent(ws.id) + '/billing/preflight',
    { token: controlKey, headers: controlHeaders(ws.id), timeoutMs: 25000 },
  );
  if (!res.ok) {
    const denied = res.status === 401 || res.status === 403;
    return {
      kind: 'probe-failed',
      provider: 'opendesign',
      error: 'billing/preflight failed: ' + res.error,
      hint: denied
        ? 'The Control Key is invalid, expired, or not allowed to read this workspace.'
        : undefined,
    };
  }

  const body = res.data || {};
  const plan = body.codingPlan || null;
  return shapeReading({
    windows: preflightWindows(body),
    balanceUsd: body.balanceUsd ?? (plan && plan.balanceUsd),
    tier: (plan && (plan.tier || plan.membershipTier)) || body.tier || null,
    source: 'billing/preflight (control key)',
  });
}

/** Console session cookie: browser-session-only `/billing/coding-plan-usage`. */
async function readWithCookie(cookie) {
  const wsRes = await getJsonViaCurl(API + '/workspaces/current', { headers: cookieHeaders(cookie) });
  if (!wsRes.ok) {
    return {
      kind: 'probe-failed',
      provider: 'opendesign',
      error: 'workspace lookup failed: ' + wsRes.error,
      hint: 'The console session cookie has probably expired — copy a fresh one.',
    };
  }
  const id = (wsRes.data && (wsRes.data.activeWorkspaceId || wsRes.data.workspaceId));
  if (!id) {
    return { kind: 'probe-failed', provider: 'opendesign', error: 'no workspaceId in /workspaces/current' };
  }

  const res = await getJsonViaCurl(
    API + '/workspaces/' + encodeURIComponent(id) + '/billing/coding-plan-usage',
    { headers: cookieHeaders(cookie), timeoutMs: 25000 },
  );
  if (!res.ok) {
    return {
      kind: 'probe-failed',
      provider: 'opendesign',
      error: 'coding-plan-usage failed: ' + res.error,
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
  return shapeReading({
    windows,
    balanceUsd: body.balanceUsd,
    tier: body.tier || null,
    source: 'coding-plan-usage (console session)',
  });
}

export async function opendesign() {
  const controlKey = readFirstRef(CONTROL_REFS);
  const cookie = readRef(COOKIE_REF);

  let controlResult = null;
  if (controlKey) {
    controlResult = await readWithControl(controlKey);
    if (controlResult.kind === 'subscription-quota' || controlResult.kind === 'payg') {
      return controlResult;
    }
  }

  if (cookie) {
    const cookieResult = await readWithCookie(cookie);
    if (cookieResult.kind === 'subscription-quota' || cookieResult.kind === 'payg') {
      return cookieResult;
    }
    return controlResult || cookieResult;
  }

  if (controlResult) return controlResult;

  return {
    kind: 'none',
    provider: 'opendesign',
    error: 'no OPENDESIGN_CONTROL_KEY (or VELA_CONTROL_KEY) and no OPENDESIGN_SESSION_COOKIE in ~/.dsh/.credentials.yaml',
    setup: {
      kind: 'control-key',
      ref: 'OPENDESIGN_CONTROL_KEY',
      refs: CONTROL_REFS,
      workspaceRefs: WORKSPACE_REFS,
      cookieRef: COOKIE_REF,
      hint: 'Add the Control Key from an Open Design account sign-in (vela_ctrl_…); '
        + 'a console session cookie also works as a fallback.',
    },
  };
}
