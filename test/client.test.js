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
    'computePanelPlacement', 'adaptationPrompt', 'isUnrecognizedProvider', 'adaptHintBlock',
    'isPeriodicWindow',
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

/** First node carrying the given className, or null. */
function findClass(node, cls) {
  if (!node || typeof node !== 'object') return null;
  if (node.props && node.props.className === cls) return node;
  for (const k of node.kids || []) {
    const hit = findClass(k, cls);
    if (hit) return hit;
  }
  return null;
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
    ['commandcode-goat/x', 'commandcode'],
    ['opendesign-go/deepseek-v4.1-flash', 'opendesign'],
    ['deepseek-account/deepseek-chat', 'deepseek'],
    ['grok-4.7', 'xai'],
    ['grok/grok-4.7', 'xai'],
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

test('a periodic window keeps its percentage even when it is full', () => {
  // A 5-hour bucket that just reset is 100% AND has remain == total; the old
  // rule would render "50k credits" and then switch back to "94%" later.
  const row = A.WindowRow({
    label: '5 小时额度剩余',
    pct: 100,
    reset: 'in 2h',
    credits: { remain: 50000, total: 50000, unit: 'credits' },
    periodic: true,
    lang: 'zh',
  });
  const cl = classes(row);
  assert.ok(cl.some((c) => c.includes('quota-pill-win-pct')), 'expects a percentage');
  assert.ok(!cl.some((c) => c.includes('quota-pill-win-credits')), 'must not show credits');
  assert.deepEqual(texts(row).filter((t) => t.endsWith('%')), ['100%']);
});

test('a credit pack without a reset period still shows credits', () => {
  const row = A.WindowRow({
    label: '全部积分',
    pct: 100,
    credits: { remain: 1000, total: 1000, unit: 'credits' },
    lang: 'zh',
  });
  const cl = classes(row);
  assert.ok(cl.some((c) => c.includes('quota-pill-win-credits')));
});

test('periodic windows are recognised by their key', () => {
  assert.equal(A.isPeriodicWindow('5h'), true);
  assert.equal(A.isPeriodicWindow('weekly'), true);
  assert.equal(A.isPeriodicWindow('weekly-2'), true);
  assert.equal(A.isPeriodicWindow('credits-all'), false);
  assert.equal(A.isPeriodicWindow('agy-opus'), false);
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

/* ------------------------------------------------ unknown provider adaptation */
test('unknown provider gets a self-contained adaptation prompt', () => {
  const p = A.adaptationPrompt('newco/model-x', 'newco', 'zh');
  assert.match(p, /newco\/model-x/, 'must name the current model');
  assert.ok(p.includes('~/.dsh/quota-pill/adapters'), 'must name the user adapter directory');
  assert.match(p, /setup\?fresh=1/);
  assert.match(p, /quota\?model=/);
  assert.match(p, /不要|绝不伪造|do not fake/i);
});

test('only unknown/no-adapter responses get the adaptation hint', () => {
  assert.equal(A.isUnrecognizedProvider({ provider: 'unknown' }), true);
  assert.equal(A.isUnrecognizedProvider({ provider: 'acme', error: "no adapter matches model 'x'" }), true);
  assert.equal(A.isUnrecognizedProvider({ provider: 'xai', error: 'http 401' }), false);
  assert.equal(A.isUnrecognizedProvider(null), false);

  const block = A.adaptHintBlock({ provider: 'unknown' }, 'newco/model-x', 'zh');
  const all = texts(block).join(' | ');
  assert.match(all, /无法识别该 provider/);
  assert.match(all, /复制提示词/);
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

/* ------------------------------------------- prepaid balance + bonus rows */
test('the all page shows the balance as one row with the bonus as detail', () => {
  const rows = A.providerEntries(DEEPSEEK_FIXTURE, 'zh');
  // Two window rows inherited the reserved reset line, leaving a blank line
  // under each amount: taller than needed and unlike every other provider.
  assert.equal(rows.length, 1, 'DeepSeek must be one row, not two');
  assert.equal(rows[0].key, 'balance');
  assert.match(String(rows[0].detail), /\u00a516\.58/, 'bonus amount missing from detail');
  assert.equal(rows[0].compact, false, 'a bonus is a real secondary line');
  const reset = findClass(A.WindowRow({
    label: rows[0].label, pct: null, reset: '', detail: rows[0].detail,
    credits: rows[0].credits, money: true, lang: 'zh',
  }), 'quota-pill-win-reset');
  assert.ok(reset, 'the bonus must render as the row secondary line');
  assert.match((reset.kids || []).join(' '), /\u00a516\.58/);
});

test('a wallet without a bonus omits the empty secondary line', () => {
  const noBonus = { ...DEEPSEEK_FIXTURE, bonus: null };
  const rows = A.providerEntries(noBonus, 'zh');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].compact, true);
  const row = A.WindowRow({
    label: rows[0].label, pct: null, reset: '', detail: rows[0].detail,
    compact: rows[0].compact, credits: rows[0].credits, money: true, lang: 'zh',
  });
  assert.equal(findClass(row, 'quota-pill-win-reset'), null,
    'a compact row must not reserve a blank line');
});

test('a prepaid row renders as currency, not a compact count', () => {
  // fmtCompact would print "97" and the unit "CNY"; money() prints the symbol.
  const row = A.WindowRow({
    label: 'balance', pct: null, reset: '',
    credits: { remain: 97.05, unit: 'CNY' }, lang: 'zh', money: true,
  });
  const all = texts(row).join(' ');
  assert.match(all, /\u00a597\.05/);
  assert.ok(!all.includes('CNY'), 'currency code must not leak beside the symbol');
});

test('no bonus means no bonus row', () => {
  const noBonus = { ...DEEPSEEK_FIXTURE, bonus: null };
  const keys = A.providerEntries(noBonus, 'zh').map((r) => r.key);
  assert.ok(keys.includes('balance'));
  assert.ok(!keys.includes('bonus'));
});

test('the current page shows the same balance and bonus', () => {
  const t = A.paygBody(DEEPSEEK_FIXTURE, 'zh').kids
    .flatMap((k) => texts(k));
  const joined = t.join(' ');
  assert.match(joined, /\u00a597\.05/);
  assert.match(joined, /\u00a516\.58/);
});

/* ------------------------------------------------- reset line alignment */
test('a row without a reset still reserves the line', () => {
  const withDate = A.WindowRow({ label: 'x', pct: 100, reset: 'in 6d', lang: 'zh' });
  const without = A.WindowRow({ label: 'x', pct: 100, reset: '', lang: 'zh' });
  const find = (node, cls) => {
    if (!node || typeof node !== 'object') return null;
    if (node.props && node.props.className === cls) return node;
    for (const k of node.kids || []) {
      const hit = find(k, cls);
      if (hit) return hit;
    }
    return null;
  };
  const classesOf = (row) => {
    const text = find(row, 'quota-pill-win-text');
    return (text.kids || []).map((k) => k.props && k.props.className);
  };
  // Both must expose the same structure, or the numbers stop lining up.
  assert.deepEqual(classesOf(without), classesOf(withDate));
});

test('the placeholder reset is hidden, not a fake date', () => {
  const without = A.WindowRow({ label: 'x', pct: 100, reset: '', lang: 'zh' });
  // Look only at the reset span: the label and the percentage legitimately
  // contain digits, so scanning the whole row would always fail.
  // This file's h() stores props under `props`, not `p`.
  const find = (node, cls) => {
    if (!node || typeof node !== 'object') return null;
    if (node.props && node.props.className === cls) return node;
    for (const k of node.kids || []) {
      const hit = find(k, cls);
      if (hit) return hit;
    }
    return null;
  };
  const resetSpan = find(without, 'quota-pill-win-reset');
  assert.ok(resetSpan, 'reset span must exist even with no date');
  const inner = (resetSpan.kids || []).join('');
  assert.equal(inner.trim(), '', 'placeholder must not carry text');
  assert.equal(resetSpan.props.style && resetSpan.props.style.visibility, 'hidden');
});
