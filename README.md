# EasyCode

EasyCode is a remote message relay for desktop AI coding clients such as Cursor,
Claude Code, and Codex. The project intentionally does not make safety or
approval decisions for those clients. It mirrors client events to a mobile
device and relays user input back to the selected desktop client.

## What is implemented now

- Shared protocol package with typed relay envelopes and client adapter models.
- WebSocket relay server with an in-memory pairing flow.
- Desktop agent core with a complete mock adapter for end-to-end validation.
- macOS window/input adapter foundations for Cursor, Codex, and Claude clients.
- Mobile-first web/PWA client for Android browser validation.
- Flutter source skeleton that uses the same protocol shape once Flutter is
  available on the machine.

## Quick start

```bash
pnpm install
pnpm build
pnpm dev:server
```

In another terminal:

```bash
pnpm dev:desktop -- --adapter mock --server http://localhost:8787
```

The desktop agent prints a pairing code. In another terminal:

```bash
pnpm dev:mobile
```

Open the Vite URL on desktop or Android, enter `http://localhost:8787`, then
claim the pairing code shown by the desktop agent.

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
- Full visual conversation extraction from real desktop clients is not yet
  implemented. The mock adapter covers the complete protocol; real macOS
  adapters currently cover window discovery and input delivery.
- Rust/Tauri and Flutter toolchains were not installed on this machine, so the
  runnable desktop implementation is a TypeScript agent core that can later be
  wrapped by Tauri.
