# EasyCode

> [中文说明](README.zh-CN.md)

EasyCode is a remote message relay for desktop AI coding clients such as Cursor,
Claude Code, and Codex. The project intentionally does not make safety or
approval decisions for those clients. It mirrors client events to a mobile
device and relays user input back to the selected desktop client.

## What is implemented now

- GitHub Actions CI for typecheck, tests, and production builds.
- Automated relay + mock desktop + simulated mobile e2e smoke test, including
  the encrypted payload path, generic `continue` delivery, interaction
  responses, and reconnect replay.
- Shared protocol package with typed relay envelopes and client adapter models.
- Generated protocol JSON Schema artifact for non-TypeScript clients such as
  the future Flutter app.
- Generated OpenAPI artifact for relay HTTP endpoints and WebSocket upgrade
  parameters.
- Protocol support for desktop/mobile `key_exchange` control messages and
  opaque encrypted relay payloads.
- Shared E2EE helper package for deriving relay payload keys and encrypting or
  decrypting payload bodies with P-256 ECDH, HKDF, and AES-GCM.
- WebSocket relay server with memory and PostgreSQL stores, per-pair server
  sequence numbers, replay backlog, and reconnect cursors.
- Desktop agent core with a complete mock adapter for end-to-end validation.
- macOS accessibility adapter foundations for Cursor, Codex, and Claude clients:
  window discovery, visible text snapshots, interaction option extraction, and
  clipboard-based input delivery.
- Mobile-first web/PWA client for Android browser validation, with saved pairing
  credentials, automatic reconnect, `afterSeq` replay recovery, and installable
  PWA metadata. Client-provided continue/approve-style interaction options are
  surfaced as a one-tap primary action while still preserving the full option
  list; when no client interaction is pending, the same primary action sends a
  plain `continue` message to the selected session.
- Flutter source skeleton for native Android/iOS that follows the same relay
  protocol shape, including saved pairing credentials and reconnect cursors,
  an in-memory outbound ack queue, and the same E2EE message flow once Flutter
  is available on the machine.

## Quick start

```bash
pnpm install
pnpm build
pnpm test:e2e
pnpm dev:lan -- --adapter codex
```

`pnpm dev:lan` starts the local relay, mobile web client, and desktop agent
together. It defaults to continue-only mode, uses `--lan-host auto`, and prints
a mobile pairing URL that a phone on the same network can open. If the default
mobile web port 5173 is already in use, it tries higher ports and passes the
selected port to the desktop agent. Use `--adapter cursor`,
`--adapter claude-code`, or `--adapter mock` for other targets. Add `--dry-run`
to print the child commands without starting them. Use
`--pairing-state-file /tmp/easycode-pairing.json` for temporary validation
without touching the default desktop pairing state.

If you want to run each service manually, start the relay first:

```bash
pnpm dev:server
```

In another terminal, start the desktop agent:

```bash
pnpm dev:desktop -- --adapter mock --server http://localhost:8787
```

If the phone is on the same network as the computer, let the desktop agent infer
the LAN URLs and print a prefilled mobile pairing link:

```bash
pnpm dev:desktop -- --adapter mock \
  --server http://localhost:8787 \
  --lan-host auto
```

`--lan-host auto` picks a non-loopback IPv4 address, rewrites local relay URLs
for the phone, and assumes the mobile web dev server is on port 5173. If the
wrong interface is selected, pass the computer IP explicitly:

```bash
pnpm dev:desktop -- --adapter mock \
  --server http://localhost:8787 \
  --lan-host 192.168.1.80
```

You can also pass fully explicit URLs:

```bash
pnpm dev:desktop -- --adapter mock \
  --server http://localhost:8787 \
  --mobile-server http://192.168.1.80:8787 \
  --mobile-url http://192.168.1.80:5173
```

`--server` is the relay URL used by the desktop agent. `--mobile-server` is the
relay URL that the phone can reach; omit it when both devices use the same URL
or when using `--lan-host`.

For a non-local relay, protect pairing creation with an admin token:

```bash
EASYCODE_RELAY_ADMIN_TOKEN=change-me pnpm dev:server
pnpm dev:desktop -- --adapter mock --server http://localhost:8787 --relay-token change-me
```

Relay WebSockets use heartbeat pings to clear dead connections. Override the
interval with `EASYCODE_WS_HEARTBEAT_MS`.
Pairing code lifetime defaults to 10 minutes and can be changed with
`EASYCODE_PAIRING_TTL_MS`. The in-memory reconnect replay backlog defaults to
200 envelopes per pair and can be changed with `EASYCODE_RELAY_BACKLOG_LIMIT`.
The recent envelope id dedupe window defaults to 1000 ids per pair and can be
changed with `EASYCODE_RELAY_DEDUPE_LIMIT`.
The desktop agent reconnects automatically and keeps a short in-memory send
queue while the relay socket is unavailable. Outbound envelopes keep the same
id until the relay returns a transport `ack`, so reconnect retries can be
deduplicated by the relay.
If the relay rejects the desktop socket token, the desktop agent stops
reconnecting because the pairing is no longer valid.
Use `/health` for diagnostics and `/ready` for container readiness probes.
Readiness checks the relay store and, when configured, the Redis fanout bus.
Set `EASYCODE_ALLOWED_ORIGINS` to a comma-separated allowlist for hosted mobile
web clients; the default is `*` for local development. The allowlist is applied
to HTTP CORS and browser WebSocket Origin headers.
Set `EASYCODE_RELAY_STORE=memory` for local in-memory state, or
`EASYCODE_RELAY_STORE=postgres` with `EASYCODE_POSTGRES_URL` for the initial
durable PostgreSQL-backed store. The store is behind an interface so Redis and
other runtime coordination drivers can be added without changing the HTTP or
WebSocket protocol layers.
Set `EASYCODE_RELAY_FANOUT=redis` with `EASYCODE_REDIS_URL` when multiple relay
nodes need to fan out live envelopes to desktop and mobile sockets connected to
different nodes.

The desktop agent prints a pairing code. In another terminal:

```bash
pnpm dev:mobile
```

Open the Vite URL on desktop or Android, enter `http://localhost:8787`, then
claim the one-time pairing code shown by the desktop agent.
If the desktop agent was started with `--mobile-url` or `EASYCODE_MOBILE_URL`,
open the printed mobile pairing URL on the phone to prefill the relay server
and pairing code.
If it was started with `--lan-host auto`, the desktop agent prints the same kind
of prefilled phone URL using the detected LAN IP.
After the first successful claim, the mobile web client stores the pairing
credentials locally and will reconnect automatically.
The desktop agent also stores its pairing credentials in `.easycode/pairing.json`
by default, so restarting the agent does not require claiming a new code. Use
`EASYCODE_PAIRING_STATE_FILE` or `--pairing-state-file` to override the file,
and `--reset-pairing` to revoke the saved relay pairing when reachable, discard
the local desktop pairing/E2EE state, and create a new one.
Like the desktop agent, the mobile web client keeps in-memory outbound
envelopes with stable ids until the relay returns a transport `ack`.
Use `Forget pairing` in the mobile web client to clear local credentials and
revoke the relay pairing.
If a pairing is revoked by either device, existing relay sockets are closed with
the shared `PAIRING_REVOKED_CLOSE_CODE`, and clients stop reconnecting with the
invalid credentials.
The desktop agent sends its WebSocket pair token in an `Authorization` header.
The mobile web client sends the mobile token in the WebSocket URL because
browsers do not allow custom WebSocket headers.
On Android Chrome, use the browser install prompt or "Add to Home screen" after
opening the mobile web URL.

When protocol or relay API types change, regenerate the checked-in JSON Schema
and OpenAPI bundles before committing:

```bash
pnpm --filter @easycode/protocol schema:generate
pnpm --filter @easycode/protocol openapi:generate
```

`pnpm --filter @easycode/protocol test` checks that
`packages/protocol/schemas/easycode-protocol.schema.json` and
`packages/protocol/openapi/easycode-relay.openapi.json` are in sync with the
protocol source.

To exercise the encrypted payload path, start the desktop agent with:

```bash
EASYCODE_E2EE=1 pnpm dev:desktop -- --adapter mock --server http://localhost:8787
```

The mobile web client answers the desktop `key_exchange` message automatically,
persists its E2EE state in local storage for browser reload recovery, and
encrypts user input after the E2EE session is ready.
The desktop agent stores E2EE state in `.easycode/e2ee` by default. Override it
with `EASYCODE_E2EE_STATE_DIR` or `--e2ee-state-dir`.

## Project layout

```text
packages/protocol        Shared TypeScript protocol and runtime schemas
packages/protocol/schemas Generated JSON Schema bundle for mobile/native clients
packages/protocol/openapi Generated OpenAPI relay API contract
packages/e2ee            Shared encryption helpers for relay payload bodies
apps/relay-server        Pairing and WebSocket relay server
apps/desktop-agent       Desktop agent core and client adapters
apps/mobile-web          Mobile-first PWA implementation for v1 validation
apps/mobile-flutter      Flutter app skeleton for native Android/iOS
docs/architecture.md     Architecture notes and extension points
```

## Relay Docker

The relay stack can run in Docker for LAN or hosted validation:

```bash
cp .env.example .env
docker compose up --build relay
```

Use the same `EASYCODE_RELAY_ADMIN_TOKEN` value when starting a desktop agent
against that relay.
The compose file also starts PostgreSQL and Redis with stable local service
names. The relay still defaults to `EASYCODE_RELAY_STORE=memory`; set
`EASYCODE_RELAY_STORE=postgres` to exercise the initial durable store.
Apply PostgreSQL migrations explicitly before using that store:

```bash
EASYCODE_POSTGRES_URL=postgres://easycode:easycode@localhost:5432/easycode pnpm --filter @easycode/relay-server migrate:postgres
```

For containerized local runs, `EASYCODE_POSTGRES_MIGRATE=true` lets the relay
apply pending PostgreSQL migrations at startup when
`EASYCODE_RELAY_STORE=postgres`.
Set `EASYCODE_RELAY_FANOUT=redis` to use the compose Redis service for
cross-node live envelope fanout.
The PostgreSQL integration test is skipped by default. Run it against a database
that has `infra/postgres/001_initial_relay.sql` applied:

```bash
EASYCODE_POSTGRES_TEST_URL=postgres://easycode:easycode@localhost:5432/easycode pnpm --filter @easycode/relay-server test
```

The Redis fanout integration test is also skipped by default. Run it with:

```bash
EASYCODE_REDIS_TEST_URL=redis://localhost:6379 pnpm --filter @easycode/relay-server test
```

## Current limitations

- The relay server has initial PostgreSQL persistence and Redis fanout support,
  but hosted deployment still needs Redis operational hardening and multi-node
  soak testing.
- Pairing and E2EE state are currently stored in browser local storage and
  local desktop files, not platform secure storage.
- The memory store is suitable for local validation. PostgreSQL persists
  envelope replay data; Redis fanout handles live delivery across relay nodes.
- Real desktop-client extraction is heuristic. The macOS adapter reads the
  Accessibility tree and works best when the target client exposes chat text and
  buttons through native accessibility nodes. Cursor should be validated first.
- Rust/Tauri and Flutter toolchains were not installed on this machine, so the
  runnable desktop implementation is a TypeScript agent core that can later be
  wrapped by Tauri, and the Flutter source still needs SDK-level analyze/build
  validation.

## Real macOS client validation

macOS must grant Accessibility permission to the terminal app running the
desktop agent. For the narrow phone-to-continue workflow, start all local
services with:

```bash
pnpm dev:lan -- --adapter codex
pnpm dev:lan -- --adapter cursor
pnpm dev:lan -- --adapter claude-code --target-index 0
```

Then open the printed mobile pairing URL on the phone.

For full Accessibility inspection mode or lower-level debugging, start one of
the real adapters manually:

```bash
pnpm dev:desktop -- --adapter cursor --server http://localhost:8787
```

When a client has multiple windows, list and select a target explicitly:

```bash
pnpm dev:desktop -- --adapter cursor --list-targets
pnpm dev:desktop -- --adapter cursor --target-index 1
pnpm dev:desktop -- --adapter cursor --target "cursor:window:1"
pnpm dev:desktop -- --adapter cursor --target-title easycode
```

Available adapter names are `cursor`, `codex`, `claude-code`, and `mock`.
`cursor` targets the Cursor app directly. `codex` first targets a Codex GUI
process when present and also scans common terminal apps for Codex CLI sessions.
`claude-code` scans common terminal apps such as Terminal, iTerm, Warp, WezTerm,
and Ghostty because Claude Code normally runs inside a terminal window.
Use `EASYCODE_MACOS_PROCESS_NAME` and, optionally,
`EASYCODE_MACOS_APP_NAME` when your client runs in a different macOS process.
For the narrow "phone can make the session continue" workflow, use
`--continue-only`. In this mode EasyCode skips macOS window content capture,
keeps the mobile primary action available, and uses process-level clipboard
paste to send text such as `continue` without reading the target window object:
before pasting, it best-effort activates the selected app and then targets the
matching System Events process.

```bash
pnpm dev:desktop -- --adapter codex --continue-only --list-targets
pnpm dev:desktop -- --adapter codex --continue-only --server http://localhost:8787
pnpm dev:desktop -- --adapter claude-code --continue-only --target-index 0
pnpm dev:desktop -- --adapter cursor --continue-only --target cursor:process
```

Continue-only mode targets a process rather than parsed conversation content.
For adapters with multiple process candidates, EasyCode uses a lightweight
process-list check to show running candidates first and falls back to the full
configured list if no candidate is detected. Use `--target-index` after
`--list-targets` when more than one candidate is shown.
If phone delivery fails in continue-only mode, run the no-input diagnostics to
check whether the target process is running and visible to System Events:

```bash
pnpm --filter @easycode/desktop-agent inspect -- --adapter codex --continue-only-targets
pnpm --filter @easycode/desktop-agent inspect -- --adapter claude-code --process Terminal --continue-only-targets
```

The polling interval defaults to 2500 ms and can be changed with:

```bash
EASYCODE_ACCESSIBILITY_POLL_MS=1000 pnpm dev:desktop -- --adapter cursor
```

The adapter does not interpret approval risk. If a client exposes options such
as approve, reject, stop, or continue as accessible buttons, EasyCode relays
them to mobile as client-provided interaction options.

To inspect a real client's accessibility tree without connecting the relay:

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

`--continue-probe` is a dry run: it captures and parses the selected window,
then reports whether the mobile primary action would send a client-provided
interaction option or the generic `continue` text. It does not click, paste, or
submit anything.
`--continue-only-targets` is also a dry run. It does not inspect window content;
it reports which process candidate continue-only mode would select and whether
System Events can see that process before EasyCode tries to paste text.
If the live desktop agent cannot capture or automate a selected macOS window,
it keeps the relay session alive and reports a failed session or delivery state
to mobile with the matching `inspect --continue-probe` or
`inspect --continue-only-targets` command to run next.

Inspect output is redacted by default before it is printed or written to disk.
Use `--no-redact` only for private local debugging after reviewing that the
dump is safe to keep:

```bash
pnpm --filter @easycode/desktop-agent inspect -- --adapter cursor --raw --no-redact --output private-cursor-accessibility.txt
```
