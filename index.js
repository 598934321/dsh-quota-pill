/**
 * Host half of the quota-pill bundle.
 *
 * Rendering lives in client.js, which the web GUI loads separately. This half
 * starts the local sidecar on first launch, so a fresh install shows quota
 * without a separate service unit. The sidecar is idempotent: if one is already
 * listening (launchd/systemd/previous launch), ensureSidecar() leaves it alone.
 *
 * It still has to be a well-formed Cordis plugin, which means exporting `name`.
 * Omitting it makes the loader reject the bundle at import time with
 * "@hystudio/dsh-quota-pill: import failed" — and because the failure happens
 * before activation, nothing in the UI says why. That is how 0.2.2 shipped.
 */
import { ensureSidecar } from './src/autostart.js';

export const name = 'quota-pill';

/** No host-side services are required. */
export const inject = [];

/**
 * Best-effort sidecar start. Never reject: a plugin host failure would be worse
 * than "quota service is not running", which the pill already explains.
 */
export function apply() {
  return ensureSidecar().catch(() => null);
}
