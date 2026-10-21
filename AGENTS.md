# Agent setup guide — dsh-quota-pill

This file is for **AI agents** helping a human install and configure the plugin.
Follow it top to bottom. It is written so that you can run the whole flow, asking
the human only for things only they can supply (an API key, an OAuth login).

> **Rule for the whole flow: never invent a quota number.** If a provider cannot
> be read, say so and explain what is missing. A wrong number is worse than "—".

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
| API key | `kimi`, `opencode`, `commandcode` | a key pasted into `~/.dsh/.credentials.yaml` |
| OAuth via CLIProxyAPI | `xai`, `codex`, `agy` | **CLIProxyAPI installed and logged in once** |

---

## 1. Verify the sidecar runs

```bash
npx @598934321/dsh-quota-pill
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
# {"ok":true,"port":8319,"providers":["kimi","opencode","commandcode","xai","codex","agy"]}
```

If `CLIProxyAPI: not set up`, the three OAuth providers will report "needs
CLIProxyAPI". That is expected on a fresh machine — tell the human that
`kimi` / `opencode` / `commandcode` work without it, and ask whether they want
the OAuth three as well.

**Keep it running.** Do not leave it in the foreground of a terminal the human
will close. Offer a background service (launchd on macOS, systemd on Linux):

```bash
# macOS: ~/Library/LaunchAgents/dev.quota-pill.plist
#   ProgramArguments: ["/usr/bin/env","node","<abs path>/bin/quota-pill-server.js"]
#   RunAtLoad: true
#   KeepAlive: true
```

Ask before installing a service — that is a persistent change to their machine.

---

## 2. Ask which providers the user actually has

Do **not** guess. Ask, in one message, listing the options with what each needs:

> I can read quota for six providers. Which do you have?
>
> - **Kimi Coding** — needs a `KIMI_CODING_API_KEY`
> - **OpenCode Go** — needs an `OPENCODE_GO_API_KEY`
> - **Command Code** — needs a `COMMANDCODE_API_KEY`
> - **xAI / Grok**, **Codex / ChatGPT Plus**, **Antigravity** — need CLIProxyAPI installed and logged in
>
> Tell me which ones, and paste the key for any of the first three.

If they have none of them: stop and say the plugin has nothing to show yet.
Do not install a fake provider to "make it look working".

---

## 3. Write the API keys

Keys live in `~/.dsh/.credentials.yaml` under `refs`. **Read the file first** —
it usually already exists and contains other credentials that must not be lost.

```yaml
refs:
  KIMI_CODING_API_KEY: sk-...
  OPENCODE_GO_API_KEY: sk-...
  COMMANDCODE_API_KEY: sk-...
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
for k in ('KIMI_CODING_API_KEY','OPENCODE_GO_API_KEY','COMMANDCODE_API_KEY'):
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
| `payg` | metered billing with no ceiling; no percentage exists |

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
