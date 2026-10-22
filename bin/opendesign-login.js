#!/usr/bin/env node
/**
 * Sign in to Open Design and write the Control Key the quota pill needs.
 *
 *   node bin/opendesign-login.js            # print the values and a YAML snippet
 *   node bin/opendesign-login.js --write    # add/update the two refs in ~/.dsh/.credentials.yaml
 *
 * The browser approval page is the same one the Open Design CLI (`vela login`)
 * and magpie use. Only the Control Key is stored by `--write`; the runtime key
 * is not needed by the quota pill and is not written.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loginOpenDesign } from '../src/opendesign-auth.js';

const write = process.argv.includes('--write');
const credentialsFile = path.join(
  process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  '.credentials.yaml',
);

function setRef(text, key, value) {
  const lines = String(text || '').split('\n');
  const lineRe = new RegExp('^(\\s*)' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':');
  const existing = lines.findIndex((line) => lineRe.test(line));
  if (existing >= 0) {
    lines[existing] = lines[existing].replace(/^(\s*).*$/, '$1' + key + ': ' + value);
    return lines.join('\n');
  }
  const refsAt = lines.findIndex((line) => /^refs:\s*$/.test(line));
  if (refsAt >= 0) {
    lines.splice(refsAt + 1, 0, '  ' + key + ': ' + value);
    return lines.join('\n');
  }
  const base = text && !text.endsWith('\n') ? text + '\n' : String(text || '');
  return base + 'refs:\n  ' + key + ': ' + value + '\n';
}

function mask(value) {
  if (value.length <= 12) return value;
  return value.slice(0, 10) + '…' + value.slice(-4);
}

const result = await loginOpenDesign({
  onDevice(device) {
    console.log('Open Design sign-in');
    console.log('  1. Open: ' + (device.activationUrl || '(activation URL missing)'));
    console.log('  2. Confirm code: ' + device.userCode);
    console.log('  3. Approve the request in the browser.');
    console.log('Waiting for approval…');
  },
  onPending() {},
});

console.log('');
console.log('Signed in' + (result.email ? ' as ' + result.email : '') + '.');
console.log('Control Key: ' + (write ? mask(result.controlKey) : result.controlKey));
console.log('Workspace ID: ' + result.workspaceId);

if (!write) {
  console.log('');
  console.log('Add these to ' + credentialsFile + ' (keep the others already there):');
  console.log('refs:');
  console.log('  OPENDESIGN_CONTROL_KEY: ' + result.controlKey);
  console.log('  OPENDESIGN_WORKSPACE_ID: ' + result.workspaceId);
} else {
  let text = '';
  try { text = fs.readFileSync(credentialsFile, 'utf8'); } catch { /* new file */ }
  text = setRef(text, 'OPENDESIGN_CONTROL_KEY', result.controlKey);
  text = setRef(text, 'OPENDESIGN_WORKSPACE_ID', result.workspaceId);
  fs.mkdirSync(path.dirname(credentialsFile), { recursive: true });
  fs.writeFileSync(credentialsFile, text, { mode: 0o600 });
  try { fs.chmodSync(credentialsFile, 0o600); } catch { /* best effort */ }
  console.log('');
  console.log('Written to ' + credentialsFile);
}

console.log('');
console.log('Restart the quota-pill sidecar (or launch it again) to pick up the new refs.');
