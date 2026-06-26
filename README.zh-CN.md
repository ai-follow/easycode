# EasyCode

> [English README](README.md)

EasyCode 是一个面向桌面 AI 编程客户端的远程消息中继，例如 Cursor、Claude Code 和 Codex。项目本身不会替这些客户端做安全或审批决策。它负责把客户端事件镜像到移动设备，并把用户输入转发回选中的桌面客户端。

## 当前已实现

- 用于类型检查、测试和生产构建的 GitHub Actions CI。
- 自动化 relay + mock desktop + simulated mobile 端到端 smoke test，覆盖加密 payload 路径、通用 `continue` 投递、交互响应和重连 replay。
- 共享 protocol package，提供类型化 relay envelope 和客户端 adapter model。
- 为非 TypeScript 客户端（例如未来的 Flutter app）生成的 protocol JSON Schema。
- 为 relay HTTP endpoint 和 WebSocket upgrade 参数生成的 OpenAPI artifact。
- 支持 desktop/mobile `key_exchange` 控制消息和 opaque encrypted relay payload 的 protocol。
- 共享 E2EE helper package，用于通过 P-256 ECDH、HKDF 和 AES-GCM 派生 relay payload key，并加密或解密 payload body。
- WebSocket relay server，支持 memory 和 PostgreSQL store、按 pairing 维护 server sequence number、replay backlog 和 reconnect cursor。
- Desktop agent core，并提供完整 mock adapter 用于端到端验证。
- Cursor、Codex 和 Claude 客户端的 macOS accessibility adapter 基础能力：window discovery、visible text snapshot、interaction option extraction 和基于剪贴板的 input delivery。
- 面向移动端优先的 web/PWA client，用于 Android 浏览器验证，支持保存 pairing credential、自动重连、`afterSeq` replay recovery 和可安装 PWA metadata。客户端提供的 continue/approve 类交互选项会作为一键 primary action 展示，同时仍保留完整选项列表；当没有客户端交互待处理时，同一个 primary action 会向选中 session 发送普通 `continue` 消息。
- 原生 Android/iOS Flutter source skeleton，遵循同一 relay protocol shape，包括保存 pairing credential 和 reconnect cursor、内存 outbound ack queue，以及在本机具备 Flutter 后可验证的同一 E2EE message flow。

## 快速开始

```bash
pnpm install
pnpm build
pnpm test:e2e
pnpm dev:lan -- --adapter codex
```

`pnpm dev:lan` 会同时启动本地 relay、mobile web client 和 desktop agent。它默认使用 continue-only mode，使用 `--lan-host auto`，并打印一条同一网络下手机可打开的 mobile pairing URL。其他目标可使用 `--adapter cursor`、`--adapter claude-code` 或 `--adapter mock`。添加 `--dry-run` 可以只打印子命令而不启动它们。使用 `--pairing-state-file /tmp/easycode-pairing.json` 可以做临时验证，避免触碰默认 desktop pairing state。

如果要手动分别运行每个服务，请先启动 relay：

```bash
pnpm dev:server
```

在另一个终端启动 desktop agent：

```bash
pnpm dev:desktop -- --adapter mock --server http://localhost:8787
```

如果手机和电脑在同一个网络下，可以让 desktop agent 推断 LAN URL 并打印预填的 mobile pairing link：

```bash
pnpm dev:desktop -- --adapter mock \
  --server http://localhost:8787 \
  --lan-host auto
```

`--lan-host auto` 会选择一个非 loopback IPv4 地址，为手机重写本地 relay URL，并假设 mobile web dev server 运行在 5173 端口。如果选择了错误网卡，请显式传入电脑 IP：

```bash
pnpm dev:desktop -- --adapter mock \
  --server http://localhost:8787 \
  --lan-host 192.168.1.80
```

也可以传入完整显式 URL：

```bash
pnpm dev:desktop -- --adapter mock \
  --server http://localhost:8787 \
  --mobile-server http://192.168.1.80:8787 \
  --mobile-url http://192.168.1.80:5173
```

`--server` 是 desktop agent 使用的 relay URL。`--mobile-server` 是手机可访问的 relay URL；如果两端使用同一个 URL，或者已经使用 `--lan-host`，可以省略它。

对于非本地 relay，请使用 admin token 保护 pairing 创建：

```bash
EASYCODE_RELAY_ADMIN_TOKEN=change-me pnpm dev:server
pnpm dev:desktop -- --adapter mock --server http://localhost:8787 --relay-token change-me
```

Relay WebSocket 使用 heartbeat ping 清理失效连接。可用 `EASYCODE_WS_HEARTBEAT_MS` 覆盖间隔。Pairing code 默认有效期是 10 分钟，可通过 `EASYCODE_PAIRING_TTL_MS` 修改。内存 reconnect replay backlog 默认每个 pair 保存 200 个 envelope，可通过 `EASYCODE_RELAY_BACKLOG_LIMIT` 修改。最近 envelope id 去重窗口默认每个 pair 1000 个 id，可通过 `EASYCODE_RELAY_DEDUPE_LIMIT` 修改。

Desktop agent 会自动重连，并在 relay socket 不可用时保留一个短内存发送队列。Outbound envelope 会在 relay 返回 transport `ack` 前保持同一个 id，因此 relay 可以对重连重试做去重。如果 relay 拒绝 desktop socket token，desktop agent 会停止重连，因为 pairing 已经无效。

使用 `/health` 做诊断，使用 `/ready` 做容器 readiness probe。Readiness 会检查 relay store；配置了 Redis fanout bus 时也会检查它。

为 hosted mobile web client 设置 `EASYCODE_ALLOWED_ORIGINS` 作为逗号分隔 allowlist；本地开发默认是 `*`。该 allowlist 会应用到 HTTP CORS 和浏览器 WebSocket Origin header。

设置 `EASYCODE_RELAY_STORE=memory` 可使用本地内存状态；设置 `EASYCODE_RELAY_STORE=postgres` 并提供 `EASYCODE_POSTGRES_URL` 可使用初始 durable PostgreSQL-backed store。Store 位于接口之后，因此后续添加 Redis 或其他 runtime coordination driver 时不需要修改 HTTP 或 WebSocket protocol 层。

当多个 relay node 需要把 live envelope fan out 到连接在不同节点的 desktop 和 mobile socket 时，设置 `EASYCODE_RELAY_FANOUT=redis` 和 `EASYCODE_REDIS_URL`。

Desktop agent 会打印 pairing code。在另一个终端运行：

```bash
pnpm dev:mobile
```

在桌面或 Android 上打开 Vite URL，输入 `http://localhost:8787`，然后 claim desktop agent 显示的一次性 pairing code。如果 desktop agent 使用了 `--mobile-url` 或 `EASYCODE_MOBILE_URL` 启动，请在手机上打开打印出来的 mobile pairing URL，以预填 relay server 和 pairing code。如果使用了 `--lan-host auto`，desktop agent 会使用检测到的 LAN IP 打印同类预填手机 URL。

首次 claim 成功后，mobile web client 会把 pairing credential 存到本地，并在之后自动重连。Desktop agent 默认也会把 pairing credential 存到 `.easycode/pairing.json`，因此重启 agent 时不需要重新 claim code。可用 `EASYCODE_PAIRING_STATE_FILE` 或 `--pairing-state-file` 覆盖该文件；使用 `--reset-pairing` 可以在 relay 可达时 revoke 已保存 pairing，丢弃本地 desktop pairing/E2EE state，并创建新的 pairing。

和 desktop agent 一样，mobile web client 会在 relay 返回 transport `ack` 前保留带稳定 id 的内存 outbound envelope。使用 mobile web client 中的 `Forget pairing` 可以清除本地 credential 并 revoke relay pairing。如果 pairing 被任意一端 revoke，现有 relay socket 会以共享的 `PAIRING_REVOKED_CLOSE_CODE` 关闭，客户端会停止使用无效 credential 重连。

Desktop agent 会在 `Authorization` header 中发送它的 WebSocket pair token。Mobile web client 会把 mobile token 放在 WebSocket URL 中，因为浏览器不允许自定义 WebSocket header。在 Android Chrome 上，打开 mobile web URL 后可使用浏览器安装提示或 “Add to Home screen”。

当 protocol 或 relay API type 发生变化时，提交前请重新生成已纳入版本控制的 JSON Schema 和 OpenAPI bundle：

```bash
pnpm --filter @easycode/protocol schema:generate
pnpm --filter @easycode/protocol openapi:generate
```

`pnpm --filter @easycode/protocol test` 会检查 `packages/protocol/schemas/easycode-protocol.schema.json` 和 `packages/protocol/openapi/easycode-relay.openapi.json` 是否与 protocol source 同步。

如需验证 encrypted payload 路径，请这样启动 desktop agent：

```bash
EASYCODE_E2EE=1 pnpm dev:desktop -- --adapter mock --server http://localhost:8787
```

Mobile web client 会自动回复 desktop `key_exchange` 消息，把 E2EE state 持久化到 local storage 以支持浏览器刷新恢复，并在 E2EE session 就绪后加密用户输入。Desktop agent 默认把 E2EE state 存在 `.easycode/e2ee`。可用 `EASYCODE_E2EE_STATE_DIR` 或 `--e2ee-state-dir` 覆盖。

## 项目结构

```text
packages/protocol        共享 TypeScript protocol 和 runtime schema
packages/protocol/schemas 面向 mobile/native client 的生成 JSON Schema bundle
packages/protocol/openapi 生成的 relay API OpenAPI contract
packages/e2ee            relay payload body 的共享 encryption helper
apps/relay-server        Pairing 和 WebSocket relay server
apps/desktop-agent       Desktop agent core 和 client adapter
apps/mobile-web          用于 v1 验证的移动端优先 PWA 实现
apps/mobile-flutter      原生 Android/iOS Flutter app skeleton
docs/architecture.md     架构说明和扩展点
```

## Relay Docker

Relay stack 可以用 Docker 运行，用于 LAN 或 hosted validation：

```bash
cp .env.example .env
docker compose up --build relay
```

启动连接该 relay 的 desktop agent 时，请使用同一个 `EASYCODE_RELAY_ADMIN_TOKEN`。Compose 文件还会使用稳定的本地 service name 启动 PostgreSQL 和 Redis。Relay 仍默认使用 `EASYCODE_RELAY_STORE=memory`；设置 `EASYCODE_RELAY_STORE=postgres` 可验证初始 durable store。

使用该 store 前请显式应用 PostgreSQL migration：

```bash
EASYCODE_POSTGRES_URL=postgres://easycode:easycode@localhost:5432/easycode pnpm --filter @easycode/relay-server migrate:postgres
```

对于容器化本地运行，设置 `EASYCODE_POSTGRES_MIGRATE=true` 可以让 relay 在启动时应用 pending PostgreSQL migration，前提是 `EASYCODE_RELAY_STORE=postgres`。设置 `EASYCODE_RELAY_FANOUT=redis` 可以使用 compose Redis service 做跨节点 live envelope fanout。

PostgreSQL integration test 默认跳过。请在已经应用 `infra/postgres/001_initial_relay.sql` 的数据库上运行它：

```bash
EASYCODE_POSTGRES_TEST_URL=postgres://easycode:easycode@localhost:5432/easycode pnpm --filter @easycode/relay-server test
```

Redis fanout integration test 默认也会跳过。运行方式：

```bash
EASYCODE_REDIS_TEST_URL=redis://localhost:6379 pnpm --filter @easycode/relay-server test
```

## 当前限制

- Relay server 已有初始 PostgreSQL persistence 和 Redis fanout 支持，但 hosted deployment 仍需要 Redis operational hardening 和 multi-node soak testing。
- Pairing 和 E2EE state 目前存储在浏览器 local storage 和本地 desktop 文件中，而不是 platform secure storage。
- Memory store 适合本地验证。PostgreSQL 会持久化 envelope replay data；Redis fanout 负责跨 relay node 的 live delivery。
- 真实 desktop-client extraction 是启发式的。macOS adapter 会读取 Accessibility tree，并且在目标客户端通过原生 accessibility node 暴露 chat text 和 button 时效果最好。应优先验证 Cursor。
- 本机没有安装 Rust/Tauri 和 Flutter toolchain，因此当前可运行的 desktop 实现是 TypeScript agent core，后续可以用 Tauri 包装；Flutter source 仍需要 SDK 级别的 analyze/build validation。

## 真实 macOS 客户端验证

macOS 必须向运行 desktop agent 的终端 app 授予 Accessibility 权限。对于较窄的“手机可以让 session continue”工作流，可用以下命令启动所有本地服务：

```bash
pnpm dev:lan -- --adapter codex
pnpm dev:lan -- --adapter cursor
pnpm dev:lan -- --adapter claude-code --target-index 0
```

然后在手机上打开打印出来的 mobile pairing URL。

对于完整 Accessibility inspection mode 或更底层的调试，请手动启动一个真实 adapter：

```bash
pnpm dev:desktop -- --adapter cursor --server http://localhost:8787
```

当客户端有多个 window 时，请显式列出并选择目标：

```bash
pnpm dev:desktop -- --adapter cursor --list-targets
pnpm dev:desktop -- --adapter cursor --target-index 1
pnpm dev:desktop -- --adapter cursor --target "cursor:window:1"
pnpm dev:desktop -- --adapter cursor --target-title easycode
```

可用 adapter 名称是 `cursor`、`codex`、`claude-code` 和 `mock`。`cursor` 会直接定位 Cursor app。`codex` 会优先定位 Codex GUI process（如果存在），也会扫描常见 terminal app 里的 Codex CLI session。`claude-code` 会扫描 Terminal、iTerm、Warp、WezTerm 和 Ghostty 等常见 terminal app，因为 Claude Code 通常运行在 terminal window 中。

当你的客户端运行在不同 macOS process 中时，请使用 `EASYCODE_MACOS_PROCESS_NAME`，必要时也设置 `EASYCODE_MACOS_APP_NAME`。

对于较窄的“手机可以让 session continue”工作流，请使用 `--continue-only`。在该模式下，EasyCode 会跳过 macOS window content capture，保持 mobile primary action 可用，并使用 process-level clipboard paste 发送 `continue` 之类的文本，而不读取目标 window object：粘贴前，它会 best-effort 激活选中的 app，然后定位匹配的 System Events process。

```bash
pnpm dev:desktop -- --adapter codex --continue-only --list-targets
pnpm dev:desktop -- --adapter codex --continue-only --server http://localhost:8787
pnpm dev:desktop -- --adapter claude-code --continue-only --target-index 0
pnpm dev:desktop -- --adapter cursor --continue-only --target cursor:process
```

Continue-only mode 的目标是 process，而不是解析后的 conversation content。对于有多个 process candidate 的 adapter，EasyCode 会用轻量 process-list check 优先展示正在运行的 candidate；如果没有检测到 candidate，则回退到完整配置列表。显示多个 candidate 时，请在 `--list-targets` 后使用 `--target-index`。

如果 continue-only mode 下手机投递失败，请运行 no-input diagnostics，检查目标 process 是否正在运行且 System Events 可见：

```bash
pnpm --filter @easycode/desktop-agent inspect -- --adapter codex --continue-only-targets
pnpm --filter @easycode/desktop-agent inspect -- --adapter claude-code --process Terminal --continue-only-targets
```

Polling interval 默认是 2500 ms，可这样修改：

```bash
EASYCODE_ACCESSIBILITY_POLL_MS=1000 pnpm dev:desktop -- --adapter cursor
```

Adapter 不解释审批风险。如果客户端通过 accessibility button 暴露 approve、reject、stop 或 continue 等选项，EasyCode 会把它们作为客户端提供的 interaction option 转发到 mobile。

如需在不连接 relay 的情况下检查真实客户端 accessibility tree：

```bash
pnpm --filter @easycode/desktop-agent inspect -- --adapter cursor --list-windows
pnpm --filter @easycode/desktop-agent inspect -- --adapter claude-code --list-windows
pnpm --filter @easycode/desktop-agent inspect -- --adapter codex --continue-only-targets
pnpm --filter @easycode/desktop-agent inspect -- --adapter codex --continue-probe
pnpm --filter @easycode/desktop-agent inspect -- --adapter claude-code --process Terminal --json
pnpm --filter @easycode/desktop-agent inspect -- --adapter cursor --json
pnpm --filter @easycode/desktop-agent inspect -- --adapter cursor --raw --output cursor-accessibility.txt
pnpm --filter @easycode/desktop-agent inspect -- --adapter cursor --input cursor-accessibility.txt --json
```

`--continue-probe` 是 dry run：它会 capture 并解析选中 window，然后报告 mobile primary action 会发送客户端提供的 interaction option，还是发送通用 `continue` 文本。它不会 click、paste 或 submit 任何内容。

`--continue-only-targets` 也是 dry run。它不会检查 window content；它会报告 continue-only mode 会选择哪个 process candidate，以及 EasyCode 尝试粘贴文本前 System Events 是否能看到该 process。

如果 live desktop agent 无法 capture 或 automate 选中的 macOS window，它会保持 relay session 存活，并向 mobile 报告 failed session 或 delivery state，同时给出下一步要运行的匹配 `inspect --continue-probe` 或 `inspect --continue-only-targets` 命令。

Inspect output 默认会在打印或写入磁盘前做 redaction。只有在确认 dump 可以安全保留后，才应使用 `--no-redact` 做私有本地调试：

```bash
pnpm --filter @easycode/desktop-agent inspect -- --adapter cursor --raw --no-redact --output private-cursor-accessibility.txt
```
