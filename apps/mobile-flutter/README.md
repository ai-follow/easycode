# EasyCode Mobile Flutter

This folder contains the native mobile client source skeleton. Flutter is not
installed on this machine, so the generated Android/iOS platform folders are
not checked in yet.

After installing Flutter:

```bash
cd apps/mobile-flutter
flutter create --platforms android,ios .
flutter pub get
flutter run
```

The app mirrors the same relay protocol used by `apps/mobile-web`: claim a
pairing code, connect to `/v1/ws`, render `session_snapshot` and `client_event`
payloads, and send `user_input` payloads back to the desktop agent.

Protocol model generation should use the checked-in schema bundle at
`../../packages/protocol/schemas/easycode-protocol.schema.json`. Relay HTTP
client generation should use
`../../packages/protocol/openapi/easycode-relay.openapi.json`. Regenerate them
after TypeScript protocol or relay API changes with:

```bash
pnpm --filter @easycode/protocol schema:generate
pnpm --filter @easycode/protocol openapi:generate
```
