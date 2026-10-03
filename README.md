# @A42Null/dsh-opencode-zen-plugin

DeepSeek Harness plugin that auto-adapts the [OpenCode Console (Zen) model catalog](https://opencode.ai/v2/docs/console/models).

- GitHub: <https://github.com/A42Null/dsh-opencode-zen-plugin>
- CNB package registry: <https://cnb.cool/A42Null/dsh-opencode-zen-plugin>
- npm package: `@A42Null/dsh-opencode-zen-plugin` (see Install below)

**Paste your OpenCode Console API Key in the plugin settings once — every OpenCode Zen model becomes usable in DSH.** Model list, context windows, endpoint routing, and reasoning parameters are all handled automatically.

## Features

- **Zero-config model catalog**: fetches `https://opencode.ai/zen/v1/models` (unauthenticated) on start and on a timer (default 300s); models appear in the DSH model picker automatically
- **Automatic endpoint routing** (per the official docs table):
  - `gpt-*` / `grok-*` / `muse-spark*` → OpenAI Responses API (`/zen/v1/responses`)
  - `claude-*` plus `qwen3.8-flash` / `qwen3.7-max` / `qwen3.7-plus` / `qwen3.6-plus` / `qwen3.5-plus` → Anthropic Messages (`/zen/v1/messages`)
  - `gemini-*` → Google GenerateContent (`/zen/v1/models/<id>:streamGenerateContent?alt=sse`)
  - `deepseek` / `glm` / `minimax` / `kimi` / `qwen3.8-max` / `big-pickle` / `*-free` → OpenAI-compatible (`/zen/v1/chat/completions`)
- **Metadata sync**: context windows, output budgets, and reasoning tiers come from [models.dev](https://models.dev/api.json) with a 7-day disk cache (`~/.opencode-zen/models.dev.json`); an embedded static catalog guarantees the picker is never empty offline
- **Free models hidden by default**: `*-free` belongs to OpenCode's in-client free tier; through the Console API it returns `403 FreeTierError` ("free tier can only be used from within OpenCode"), so it is excluded from the picker unless you opt in
- **Readable billing/permission errors**: insufficient funds (402), model access disabled (403), and the free-tier gate (403 FreeTierError) map to distinct error codes with actionable advice instead of a blanket "invalid API key"
- **Reasoning passthrough**: `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max`, mapped to each protocol's native field (`reasoning_effort`, `thinking.budget_tokens`, `thinkingConfig.thinkingBudget`, `reasoning.effort`)
- **Full harness stream protocol**: streamed text / reasoning / tool-call blocks, usage accounting, stop-reason mapping, and error classification (AUTH, QUOTA_EXCEEDED, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, CONTEXT_WINDOW_EXCEEDED, ...)
- **Tool calls & image input**: vision models (claude- / gemini- / deepseek-v4-flash-vision, ...) accept image attachments
- **Stream watchdog**: aborts after 120s first-byte / 300s idle to avoid hung requests

## Install

Published to the CNB package registry: <https://cnb.cool/A42Null/dsh-opencode-zen-plugin> (npm package `@A42Null/dsh-opencode-zen-plugin`)

### Option 1 — install from the CNB registry (recommended)

```bash
npm config set @A42Null:registry https://npm.cnb.cool/A42Null/dsh-opencode-zen-plugin/-/packages/
dsh plugin add @A42Null/dsh-opencode-zen-plugin
```

### Option 2 — install from a local directory

1. Get this plugin directory (e.g. `D:\DSH\插件开发\opencode-zen-dsh-plugin`)
2. `dsh plugin add D:\DSH\插件开发\opencode-zen-dsh-plugin`, or install the local package directory via the plugin manager

### Then

3. Restart DSH (or reload plugins); the plugin registers provider `opencode-zen` (override via `providerId` in `cordis.patch.yml`)

The package ships a `dsh.bundle.patch` (`cordis.patch.yml`), so installation writes the registration row into the profile patch automatically, and `dsh.client` provides the Web settings card.

## Settings (Settings → Plugins → OpenCode Zen → Configure)

> The DSH settings UI is contributed by the plugin's **client half** (`lib/client.js`): this plugin registers into the `plugins.row.config` slot (key = `<package name>#<row id>`), which gives the opencode-zen row under Settings → Plugins a Configure control. With only the host half (`lib/index.js`) the models work, but **no** settings UI appears anywhere.

| Field | Description | Default |
| --- | --- | --- |
| `apiKey` | OpenCode Console API Key — **required**. Get it at https://opencode.ai/console | empty |
| `baseUrl` | OpenCode Zen gateway base URL | `https://opencode.ai/zen` |
| `includeFreeModels` | Include free (`*-free`) models — **off by default**, since they only work inside the OpenCode client | `false` |
| `refreshSeconds` | Catalog auto-refresh interval in seconds (30–86400) | `300` |

Saving takes effect immediately — no DSH restart. As a fallback the key can also come from the `OPENCODE_ZEN_API_KEY` environment variable (the setting wins).

## Auth

All endpoints use `Authorization: Bearer <apiKey>`; Anthropic endpoints also send `x-api-key` + `anthropic-version: 2023-06-01`, Google endpoints also send `x-goog-api-key`. The model-list endpoint is unauthenticated, so models are visible before a key is set — actual calls then fail with a clear AUTH error.

## Runtime status & cache

| Path | Content |
| --- | --- |
| `~/.opencode-zen/adapter-status.json` | Catalog health snapshot: `status` / `total` / `updatedAt` / `lastError` |
| `~/.opencode-zen/models.dev.json` | models.dev metadata cache (7-day TTL, atomic tmp+rename writes) |
| `~/.opencode-zen/plugin-load.json` | Last plugin-load marker (`build` / `loadedAt` / `pid`) — tells you which code version the running DSH actually loaded |
| `~/.opencode-zen/errors.log` | Raw adapter failures: time, HTTP status, protocol, model, error code, body excerpt (128 KB cap, auto-cleared) |

> Error codes follow DSH's canonical taxonomy: `QUOTA` for an exhausted balance (drives the client's "quota used up" copy and the shell notice), `AUTH` for key problems, `FREE_TIER_BLOCKED` for the free-tier gate, `MODEL_ACCESS_DISABLED` for missing model entitlement. The last two surface the plugin's own explanatory text in the UI.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| AUTH error | Missing or invalid API Key → paste one under Settings → Plugins → OpenCode Zen → Configure; the model list needs no auth, so models stay visible without a key |
| FREE_TIER_BLOCKED (403 FreeTierError) | A `*-free` model was selected; the free tier only works inside the OpenCode client → disable "include free models" or use a paid model |
| QUOTA (402 Insufficient account funds) | The key is valid but the Console balance is empty → top up at https://opencode.ai/console |
| MODEL_ACCESS_DISABLED (403 Model access is disabled) | The Console account lacks access to that model → pick a different model |
| RATE_LIMIT (429) | Too many requests → retry later |
| opencode-zen missing from Settings | The client half is not loaded (older install / no restart) → make sure `lib/client.js` exists and `package.json` declares `dsh.client` plus the `"./client"` export, then restart DSH and reload the page |
| SERVER / TRANSPORT / TIMEOUT | Gateway/network issue → retry later; check `lastError` in `adapter-status.json` |
| CONTEXT_WINDOW_EXCEEDED | Input exceeded the model's context window → shorten the session or pick a larger-window model |
| Empty or stale model list | Live-list failures fall back to the embedded static catalog; inspect `adapter-status.json` |
| `jev-*` reports INVALID_REQUEST | That family uses the SystemOne endpoint and is not chat-capable; excluded from the catalog |

## Releasing (maintainers)

Push a tag that matches the `version` in `package.json` and the package is published to the CNB registry automatically (workflow [`.github/workflows/publish.yml`](.github/workflows/publish.yml)):

```bash
npm version patch --no-git-tag-version   # or edit version in package.json manually
git commit -am "chore: release vX.Y.Z"
git tag vX.Y.Z
git push origin main --follow-tags
```

One-time token setup: create an environment named **`cnb`** under the repository's `Settings → Environments` and add an **Environment secret**:

| Secret | Value |
| --- | --- |
| `CNB_TOKEN` | CNB access token (enable the package-registry scope when creating it) |

The workflow reads the token only from that Environment secret — **no token is ever stored in the repository**. The CNB npm username is always `cnb` (change `CNB_USERNAME` in the workflow if yours differs). A tag that does not match `package.json` fails the job, so a wrong version can never be published.

## Docs

- OpenCode Console models & endpoints: https://opencode.ai/v2/docs/console/models
- OpenCode Console (paid gateway): https://opencode.ai/console
