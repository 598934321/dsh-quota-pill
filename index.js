/**
 * Host half of the quota-pill bundle.
 *
 * Rendering lives in client.js, which the web GUI loads separately. This half
 * registers nothing: the plugin only paints a pill, exposes no host service and
 * no RPC.
 *
 * It still has to be a well-formed Cordis plugin, which means exporting `name`.
 * Omitting it makes the loader reject the bundle at import time with
 * "@hystudio/dsh-quota-pill: import failed" — and because the failure happens
 * before activation, nothing in the UI says why. That is how 0.2.2 shipped.
 */
export const name = 'quota-pill';

/** No host-side services are required. */
export const inject = [];

/** Nothing to set up on the host; the client half does all the work. */
export function apply() {}
