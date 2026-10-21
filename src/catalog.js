/**
 * Which providers this user actually has.
 *
 * A hardcoded adapter list is wrong in both directions: it lists providers that
 * were removed or never configured, and it cannot know about new ones. DSH's own
 * `session/modelCatalog` is the authoritative answer — it is literally the set of
 * providers the app can route to right now.
 *
 * If the catalog is unavailable (DSH not running), callers fall back to showing
 * whatever the adapters can read, so the pill degrades rather than going blank.
 */
import { dshRpc } from './dsh.js';

const TTL_MS = 120 * 1000;
let cache = { at: 0, ids: null };

/** Provider ids DSH currently exposes, or null when unknown. */
export async function catalogProviderIds() {
  if (cache.ids && Date.now() - cache.at < TTL_MS) return cache.ids;

  const res = await dshRpc('session/modelCatalog', {});
  if (!res.ok) return cache.ids; // keep the last good answer, if any

  const groups = (res.value && res.value.groups) || [];
  const ids = groups.map((g) => g && g.id).filter(Boolean);
  if (!ids.length) return cache.ids;

  cache = { at: Date.now(), ids };
  return ids;
}

/** Drop the cached catalog (tests, or after installing a provider). */
export function forgetCatalog() {
  cache = { at: 0, ids: null };
}
