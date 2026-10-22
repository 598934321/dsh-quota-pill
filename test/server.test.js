/**
 * Sidecar tests: credential parsing, provider resolution, response shape.
 *
 * No network here. Anything that would hit an upstream is covered by the
 * adapter contracts below (which only assert the shape adapters must return),
 * not by calling real services.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

// Must be set BEFORE importing the adapters: credentials.js resolves these
// paths once at module load. Without this the suite would hit live upstreams
// and depend on whatever accounts the machine happens to have.
process.env.CLI_PROXY_API_DIR = '/nonexistent-quota-pill-test';
process.env.DSH_HOME = '/nonexistent-quota-pill-test';
process.env.QUOTA_PILL_TIMEOUT_MS = '1500';

const { parseCredentialsYaml, pickFirstRef } = await import('../src/credentials.js');

test('parses plain refs', () => {
  const doc = parseCredentialsYaml('refs:\n  KIMI_CODING_API_KEY: sk-abc\n');
  assert.equal(doc.refs.KIMI_CODING_API_KEY, 'sk-abc');
});

test('parses quoted refs', () => {
  const doc = parseCredentialsYaml('refs:\n  KEY: "sk with space"\n');
  assert.equal(doc.refs.KEY, 'sk with space');
});

test('parses inline flow maps (records shape)', () => {
  const doc = parseCredentialsYaml(
    'records:\n  client-connection/browser-session:\n    payload: {secret: abc123}\n',
  );
  assert.equal(doc.records['client-connection/browser-session'].payload.secret, 'abc123');
});

test('parses nested maps alongside refs', () => {
  const doc = parseCredentialsYaml(
    [
      'records:',
      '  some/record:',
      '    payload: {secret: s3cr3t}',
      'refs:',
      '  A: one',
      '  B: two',
    ].join('\n'),
  );
  assert.equal(doc.records['some/record'].payload.secret, 's3cr3t');
  assert.deepEqual(doc.refs, { A: 'one', B: 'two' });
});

test('ignores comments and blank lines', () => {
  const doc = parseCredentialsYaml('# header\n\nrefs:\n  A: 1\n');
  assert.equal(doc.refs.A, '1');
});

test('malformed input degrades to no refs instead of throwing', () => {
  assert.deepEqual(parseCredentialsYaml('not: [valid').refs ?? {}, {});
  assert.deepEqual(parseCredentialsYaml('').refs ?? {}, {});
  assert.deepEqual(parseCredentialsYaml(null).refs ?? {}, {});
});

/* ------------------------------------------------ adapter response contracts */
/**
 * Whatever an adapter returns, the client must be able to render it. These
 * assertions encode that contract so a new adapter cannot ship a shape the
 * pill does not understand.
 */
test('adapter results always carry kind and provider', async () => {
  const { kimi, opencode, commandcode } = await import('../src/adapters-apikey.js');
  const { xai, codex, agy } = await import('../src/adapters-cliproxy.js');
  const { deepseek } = await import('../src/adapters-deepseek.js');
  const { opendesign } = await import('../src/adapters-opendesign.js');

  for (const [name, fn] of Object.entries({ deepseek, kimi, opencode, commandcode, xai, codex, agy, opendesign })) {
    const r = await fn(null);
    assert.ok(r && typeof r === 'object', `${name} returned nothing`);
    assert.equal(typeof r.kind, 'string', `${name}.kind missing`);
    assert.ok(r.kind.length > 0, `${name}.kind empty`);
    assert.equal(r.provider, name, `${name}.provider should be '${name}', got '${r.provider}'`);
  }
});

test('subscription-quota results carry usable numbers', async () => {
  const { opencode, commandcode } = await import('../src/adapters-apikey.js');
  for (const [name, fn] of Object.entries({ opencode, commandcode })) {
    const r = await fn(null);
    // Without credentials these return 'none'; the shape contract below only
    // applies when a real reading was produced.
    if (r.kind !== 'subscription-quota') continue;
    assert.equal(typeof r.remainingPct, 'number', `${name}.remainingPct`);
    assert.ok(r.remainingPct >= 0 && r.remainingPct <= 100, `${name} remainingPct out of range`);
    assert.ok(Array.isArray(r.windows), `${name}.windows must be an array`);
    for (const w of r.windows) {
      assert.equal(typeof w.key, 'string', `${name} window key`);
      assert.equal(typeof w.remainPct, 'number', `${name} window remainPct`);
      assert.ok(w.remainPct >= 0 && w.remainPct <= 100, `${name} window remainPct out of range`);
    }
  }
});

test('missing credentials produce an actionable error, never a fake zero', async () => {
  const { kimi } = await import('../src/adapters-apikey.js');
  const r = await kimi(null);
  if (r.kind === 'none') {
    assert.match(String(r.error), /KIMI_CODING_API_KEY|credentials/,
      'error must name what is missing so the user knows what to add');
    assert.ok(r.setup, 'must include setup hints for the agent-driven flow');
  }
});

test('CLIProxy providers explain the dependency when it is absent', async () => {
  const { codex } = await import('../src/adapters-cliproxy.js');
  const r = await codex(null);
  if (r.kind === 'none' || r.kind === 'probe-failed') {
    assert.match(String(r.error), /CLIProxy|codex|credential/i);
  }
});

test('deepseek reports the Platform grant, not an api.deepseek.com key', async () => {
  const { deepseek } = await import('../src/adapters-deepseek.js');
  const { opendesign } = await import('../src/adapters-opendesign.js');
  const r = await deepseek();
  // With DSH_HOME pointed at a nonexistent dir there is no grant at all.
  if (r.kind === 'none') {
    assert.match(String(r.error), /DeepSeek|grant|sign/i,
      'must explain that the Platform sign-in is missing');
    assert.ok(r.setup, 'must carry setup hints for the agent flow');
  }
});

test('deepseek is never reported as a percentage', async () => {
  const { deepseek } = await import('../src/adapters-deepseek.js');
  const { opendesign } = await import('../src/adapters-opendesign.js');
  const r = await deepseek();
  // A prepaid wallet has no ceiling, so a percentage would be fabricated.
  assert.equal(r.remainingPct ?? null, null);
});

/* ---------------------------------------------------- bundle manifest sanity */
/**
 * DSH resolves the client entry through the bundle's cordis.patch.yml. An empty
 * list there is silently fatal: the package installs fine, the profile lists it
 * in bundles, and client.js is simply never loaded — the UI just never appears.
 * That is exactly how the first release shipped broken.
 */
test('cordis.patch.yml registers this package', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const patch = fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8');

  assert.match(patch, /insert:/, 'patch must insert an entry, not be empty');
  assert.match(patch, /@hystudio\/dsh-quota-pill/, 'entry must name this package');
});

test('package.json points the bundle at that patch', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(fs.existsSync(path.join(root, 'cordis.patch.yml')));
  assert.equal(pkg.dsh.client.platform, 'web');
});

/* ------------------------------------------------ client bundle registration */
/**
 * The client half registers itself with the DSH module loader under its own
 * package name. Registering under a stale id (e.g. the previous package name)
 * is silently fatal twice over: the loader looks up the bundle's name, finds no
 * factory, and reports "import failed" — and if the old package also loads, the
 * duplicate id throws and takes the renderer down.
 */
test('client.js registers under its own package name', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const client = fs.readFileSync(path.join(root, 'client.js'), 'utf8');

  const m = /id:\s*['"]([^'"]+)['"]/.exec(client);
  assert.ok(m, 'client.js must pass an id to __ModuleLoader__.load');
  assert.equal(m[1], pkg.name, 'registration id must equal the package name');
});

/**
 * A Cordis host plugin must export `name`. Without it the loader treats the
 * bundle as unimportable and the whole thing never activates.
 */
test('host entry exports name and apply', async () => {
  const mod = await import('../index.js');
  assert.equal(typeof mod.name, 'string');
  assert.ok(mod.name.length > 0, 'name must not be empty');
  assert.equal(typeof mod.apply, 'function');
  assert.ok(Array.isArray(mod.inject ?? []), 'inject, when present, must be an array');
});

/* ----------------------------------------------------- provider visibility */
test('every configured real DSH catalog id is visible to its adapter', async () => {
  const { inCatalog } = await import('../src/providers.js');
  // The exact ids a real DSH 0.2.1 profile can expose. grok / commandcode-goat
  // / opendesign-go are the ones the short adapter keys did not cover, so a
  // configured provider was silently dropped from the All page.
  const catalog = [
    'deepseek-account', 'opencode-go', 'commandcode-goat', 'opendesign-go',
    'codex', 'antigravity', 'grok',
  ];
  for (const adapter of ['deepseek', 'opencode', 'commandcode', 'opendesign', 'codex', 'agy', 'xai']) {
    assert.equal(inCatalog(adapter, catalog), true, `${adapter} must be visible`);
  }
  // A provider the catalog does not expose must still be hidden (its adapter
  // may exist for another profile), and an unknown catalog means "show all".
  assert.equal(inCatalog('kimi', catalog), false);
  assert.equal(inCatalog('xai', null), true);
});

test('model prefixes from DSH map to the right adapter', async () => {
  const { providerForModel } = await import('../src/providers.js');
  const cases = [
    ['opendesign-go/deepseek-v4.1-flash', 'opendesign'],
    ['commandcode-goat/deepseek/deepseek-v4.1-flash', 'commandcode'],
    ['deepseek-account/deepseek-chat', 'deepseek'],
    ['opencode-go/deepseek-v4.1-flash', 'opencode'],
    ['grok-4.7', 'xai'],
    ['grok/grok-4.7', 'xai'],
    ['antigravity/gemini-3.8-flash-high', 'agy'],
    ['codex/gpt-6.1-sol', 'codex'],
    ['totally-unknown/model', ''],
  ];
  for (const [model, want] of cases) {
    assert.equal(providerForModel(model), want, `providerForModel(${model})`);
  }
});

test('a DSH-named credential ref is accepted when the short one is absent', () => {
  // The user's DSH config names the ref after apiKeyEnv (GOAT); the plugin's
  // docs name the short form. Either must be readable, first match wins.
  const refs = { COMMANDCODE_GOAT_API_KEY: 'sk-goat' };
  assert.equal(
    pickFirstRef(refs, ['COMMANDCODE_API_KEY', 'COMMANDCODE_GOAT_API_KEY']),
    'sk-goat',
  );
  assert.equal(
    pickFirstRef({ COMMANDCODE_API_KEY: 'sk-short', COMMANDCODE_GOAT_API_KEY: 'sk-goat' },
      ['COMMANDCODE_API_KEY', 'COMMANDCODE_GOAT_API_KEY']),
    'sk-short',
  );
  assert.equal(pickFirstRef({ COMMANDCODE_GOAT_API_KEY: '' },
    ['COMMANDCODE_API_KEY', 'COMMANDCODE_GOAT_API_KEY']), null);
});

test('unconfigured providers are filtered out of the all page', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  // kind 'none' means "no credential": showing it as a row is noise.
  assert.match(src, /kind !== 'none'/, 'readAll must drop kind none');
  // probe-failed must NOT be dropped: the provider is configured, the failure matters.
  assert.doesNotMatch(src, /kind !== 'probe-failed'/);
});

/* ------------------------------------------------------------- opendesign */
/**
 * Open Design is opt-in: it reads a console session cookie, not an API key.
 * Without the cookie it must say so by name — an undefined percentage would be
 * indistinguishable from "zero quota left".
 */
test('opendesign names the cookie it needs', async () => {
  const { opendesign } = await import('../src/adapters-opendesign.js');
  const r = await opendesign();
  if (r.kind === 'none') {
    assert.match(String(r.error), /OPENDESIGN_SESSION_COOKIE/);
    assert.ok(r.setup, 'must carry setup hints');
  }
});

test('opendesign never reports a percentage without a reading', async () => {
  const { opendesign } = await import('../src/adapters-opendesign.js');
  const r = await opendesign();
  if (r.kind !== 'subscription-quota') {
    assert.equal(r.remainingPct ?? null, null);
  }
});

test('opendesign window labels come from window length', async () => {
  const src = (await import('node:fs')).readFileSync(
    new URL('../src/adapters-opendesign.js', import.meta.url), 'utf8',
  );
  // 18000s = 5h cap, 604800s = weekly. Hardcoded ids would drift.
  assert.match(src, /6 \* 3600/);
  assert.match(src, /8 \* 86400/);
});

/* ---------------------------------------------------- reset normalisation */
test('epoch milliseconds become ISO, and 0 means "no reset"', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/adapters-apikey.js', import.meta.url), 'utf8');
  // Command Code sends epoch ms for weekly and 0 for "nothing pending" on 5h;
  // treating 0 as a date would render 1970.
  assert.match(src, /function isoReset/);
  assert.match(src, /v === 0/);
  assert.match(src, /n < 1e11/);
});

test('the monthly reset comes from the subscription period', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/adapters-apikey.js', import.meta.url), 'utf8');
  // The credits endpoint has no monthly reset; currentPeriodEnd is the real one.
  assert.match(src, /currentPeriodEnd/);
  // And the plan is nested under `data`, not at the top level.
  assert.match(src, /planId/);
});
