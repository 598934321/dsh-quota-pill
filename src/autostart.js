/**
 * Start the sidecar as soon as the DSH host plugin loads.
 *
 * The pill is useless without the sidecar, and asking a fresh user to install a
 * launchd/systemd unit before they see any quota is the opposite of out-of-box.
 * The host half therefore spawns the bundled server when nothing is listening
 * on the port.
 *
 * - If a sidecar is already running (launchd, systemd, a previous DSH launch),
 *   the port check makes this a no-op instead of a duplicate.
 * - The child is detached so it survives a DSH window reload and can serve the
 *   next launch too. QUOTA_PILL_NO_AUTOSTART=1 opts out (service managers).
 * - Electron's executable is not Node; ELECTRON_RUN_AS_NODE=1 turns it into one.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const DEFAULT_PORT = 8319;
const SERVER = fileURLToPath(new URL('../bin/quota-pill-server.js', import.meta.url));

export function sidecarPort() {
  const port = Number(process.env.QUOTA_PILL_PORT || DEFAULT_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

/** True when something (healthy or not) is already listening. */
export function isPortOpen(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    // A port that accepts TCP but never speaks still means "do not start a
    // second copy"; the health endpoint is the client's job.
    socket.setTimeout(timeoutMs, () => done(true));
  });
}

export async function ensureSidecar({ port = sidecarPort(), server = SERVER, env = process.env } = {}) {
  if (env.QUOTA_PILL_NO_AUTOSTART === '1' || env.QUOTA_PILL_NO_AUTOSTART === 'true') return null;
  if (!fs.existsSync(server)) return null;
  if (await isPortOpen(port)) return null;

  const childEnv = { ...env, QUOTA_PILL_PORT: String(port) };
  if (process.versions.electron && !childEnv.ELECTRON_RUN_AS_NODE) {
    childEnv.ELECTRON_RUN_AS_NODE = '1';
  }
  const child = spawn(process.execPath, [server], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: childEnv,
  });
  child.unref();
  return child;
}
