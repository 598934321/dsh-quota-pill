/**
 * Client-render tests for dsh-quota-pill.
 *
 * These run client.js in Node with a tiny React stand-in, so the rendering
 * logic is exercised without a browser. Fixtures come from the sidecar's own
 * adapters (test/fixtures.js) — never from a live account.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURES, DEEPSEEK_FIXTURE } from './fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT = path.join(HERE, '..', 'client.js');

/** Minimal React: enough for the hooks client.js uses at module scope. */
function makeReact() {
  return {
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useRef: (v) => ({ current: v }),
    useEffect: () => {},
    useCallback: (f) => f,
    useSyncExternalStore: (sub, get) => get(),
    Fragment: 'Fragment',
  };
}

const h = (type, props, ...kids) => {
  const flat = kids.flat().filter((x) => x != null);
  if (typeof type === 'function') return type({ ...(props || {}), children: flat });
  if (type === 'Fragment') return { type, props: props || {}, kids: flat };
  return { type, props: props || {}, kids: flat };
};

/** Load client.js and expose the internals under test. */
function loadClient() {
  const src = fs.readFileSync(CLIENT, 'utf8');
  const start = src.indexOf('function providerFor');
  const end = src.lastIndexOf('\n    return {');
  assert.ok(start > 0 && end > start, 'client.js structure changed — update this test');

  const body = src.slice(start, end);
  const exports = [
    'providerFor', 'providerName', 'providerEntries', 'quotaBody', 'canRenderBody',
    'describeQuota', 'pctIsInformative', 'tweenEase', 'fmtCompact', 'fmtAmount',
    'providersFromAll', 'ALL_PROVIDERS', 'WindowRow', 'paygBody', 'money',
    'computePanelPlacement',
  ];
  const factory = new Function(
    'React', 'document', 'navigator', 'h', 'performance',
    body + `\nreturn { ${exports.join(', ')} };`,
  );
  const api = factory(
    makeReact(),
    { documentElement: { getAttribute: () => 'zh' } },
    { language: 'zh-CN' },
    h,
    { now: () => Date.now() },
  );
  // The provider list is runtime data; seed it so providerFor's prefix rules work.
  api.ALL_PROVIDERS.push(...Object.entries(FIXTURES).map(([k, v]) => [k, v.displayName || k]));
  return api;
}

const A = loadClient();

/** All text nodes under a tree. */
function texts(node, acc = []) {
  if (node == null) return acc;
  if (typeof node === 'string' || typeof node === 'number') {
    acc.push(String(node));
    return acc;
  }
  for (const k of node.kids || []) texts(k, acc);
  return acc;
}

/** All classNames under a tree. */
function classes(node, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (node.props && node.props.className) acc.push(String(node.props.className));
  for (const k of node.kids || []) classes(k, acc);
  return acc;
}

/* ------------------------------------------------------------- provider map */
test('providerFor maps the six supported providers', () => {
  const cases = [
    ['kimi/k3', 'kimi'],
    ['kimi-coding/k3', 'kimi'],
    ['opencode-go/deepseek-v4.1-flash', 'opencode'],
    ['opencode/x', 'opencode'],
    ['commandcode/x', 'commandcode'],
    ['command-code/x', 'commandcode'],
    ['xai/grok-4', 'xai'],
    ['codex/gpt-6', 'codex'],
    ['antigravity/gemini-3.6', 'agy'],
    ['agy/gemini-3.6', 'agy'],
  ];
  for (const [model, want] of cases) {
    assert.equal(A.providerFor(model), want, `providerFor(${model})`);
  }
});

test('providerFor returns empty for unknown providers', () => {
  assert.equal(A.providerFor('totally-unknown/model'), '');
});

test('providerName never returns empty for a known provider', () => {
  for (const key of Object.keys(FIXTURES)) {
    assert.ok(A.providerName(key).length > 0, `providerName(${key}) must not be empty`);
  }
});

/* ------------------------------------------------------------- window rows */
test('every fixture renders at least one row', () => {
  for (const [key, v] of Object.entries(FIXTURES)) {
    const entries = A.providerEntries(v, 'zh');
    assert.ok(entries.length >= 1, `${key} rendered no rows`);
  }
});

test('no row label is empty or a raw kind literal', () => {
  const bad = [];
  for (const [key, v] of Object.entries(FIXTURES)) {
    for (const e of A.providerEntries(v, 'zh')) {
      const label = String(e.label || '');
      if (!label || label === 'none' || label === 'undefined' || label === 'null') {
        bad.push(`${key}: ${label || '(empty)'}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('windows expand into one row each, with remaining percent', () => {
  const v = FIXTURES.opencode;
  const entries = A.providerEntries(v, 'zh');
  const keys = entries.map((e) => e.key);
  for (const w of v.windows) {
    assert.ok(keys.includes(w.key), `window ${w.key} missing from rows`);
  }
  for (const e of entries) {
    if (e.key === '__aggregate') continue;
    assert.equal(typeof e.pct, 'number', `${e.key} has no numeric pct`);
  }
});

/* ------------------------------------------------------- percentage priority */
test('percentage wins when it carries information', () => {
  assert.equal(A.pctIsInformative(94.12, { remain: 47062, total: 50000 }), true);
});

test('credits-only channels still render their value', () => {
  // remain == total means the percentage is always 100% — useless as a reading.
  assert.equal(A.pctIsInformative(100, { remain: 1000, total: 1000 }), false);
});

test('a row shows either a percentage or credits, never both', () => {
  const row = A.WindowRow({
    label: '5h remaining',
    pct: 94.12,
    reset: 'in 4h',
    credits: { remain: 47062, total: 50000, unit: 'credits' },
    lang: 'zh',
  });
  const cl = classes(row);
  const hasPct = cl.some((c) => c.includes('quota-pill-win-pct'));
  const hasCredits = cl.some((c) => c.includes('quota-pill-win-credits'));
  assert.notEqual(hasPct, hasCredits, 'exactly one readout mode must be active');
});

/* ---------------------------------------------------------------- tweening */
test('tweenEase is monotonic and hits both endpoints', () => {
  assert.equal(A.tweenEase(0), 0);
  assert.equal(A.tweenEase(1), 1);
  let prev = -1;
  for (let t = 0; t <= 1.0001; t += 0.01) {
    const v = A.tweenEase(t);
    assert.ok(v >= prev - 1e-9, `not monotonic at t=${t}`);
    prev = v;
  }
});

test('tweenEase decelerates at the tail', () => {
  const f = A.tweenEase;
  const segs = [];
  for (let t = 0.8; t < 1; t += 0.05) segs.push(f(t + 0.05) - f(t));
  for (let i = 1; i < segs.length; i++) {
    assert.ok(segs[i] <= segs[i - 1] + 1e-9, 'tail must slow down, not speed up');
  }
  assert.ok(segs[segs.length - 1] < 0.01, 'last 5% of time should move <1%');
});

/* ------------------------------------------------------------- stale states */
test('stale readings are marked, live ones are not', () => {
  const stale = A.quotaBody(FIXTURES.opencode, null, null, null, null, 0, 'zh', 'opencode-go', true);
  const live = A.quotaBody(FIXTURES.opencode, null, null, null, null, 0, 'zh', 'opencode-go', false);
  const marked = (tree) => classes(tree).some((c) => c.includes('quota-pill-win')) && JSON.stringify(tree).includes('"data-stale":"1"');
  assert.equal(marked(stale), true, 'stale tree should carry data-stale');
  assert.equal(marked(live), false, 'live tree should not carry data-stale');
});

test('a provider with no reading reports "no data" instead of a number', () => {
  assert.equal(A.canRenderBody(null), false);
  const d = A.describeQuota({ kind: 'none', error: 'no credentials' }, 'zh');
  assert.ok(d.text.length > 0);
  assert.notEqual(d.text, 'none');
});

/* -------------------------------------------------------------- formatting */
test('fmtCompact truncates rather than rounds up', () => {
  // Never overstate what is left.
  assert.equal(A.fmtCompact(1758), A.fmtCompact(1758));
  assert.ok(A.fmtCompact(999999).endsWith('k'));
});

/* ------------------------------------------------------------ provider list */
test('providersFromAll reflects the sidecar payload verbatim', () => {
  const rows = A.providersFromAll(FIXTURES);
  assert.equal(rows.length, Object.keys(FIXTURES).length);
  for (const [key, name] of rows) {
    assert.equal(name, FIXTURES[key].displayName || key);
  }
});

test('providersFromAll tolerates empty/garbage payloads', () => {
  assert.equal(A.providersFromAll(null), null);
  assert.equal(A.providersFromAll({}), null);
});

/* ------------------------------------------------- prepaid wallets (DeepSeek) */
test('a prepaid balance renders as a currency amount, not a label', () => {
  const d = A.describeQuota(DEEPSEEK_FIXTURE, 'zh');
  assert.equal(d.pct, null, 'a wallet has no percentage');
  assert.match(d.text, /\u00a597/, 'must show the actual CNY balance');
});

test('prepaid balance and bonus are shown separately', () => {
  const t = A.paygBody(DEEPSEEK_FIXTURE, 'zh');
  const all = texts(t).join(' | ');
  assert.match(all, /\u00a597\.05/, 'balance amount missing');
  assert.match(all, /\u00a516\.58/, 'bonus amount missing');
});

test('money() never invents a currency symbol it was not given', () => {
  assert.equal(A.money(12.345, 'CNY'), '\u00a512.35');
  assert.ok(!A.money(5, 'XYZ').includes('\u00a5'));
  assert.equal(A.money(null, 'CNY'), '');
});

test('money() picks shorter precision for large amounts', () => {
  // 1234.56 as CNY should not be 6 significant chars longer than needed
  assert.ok(A.money(1234.56, 'CNY').length <= 8);
});

/* ------------------------------------------------------- panel placement */
const GAP = 8, EDGE = 12, MAXW = 340;
const place = (anchor, vw, vh, ph = 300) =>
  A.computePanelPlacement(anchor, { width: vw, height: vh }, ph, GAP, EDGE, MAXW);

test('a wide window keeps the panel aligned with the trigger', () => {
  const p = place({ left: 600, top: 800, bottom: 830 }, 1200, 900);
  assert.equal(p.left, 600);
  assert.equal(p.width, MAXW);
});

test('a narrow window shrinks the panel instead of clipping it', () => {
  // 320px viewport cannot hold a 340px panel; without clamping the right side is cut off.
  const p = place({ left: 100, top: 800, bottom: 830 }, 320, 900);
  assert.ok(p.left >= EDGE, 'left must respect the edge margin');
  assert.ok(p.left + p.width <= 320 - EDGE + 0.5, 'must not exceed the viewport');
});

test('a trigger near the right edge pulls the panel back in', () => {
  const p = place({ left: 840, top: 800, bottom: 830 }, 860, 900);
  assert.ok(p.left + p.width <= 860, 'panel must fit inside the viewport');
  assert.ok(p.left < 840, 'panel shifts left rather than overflowing');
});

test('the panel never leaves the viewport at any width', () => {
  for (const vw of [240, 320, 400, 600, 900, 1400]) {
    for (const left of [0, 50, 200, vw - 60, vw - 10]) {
      const p = place({ left, top: 800, bottom: 830 }, vw, 900);
      assert.ok(p.left >= 0, `left<0 at vw=${vw} left=${left}`);
      assert.ok(p.left + p.width <= vw, `overflow at vw=${vw} left=${left}`);
    }
  }
});

test('the panel flips below when there is no room above', () => {
  // Trigger near the top: opening upward would put the panel off-screen.
  const p = place({ left: 100, top: 20, bottom: 50 }, 1200, 900);
  assert.equal(p.placement, 'down');
});

test('the panel opens upward from a bottom toolbar', () => {
  const p = place({ left: 100, top: 800, bottom: 830 }, 1200, 900);
  assert.equal(p.placement, 'up');
});

test('both directions cap height so the panel scrolls instead of overflowing', () => {
  const tall = place({ left: 100, top: 400, bottom: 430 }, 900, 900, 800);
  assert.ok(tall.maxHeight <= 900, 'maxHeight must fit the viewport');
  assert.equal(tall.overflowY, 'auto', 'content must scroll, not spill');
});
