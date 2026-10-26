<div align="center">

# dsh-model-bridge

**One local gateway in front of your WorkBuddy / Trae / Qoder free quota —
speaking OpenAI Responses (Codex), Anthropic Messages (Claude Code), and plain
OpenAI Chat Completions.**

English | [中文说明见下](#中文说明)

</div>

---

## What it does

[the coding assistant (DSH)](https://github.com/) has a great community plugin —
[dsh-workbuddy-trae-qoder-connect](https://github.com/chengshenyangtai/dsh-workbuddy-trae-qoder-connect) —
that pools the **free quota** of three AI coding clients into one model picker inside DSH:

| Channel | What you get | Login |
|---|---|---|
| **WorkBuddy** (CN + AI international) | daily check-in credits; intl has limited-time free models like `deepseek-v4.1-flash` at ×0.00 | desktop App, or QR / paste |
| **Trae CN** | full IDE model roster | local IDE credential export |
| **Qoder CN** | daily check-in campaign | desktop App session or PAT |

But those models are locked inside DSH. **This project takes the plugin's own provider
drivers and assembles them into a standalone gateway**, so the same quota works in
**Codex CLI** and **Claude Code** too — without modifying a single line of the plugin.

```
Codex CLI ──Responses──┐
                       ├──▶ dsh-model-bridge :18780 ──▶ plugin shims ──▶ upstreams
Claude Code ─Messages──┤         (dialect translate)
                       │
anything ──chat/completions──┘
```

One endpoint, four channels, three wire dialects:

| Endpoint | Client | Dialect |
|---|---|---|
| `POST /v1/responses` | **Codex** | OpenAI Responses (SSE) |
| `POST /v1/messages` | **Claude Code** | Anthropic Messages (SSE, thinking + tool_use) |
| `POST /v1/chat/completions` | anything else | OpenAI Chat (stream + non-stream) |
| `GET /v1/models` | both | unified catalog, namespaced `channel/model` |

## Quick start

Requirements: Node ≥ 22 (or Docker), and the desktop apps installed & signed in on
this machine (WorkBuddy, Trae IDE, Qoder CN) — the gateway reads **already-decrypted
plaintext snapshots**, it never touches keychains itself. Export snapshots once with
the plugin's own scripts (see [Credentials](#credentials)).

```bash
git clone https://github.com/sandyhery/dsh-model-bridge.git
cd dsh-model-bridge
npm install
bash scripts/sync-provider.mjs     # vendor the plugin's lib/ (pinned, MIT)
bash scripts/up.sh                 # builds, starts, prints your client config
```

`scripts/up.sh` waits for `/healthz` and prints exactly what to paste:

```
BRIDGE_API_KEY=brg-xxxxxxxxxxxxxxxx
ANTHROPIC_BASE_URL=http://127.0.0.1:18780
ANTHROPIC_AUTH_TOKEN=brg-xxxxxxxxxxxxxxxx
```

Or with Docker only:

```bash
echo "BRIDGE_TOKEN=$(bash scripts/token.sh)" > .env
docker compose up -d --build
```

## Wire it into Codex

`~/.codex/config.toml` (append; your default provider stays untouched):

```toml
[model_providers.bridge]
name = "dsh-model-bridge"
base_url = "http://127.0.0.1:18780/v1"
wire_api = "responses"
env_key = "BRIDGE_API_KEY"
```

> Codex ≥ 0.16x **removed** `wire_api = "chat"` — it only speaks Responses now.
> This bridge translates chat-completions upstream into the Responses event stream.

Profile must live in a **separate file** `~/.codex/bridge.config.toml`
(newer Codex rejects legacy `[profiles.x]` tables in the main file):

```toml
model_provider = "bridge"
model = "workbuddy4/deepseek-v4.1-flash"
model_reasoning_effort = "none"
approval_policy = "never"
sandbox_mode = "danger-full-access"
```

Then:

```bash
export BRIDGE_API_KEY=$(cat ~/.dsh-model-bridge/token)
codex --profile bridge                       # interactive; picker lists every bridged model
codex --profile bridge -m trae/glm-5.3-flash # switch channel
```

For the model picker to list bridge models, generate a catalog and point the profile
at it (`model_catalog_json = "/path/to/bridge-models.json"`):

```bash
bash bin/sync-models.sh        # writes ~/.codex/bridge-models.json from GET /v1/models
```

## Wire it into Claude Code

Don't touch your global `~/.claude/settings.json` — use the bundled launcher, which
overrides env vars **for that process only** and health-checks the bridge first:

```bash
ln -sf "$PWD/bin/cc-bridge" ~/.local/bin/cc-bridge
cc-bridge                                     # default channel
cc-bridge -p "hi"                             # args pass through to claude
CC_MODEL=qoder/qmodel_38max cc-bridge         # switch channel
```

## Multi-account

WorkBuddy supports multiple slots natively (`workbuddy1`, `workbuddy2`, …).
**Qoder/Trae are single-instance in the upstream plugin** — the provider routes and
state files are hard-wired singletons, so a second registry row just renders as
permanently unavailable.

This bridge lifts that for Qoder by assembling **independent instances** per
credential file:

```
~/.dsh/connect-auth/qoder-session.json      → models under qoder/…
~/.dsh/connect-auth/qoder-session-2.json    → models under qoder2/…
~/.dsh/connect-auth/qoder-session-3.json    → qoder3/…  (up to -5)
```

Drop in another snapshot, restart the bridge, and both accounts appear side by side
in Codex / Claude Code. A malformed or expired snapshot only skips its own slot —
one dead account can't take the channel down.

To get a second Qoder snapshot: sign in with account B in the desktop app, export
it to `qoder-session-2.json`, then sign back in with account A and re-export.

## Model naming

Always `channel/model` — `workbuddy1`, `workbuddy4` (AI intl), `trae`, `qoder`,
`qoder2`, …. A bare id works **only** when it's unique across channels
(`deepseek-v4.1-flash` exists on both WorkBuddy lines → prefix required).

```bash
curl -s http://127.0.0.1:18780/v1/models -H "Authorization: Bearer $(cat ~/.dsh-model-bridge/token)" \
 | python3 -c "import json,sys;[print(m['id']) for m in json.load(sys.stdin)['data']]"
```

## Credentials

The gateway is **read-only** with respect to credentials. It consumes plaintext
snapshot files from `$DSH_HOME/connect-auth/` (default `~/.dsh/connect-auth/`):

| File | Channel | Format |
|---|---|---|
| `qoder-session.json` / `-2.json` … | Qoder CN | `{token, refreshToken, expiresAt, uid, name, email}` |
| `trae.json` | Trae CN | plugin credential snapshot |
| `workbuddy1.json`… / `workbuddy4.json` | WorkBuddy | desktop format `{account:{…}, auth:{accessToken,…}}` or own-copy `{version, credential:{…}}` — both accepted |

How snapshots get there in the first place: the upstream plugin's auth flows
(desktop-app credential decryption on macOS, QR login, IDE export). On macOS the
WorkBuddy envelope needs the **app's own Electron binary** to decrypt — this bridge
never does that; it consumes the decrypted output. Snapshots expire; re-export and
`docker compose restart` (or just wait — session files are re-read per request by
the upstream stores, and the bridge restart is the belt-and-braces step).

Nothing account-related is stored in this repo: no tokens, no paths to your home
directory, no account ids.

## Account CLI (`bridge`)

The bundled `bin/bridge` observes all channels without starting the gateway —
the missing piece of `dsh-workbuddy-connect` 0.7.9's `status / doctor / logout`
CLI, in a four-channel shape:

```bash
ln -sf "$PWD/bin/bridge" ~/.local/bin/bridge

bridge status    # signed-in state, token expiry, per channel — no upstream call
bridge credits   # WorkBuddy billing query (real metering API, per slot)
bridge quota     # Qoder OpenAPI usage (used/total/percent)
bridge doctor    # snapshots, Electron availability, catalog source — exit 1 on failure
bridge logout workbuddy1   # remove the plugin-owned copy only
```

All commands accept `--json` for machine-readable output. Everything except
`logout` is read-only. Credits/quota hit real metering endpoints — expect
those calls to be metered by the vendor.

## Operations

```bash
docker compose up -d --build   # start (build after code changes)
docker compose restart         # restart (after credential refresh)
docker logs -f dsh-model-bridge
docker compose down            # stop
```

Health: `GET /healthz` → `{"ok":true,"channels":[{"id":"workbuddy4","models":29},…]}`.

After the upstream plugin updates: `bash scripts/sync-provider.mjs && docker compose up -d --build`.

## Design notes (the parts that cost us blood)

- **All three plugin shims ignore `stream:false`** and always answer with SSE —
  non-stream requests must be re-aggregated locally from the chunk stream
  (`src/aggregate.mjs`), or clients parse `data:` lines as JSON and explode.
- **Codex ≥ 0.16x speaks only Responses.** The translation layer
  (`src/responses.mjs`) emits exactly the event set Codex accepts; adding
  `response.reasoning_summary_part.added` / `response.content_part.done` makes
  Codex loop on `Reconnecting…` — verified the hard way.
- **Credential formats are load-bearing**: WorkBuddy's desktop-path parser expects
  `{auth:{accessToken,…}}` while the plugin's own-copy format is
  `{version, credential:{…}}` — swapping them yields `no signed-in account`.
- **`DSH_HOME` must be set explicitly in containers** (default is `$HOME/.dsh`,
  which is `/root/.dsh` inside the container → catalogs silently fall back to
  fallback rosters).
- **Upstream catalogs are account-tiered**: a fresh Qoder account's `model/list`
  marks most models `enable=false`. That's the vendor's gating, not a bridge bug —
  the bridge filters by `enable`, consistent with what DSH's panel shows.
- Trae's shim calls `options.settings()` per request; standalone assembly must
  provide that closure or every call 500s.

## License

MIT for this repo's own code (`src/`, `bin/`, `scripts/`). The vendored
`vendor/` directory is an unmodified copy of the upstream plugin's `lib/`
(MIT, © chengshenyangtai) — see [NOTICE](NOTICE) and [vendor/LICENSE](vendor/LICENSE).

This is an independent integration harness, not affiliated with Qoder, Trae,
WorkBuddy/CodeBuddy, or the coding assistant. You are responsible for complying
with each upstream provider's terms of service.

---

<div align="center">

## 中文说明

</div>

### 这是什么

DSH 的社区插件 [dsh-workbuddy-trae-qoder-connect](https://github.com/chengshenyangtai/dsh-workbuddy-trae-qoder-connect)
把 WorkBuddy（国区 + AI 国际版）、Trae CN、Qoder CN 三家客户端的**免费额度**收进了 DSH 的
模型下拉。但额度锁在 DSH 里。

本工程把插件自带的 provider 驱动（`vendor/`，MIT，原样拷贝）**自己装配**成独立网关，
同一份额度于是也能喂给 **Codex CLI** 和 **Claude Code**——插件源码一行不改。

三个方言出口：`/v1/responses`（Codex）、`/v1/messages`（Claude Code，含 thinking 与
tool_use 的 SSE 翻译）、`/v1/chat/completions`（透传，流式与非流式都行）。

### 快速开始

前置：Node ≥ 22 或 Docker；本机装好三个桌面客户端并登录（WorkBuddy、Trae IDE、Qoder CN）。
网关读的是**已解密的明文快照**，不碰钥匙串——快照用插件自带的登录/导出流程生成。

```bash
git clone https://github.com/sandyhery/dsh-model-bridge.git
cd dsh-model-bridge && npm install
bash scripts/sync-provider.mjs
bash scripts/up.sh     # 起桥并打印客户端要填的三个值
```

### 接 Codex

`~/.codex/config.toml` 追加 `[model_providers.bridge]`（上面英文节有完整片段），
profile 放独立文件 `~/.codex/bridge.config.toml`，然后：

```bash
codex --profile bridge
```

要让选择器列出桥上全部模型，先 `bash bin/sync-models.sh` 生成
`~/.codex/bridge-models.json`，并在 profile 里写
`model_catalog_json = "<绝对路径>/bridge-models.json"`。
或者直接用启动器（已探活 + 自动带 key）：

```bash
ln -sf "$PWD/bin/codex-bridge" ~/.local/bin/codex-bridge
codex-bridge
```

### 接 Claude Code

```bash
ln -sf "$PWD/bin/cc-bridge" ~/.local/bin/cc-bridge
cc-bridge                          # 默认渠道
CC_MODEL=trae/glm-5.3-flash cc-bridge
```

### 多账号（Qoder 也能双开）

上游插件把 qoder/trae 钉成单实例，本桥解除了这个限制——每个凭据快照一个独立实例：

```
connect-auth/qoder-session.json      → qoder/…
connect-auth/qoder-session-2.json    → qoder2/…
```

放好第二份快照、重启桥，两个账号的模型并排出现在选择器里。一份快照过期只影响自己的槽位。

### 模型命名

`渠道/模型`。裸 id 仅在四家唯一时可用（`deepseek-v4.1-flash` 国区和国际版都有 → 必须带前缀）。

### 凭据与安全

网关对凭据**只读**：不碰钥匙串、不落明文日志、仓库里没有任何账号数据
（`.env` 与 `*.token` 在 `.gitignore`）。快照过期就按插件流程重导出。

### License

本仓库自有代码 MIT；`vendor/` 是上游插件 `lib/` 的原样拷贝（MIT，© chengshenyangtai），
见 [NOTICE](NOTICE)。本项目与 Qoder / Trae / WorkBuddy / CodeBuddy / the coding assistant
无隶属关系；请自行遵守各上游服务的使用条款。
