import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadUserAdapters,
  userAdapterFor,
  adapterContext,
} from '../src/user-adapters.js';
import { providerForModel, inCatalog, clearUserProviders } from '../src/providers.js';
import { credentialSource, clearUserCredentialSources } from '../src/credentials.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function writeAdapter(dir, name, source) {
  fs.writeFileSync(path.join(dir, name), source, 'utf8');
}

test('user adapters register provider ids and can be read', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-user-adapters-'));
  try {
    writeAdapter(dir, 'demo.mjs', `
export const provider = 'demo';
export const catalogIds = ['demo-go'];
export const displayName = 'Demo Provider';
export const credential = {
  kind: 'api-key',
  refs: ['DEMO_API_KEY'],
  requires: 'refs.DEMO_API_KEY',
};
export async function read(ctx) {
  return { kind: 'payg', credits: { remain: ctx.model === 'demo-go/model' ? 7 : 0, unit: 'USD' } };
}
`);
    const info = await loadUserAdapters({ dir, force: true });
    assert.equal(info.errors.length, 0, JSON.stringify(info.errors));
    assert.equal(info.adapters[0].provider, 'demo');
    assert.equal(providerForModel('demo-go/model'), 'demo');
    assert.equal(inCatalog('demo', ['demo-go']), true);
    assert.equal(credentialSource('demo').requires, 'refs.DEMO_API_KEY');

    const adapter = userAdapterFor('demo');
    const reading = await adapter.read(adapterContext('demo-go/model'));
    assert.equal(reading.kind, 'payg');
    assert.equal(reading.credits.remain, 7);
  } finally {
    clearUserProviders();
    clearUserCredentialSources();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('editing a user adapter reloads it, and deleting it unregisters the provider', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-user-adapters-'));
  try {
    writeAdapter(dir, 'demo.mjs', `export const provider = 'demo'; export const catalogIds = ['demo-go']; export async function read() { return { kind: 'none', error: 'v1' }; }`);
    await loadUserAdapters({ dir, force: true });
    assert.equal(providerForModel('demo-go/model'), 'demo');

    // Same path, different mtime/size: the loader must bust Node's ESM cache.
    writeAdapter(dir, 'demo.mjs', `export const provider = 'demo'; export const catalogIds = ['demo-go']; export async function read() { return { kind: 'none', error: 'v2' }; }`);
    const info = await loadUserAdapters({ dir, force: true });
    const reading = await info.adapters[0].read(adapterContext('demo-go/model'));
    assert.equal(reading.error, 'v2');

    fs.rmSync(path.join(dir, 'demo.mjs'));
    await loadUserAdapters({ dir, force: true });
    assert.equal(providerForModel('demo-go/model'), '');
    assert.equal(inCatalog('demo', ['demo-go']), false);
  } finally {
    clearUserProviders();
    clearUserCredentialSources();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a broken user adapter is reported, not fatal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qp-user-adapters-'));
  try {
    writeAdapter(dir, 'broken.mjs', 'export const provider = 1;');
    const info = await loadUserAdapters({ dir, force: true });
    assert.equal(info.adapters.length, 0);
    assert.equal(info.errors.length, 1);
    assert.match(info.errors[0].error, /invalid provider id|read/);
  } finally {
    clearUserProviders();
    clearUserCredentialSources();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
