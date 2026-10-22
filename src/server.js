#!/usr/bin/env node
/**
 * quota-pill sidecar.
 *
 * A tiny local HTTP service that reads "how much quota is left" from each LLM
 * subscription and hands the result to the DSH web GUI as JSON.
 *
 * Why a separate process instead of doing it inside the client plugin:
 *   · credentials live on disk and must never be shipped to the browser
 *   · upstream calls need a real TLS stack and generous timeouts
 *   · results are cached across sessions
 *
 * Endpoints
 *   GET /health                → {ok:true, providers:[...]}
 *   GET /quota?model=<id>      → one provider's reading (model picks the provider)
 *   GET /quota/all            → every provider, concurrently
 *   GET /setup                → what each provider still needs (for AGENTS.md flow)
 *
 * Every response includes `cached` and `at` so the client can tell a live
 * reading from a cached one.
 */
import http from 'node:http';
import { kimi, opencode, commandcode } from './adapters-apikey.js';
import { xai, codex, agy } from './adapters-cliproxy.js';
import { deepseek } from './adapters-deepseek.js';
import { credentialSource, hasCliProxy, CLI_PROXY_DIR, CREDENTIALS_FILE } from './credentials.js';
import { catalogProviderIds } from './catalog.js';
import { opendesign } from './adapters-opendesign.js';
import { providerForModel, inCatalog } from './providers.js';

const PORT = Number(process.env.QUOTA_PILL_PORT || 8319);
const HOST = process.env.QUOTA_PILL_HOST || '127.0.0.1';
const CACHE_TTL_MS = Number(process.env.QUOTA_PILL_CACHE_TTL || 60) * 1000;

// Order matters: the pill lists providers in this order, and the official
// DeepSeek account is the one most people look for first.
const ADAPTERS = { deepseek, kimi, opencode, commandcode, xai, codex, agy, opendesign };

/** Display names. Deliberately small: the table stays in sync with ADAPTERS. */
const DISPLAY_NAMES = {
  deepseek: 'DeepSeek',
  kimi: 'Kimi Coding',
  opencode: 'OpenCode Go',
  commandcode: 'Command Code',
  xai: 'xAI (Grok)',
  codex: 'Codex (ChatGPT Plus)',
  agy: 'Antigravity',
  opendesign: 'Open Design',
};

/** provider|model → { at, payload }. Keyed by model because readings differ per model. */
const cache = new Map();

async function readOne(provider, model, { fresh = false } = {}) {
  const fn = ADAPTERS[provider];
  if (!fn) return { kind: 'none', provider, error: `no adapter for '${provider}'` };

  const key = `${provider}|${model || ''}`;
  const hit = cache.get(key);
  const now = Date.now();
  if (!fresh && hit && now - hit.at < CACHE_TTL_MS) {
    return { ...hit.payload, cached: true, at: hit.at };
  }

  let payload;
  try {
    payload = await fn(model);
  } catch (e) {
    payload = { kind: 'probe-failed', provider, error: String((e && e.message) || e) };
  }
  if (!payload || typeof payload !== 'object') {
    payload = { kind: 'none', provider, error: 'adapter returned nothing' };
  }
  payload.displayName = DISPLAY_NAMES[provider] || provider;
  payload.provider = payload.provider || provider;

  cache.set(key, { at: now, payload });
  return { ...payload, cached: false, at: now };
}

/**
 * Every provider worth showing: present in DSH's catalog AND actually readable.
 *
 * Two filters, for two different complaints:
 *   · catalog — a provider removed from DSH must disappear from the pill, even
 *     though its adapter still exists in this package
 *   · kind 'none' — a provider with no credential has nothing to show; listing
 *     it as "no data source" is noise, and new users mistake it for breakage
 *
 * `probe-failed` deliberately still shows: the provider *is* configured, so a
 * failure is information the user needs.
 */
async function readAll({ fresh = false } = {}) {
  const ids = await catalogProviderIds();
  const wanted = Object.keys(ADAPTERS).filter((p) => inCatalog(p, ids));

  const entries = await Promise.all(
    wanted.map(async (p) => [p, await readOne(p, null, { fresh })]),
  );
  return Object.fromEntries(
    entries.filter(([, v]) => v && v.kind !== 'none'),
  );
}

/** What is configured and what is missing — powers the agent-driven setup. */
/** Human-readable "what this provider still needs" for /setup and AGENTS.md. */
function requiresText(src) {
  if (src.kind === 'cli-proxy') return 'CLIProxyAPI + OAuth login';
  if (src.kind === 'dsh-account') return 'DSH Platform sign-in (nothing to add)';
  const refs = (src.refs && src.refs.length) ? src.refs : (src.ref ? [src.ref] : []);
  if (!refs.length) return 'no credential source';
  const named = refs.map((r) => `refs.${r}`).join(' or ');
  if (src.kind === 'control-key') {
    const ws = (src.workspaceRefs || []).map((r) => `refs.${r}`).join(' or ')
      || 'an explicit workspace ref (optional: resolved from /workspaces/current)';
    const cookie = src.cookieRef ? ` or console cookie refs.${src.cookieRef}` : '';
    return `~/.dsh/.credentials.yaml → ${named} + ${ws}${cookie}`;
  }
  const suffix = src.kind === 'session-cookie' ? ' (console session cookie)' : '';
  return `~/.dsh/.credentials.yaml → ${named}${suffix}`;
}

function describeSetup() {
  const providers = Object.keys(ADAPTERS).map((p) => {
    const src = credentialSource(p);
    return {
      provider: p,
      name: DISPLAY_NAMES[p] || p,
      requires: requiresText(src),
      credential: src,
    };
  });
  return {
    ok: true,
    credentialsFile: CREDENTIALS_FILE,
    cliProxy: { dir: CLI_PROXY_DIR, present: hasCliProxy() },
    providers,
  };
}

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(text);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const fresh = url.searchParams.get('fresh') === '1';

  try {
    if (url.pathname === '/health') {
      return json(res, 200, { ok: true, port: PORT, providers: Object.keys(ADAPTERS) });
    }
    if (url.pathname === '/setup') {
      return json(res, 200, describeSetup());
    }
    if (url.pathname === '/quota/all') {
      const all = await readAll({ fresh });
      return json(res, 200, all);
    }
    if (url.pathname === '/quota') {
      const model = url.searchParams.get('model') || '';
      const provider = providerForModel(model);
      if (!provider) {
        return json(res, 200, {
          kind: 'none',
          provider: 'unknown',
          model,
          error: `no adapter matches model '${model}'`,
        });
      }
      const out = await readOne(provider, model, { fresh });
      return json(res, 200, out);
    }
    return json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    return json(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});

server.listen(PORT, HOST, () => {
  process.stdout.write(
    `[quota-pill] listening on http://${HOST}:${PORT}\n`
    + `[quota-pill] credentials: ${CREDENTIALS_FILE}\n`
    + `[quota-pill] CLIProxyAPI: ${hasCliProxy() ? CLI_PROXY_DIR : 'not set up (xai/codex/agy will be skipped)'}\n`,
  );
});
