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

const { parseCredentialsYaml } = await import('../src/credentials.js');

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

  for (const [name, fn] of Object.entries({ deepseek, kimi, opencode, commandcode, xai, codex, agy })) {
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
  const r = await deepseek();
  // A prepaid wallet has no ceiling, so a percentage would be fabricated.
  assert.equal(r.remainingPct ?? null, null);
});
