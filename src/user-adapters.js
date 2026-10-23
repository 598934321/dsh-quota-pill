/**
 * User-contributed provider adapters.
 *
 * The package only ships eight built-ins. A DSH user can add a provider the
 * built-ins do not know (and an agent can do it for them) by dropping a module
 * in:
 *
 *   ~/.dsh/quota-pill/adapters/<provider>.mjs
 *
 * That directory is OUTSIDE the npm package, so updating/reinstalling the plugin
 * never overwrites it. The sidecar discovers it on every request (mtime check),
 * so adding a file and pressing Refresh is enough — no restart.
 *
 * Contract (all exports optional except provider/read):
 *
 *   export const provider = 'myprovider';
 *   export const catalogIds = ['myprovider-go'];   // DSH catalog/model ids
 *   export const displayName = 'My Provider';
 *   export const credential = { kind: 'api-key', refs: ['MYPROVIDER_API_KEY'] };
 *   export async function read(ctx) {
 *     // ctx.model, ctx.readRef, ctx.readFirstRef, ctx.getJson,
 *     // ctx.getJsonViaCurl, ctx.postJsonViaCurl, ctx.env, ctx.dshHome
 *     return { kind: 'subscription-quota', remainingPct: 42, window: '5h', ... };
 *   }
 *
 * The result must use the same kinds as the built-in adapters
 * (subscription-quota / payg / usage-only / none / probe-failed). Never invent
 * a number: if the provider has no quota API, say so in `error`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DSH_DIR,
  readRef,
  readFirstRef,
  registerCredentialSource,
  clearUserCredentialSources,
} from './credentials.js';
import { getJson, getJsonViaCurl, postJsonViaCurl } from './http.js';
import { clearUserProviders, registerUserProvider } from './providers.js';

export const USER_ADAPTER_DIR = process.env.QUOTA_PILL_USER_ADAPTER_DIR
  || path.join(DSH_DIR, 'quota-pill', 'adapters');

let current = { dir: USER_ADAPTER_DIR, adapters: [], errors: [], loadedAt: 0, signature: '' };

function signatureOf(dir) {
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter((f) => /\.(mjs|js)$/i.test(f) && !f.endsWith('.test.mjs'))
      .sort();
  } catch {
    return { files: [], sig: dir + '|missing' };
  }
  const parts = [];
  for (const f of files) {
    try {
      const s = fs.statSync(path.join(dir, f));
      parts.push(f + ':' + s.mtimeMs + ':' + s.size);
    } catch {
      parts.push(f + ':missing');
    }
  }
  return { files, sig: dir + '|' + parts.join('|') };
}

function normalizeCredential(raw, provider) {
  if (raw && typeof raw === 'object') {
    return {
      kind: raw.kind || 'user-adapter',
      refs: Array.isArray(raw.refs) ? raw.refs : (raw.ref ? [raw.ref] : []),
      ref: raw.ref || (Array.isArray(raw.refs) ? raw.refs[0] : null) || null,
      requires: raw.requires || null,
      ...raw,
    };
  }
  return {
    kind: 'user-adapter',
    refs: [],
    ref: null,
    requires: 'credentials defined by the user adapter ' + provider,
  };
}

async function importAdapter(full, stat) {
  // The mtime/size query busts Node's ESM cache, so editing an adapter and
  // refreshing really reloads it instead of serving the first version.
  const href = pathToFileURL(full).href + '?v=' + encodeURIComponent(stat.mtimeMs + '-' + stat.size);
  const mod = await import(href);
  const spec = (mod && mod.default && typeof mod.default === 'object') ? { ...mod.default, ...mod } : mod;
  const fallback = path.basename(full, path.extname(full));
  const provider = String(spec.provider || fallback).trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(provider)) {
    throw new Error('invalid provider id: ' + JSON.stringify(provider));
  }
  if (typeof spec.read !== 'function') throw new Error('adapter must export an async read(ctx) function');
  return {
    provider,
    read: spec.read,
    displayName: spec.displayName ? String(spec.displayName) : provider,
    catalogIds: Array.isArray(spec.catalogIds) ? spec.catalogIds.map(String).filter(Boolean) : [provider],
    prefixes: Array.isArray(spec.prefixes) ? spec.prefixes.map(String).filter(Boolean) : [],
    credential: normalizeCredential(spec.credential, provider),
    file: full,
  };
}

/** Load/reload user adapters. Cheap when the directory has not changed. */
export async function loadUserAdapters({ force = false, dir = USER_ADAPTER_DIR } = {}) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // read-only home: scan whatever exists, /setup will show the error
  }
  const { files, sig } = signatureOf(dir);
  if (!force && sig === current.signature) return current;

  // Rebuild registrations from scratch so a deleted file also unregisters its
  // provider instead of leaving a stale adapter/mapping behind.
  clearUserProviders();
  clearUserCredentialSources();

  const adapters = [];
  const errors = [];
  for (const file of files) {
    const full = path.join(dir, file);
    try {
      const stat = fs.statSync(full);
      const adapter = await importAdapter(full, stat);
      adapters.push(adapter);
      registerUserProvider(adapter);
      registerCredentialSource(adapter.provider, adapter.credential);
    } catch (e) {
      errors.push({ file, error: String((e && e.message) || e) });
    }
  }

  current = { dir, adapters, errors, loadedAt: Date.now(), signature: sig };
  return current;
}

export function userAdapterProviders() {
  return current.adapters.map((a) => a.provider);
}

export function userAdapterFor(provider) {
  return current.adapters.find((a) => a.provider === provider) || null;
}

export function userAdaptersInfo() {
  return {
    dir: current.dir,
    providers: current.adapters.map((a) => ({ provider: a.provider, displayName: a.displayName, file: a.file })),
    errors: current.errors,
  };
}

/** Context passed to a user adapter's read(ctx). */
export function adapterContext(model) {
  return {
    model,
    readRef,
    readFirstRef,
    getJson,
    getJsonViaCurl,
    postJsonViaCurl,
    env: process.env,
    dshHome: DSH_DIR,
  };
}
