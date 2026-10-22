/**
 * API-key providers.
 *
 * These authenticate with a plain key the user pastes into
 * ~/.dsh/.credentials.yaml → refs.<NAME>. No OAuth, no external tool: if the
 * key is present the adapter works, and it is the only requirement.
 */
import { readRef, readFirstRef, credentialSource } from './credentials.js';
import { getJson } from './http.js';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Normalise a reset timestamp to ISO, or null when there is none.
 *
 * Upstreams are inconsistent: some send ISO strings, some epoch milliseconds,
 * and some use `0` to mean "this window has no reset pending" (Command Code's
 * five-hour window does exactly that). Treating 0 as a date would render 1970.
 */
function isoReset(v) {
  if (v == null || v === '' || v === 0) return null;
  if (typeof v === 'string') {
    // Already ISO-ish: keep as-is so the client formats it consistently.
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  // Seconds vs milliseconds: anything below ~year 33658 in ms is really seconds.
  const ms = n < 1e11 ? n * 1000 : n;
  return new Date(ms).toISOString();
}

/** Expand `products` (window → used%) into the `windows` rows the pill renders. */
function toWindows(products, resetByKey = {}) {
  const out = [];
  for (const [key, used] of Object.entries(products || {})) {
    const n = Number(used);
    if (!Number.isFinite(n)) continue;
    out.push({
      key,
      remainPct: Math.round(Math.max(0, Math.min(100, 100 - n)) * 100) / 100,
      resetAt: resetByKey[key] || null,
    });
  }
  const order = { '5h': 0, rolling: 0, weekly: 1, '7d': 1, monthly: 2 };
  out.sort((a, b) => (order[a.key] ?? 9) - (order[b.key] ?? 9));
  return out;
}

/** Shared shape for "I cannot answer, and here is why" — never a fake number. */
function notConfigured(provider, ref) {
  return {
    kind: 'none',
    provider,
    error: `no ${ref} in ~/.dsh/.credentials.yaml (run /dsh-quota-pill-setup to add it)`,
    setup: { ref, source: credentialSource(provider) },
  };
}

/* ------------------------------------------------------------------ kimi */
/**
 * Kimi Coding exposes `usages` keyed by window name with a `used_ratio`, plus a
 * newer `limits[]` shape. Both carry the same information, so we read whichever
 * is present and normalise to "remaining percent".
 */
export async function kimi() {
  const token = readRef('KIMI_CODING_API_KEY');
  if (!token) return notConfigured('kimi', 'KIMI_CODING_API_KEY');

  const res = await getJson('https://api.kimi.com/coding/v1/usages', { token });
  if (!res.ok) return { kind: 'probe-failed', provider: 'kimi', error: res.error };

  const data = res.data || {};
  const windows = data.usages || {};
  const legacy = data.usage || {};
  const limits = data.limits || [];

  const products = {};
  for (const [label, w] of Object.entries(windows)) {
    const ratio = w && w.used_ratio;
    if (ratio != null) products[String(label).replace('limit_', '')] = round2(Number(ratio) * 100);
  }
  for (const entry of limits) {
    const win = (entry && entry.window) || {};
    const det = (entry && entry.detail) || {};
    const dur = win.duration;
    const unit = win.timeUnit;
    let label = String(dur || 'window');
    if (unit === 'TIME_UNIT_MINUTE' && dur) label = `${Math.floor(dur / 60)}h`;
    if (det.limit) {
      const used = Number(det.used) || 0;
      const limit = Number(det.limit) || 0;
      if (limit > 0) products[label] = round2((used / limit) * 100);
    }
  }

  // The binding window is the one closest to its ceiling.
  let tightLabel = null;
  let tight = null;
  for (const [label, w] of Object.entries(windows)) {
    const ratio = w && w.used_ratio;
    if (ratio == null) continue;
    if (tight === null || Number(ratio) > Number(tight.used_ratio || 0)) {
      tightLabel = label;
      tight = w;
    }
  }

  let used;
  let reset;
  let window;
  if (tight) {
    used = Number(tight.used_ratio) * 100;
    reset = tight.reset_time;
    window = String(tightLabel).replace('limit_', '');
  } else if (legacy.limit) {
    used = (Number(legacy.used) / Number(legacy.limit)) * 100;
    reset = legacy.resetTime;
    window = String(legacy.window || '').replace('limit_', '') || null;
  } else {
    return { kind: 'none', provider: 'kimi', error: 'usages payload had no ratios' };
  }

  return {
    kind: 'subscription-quota',
    provider: 'kimi',
    account: 'kimi-coding',
    remainingPct: round2(100 - used),
    usedPct: round2(used),
    window,
    resetAt: reset || null,
    products,
    windows: toWindows(products, (() => {
      const r = {};
      for (const [label, w] of Object.entries(windows)) {
        if (w && w.reset_time) r[String(label).replace('limit_', '')] = w.reset_time;
      }
      return r;
    })()),
    raw: { source: 'api.kimi.com/coding/v1/usages' },
  };
}

/* -------------------------------------------------------------- opencode */
/**
 * OpenCode Go reports a `percent` per window. No credits, no ceiling — just the
 * percentage, which is already exactly what we render.
 */
export async function opencode() {
  const token = readRef('OPENCODE_GO_API_KEY');
  if (!token) return notConfigured('opencode', 'OPENCODE_GO_API_KEY');

  const res = await getJson('https://opencode.ai/zen/go/v1/usage', {
    token,
    headers: { 'User-Agent': 'opencode/1.18.31' },
  });
  if (!res.ok) return { kind: 'probe-failed', provider: 'opencode', error: res.error };

  const windows = (res.data && res.data.usage) || {};
  const products = {};
  for (const [label, w] of Object.entries(windows)) {
    const pct = w && w.percent;
    if (pct != null) products[label] = round2(Number(pct));
  }

  let tightLabel = null;
  let tight = null;
  for (const [label, w] of Object.entries(windows)) {
    const pct = w && w.percent;
    if (pct == null) continue;
    if (tight === null || Number(pct) > Number(tight.percent || 0)) {
      tightLabel = label;
      tight = w;
    }
  }
  if (!tight) return { kind: 'probe-failed', provider: 'opencode', error: 'usage payload empty' };

  const used = Number(tight.percent) || 0;
  return {
    kind: 'subscription-quota',
    provider: 'opencode',
    account: 'opencode-go',
    remainingPct: round2(100 - used),
    usedPct: round2(used),
    window: tightLabel,
    resetAt: tight.resetsAt || null,
    products,
    windows: toWindows(products, (() => {
      const r = {};
      for (const [label, w] of Object.entries(windows)) {
        if (w && w.resetsAt) r[label] = w.resetsAt;
      }
      return r;
    })()),
    raw: { source: 'opencode.ai/zen/go/v1/usage' },
  };
}

/* ----------------------------------------------------------- commandcode */
/**
 * Command Code bills in credits with 5h / weekly / monthly windows.
 *
 * The docs only document the CLI's `/usage` command, but that command calls
 * /alpha/billing/credits with the same Provider API key — so the numbers are
 * reachable directly.
 *
 * Monthly is derived, not given: the API only returns `credits.monthlyCredits`
 * (what is *left*). Empirically `weekly.used + monthlyCredits` equals the
 * monthly total and `monthlyCap = weekly.cap × 2` — verified against two
 * different plans (Provider 31.6+38.4=70 with weekly.cap 35; Go 0.225+9.775=10
 * with weekly.cap 6). So the ceiling is inferred rather than hardcoded to 70.
 */
export async function commandcode() {
  // DSH's own provider config names this ref after its apiKeyEnv
  // (COMMANDCODE_GOAT_API_KEY); older docs use the short name. Accept both so
  // a key the user already has is not reported as missing.
  const token = readFirstRef(['COMMANDCODE_API_KEY', 'COMMANDCODE_GOAT_API_KEY']);
  if (!token) {
    return notConfigured('commandcode', 'COMMANDCODE_API_KEY or COMMANDCODE_GOAT_API_KEY');
  }

  const res = await getJson('https://api.commandcode.ai/alpha/billing/credits', {
    token,
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return { kind: 'probe-failed', provider: 'commandcode', error: res.error };

  const data = res.data || {};
  const win = data.windowLimits || {};
  const cred = data.credits || {};

  const products = {};
  const ratios = [];
  let tight = null;

  for (const [label, key] of [['5h', 'fiveHour'], ['weekly', 'weekly']]) {
    const w = win[key] || {};
    const used = w.used;
    const cap = w.cap;
    if (used == null || !cap) continue;
    const pct = round2((Number(used) / Number(cap)) * 100);
    products[label] = pct;
    ratios.push(100 - pct);
    if (tight === null || pct > tight[1]) tight = [key, pct, isoReset(w.resetAt)];
  }

  const monthlyLeft = cred.monthlyCredits;
  const wk = win.weekly || {};
  if (typeof monthlyLeft === 'number' && wk.cap) {
    const monthlyCap = Number(wk.cap) * 2;
    if (monthlyCap > 0) {
      const mpct = round2(((monthlyCap - monthlyLeft) / monthlyCap) * 100);
      products.monthly = clamp(mpct, 0, 100);
      ratios.push(100 - products.monthly);
    }
  }

  if (!Object.keys(products).length) {
    return { kind: 'none', provider: 'commandcode', error: 'billing/credits returned no window limits' };
  }

  // Plan identity (GOAT / Pro / Max) lives on a sibling endpoint; failure there
  // must not lose the quota we already have.
  // Plan identity and the monthly period live on a sibling endpoint, nested under
  // `data`. Getting this wrong is silent: the quota still renders, just with a
  // null plan and a monthly window that cannot show when it renews.
  let plan = null;
  let monthlyReset = null;
  try {
    const sub = await getJson('https://api.commandcode.ai/alpha/billing/subscriptions', { token });
    const d = sub.ok && sub.data ? (sub.data.data || {}) : {};
    plan = d.planId || null;
    // currentPeriodEnd is the real monthly renewal — better than deriving it
    // from the weekly window, which was my earlier guess.
    monthlyReset = d.currentPeriodEnd || null;
  } catch {
    plan = null;
    monthlyReset = null;
  }

  const remaining = round2(Math.min(...ratios));
  return {
    kind: 'subscription-quota',
    provider: 'commandcode',
    account: plan || 'commandcode',
    remainingPct: remaining,
    usedPct: round2(100 - remaining),
    window: tight ? tight[0] : null,
    resetAt: tight ? tight[2] : null,
    products,
    windows: toWindows(products, (() => {
      const r = {};
      for (const [label, key] of [['5h', 'fiveHour'], ['weekly', 'weekly']]) {
        const w = win[key] || {};
        const iso = isoReset(w.resetAt);
        if (iso) r[label] = iso;
      }
      // The monthly ceiling is derived, so its reset must come from the
      // subscription period; the credits endpoint does not carry one.
      if (monthlyReset) r.monthly = monthlyReset;
      return r;
    })()),
    raw: { source: 'api.commandcode.ai/alpha/billing/credits', plan },
  };
}
