/**
 * CLIProxyAPI providers.
 *
 * These three (xAI / Codex / Antigravity) authenticate through a browser OAuth
 * flow. We do not run that flow — CLIProxyAPI does, and leaves the resulting
 * tokens in ~/.cli-proxy-api/<provider>-<account>.json. We only read them.
 *
 * Consequence for users: these providers require CLIProxyAPI to be installed
 * *and* logged in at least once. When the directory is missing entirely the
 * adapters say so explicitly ("needs CLIProxyAPI") rather than reporting an
 * empty quota, because "0 left" and "not set up" must not look the same.
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { readAuthFiles, hasCliProxy, CLI_PROXY_DIR, HOME } from './credentials.js';
import { getJson, getJsonViaCurl } from './http.js';

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Many OAuth-provider users run a local HTTP proxy (CLIProxyAPI setups commonly
 * point at 127.0.0.1:1082). Without it grok.com / googleapis are unreachable on
 * some networks. We only use it when the port is actually listening, so users
 * who do not run a proxy are unaffected.
 */
let proxyProbe;
function defaultProxy() {
  if (proxyProbe !== undefined) return proxyProbe;
  const candidate = process.env.QUOTA_PILL_PROXY || 'http://127.0.0.1:1082';
  // Only use it when the port is actually listening: users without a local
  // proxy must not get every request pointed at a dead socket.
  try {
    const probe = spawnSync('nc', ['-z', '127.0.0.1', '1082'], { timeout: 1500 });
    proxyProbe = probe.status === 0 ? candidate : null;
  } catch {
    proxyProbe = null;
  }
  return proxyProbe;
}
const CODEX_ORIGINATOR = 'codex_cli_rs';
const CODEX_CLI_VERSION = process.env.CODEX_CLI_VERSION || '0.153.4';

/** Distinguish "CLIProxyAPI not installed" from "installed but no account". */
function noCredential(provider, prefix) {
  if (!hasCliProxy()) {
    return {
      kind: 'none',
      provider,
      error: `CLIProxyAPI is not set up (${CLI_PROXY_DIR} missing). `
        + `Install CLIProxyAPI and log in once, or use an API-key provider instead.`,
      setup: { kind: 'cli-proxy', dir: CLI_PROXY_DIR, needs: 'CLIProxyAPI + ' + prefix },
    };
  }
  return {
    kind: 'none',
    provider,
    error: `no ${prefix}-*.json in ${CLI_PROXY_DIR} — log into ${prefix} through CLIProxyAPI once`,
    setup: { kind: 'cli-proxy', dir: CLI_PROXY_DIR, needs: prefix },
  };
}

function usableFiles(prefix) {
  return readAuthFiles(prefix).filter((f) => f.token && !f.disabled);
}

/** ISO timestamp from epoch seconds, or null. */
function isoFromEpoch(sec) {
  const n = Number(sec);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000).toISOString();
}


/** Same reset for every product row — xAI reports one billing period for all. */
function fillReset(products, resetAt) {
  const out = {};
  if (!resetAt) return out;
  for (const key of Object.keys(products || {})) out[key] = resetAt;
  return out;
}

/**
 * Expand `products` (window → used%) into the `windows` array the client
 * renders. The client shows one row per window with its own reset time, so an
 * adapter that only reports the tightest window loses those rows.
 *
 * `resetByKey` supplies per-window reset timestamps where the upstream has
 * them; windows without one simply show no reset line.
 */
function toWindows(products, resetByKey = {}) {
  if (!products || typeof products !== 'object') return [];
  const out = [];
  for (const [key, used] of Object.entries(products)) {
    const n = Number(used);
    if (!Number.isFinite(n)) continue;
    out.push({
      key,
      remainPct: round2(Math.max(0, Math.min(100, 100 - n))),
      resetAt: resetByKey[key] || null,
    });
  }
  // Stable order: shortest window first, it is the near-term constraint.
  const order = { '5h': 0, rolling: 0, weekly: 1, '7d': 1, monthly: 2 };
  out.sort((a, b) => (order[a.key] ?? 9) - (order[b.key] ?? 9));
  return out;
}

/* --------------------------------------------------------------------- xai */
/**
 * xAI has three account generations and they expose quota in different places:
 *
 *  1. Grandfathered plans  → billing?format=credits carries creditUsagePercent
 *  2. Current plans        → only a 1-token completion carries the allowance,
 *                            as x-ratelimit-* response headers
 *  3. Unified billing      → no ceiling at all (monthlyLimit 0); report spend
 *
 * We try them in that order. Branch 3 is genuinely "pay as you go", so it is
 * reported as such rather than as a fake percentage.
 */
export async function xai(model) {
  const files = usableFiles('xai');
  if (!files.length) return noCredential('xai', 'xai');
  const cred = files[0];
  const account = cred.account || cred.name;

  const credits = await curlJson('https://cli-chat-proxy.grok.com/v1/billing?format=credits', {
    token: cred.token,
    proxy: process.env.QUOTA_PILL_PROXY || defaultProxy(),
  });
  if (!credits.ok) {
    return { kind: 'probe-failed', provider: 'xai', error: credits.error };
  }
  const cfg = (credits.data && credits.data.config) || {};
  const period = cfg.currentPeriod || {};

  // ---- branch 1: a real subscription percentage
  const used = cfg.creditUsagePercent;
  if (used != null) {
    const products = {};
    for (const p of cfg.productUsage || []) {
      if (p && p.product) products[p.product] = p.usagePercent;
    }
    return {
      kind: 'subscription-quota',
      provider: 'xai',
      account,
      remainingPct: round2(100 - Number(used)),
      usedPct: used,
      window: period.type || null,
      resetAt: period.end || cfg.billingPeriodEnd || null,
      products,
      // Every per-product row shares the account's billing period, so they all
      // carry the same reset. Leaving it empty made those rows look like they
      // never expire while the summary right above them showed a date.
      windows: toWindows(products, fillReset(products, period.end || cfg.billingPeriodEnd)),
      raw: { source: 'billing?format=credits', config: cfg },
    };
  }

  // ---- branch 2: allowance only visible in completion response headers
  const rl = await xaiRateLimits(cred.token, model);
  if (rl) {
    const ratios = [];
    if (rl.limit_tokens && rl.remaining_tokens != null) {
      ratios.push((rl.remaining_tokens / rl.limit_tokens) * 100);
    }
    if (rl.limit_requests && rl.remaining_requests != null) {
      ratios.push((rl.remaining_requests / rl.limit_requests) * 100);
    }
    if (ratios.length) {
      const remaining = round2(Math.min(...ratios));
      const products = {};
      if (rl.limit_requests) {
        products.requests = round2(100 - (rl.remaining_requests / rl.limit_requests) * 100);
      }
      if (rl.limit_tokens) {
        products.tokens = round2(100 - (rl.remaining_tokens / rl.limit_tokens) * 100);
      }
      return {
        kind: 'subscription-quota',
        provider: 'xai',
        account,
        remainingPct: remaining,
        usedPct: round2(100 - remaining),
        window: period.type || null,
        resetAt: period.end || cfg.billingPeriodEnd || null,
        products,
        windows: toWindows(products, fillReset(products, period.end || cfg.billingPeriodEnd)),
        detail: {
          tokens: `${rl.remaining_tokens}/${rl.limit_tokens}`,
          requests: `${rl.remaining_requests}/${rl.limit_requests}`,
        },
        raw: { source: 'x-ratelimit headers', rateLimits: rl },
      };
    }
  }

  // ---- branch 3: unified billing, no ceiling
  const spend = await getJson('https://cli-chat-proxy.grok.com/v1/billing', { token: cred.token });
  const scfg = (spend.ok && spend.data && spend.data.config) || {};
  return {
    kind: 'payg',
    provider: 'xai',
    account,
    label: 'metered',
    note: 'unified billing, no quota ceiling',
    remainingPct: null,
    usedPct: null,
    usedAmount: scfg.used && scfg.used.val,
    monthlyLimit: scfg.monthlyLimit && scfg.monthlyLimit.val,
    window: period.type || null,
    resetAt: period.end || scfg.billingPeriodEnd || null,
    products: {},
    raw: { source: 'billing', spend: scfg },
  };
}

/**
 * A one-token completion is the only endpoint that reports xAI's allowance.
 * The token cost is negligible next to the allowance it reveals.
 */
async function xaiRateLimits(token, model) {
  const probeModel = process.env.XAI_PROBE_MODEL
    || String(model || '').split('/').slice(-1)[0]
    || 'grok-4';
  const res = await curlJson(
    'https://api.x.ai/v1/chat/completions',
    {
      method: 'POST',
      token,
      body: { model: probeModel, messages: [{ role: 'user', content: '.' }], max_tokens: 1 },
      headers: { 'Content-Type': 'application/json' },
      captureHeaders: true,
      timeoutMs: 35000,
    },
  );
  if (!res || !res.headers) return null;
  const low = {};
  for (const [k, v] of Object.entries(res.headers)) low[String(k).toLowerCase()] = v;
  const num = (name) => {
    const v = low[name];
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const out = {
    limit_tokens: num('x-ratelimit-limit-tokens'),
    remaining_tokens: num('x-ratelimit-remaining-tokens'),
    limit_requests: num('x-ratelimit-limit-requests'),
    remaining_requests: num('x-ratelimit-remaining-requests'),
  };
  return Object.values(out).some((v) => v != null) ? out : null;
}

/* ------------------------------------------------------------------- codex */
/**
 * Codex quota, two sources — tried in this order:
 *
 *  1. CLIProxyAPI's management API. While proxying real traffic, CPA records
 *     the upstream `X-Codex-*` headers it observed. Reading them costs no
 *     upstream call and is immune to Cloudflare's challenge. This is the
 *     preferred route.
 *
 *  2. The /usage endpoint on chatgpt.com. It sits behind Cloudflare and needs a
 *     browser TLS fingerprint, which Node does not have — so this fallback
 *     often fails with 403. Kept because it works on networks without CPA.
 *
 * Neither path invents a number: if both fail the provider reports failure.
 */
const CPA_MGMT = process.env.CLI_PROXY_MGMT_URL || 'http://127.0.0.1:8317';
const cpaCircuit = { until: 0 };

function cpaMgmtKey() {
  // CLIProxyAPI writes its management key here on first start.
  const candidates = [
    path.join(HOME, 'dev', 'cli-proxy-api', '.mgmt-key'),
    path.join(HOME, '.cli-proxy-api', '.mgmt-key'),
  ];
  for (const p of candidates) {
    try {
      const v = fs.readFileSync(p, 'utf8').trim();
      if (v) return v;
    } catch { /* keep looking */ }
  }
  return null;
}

async function cpaCodexSignals() {
  const key = cpaMgmtKey();
  if (!key) return null;
  if (Date.now() < cpaCircuit.until) return null;

  const res = await getJson(`${CPA_MGMT}/v0/management/auth-files`, {
    headers: { 'X-Management-Key': key },
    timeoutMs: 8000,
  });
  if (!res.ok) {
    // CPA's management API stalls intermittently; back off instead of making
    // every codex refresh wait for a timeout.
    cpaCircuit.until = Date.now() + 120000;
    return null;
  }
  for (const f of (res.data && res.data.files) || []) {
    if (f.provider !== 'codex') continue;
    const quota = f.quota || {};
    const sig = quota.signals || {};
    if (sig['X-Codex-Primary-Used-Percent'] != null) {
      return { sig, name: f.name, observedAt: quota.observed_at || null };
    }
  }
  return null;
}

export async function codex() {
  // ---- route 1: CPA passive signals (no upstream call, CF-proof)
  const hit = await cpaCodexSignals();
  if (hit) {
    const num = (k) => {
      const v = Number(hit.sig[k]);
      return Number.isFinite(v) ? v : 0;
    };
    const prim = num('X-Codex-Primary-Used-Percent');
    const seco = num('X-Codex-Secondary-Used-Percent');
    const primReset = num('X-Codex-Primary-Reset-At');
    const secoReset = num('X-Codex-Secondary-Reset-At');

    // Label the primary window from how far out its reset is: a short window is
    // the 5h cap, a long one is the weekly cap.
    let primLabel = '5h';
    if (primReset) {
      const left = primReset - Math.floor(Date.now() / 1000);
      if (left > 86400) primLabel = 'weekly';
      else if (left > 0) primLabel = `${Math.max(1, Math.round(num('X-Codex-Primary-Window-Minutes') / 60))}h`;
    }
    const secoLabel = primLabel === 'weekly' ? 'weekly-2' : 'weekly';

    const products = {};
    products[primLabel] = prim;
    products[secoLabel] = seco;

    // The tighter window is what blocks the next request.
    const tightIsSeco = seco > prim;
    const tightUsed = tightIsSeco ? seco : prim;
    const tightReset = tightIsSeco ? secoReset : primReset;
    const window = tightIsSeco ? secoLabel : primLabel;

    return {
      kind: 'subscription-quota',
      provider: 'codex',
      account: String(hit.name || '').replace(/^codex-/, '').replace(/\.json$/, ''),
      remainingPct: round2(100 - tightUsed),
      usedPct: tightUsed,
      window,
      resetAt: tightReset ? new Date(tightReset * 1000).toISOString() : null,
      products,
      windows: toWindows(products, {
        [primLabel]: primReset ? new Date(primReset * 1000).toISOString() : null,
        [secoLabel]: secoReset ? new Date(secoReset * 1000).toISOString() : null,
      }),
      raw: { source: 'CLIProxyAPI observed headers', observedAt: hit.observedAt },
    };
  }

  // ---- route 2: chatgpt.com /usage (needs browser TLS; often 403 on Node)
  const files = usableFiles('codex');
  if (!files.length) return noCredential('codex', 'codex');
  const cred = files[0];

  const res = await curlJson('https://chatgpt.com/backend-api/codex/usage', {
    token: cred.token,
    headers: {
      Originator: CODEX_ORIGINATOR,
      'Chatgpt-Account-Id': cred.accountId || '',
      'User-Agent': 'codex_cli_rs/' + CODEX_CLI_VERSION,
    },
  });
  if (!res || !res.ok) {
    return {
      kind: 'probe-failed',
      provider: 'codex',
      error: (res && res.error) || 'usage request failed',
      hint: hasCliProxy()
        ? 'chatgpt.com blocks non-browser TLS. Start CLIProxyAPI so its observed headers can be read instead.'
        : 'needs CLIProxyAPI running for its observed headers',
    };
  }

  const data = res.data || {};
  const limit = data.rate_limit || {};
  const primary = limit.primary_window || {};
  const weekly = limit.secondary_window || {};

  const products = {};
  if (primary.used_percent != null) products['5h'] = primary.used_percent;
  if (weekly.used_percent != null) products.weekly = weekly.used_percent;

  const candidates = [primary, weekly].filter((w) => w && w.used_percent != null);
  const tight = candidates.length
    ? candidates.reduce((a, b) => (Number(a.used_percent) >= Number(b.used_percent) ? a : b))
    : {};
  const used = tight.used_percent;
  if (used == null) {
    return { kind: 'none', provider: 'codex', error: 'usage payload had no used_percent' };
  }
  return {
    kind: 'subscription-quota',
    provider: 'codex',
    account: cred.account || cred.name,
    remainingPct: round2(100 - Number(used)),
    usedPct: used,
    window: tight === primary ? '5h' : tight === weekly ? 'weekly' : null,
    resetAt: isoFromEpoch(tight.reset_at),
    products,
    windows: toWindows(products, {
      '5h': isoFromEpoch(primary.reset_at),
      weekly: isoFromEpoch(weekly.reset_at),
    }),
    raw: { source: 'chatgpt codex usage', planType: data.plan_type },
  };
}

/* --------------------------------------------------------------------- agy */
/**
 * Antigravity (Google Cloud Code) reports THREE independent quota families,
 * each with its own limits:
 *
 *   - Gemini models   - 5-hour + weekly buckets  ("Gemini Models" group)
 *   - Gemini 4 Argon  - its own weekly bucket    ("Gemini 4 Argon" group)
 *   - Claude / GPT    - 5-hour + weekly buckets  ("Claude and GPT models")
 *
 * The backend decides which catalogue AND which quota groups it reports from
 * the client label in the User-Agent. With a generic UA ("antigravity/1.0") it
 * serves a legacy catalogue: no gemini-4-argon-*, and every Gemini model comes
 * back with remainingFraction 1 and a resetTime that merely tracks "now + 5h"
 * - a permanent 100% that hides real usage. The Antigravity CLI's own UA
 * ("antigravity/cli/<version> (aidev_client; ...)") gets the real catalogue and
 * the real groups. Verified against the CLI's captured traffic on 2026-10-26
 * (same token: generic UA -> 23 models, no argon, no Gemini group; CLI UA ->
 * 29 models, argon at ~91%, three groups).
 *
 * Preferred source is retrieveUserQuotaSummary: one request, one group per
 * family, each with its buckets. Per-model fetchAvailableModels stays as a
 * fallback if that RPC changes shape.
 */
const AGY_CLI_UA = process.env.QUOTA_PILL_AGY_UA
  || 'antigravity/cli/1.4.7 (aidev_client; os_type=darwin; arch=arm64; cl=1006008713; auth_method=consumer)';
const AGY_PROJECT = { project: 'aicode-consumers' };

/**
 * One entry per quota family the pill shows. The key is the window key the
 * client renders; keep it stable - the label table and the spend history are
 * keyed by it.
 */
const AGY_FAMILIES = [
  { key: 'agy-gemini', label: 'Gemini' },
  { key: 'agy-argon', label: 'Gemini 4' },
  { key: 'agy-opus', label: 'Claude / Opus' },
];

/** Family a model id belongs to (decides which number is the headline one). */
function agyFamilyForModel(model) {
  // Model ids arrive bare from the all page and as provider/model on /quota.
  const id = String(model || '').split('/').pop();
  if (/argon/i.test(id)) return 'agy-argon';
  if (/^(claude|gpt)/i.test(id)) return 'agy-opus';
  if (/gemini/i.test(id)) return 'agy-gemini';
  return null;
}

/** Family a quota-summary group belongs to. */
function agyFamilyForGroup(name) {
  const n = String(name || '');
  if (/argon/i.test(n)) return 'agy-argon';
  if (/claude|gpt/i.test(n)) return 'agy-opus';
  if (/gemini/i.test(n)) return 'agy-gemini';
  return null;
}

/**
 * Collapse quota-summary groups into one reading per family. The tightest
 * bucket decides the percentage (a 5-hour bucket at 0 blocks even when the
 * weekly one still has 46%), and that bucket's reset is what the user can act
 * on.
 */
function agyFamiliesFromSummary(data) {
  const out = new Map();
  for (const group of (data && data.groups) || []) {
    const key = agyFamilyForGroup(group && group.displayName);
    if (!key) continue;
    const fam = AGY_FAMILIES.find((f) => f.key === key);
    let frac = null;
    let resetAt = null;
    const buckets = [];
    for (const b of (group && group.buckets) || []) {
      const v = b && b.remainingFraction;
      if (typeof v !== 'number') continue;
      buckets.push({ id: b.bucketId || null, window: b.window || null, frac: v, resetAt: b.resetTime || null });
      if (frac === null || v < frac) {
        frac = v;
        resetAt = b.resetTime || resetAt;
      }
    }
    if (frac === null) continue;
    out.set(key, { key, label: fam.label, frac, resetAt, buckets });
  }
  return out;
}

/** Fallback: collapse per-model buckets into one reading per family. */
function agyFamiliesFromModels(models) {
  const out = new Map();
  for (const [mid, info] of Object.entries(models || {})) {
    const key = agyFamilyForModel(mid);
    if (!key) continue;
    const q = (info && info.quotaInfo) || {};
    const frac = q.remainingFraction;
    if (typeof frac !== 'number') continue;
    const fam = AGY_FAMILIES.find((f) => f.key === key);
    const cur = out.get(key) || { key, label: fam.label, frac: 1, resetAt: null, buckets: [] };
    cur.buckets.push({ id: mid, window: null, frac, resetAt: q.resetTime || null });
    if (frac < cur.frac) {
      cur.frac = frac;
      cur.resetAt = q.resetTime || cur.resetAt;
    } else if (!cur.resetAt && q.resetTime) {
      cur.resetAt = q.resetTime;
    }
    out.set(key, cur);
  }
  return out;
}

/** Shape one adapter payload from the families that were actually reported. */
function agyPayload(cred, fams, model, source) {
  const wanted = agyFamilyForModel(model);
  // Headline: the family the current model uses. Without a model (the all
  // page) Gemini leads, which is also the number quota failover tools compare
  // against - do not change that silently.
  const primary = (wanted && fams.get(wanted))
    || fams.get('agy-gemini')
    || fams.values().next().value;
  const remaining = round2(primary.frac * 100);
  const windows = AGY_FAMILIES
    .filter((f) => fams.has(f.key))
    .map((f) => {
      const v = fams.get(f.key);
      return { key: v.key, remainPct: round2(v.frac * 100), resetAt: v.resetAt || null };
    });
  return {
    kind: 'subscription-quota',
    provider: 'agy',
    account: cred.account || cred.name,
    remainingPct: remaining,
    usedPct: round2(100 - remaining),
    window: primary.key,
    resetAt: primary.resetAt || null,
    windows,
    raw: {
      source,
      families: Object.fromEntries([...fams].map(([k, v]) => [k, {
        remainPct: round2(v.frac * 100),
        resetAt: v.resetAt || null,
        buckets: v.buckets,
      }])),
    },
  };
}

/**
 * Read one Antigravity login. Both endpoints need the CLI User-Agent - see the
 * comment above: without it the backend answers from a legacy catalogue whose
 * Gemini quota is a permanent 100%.
 */
async function agyReading(cred, model, errors) {
  const post = (url) => curlJson(url, {
    method: 'POST',
    // googleapis is unreachable directly on some networks; CLIProxyAPI users
    // almost always have a local proxy configured.
    proxy: process.env.QUOTA_PILL_PROXY || defaultProxy(),
    token: cred.token,
    body: AGY_PROJECT,
    headers: { 'Content-Type': 'application/json', 'User-Agent': AGY_CLI_UA },
    timeoutMs: 25000,
  });

  const summary = await post('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary');
  if (summary && summary.ok) {
    const fams = agyFamiliesFromSummary(summary.data);
    if (fams.size) return agyPayload(cred, fams, model, 'v1internal:retrieveUserQuotaSummary');
    errors.push(cred.name + ': retrieveUserQuotaSummary had no known groups');
  } else {
    errors.push(cred.name + ': retrieveUserQuotaSummary ' + ((summary && summary.error) || 'request failed'));
  }

  const available = await post('https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels');
  if (!available || !available.ok) {
    errors.push(cred.name + ': ' + ((available && available.error) || 'request failed'));
    return null;
  }
  const fams = agyFamiliesFromModels((available.data && available.data.models) || {});
  if (!fams.size) {
    errors.push(cred.name + ': fetchAvailableModels had no quotaInfo');
    return null;
  }
  return agyPayload(cred, fams, model, 'v1internal:fetchAvailableModels');
}

export async function agy(model) {
  const usable = usableFiles('antigravity');
  if (!usable.length) return noCredential('agy', 'antigravity');

  const errors = [];
  let best = null;
  for (const cred of usable) {
    const reading = await agyReading(cred, model, errors);
    if (!reading) continue;
    // Several antigravity logins: report the one with the most headroom in its
    // tightest family, so a half-spent account cannot mask a full one.
    const tightest = Math.min(...reading.windows.map((w) => w.remainPct));
    if (!best || tightest > best.tightest) best = { reading, tightest };
  }

  if (best) {
    if (usable.length > 1) {
      best.reading.raw = { ...best.reading.raw, accounts: usable.length };
    }
    return best.reading;
  }
  return { kind: 'probe-failed', provider: 'agy', error: errors.join('; ') || 'no quota' };
}

/* ------------------------------------------------------- curl helper (JSON) */
/**
 * curl with optional response-header capture and a JSON body.
 * Kept here rather than http.js because only these OAuth upstreams need it.
 */
function curlJson(url, opts = {}) {
  const {
    method = 'GET',
    token,
    body,
    headers = {},
    captureHeaders = false,
    timeoutMs = 20000,
    proxy,
  } = opts;

  const args = [
    '-sS',
    '--max-time', String(Math.ceil(timeoutMs / 1000)),
    '-X', method,
  ];
  const useProxy = proxy || process.env.QUOTA_PILL_PROXY;
  if (useProxy) args.push('--proxy', useProxy);
  else args.push('--noproxy', '*');
  if (token) args.push('-H', 'Authorization: Bearer ' + token);
  args.push('-H', 'Accept: application/json');
  for (const [k, v] of Object.entries(headers)) {
    if (v != null && v !== '') args.push('-H', `${k}: ${v}`);
  }
  if (body !== undefined) args.push('--data-binary', JSON.stringify(body));
  if (captureHeaders) args.push('-D', '-');
  args.push('-w', '\n%{http_code}');
  args.push(url);

  return new Promise((resolve) => {
    // execFile keeps the request out of a shell, so no quoting issues.
    import('node:child_process').then(({ execFile }) => {
      execFile('curl', args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) return resolve({ ok: false, error: String(err.message || err) });
        const text = String(stdout || '');
        const cut = text.lastIndexOf('\n');
        if (cut < 0) return resolve({ ok: false, error: 'empty response' });
        const status = Number(text.slice(cut + 1).trim());
        let head = text.slice(0, cut);

        // When -D - is used, the header block precedes the body.
        const parsedHeaders = {};
        if (captureHeaders) {
          const split = head.indexOf('\r\n\r\n');
          const splitLf = head.indexOf('\n\n');
          const idx = split >= 0 ? split : splitLf;
          if (idx >= 0) {
            const rawHead = head.slice(0, idx);
            head = head.slice(idx).replace(/^(\r?\n)+/, '');
            for (const line of rawHead.split(/\r?\n/)) {
              const m = /^([^:]+):\s*(.*)$/.exec(line);
              if (m && !line.startsWith('HTTP/')) parsedHeaders[m[1].trim()] = m[2].trim();
            }
          }
        }

        if (status < 200 || status >= 300) {
          return resolve({ ok: false, status, headers: parsedHeaders, error: `http ${status}: ${head.slice(0, 160)}` });
        }
        try {
          resolve({ ok: true, status, headers: parsedHeaders, data: JSON.parse(head) });
        } catch {
          resolve({ ok: false, status, headers: parsedHeaders, error: 'unparsable json: ' + head.slice(0, 120) });
        }
      });
    });
  });
}
