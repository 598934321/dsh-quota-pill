# dsh-quota-pill

A quota pill for the [DeepSeek Harness](https://github.com/deepseek-ai) web GUI:
**how much is left** on every LLM subscription you have, in one collapsible pill
next to the composer.

![quota pill](docs/screenshot.png)

It sits in the composer toolbar, shows the tightest window at a glance, and opens
into a per-provider breakdown with reset times. Switch sessions and it follows
the model — showing that provider's last reading while it refreshes, then easing
into the live number.

## What it reads

| Provider | Credential |
|---|---|
| **DeepSeek** (official) | the Platform sign-in DSH already holds — nothing to add |
| **Kimi Coding** | `refs.KIMI_CODING_API_KEY` in `~/.dsh/.credentials.yaml` |
| **OpenCode Go** | `refs.OPENCODE_GO_API_KEY` |
| **Command Code** | `refs.COMMANDCODE_API_KEY` |
| **xAI (Grok)** | OAuth token from [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) |
| **Codex (ChatGPT Plus)** | same — and CLIProxyAPI must be **running** |
| **Antigravity** | same |

**DeepSeek works with no setup at all** if you are signed in to DeepSeek Platform
in DSH — that is the official account, and it is the one most users care about.

The three API-key providers need nothing but the key. The three OAuth providers
need CLIProxyAPI installed and logged in, because that is what holds the tokens;
this plugin only reads them and never runs an OAuth flow itself.

Every provider is optional. Unconfigured ones say exactly what is missing instead
of showing a fake zero.

## Install

```bash
# 1. the DSH plugin
dsh plugin add @hystudio/dsh-quota-pill

# 2. the sidecar (reads credentials, talks to upstream APIs)
npx @hystudio/dsh-quota-pill
```

> The npm package is `@hystudio/...` while the repo lives at `598934321/...` —
> they are the same author under two account names.

The pill shows **"quota service is not running"** with that exact command until
the sidecar is up. Keep it running in the background — see
[Running it as a service](#running-it-as-a-service).

Then add whichever keys you have:

```yaml
# ~/.dsh/.credentials.yaml
refs:
  KIMI_CODING_API_KEY: sk-...
  OPENCODE_GO_API_KEY: sk-...
  COMMANDCODE_API_KEY: sk-...
```

Reload the DSH window. Done.

### Let an agent do it

The repo ships [`AGENTS.md`](AGENTS.md) — a step-by-step guide written for an AI
agent. Ask your agent to set the plugin up and it will detect what you already
have, ask only for what it cannot know (your keys), write them safely, and verify
each provider end to end.

```text
Read AGENTS.md in this repo and set up dsh-quota-pill for me.
```

## Running it as a service

`npx` in a terminal dies with the terminal. Pick one:

**macOS (launchd)** — `~/Library/LaunchAgents/dev.quota-pill.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.quota-pill</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string><string>node</string>
    <string>/absolute/path/to/bin/quota-pill-server.js</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

```bash
launchctl load ~/Library/LaunchAgents/dev.quota-pill.plist
```

**Linux (systemd)** — `~/.config/systemd/user/quota-pill.service`

```ini
[Unit]
Description=dsh-quota-pill sidecar

[Service]
ExecStart=/usr/bin/env node /absolute/path/to/bin/quota-pill-server.js
Restart=always

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now quota-pill
```

## How it works

```
DSH web GUI
   └─ client.js          renders the pill; never sees a credential
        │  HTTP (localhost)
        ▼
      sidecar           reads ~/.dsh/.credentials.yaml and ~/.cli-proxy-api/*.json,
                        calls each provider's quota endpoint, caches 60s
```

Two processes because credentials must never reach the browser, and because
upstream calls need real timeouts and a TLS stack Node's `fetch` does not have
for some hosts.

### Endpoints

| Path | Purpose |
|---|---|
| `GET /health` | liveness + provider list |
| `GET /quota?model=<id>` | one provider's reading, selected by model prefix |
| `GET /quota/all` | every provider, concurrently |
| `GET /setup` | what each provider still needs |

`?fresh=1` bypasses the 60-second cache.

### Response

```jsonc
{
  "kind": "subscription-quota",   // subscription-quota | payg | none | probe-failed
  "provider": "opencode",
  "displayName": "OpenCode Go",
  "remainingPct": 17,             // remaining, never used
  "window": "monthly",            // the binding window
  "resetAt": "2026-11-12T00:00:00.000Z",
  "products": { "rolling": 9, "weekly": 67, "monthly": 83 },  // per-window used%
  "windows": [                    // one row each in the UI
    { "key": "monthly", "remainPct": 17, "resetAt": "..." }
  ],
  "cached": false,
  "at": 1792500000000
}
```

`kind` is meant to be exhaustive so the UI never has to guess:

- `subscription-quota` — a real percentage exists
- `payg` — metered billing, no ceiling (shows spend, not a percentage)
- `none` — not configured; `error` names the missing credential
- `probe-failed` — configured but the upstream call failed

## Notes on specific providers

**Codex** is read through CLIProxyAPI's management API, which reports the
`X-Codex-*` headers CLIProxyAPI observed while proxying real traffic. The direct
`chatgpt.com/backend-api/codex/usage` endpoint sits behind Cloudflare and rejects
non-browser TLS fingerprints, so it only works as a fallback. CLIProxyAPI must be
*running*, not merely installed.

**xAI** has three account generations: grandfathered plans report a percentage
directly, current plans only reveal allowance in `x-ratelimit-*` response headers
of a one-token completion, and unified-billing accounts have no ceiling at all
(reported as `payg`).

**Antigravity** shares one quota pool across all Gemini models, so it reports a
single aggregate row — per-model rows would all be the same number and the label
would flicker between models you do not even have configured.

**Command Code** does not expose a monthly ceiling. The adapter derives it from
`monthlyCap = weekly.cap × 2`, an identity verified against two different plans
(31.6 + 38.4 = 70 with `weekly.cap` 35; 0.225 + 9.775 = 10 with `weekly.cap` 6).

**DeepSeek** is a prepaid CNY wallet, so there is no percentage to show — the pill
shows the balance and, separately, any bonus credit. Two traps worth recording:
the stored credential is a *Platform login grant*, not an `api.deepseek.com` API
key (sending it there returns 401), and calling `platform.deepseek.com` directly
returns 429 from Cloudflare. The balance is therefore read through DSH's own
`account/getBalance` RPC, which already holds the grant and projects the response
down to wallet currency and balance. We never handle the Platform token ourselves.

## Privacy

- Credentials are read from disk, used for the upstream call, and never logged.
- The sidecar binds `127.0.0.1` only.
- Nothing is sent anywhere except the provider's own quota endpoint.
- The client shows no credential, and the sidecar's JSON carries no token.

## Development

```bash
git clone https://github.com/598934321/dsh-quota-pill
cd dsh-quota-pill
npm test              # 26 tests, offline
npm start             # sidecar on :8319
```

Tests are offline by design: they point the credential layer at a nonexistent
directory so they never touch a live account. Fixtures in `test/fixtures.js` are
synthetic — no real emails, account ids, or balances.

## License

MIT
