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
 * Antigravity (Google Cloud Code) — all Gemini models share ONE pool.
 *
 * That is why this adapter deliberately reports no per-model rows: all 22
 * remainingFraction values are identical, so picking "the tightest" would just
 * be "first in dict order" and the label would flicker between model names that
 * are not even what the user has configured. The pool total is real, so only
 * the aggregate is reported.
 */
export async function agy() {
  const usable = usableFiles('antigravity');
  if (!usable.length) return noCredential('agy', 'antigravity');

  const errors = [];
  let best = null;

  for (const cred of usable) {
    const res = await curlJson(
      'https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels',
      {
        method: 'POST',
        // googleapis is unreachable directly on some networks; CLIProxyAPI
        // users almost always have a local proxy configured.
        proxy: process.env.QUOTA_PILL_PROXY || defaultProxy(),
        token: cred.token,
        body: {},
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'antigravity/1.0' },
        timeoutMs: 25000,
      },
    );
    if (!res || !res.ok) {
      errors.push(`${cred.name}: ${(res && res.error) || 'request failed'}`);
      continue;
    }
    const models = (res.data && res.data.models) || {};
    const fractions = [];
    for (const [mid, info] of Object.entries(models)) {
      const q = (info && info.quotaInfo) || {};
      const frac = q.remainingFraction;
      if (typeof frac === 'number') fractions.push([mid, frac, q.resetTime]);
    }
    if (!fractions.length) {
      errors.push(cred.name + ': no quotaInfo');
      continue;
    }
    fractions.sort((a, b) => a[1] - b[1]);
    const [sampleModel, frac, reset] = fractions[0];
    const remaining = round2(frac * 100);
    const candidate = {
      kind: 'subscription-quota',
      provider: 'agy',
      account: cred.account || cred.name,
      remainingPct: remaining,
      usedPct: round2(100 - remaining),
      window: 'model-pool',
      resetAt: reset || null,
      raw: { accounts: usable.length, poolModels: fractions.length, sampleModel },
    };
    if (!best || candidate.remainingPct > best.remainingPct) best = candidate;
  }

  if (best) return best;
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
