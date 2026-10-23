/**
 * Adapter keys ↔ DSH provider/model ids.
 *
 * Two different namespaces meet here:
 *   · DSH names providers after the upstream or the user's provider config
 *     (`grok`, `commandcode-goat`, `opendesign-go`, `deepseek-account`,
 *     `opencode-go`), and models carry that id as their prefix;
 *   · adapters in this package use short historical keys (`xai`, `commandcode`,
 *     `opendesign`, `deepseek`, `opencode`).
 *
 * A missing alias is invisible in the worst way: the provider is configured and
 * readable, but the catalog filter drops it before any adapter runs. Keep these
 * maps in one place and test them against a real catalog shape.
 */

/** Which DSH model prefixes map to which adapter. */
export const PREFIX_ALIASES = {
  'kimi-coding': 'kimi',
  kimi: 'kimi',
  'opencode-go': 'opencode',
  opencode: 'opencode',
  commandcode: 'commandcode',
  'command-code': 'commandcode',
  'commandcode-goat': 'commandcode',
  xai: 'xai',
  grok: 'xai',
  codex: 'codex',
  antigravity: 'agy',
  agy: 'agy',
  deepseek: 'deepseek',
  'deepseek-account': 'deepseek',
  opendesign: 'opendesign',
  'opendesign-go': 'opendesign',
};

/**
 * Which DSH catalog ids count as "this adapter".
 *
 * DSH names providers after the upstream (`antigravity`, `deepseek-account`,
 * `opencode-go`); the adapters use the short keys the pill has always used.
 */
export const CATALOG_ALIASES = {
  agy: ['antigravity', 'agy'],
  deepseek: ['deepseek-account', 'deepseek'],
  opencode: ['opencode-go', 'opencode'],
  kimi: ['kimi-coding', 'kimi'],
  // DSH ids follow the upstream/provider config name, not the short adapter
  // key. Missing one of these hides a provider the user actually configured:
  // grok (xAI), commandcode-goat (Command Code), opendesign-go (Open Design).
  xai: ['xai', 'grok'],
  codex: ['codex'],
  commandcode: ['commandcode', 'commandcode-goat', 'command-code'],
  opendesign: ['opendesign', 'opendesign-go'],
};

/**
 * Providers contributed by the user's own adapters (~/.dsh/quota-pill/adapters).
 * Kept separate from the built-in maps so a package update can re-register them
 * from disk without ever rewriting the user's files.
 */
export const USER_PREFIX_ALIASES = {};
export const USER_CATALOG_ALIASES = {};
export const USER_DISPLAY_NAMES = {};

export function clearUserProviders() {
  for (const key of Object.keys(USER_PREFIX_ALIASES)) delete USER_PREFIX_ALIASES[key];
  for (const key of Object.keys(USER_CATALOG_ALIASES)) delete USER_CATALOG_ALIASES[key];
  for (const key of Object.keys(USER_DISPLAY_NAMES)) delete USER_DISPLAY_NAMES[key];
}

/** Register one user adapter's ids/name. Called on every adapter-dir reload. */
export function registerUserProvider({ provider, catalogIds = [], prefixes = [], displayName } = {}) {
  if (!provider) return;
  const key = String(provider);
  const ids = new Set([key, ...(Array.isArray(catalogIds) ? catalogIds : []), ...(Array.isArray(prefixes) ? prefixes : [])]);
  for (const id of ids) {
    if (!id) continue;
    USER_PREFIX_ALIASES[String(id).toLowerCase()] = key;
  }
  USER_CATALOG_ALIASES[key] = Array.from(new Set([key, ...(USER_CATALOG_ALIASES[key] || []), ...(Array.isArray(catalogIds) ? catalogIds : [])]));
  if (displayName) USER_DISPLAY_NAMES[key] = String(displayName);
}

export function providerForModel(model) {
  const m = String(model || '').toLowerCase();
  const prefix = m.split('/')[0];
  // User adapters win: their catalog id is exactly what DSH uses for the model
  // prefix, and the user added the adapter specifically for it.
  if (USER_PREFIX_ALIASES[prefix]) return USER_PREFIX_ALIASES[prefix];
  if (PREFIX_ALIASES[prefix]) return PREFIX_ALIASES[prefix];
  // Fuzzy fallbacks for models whose prefix is not the provider id.
  if (m.includes('grok')) return 'xai';
  if (m.includes('codex') || m.startsWith('gpt-')) return 'codex';
  if (m.includes('gemini')) return 'agy';
  if (m.startsWith('k3') || m.startsWith('kimi')) return 'kimi';
  return '';
}

export function inCatalog(provider, ids) {
  if (!ids) return true; // catalog unknown: do not hide anything
  const names = [
    ...(CATALOG_ALIASES[provider] || []),
    ...(USER_CATALOG_ALIASES[provider] || []),
  ];
  if (!names.length) names.push(provider);
  return names.some((n) => ids.includes(n));
}

/** Display name for user adapters (built-ins keep their server-side table). */
export function userDisplayName(provider) {
  return USER_DISPLAY_NAMES[provider] || null;
}
