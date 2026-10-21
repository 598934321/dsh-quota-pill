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
import { credentialSource, hasCliProxy, CLI_PROXY_DIR, CREDENTIALS_FILE } from './credentials.js';

const PORT = Number(process.env.QUOTA_PILL_PORT || 8319);
const HOST = process.env.QUOTA_PILL_HOST || '127.0.0.1';
const CACHE_TTL_MS = Number(process.env.QUOTA_PILL_CACHE_TTL || 60) * 1000;

const ADAPTERS = { kimi, opencode, commandcode, xai, codex, agy };

/** Display names. Deliberately small: the table stays in sync with ADAPTERS. */
const DISPLAY_NAMES = {
  kimi: 'Kimi Coding',
  opencode: 'OpenCode Go',
  commandcode: 'Command Code',
  xai: 'xAI (Grok)',
  codex: 'Codex (ChatGPT Plus)',
  agy: 'Antigravity',
};

/** Which DSH model prefixes map to which adapter. */
const PREFIX_ALIASES = {
  'kimi-coding': 'kimi',
  kimi: 'kimi',
  'opencode-go': 'opencode',
  opencode: 'opencode',
  commandcode: 'commandcode',
  'command-code': 'commandcode',
  xai: 'xai',
  codex: 'codex',
  antigravity: 'agy',
  agy: 'agy',
};

/** provider|model → { at, payload }. Keyed by model because readings differ per model. */
const cache = new Map();

function providerForModel(model) {
  const m = String(model || '').toLowerCase();
  const prefix = m.split('/')[0];
  if (PREFIX_ALIASES[prefix]) return PREFIX_ALIASES[prefix];
  // Fuzzy fallbacks for models whose prefix is not the provider id.
  if (m.includes('grok')) return 'xai';
  if (m.includes('codex') || m.startsWith('gpt-')) return 'codex';
  if (m.includes('gemini')) return 'agy';
  if (m.startsWith('k3') || m.startsWith('kimi')) return 'kimi';
  return '';
}

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

async function readAll({ fresh = false } = {}) {
  const entries = await Promise.all(
    Object.keys(ADAPTERS).map(async (p) => [p, await readOne(p, null, { fresh })]),
  );
  return Object.fromEntries(entries);
}

/** What is configured and what is missing — powers the agent-driven setup. */
function describeSetup() {
  const providers = Object.keys(ADAPTERS).map((p) => {
    const src = credentialSource(p);
    return {
      provider: p,
      name: DISPLAY_NAMES[p] || p,
      requires: src.kind === 'cli-proxy' ? 'CLIProxyAPI + OAuth login' : `~/.dsh/.credentials.yaml → refs.${src.ref}`,
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
