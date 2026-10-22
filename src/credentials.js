/**
 * Credential discovery.
 *
 * Two completely different sources, because the providers themselves differ:
 *
 *   1. DSH credential refs  (~/.dsh/.credentials.yaml → refs.<NAME>)
 *      Used by providers that authenticate with a plain API key.
 *
 *   2. CLIProxyAPI OAuth files  (~/.cli-proxy-api/<provider>-<account>.json)
 *      Used by providers that authenticate through a browser OAuth flow. The
 *      files are written by CLIProxyAPI, not by us — we only read them. If the
 *      user has never installed CLIProxyAPI these simply do not exist, and the
 *      provider reports "not configured" instead of pretending to be empty.
 *
 * Nothing here writes to disk. All reading is best-effort and never throws.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
export const DSH_DIR = process.env.DSH_HOME || path.join(HOME, '.dsh');
export const CREDENTIALS_FILE = path.join(DSH_DIR, '.credentials.yaml');
export const CLI_PROXY_DIR = process.env.CLI_PROXY_API_DIR || path.join(HOME, '.cli-proxy-api');

/**
 * Minimal reader for the subset of YAML that .credentials.yaml actually uses:
 *
 *   records:
 *     client-connection/browser-session:
 *       payload: {secret: "..."}
 *   refs:
 *     SOME_API_KEY: sk-xxxx
 *     QUOTED_KEY: "sk yyy"
 *
 * A full YAML parser would pull in a dependency for one file. This handles
 * nested maps, quoted/unquoted scalars and comments — and returns {} on
 * anything it does not understand, so a malformed file degrades to
 * "no credentials" instead of crashing the sidecar.
 */
export function parseCredentialsYaml(text) {
  const out = {};
  const stack = [{ indent: -1, obj: out }];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indent = rawLine.length - rawLine.replace(/^\s+/, '').length;
    const line = rawLine.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;

    const m = /^([^:]+?):\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].trim().replace(/^["']|["']$/g, '');
    let value = m[2].trim();

    if (value === '') {
      const child = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
      continue;
    }
    // Inline flow map: {secret: "..."}
    if (value.startsWith('{') && value.endsWith('}')) {
      const inner = {};
      for (const part of value.slice(1, -1).split(',')) {
        const kv = /^\s*([^:]+?):\s*(.*)$/.exec(part);
        if (kv) inner[kv[1].trim()] = unquote(kv[2].trim());
      }
      parent[key] = inner;
      continue;
    }
    parent[key] = unquote(value);
  }
  return out;
}

function unquote(v) {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

/** Pick the first present, non-empty ref from an ordered list. */
export function pickFirstRef(refs, names) {
  for (const name of names || []) {
    const v = refs && refs[name];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

/** Read one DSH credential ref. Returns null when absent. */
export function readRef(name) {
  return readFirstRef([name]);
}

/**
 * Read the first of several acceptable credential refs.
 *
 * DSH names a provider's key after its configured `apiKeyEnv` (for example
 * `COMMANDCODE_GOAT_API_KEY`), while older docs and other setups used the
 * short provider name. Accepting both keeps a key the user already has
 * visible instead of reporting the provider as unconfigured.
 */
export function readFirstRef(names) {
  try {
    const text = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
    const doc = parseCredentialsYaml(text);
    return pickFirstRef(doc.refs || {}, names);
  } catch {
    return null;
  }
}

/**
 * Read CLIProxyAPI OAuth token files for one provider prefix.
 * Returns [{ name, token, account, accountId, disabled }] newest first.
 */
export function readAuthFiles(prefix) {
  let entries;
  try {
    entries = fs.readdirSync(CLI_PROXY_DIR);
  } catch {
    return [];
  }
  const out = [];
  for (const file of entries) {
    if (!file.startsWith(prefix + '-') || !file.endsWith('.json')) continue;
    const full = path.join(CLI_PROXY_DIR, file);
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      continue;
    }
    if (!doc || typeof doc !== 'object') continue;
    out.push({
      name: file,
      file: full,
      token: doc.access_token || null,
      account: doc.email || doc.sub || file.replace(prefix + '-', '').replace('.json', ''),
      accountId: doc.account_id || null,
      disabled: !!doc.disabled,
      expired: !!doc.expired,
      mtime: safeMtime(full),
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

function safeMtime(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}

/** True when CLIProxyAPI's directory exists at all — used for user-facing hints. */
export function hasCliProxy() {
  try {
    return fs.statSync(CLI_PROXY_DIR).isDirectory();
  } catch {
    return false;
  }
}

/** Where a given provider's credentials come from, for the setup docs / AGENTS.md. */
export function credentialSource(provider) {
  if (provider === 'xai' || provider === 'codex' || provider === 'agy') {
    return { kind: 'cli-proxy', dir: CLI_PROXY_DIR, ref: null, refs: [] };
  }
  if (provider === 'deepseek') {
    // The official account is read through DSH's own Platform sign-in; there is
    // no credential the user can add to this file.
    return { kind: 'dsh-account', dir: null, ref: null, refs: [] };
  }
  if (provider === 'opendesign') {
    // The quota control plane authenticates with a Control Key (vela_ctrl_…);
    // a console session cookie is a fallback. The inference sk-amr-… key is a
    // different credential and cannot read it.
    return {
      kind: 'control-key',
      dir: null,
      ref: 'OPENDESIGN_CONTROL_KEY',
      refs: ['OPENDESIGN_CONTROL_KEY', 'VELA_CONTROL_KEY'],
      workspaceRefs: ['OPENDESIGN_WORKSPACE_ID', 'VELA_WORKSPACE_ID'],
      cookieRef: 'OPENDESIGN_SESSION_COOKIE',
    };
  }
  const refsByProvider = {
    kimi: ['KIMI_CODING_API_KEY'],
    commandcode: ['COMMANDCODE_API_KEY', 'COMMANDCODE_GOAT_API_KEY'],
    opencode: ['OPENCODE_GO_API_KEY'],
  };
  const refs = refsByProvider[provider] || [];
  return { kind: 'api-key', dir: null, ref: refs[0] || null, refs };
}

/**
 * Read a `records` entry (grants and session material live here, not in refs).
 * Returns the record's payload object, or null.
 */
export function readRecord(name) {
  try {
    const doc = parseCredentialsYaml(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
    const rec = (doc.records || {})[name];
    return rec && rec.payload ? rec.payload : null;
  } catch {
    return null;
  }
}

/**
 * The DeepSeek Platform grant.
 *
 * Note this is NOT an api.deepseek.com API key — it is a Platform login grant,
 * used as an `x-dsh-auth-token` header against platform.deepseek.com. Sending it
 * to api.deepseek.com fails with 401 (verified), so the balance must be read
 * through DSH's own account/getBalance RPC.
 */
export function deepseekGrant() {
  const p = readRecord('deepseek-account-platform/default');
  if (!p || typeof p.token !== 'string' || !p.token) return null;
  return { token: p.token, issuer: p.issuer || 'https://platform.deepseek.com' };
}

/** The browser-session secret, used to sign DSH RPC cookies. */
export function browserSessionSecret() {
  const p = readRecord('client-connection/browser-session');
  if (!p || typeof p.secret !== 'string' || !p.secret) return null;
  return p.secret;
}
