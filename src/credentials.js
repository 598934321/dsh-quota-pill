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

/** Read one DSH credential ref. Returns null when absent. */
export function readRef(name) {
  try {
    const text = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
    const doc = parseCredentialsYaml(text);
    const refs = doc.refs || {};
    const v = refs[name];
    return typeof v === 'string' && v ? v : null;
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
    return { kind: 'cli-proxy', dir: CLI_PROXY_DIR, ref: null };
  }
  const refByProvider = {
    kimi: 'KIMI_CODING_API_KEY',
    commandcode: 'COMMANDCODE_API_KEY',
    opencode: 'OPENCODE_GO_API_KEY',
  };
  return { kind: 'api-key', dir: null, ref: refByProvider[provider] || null };
}
