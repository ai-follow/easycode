# EasyCode

EasyCode is a remote message relay for desktop AI coding clients such as Cursor,
Claude Code, and Codex. The project intentionally does not make safety or
approval decisions for those clients. It mirrors client events to a mobile
device and relays user input back to the selected desktop client.

## What is implemented now

- GitHub Actions CI for typecheck, tests, and production builds.
- Automated relay + mock desktop + simulated mobile e2e smoke test.
- Shared protocol package with typed relay envelopes and client adapter models.
- WebSocket relay server with an in-memory pairing flow, per-pair server
  sequence numbers, replay backlog, and reconnect cursors.
- Desktop agent core with a complete mock adapter for end-to-end validation.
- macOS accessibility adapter foundations for Cursor, Codex, and Claude clients:
  window discovery, visible text snapshots, interaction option extraction, and
  clipboard-based input delivery.
- Mobile-first web/PWA client for Android browser validation, with saved pairing
  credentials, automatic reconnect, and `afterSeq` replay recovery.
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

The desktop agent prints a pairing code. In another terminal:

```bash
pnpm dev:mobile
```

Open the Vite URL on desktop or Android, enter `http://localhost:8787`, then
claim the pairing code shown by the desktop agent.
After the first successful claim, the mobile web client stores the pairing
credentials locally and will reconnect automatically.

## Project layout

```text
packages/protocol        Shared TypeScript protocol and runtime schemas
apps/relay-server        Pairing and WebSocket relay server
apps/desktop-agent       Desktop agent core and client adapters
apps/mobile-web          Mobile-first PWA implementation for v1 validation
apps/mobile-flutter      Flutter app skeleton for native Android/iOS
docs/architecture.md     Architecture notes and extension points
```

## Current limitations

- The relay server uses in-memory storage. PostgreSQL and Redis adapters should
  replace it before a hosted deployment.
- Reconnect recovery is implemented with an in-memory backlog. It is suitable
  for local validation, but production still needs durable storage.
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
pnpm --filter @easycode/desktop-agent inspect -- --adapter cursor --json
pnpm --filter @easycode/desktop-agent inspect -- --adapter cursor --raw --output cursor-accessibility.txt
pnpm --filter @easycode/desktop-agent inspect -- --adapter cursor --input cursor-accessibility.txt --json
```
