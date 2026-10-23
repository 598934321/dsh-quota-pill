# Agent setup guide — dsh-quota-pill

This file is for **AI agents** helping a human install and configure the plugin.
Follow it top to bottom. It is written so that you can run the whole flow, asking
the human only for things only they can supply (an API key, an OAuth login).

> **Rule for the whole flow: never invent a quota number.** If a provider cannot
> be read, say so and explain what is missing. A wrong number is worse than "—".

---

## Before 1: install the bundle into DSH

This guide assumes the **bundle** is installed and enabled, not just the sidecar.
For a fresh DSH Desktop:

1. If `dsh` is not on PATH: DSH Desktop → Settings → **Manage dsh Command**.
2. Install a **pinned** build, never the bare name:
   - GUI: **Plugins → Install** → `@hystudio/dsh-quota-pill@0.2.10`
   - CLI: `dsh plugin add @hystudio/dsh-quota-pill@0.2.10 --profile desktop`
   - Until 0.2.10 is on npm:
     `github:598934321/dsh-quota-pill#feat/oob-discovery-0.2.10`
3. Confirm the dependency and the bundle are present:

   ```bash
   python3 - <<'PY'
   import json, os
   p = os.path.expanduser('~/.dsh/profiles/desktop/package.json')
   d = json.load(open(p))
   print(d.get('dependencies', {}).get('@hystudio/dsh-quota-pill'))
   print('enabled:', '@hystudio/dsh-quota-pill' in d.get('dsh', {}).get('profile', {}).get('bundles', []))
   PY
   ```

**Why pinned:** pnpm's `minimumReleaseAge` can resolve an unpinned install to the
broken 0.2.2 (its client half fails to import and the web GUI shows "Failed to
load plugins"). 0.2.10 is the first version with all providers, Open Design
Control Keys, and sidecar auto-start.

The host half starts the sidecar when nothing is listening on :8319, so a normal
desktop install does **not** need a separate `npx` or launchd unit.

---

## 0. What this plugin does

It shows how much quota is **left** for the LLM subscriptions the user has, in a
small pill in the DeepSeek Harness web GUI.

Architecture — two pieces, both required:

```
DSH web GUI  ──►  client.js   (the pill; renders JSON)
                      │
                      ▼
                  sidecar      (Node process; reads credentials + upstream APIs)
```

The pill shows nothing until the sidecar runs. That is by design: credentials
must never reach the browser.

There are **two credential families**, and this matters for every step:

| Family | Providers | What the user needs |
|---|---|---|
| DSH Platform sign-in | `deepseek` | **nothing** — works if they are signed in to DeepSeek Platform in DSH |
| API key | `kimi`, `opencode`, `commandcode` | a key pasted into `~/.dsh/.credentials.yaml` |
| OAuth via CLIProxyAPI | `xai`, `codex`, `agy` | **CLIProxyAPI installed and logged in once** |
| Open Design Control Key | `opendesign` | a `vela_ctrl_…` Control Key from the Open Design device sign-in, plus the workspace id (optional); a `__Secure-better-auth.session_token` console cookie is a fallback |

**Check DeepSeek first.** It is the official account and needs no setup beyond a
DSH Platform sign-in, so it is usually the one the user actually wants. If it
reports `none` with "not signed in to DeepSeek Platform", tell them to use the
DSH account menu, then re-run step 5.

---

## 1. Verify the sidecar runs

The 0.2.10 host plugin starts it automatically when :8319 is free. Give DSH a few
seconds, then check. If the host half could not start it (or you opted out with
`QUOTA_PILL_NO_AUTOSTART=1`), run it manually:

```bash
npx @hystudio/dsh-quota-pill
```

Expected first lines:

```
[quota-pill] listening on http://127.0.0.1:8319
[quota-pill] credentials: /Users/<user>/.dsh/.credentials.yaml
[quota-pill] CLIProxyAPI: /Users/<user>/.cli-proxy-api        ← or "not set up"
```

Then, in another shell:

```bash
curl -s http://127.0.0.1:8319/health
# {"ok":true,"port":8319,"providers":["deepseek","kimi","opencode","commandcode","xai","codex","agy","opendesign"]}
```

If `CLIProxyAPI: not set up`, the three OAuth providers will report "needs
CLIProxyAPI". That is expected on a fresh machine — tell the human that
`kimi` / `opencode` / `commandcode` work without it, and ask whether they want
the OAuth three as well.

**Auto-start is the default from 0.2.10**; do not add a service unless the human
asks for one or DSH is headless. If you do add one, set
`QUOTA_PILL_NO_AUTOSTART=1` so the plugin and the service do not race, and use
the **absolute** Node path (launchd's PATH does not include nvm/homebrew):

```bash
# macOS: ~/Library/LaunchAgents/dev.quota-pill.plist
#   ProgramArguments: ["/absolute/path/to/node","<abs path>/bin/quota-pill-server.js"]
#   RunAtLoad: true
#   KeepAlive: true
#   EnvironmentVariables: { QUOTA_PILL_NO_AUTOSTART: "1" }
```

Ask before installing a service — that is a persistent change to their machine.

---

## 2. Discover what the user actually has

Do **not** guess, and do not make the human enumerate providers from memory.
Use the sidecar's discovery data first:

1. **DSH catalog + supported adapters + required refs:**

   ```bash
   curl -s 'http://127.0.0.1:8319/setup?fresh=1' | python3 -m json.tool
   ```

   `catalog` is DSH's live `session/modelCatalog` — the providers the app can
   route to right now. Each entry in `providers` carries `inCatalog`,
   `requires`, and `credential`. Compare those with `catalog` to know exactly
   what is present, what is supported, and what each missing one needs.

2. **What is already readable:**

   ```bash
   curl -s 'http://127.0.0.1:8319/quota/all?fresh=1' | python3 -m json.tool
   ```

3. **Credential files** (names only; never print values):
   `~/.dsh/.credentials.yaml` refs, and `~/.cli-proxy-api/*` token files.

Then ask **only** for what cannot be inferred: an API key, an OAuth login, or an
Open Design browser approval. Suggested one message:

> Your DSH catalog has: <ids>. I can already read <working>. For <missing> I need
> <one action each>. Which would you like me to set up?

If the catalog has an id that is **not one of the eight adapters**, say plainly
that the plugin has no adapter for it; do not claim it will appear by itself.

If the user has none of them: stop and say the plugin has nothing to show yet.
Do not install a fake provider to "make it look working".

---

## 3. Write the API keys

Keys live in `~/.dsh/.credentials.yaml` under `refs`. **Read the file first** —
it usually already exists and contains other credentials that must not be lost.

```yaml
refs:
  KIMI_CODING_API_KEY: sk-...
  OPENCODE_GO_API_KEY: sk-...
  COMMANDCODE_API_KEY: sk-...          # or reuse COMMANDCODE_GOAT_API_KEY
```

Rules:

- **Append or edit one line at a time.** Never rewrite the whole file from a
  template — that would delete the user's other credentials.
- **Never echo a key back** into the chat, a log, or a commit. After writing,
  verify only that the key is *present*, not what it is.
- If the file does not exist, create it with `chmod 600`.

Verify each one without printing it:

```bash
python3 - <<'PY'
import yaml, os
d = yaml.safe_load(open(os.path.expanduser('~/.dsh/.credentials.yaml')))
refs = d.get('refs') or {}
for k in ('KIMI_CODING_API_KEY','OPENCODE_GO_API_KEY','COMMANDCODE_API_KEY','COMMANDCODE_GOAT_API_KEY'):
    print(f'{k}: ' + ('present' if refs.get(k) else 'MISSING'))
PY
```

---

## 4. Configure the OAuth three (only if asked for)

These read token files that **CLIProxyAPI** writes. This plugin never performs
the OAuth flow itself.

1. Check whether CLIProxyAPI is already there:

   ```bash
   ls ~/.cli-proxy-api/ 2>/dev/null
   ```

2. If the directory is missing, tell the human:

   > xAI / Codex / Antigravity need CLIProxyAPI installed and logged in once.
   > It writes tokens to `~/.cli-proxy-api/`, which is what I read.
   > Install it, log into those services, then tell me — or skip them for now.

3. Once logged in, confirm the files appeared:

   ```bash
   ls ~/.cli-proxy-api/ | grep -E '^(xai|codex|antigravity)-'
   ```

4. **Codex needs CLIProxyAPI to be *running***, not just installed. Codex quota
   is read from CLIProxyAPI's management API (`/v0/management/auth-files`), which
   reports the `X-Codex-*` headers CLIProxyAPI observed. Without it running, the
   fallback hits `chatgpt.com`, which blocks non-browser TLS and returns 403.

### Open Design (optional)

Open Design quota uses a **Control Key** (`vela_ctrl_…`), not the `sk-amr-…`
inference key. Run the bundled device sign-in and approve its URL in the user's
browser:

```bash
node bin/opendesign-login.js --write
```

That writes `OPENDESIGN_CONTROL_KEY` and `OPENDESIGN_WORKSPACE_ID` into
`~/.dsh/.credentials.yaml`. A console session cookie
(`OPENDESIGN_SESSION_COOKIE`) is still accepted as a fallback. If the user only
has an inference key, skip Open Design — an inference key returns 401 on the
control plane.

---

## 4b. Adding or removing a provider later

No restart/reinstall is needed for supported providers:

| Change | When it appears |
|---|---|
| New credential for a supported provider already in the DSH catalog | next `/quota/all` (All refresh); no sidecar restart |
| New provider group added to DSH's catalog | within the 2-minute catalog TTL, or immediately with `/quota/all?fresh=1` / **Refresh** / reopening All |
| Provider removed from DSH | same: next refresh removes it |
| Brand-new provider **type** (not one of the eight adapters) | needs an adapter in this repo; the catalog alone is not enough |

The All page reads fresh on open, on **Refresh**, and when DSH regains focus; it
is not a background poll. `/setup?fresh=1` is the quickest way for an agent to
see the current catalog and which supported provider it has no credential for.

---

## 5. Verify end to end

```bash
curl -s 'http://127.0.0.1:8319/quota/all?fresh=1' | python3 -m json.tool | head -40
```

For each provider look at `kind`:

| `kind` | Meaning |
|---|---|
| `subscription-quota` | working — `remainingPct` and `windows` are populated |
| `none` | not configured — the `error` field says exactly what to add |
| `probe-failed` | configured but the upstream call failed — see `error` |
| `payg` | prepaid/metered — no ceiling, so no percentage. If `credits.remain` is set, that is the balance to report |

Cross-check one provider against its official dashboard if the human is unsure.
**The plugin reports remaining quota, not used.**

If a provider came back `none` with `no <REF>`, the key did not get written —
go back to step 3. Do not report success while any asked-for provider is `none`.

---

## 6. Report back

Tell the human, per provider: how much is left and when it resets. Then state
plainly:

- which providers are working
- which are skipped, and the single action that would enable each

Do not paste raw JSON. Do not claim a provider works if it returned `none` or
`probe-failed`.

---

## Troubleshooting

**Pill shows "quota service is not running"**
The sidecar is not up, or is on another port. Start it; if it must live on a
different port, set `window.__QUOTA_PILL_PORT__` or run with `QUOTA_PILL_PORT=…`
and set the same on the client side.

**`probe-failed` with http 403 / ECONNRESET**
Some upstreams (`chatgpt.com`, `googleapis`, `grok.com`) need either CLIProxyAPI
or a local proxy. Codex additionally needs CLIProxyAPI *running* for its
observed-headers route.

**`none` with "no … in ~/.dsh/.credentials.yaml"**
The key is missing. Steps above show the exact `refs.` name to add.

**Everything is `none` even though keys exist**
Check the sidecar's printed `credentials:` path — it may be reading a different
`DSH_HOME` than the one the user edited.

**Numbers look stale**
The sidecar caches for 60s. `?fresh=1` forces an upstream read. The pill does
this automatically when the session context changes.
