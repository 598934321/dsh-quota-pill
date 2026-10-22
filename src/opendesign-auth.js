/**
 * Open Design account sign-in — the device authorization `vela login` runs.
 *
 * The control plane (https://amr-api.open-design.ai) issues two keys:
 *   · control key (`vela_ctrl_…`) — plan, wallet, Design Plan allowance
 *   · runtime key (`sk-amr-…`)   — model requests at amr-link
 *
 * The quota pill only needs the control key. The CLI flow is:
 *   POST /api/v1/cli/device-authorizations      → deviceId, deviceSecret, code, activation URL
 *   user approves the URL in a signed-in browser
 *   POST /api/v1/cli/device-authorizations/:id/token { deviceSecret } → the keys
 */
import os from 'node:os';
import { getJsonViaCurl, postJsonViaCurl } from './http.js';

export const CONTROL_ORIGIN = 'https://amr-api.open-design.ai';
export const CONTROL_API = CONTROL_ORIGIN + '/api/v1';
const CLI_VERSION = '0.1.4';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function headers(extra = {}) {
  return { Origin: 'https://open-design.ai', Referer: 'https://open-design.ai/', ...extra };
}

export async function startDevice() {
  const res = await postJsonViaCurl(CONTROL_API + '/cli/device-authorizations', {
    cliVersion: CLI_VERSION,
    host: os.hostname() || 'dsh',
    profile: 'prod',
  }, { headers: headers() });
  if (!res.ok) throw new Error('device authorization failed: ' + res.error);
  const d = res.data || {};
  if (!d.deviceId || !d.deviceSecret) {
    throw new Error('device authorization response is missing deviceId/deviceSecret');
  }
  return {
    deviceId: String(d.deviceId),
    deviceSecret: String(d.deviceSecret),
    userCode: d.userCode ? String(d.userCode) : '',
    activationUrl: d.activationUrl ? String(d.activationUrl) : '',
    intervalSeconds: Number(d.pollIntervalSeconds) > 0 ? Number(d.pollIntervalSeconds) : 2,
    expiresAt: Date.parse(d.expiresAt || '') || Date.now() + 10 * 60_000,
  };
}

export async function waitForDevice(device, { onPending } = {}) {
  for (;;) {
    if (Date.now() > device.expiresAt) {
      throw new Error('the device code expired before it was approved');
    }
    await sleep((device.intervalSeconds || 2) * 1000);
    const res = await postJsonViaCurl(
      CONTROL_API + '/cli/device-authorizations/' + encodeURIComponent(device.deviceId) + '/token',
      { deviceSecret: device.deviceSecret },
      { headers: headers() },
    );
    if (res.ok && res.data && res.data.controlKey && res.data.runtimeKey) {
      return {
        controlKey: String(res.data.controlKey),
        runtimeKey: String(res.data.runtimeKey),
        email: res.data.user && res.data.user.email ? String(res.data.user.email) : null,
      };
    }
    const status = String((res.data && res.data.status) || '').toLowerCase();
    if (status === 'expired' || status === 'denied' || status === 'cancelled' || status === 'canceled' || status === 'rejected') {
      throw new Error('the device authorization was ' + status);
    }
    if (res.status === 401 && /invalid_device_secret/.test(String((res.data && res.data.error) || ''))) {
      throw new Error('the device code is no longer valid');
    }
    if (onPending) onPending(status || 'pending');
  }
}

/** The workspace whose allowance is shown. Explicit ref wins; otherwise ask. */
export async function workspaceOf(controlKey) {
  const res = await getJsonViaCurl(CONTROL_API + '/workspaces/current', {
    token: controlKey,
    headers: headers(),
  });
  if (!res.ok) throw new Error('workspace lookup failed: ' + res.error);
  const body = res.data || {};
  const id = body.activeWorkspaceId || body.workspaceId;
  if (!id) throw new Error('the account has no active workspace');
  return String(id);
}

/** Run the full device login. `onDevice` receives the URL/code to show the user. */
export async function loginOpenDesign({ onDevice, onPending } = {}) {
  const device = await startDevice();
  if (onDevice) onDevice(device);
  const keys = await waitForDevice(device, { onPending });
  const workspaceId = await workspaceOf(keys.controlKey);
  return { ...keys, workspaceId };
}
