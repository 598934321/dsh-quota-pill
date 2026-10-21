/**
 * Synthetic sidecar payloads.
 *
 * Deliberately NOT captured from a real account: no emails, no account ids, no
 * real credit balances. Shapes mirror what the adapters produce, values are
 * invented. Tests must never depend on a live subscription.
 */
export const FIXTURES = {
  opencode: {
    kind: 'subscription-quota',
    provider: 'opencode',
    displayName: 'OpenCode Go',
    account: 'opencode-go',
    remainingPct: 17,
    usedPct: 83,
    window: 'monthly',
    resetAt: '2026-11-12T00:00:00.000Z',
    products: { rolling: 9, weekly: 67, monthly: 83 },
    windows: [
      { key: 'rolling', remainPct: 91, resetAt: '2026-10-21T18:00:00.000Z' },
      { key: 'weekly', remainPct: 33, resetAt: '2026-10-27T00:00:00.000Z' },
      { key: 'monthly', remainPct: 17, resetAt: '2026-11-12T00:00:00.000Z' },
    ],
  },

  commandcode: {
    kind: 'subscription-quota',
    provider: 'commandcode',
    displayName: 'Command Code',
    account: 'example-plan',
    remainingPct: 0,
    usedPct: 100,
    window: 'weekly',
    resetAt: '2026-10-22T00:00:00.000Z',
    products: { '5h': 100, weekly: 0, monthly: 50 },
    windows: [
      { key: '5h', remainPct: 0, resetAt: '2026-10-22T00:00:00.000Z' },
      { key: 'weekly', remainPct: 100, resetAt: '2026-10-28T00:00:00.000Z' },
      { key: 'monthly', remainPct: 50, resetAt: null },
    ],
  },

  xai: {
    kind: 'subscription-quota',
    provider: 'xai',
    displayName: 'xAI (Grok)',
    account: 'example@example.com',
    remainingPct: 1,
    usedPct: 99,
    window: 'USAGE_PERIOD_TYPE_WEEKLY',
    resetAt: '2026-10-25T22:32:19.529383+00:00',
    products: { GrokBuild: 99 },
    windows: [{ key: 'GrokBuild', remainPct: 1, resetAt: null }],
  },

  codex: {
    kind: 'subscription-quota',
    provider: 'codex',
    displayName: 'Codex (ChatGPT Plus)',
    account: 'example@example.com',
    remainingPct: 98,
    usedPct: 2,
    window: 'weekly',
    resetAt: '2026-10-28T00:00:00.000Z',
    products: { '5h': 0, weekly: 2 },
    windows: [
      { key: '5h', remainPct: 100, resetAt: '2026-10-21T20:00:00.000Z' },
      { key: 'weekly', remainPct: 98, resetAt: '2026-10-28T00:00:00.000Z' },
    ],
  },

  agy: {
    kind: 'subscription-quota',
    provider: 'agy',
    displayName: 'Antigravity',
    account: 'example@example.com',
    remainingPct: 100,
    usedPct: 0,
    window: 'model-pool',
    resetAt: '2026-10-21T21:00:00.000Z',
    products: {},
    // Shared pool: every model reports the same fraction, so no per-model rows.
    windows: [],
  },

  kimi: {
    kind: 'none',
    provider: 'kimi',
    displayName: 'Kimi Coding',
    error: 'no KIMI_CODING_API_KEY in ~/.dsh/.credentials.yaml',
  },
};

/** A provider that reports metered spend with no ceiling (xAI unified billing). */
export const PAYG_FIXTURE = {
  kind: 'payg',
  provider: 'xai',
  displayName: 'xAI (Grok)',
  account: 'example@example.com',
  label: 'metered',
  note: 'unified billing, no quota ceiling',
  remainingPct: null,
  products: {},
  windows: [],
};

/** A provider whose upstream call failed — must not look like 0% left. */
export const FAILED_FIXTURE = {
  kind: 'probe-failed',
  provider: 'codex',
  displayName: 'Codex (ChatGPT Plus)',
  error: 'http 403: challenge',
  windows: [],
};
