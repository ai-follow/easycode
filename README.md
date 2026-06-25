# EasyCode

EasyCode is a remote message relay for desktop AI coding clients such as Cursor,
Claude Code, and Codex. The project intentionally does not make safety or
approval decisions for those clients. It mirrors client events to a mobile
device and relays user input back to the selected desktop client.

## What is implemented now

- GitHub Actions CI for typecheck, tests, and production builds.
- Automated relay + mock desktop + simulated mobile e2e smoke test.
- Shared protocol package with typed relay envelopes and client adapter models.
- Protocol support for opaque encrypted relay payloads, ready for a later
  desktop/mobile end-to-end key exchange.
- WebSocket relay server with memory and PostgreSQL stores, per-pair server
  sequence numbers, replay backlog, and reconnect cursors.
- Desktop agent core with a complete mock adapter for end-to-end validation.
- macOS accessibility adapter foundations for Cursor, Codex, and Claude clients:
  window discovery, visible text snapshots, interaction option extraction, and
  clipboard-based input delivery.
- Mobile-first web/PWA client for Android browser validation, with saved pairing
  credentials, automatic reconnect, `afterSeq` replay recovery, and installable
  PWA metadata.
- Flutter source skeleton that uses the same protocol shape once Flutter is
  available on the machine.

## Quick start

```bash
pnpm install
pnpm build
pnpm test:e2e
pnpm dev:server
```

In another terminal:

```bash
pnpm dev:desktop -- --adapter mock --server http://localhost:8787
```

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
After the first successful claim, the mobile web client stores the pairing
credentials locally and will reconnect automatically.
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

## Project layout

```text
packages/protocol        Shared TypeScript protocol and runtime schemas
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
- The protocol can carry encrypted payloads, but clients still send cleartext
  until the desktop/mobile key exchange is implemented.
- The memory store is suitable for local validation. PostgreSQL persists
  envelope replay data; Redis fanout handles live delivery across relay nodes.
- Real desktop-client extraction is heuristic. The macOS adapter reads the
  Accessibility tree and works best when the target client exposes chat text and
  buttons through native accessibility nodes. Cursor should be validated first.
- Rust/Tauri and Flutter toolchains were not installed on this machine, so the
  runnable desktop implementation is a TypeScript agent core that can later be
  wrapped by Tauri.

## Real macOS client validation

macOS must grant Accessibility permission to the terminal app running the
desktop agent. Then start one of the real adapters:

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
pnpm --filter @easycode/desktop-agent inspect -- --adapter cursor --json
pnpm --filter @easycode/desktop-agent inspect -- --adapter cursor --raw --output cursor-accessibility.txt
pnpm --filter @easycode/desktop-agent inspect -- --adapter cursor --input cursor-accessibility.txt --json
```

Inspect output is redacted by default before it is printed or written to disk.
Use `--no-redact` only for private local debugging after reviewing that the
dump is safe to keep:

```bash
pnpm --filter @easycode/desktop-agent inspect -- --adapter cursor --raw --no-redact --output private-cursor-accessibility.txt
```
