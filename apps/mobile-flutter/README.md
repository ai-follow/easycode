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
pairing code, save the relay URL and mobile pair token locally, reconnect to
`/v1/ws` with the last seen `afterSeq` cursor, render `session_snapshot` and
`client_event` payloads, and send `user_input` payloads back to the desktop
agent. Interaction responses send the client-provided `optionId` only; EasyCode
does not interpret approve, reject, stop, or continue semantics.
Outbound envelopes are kept in a bounded in-memory queue until the relay returns
transport `ack`, so reconnect retries reuse the same envelope ids.
Client-provided continue/approve-style interaction options are promoted to a
one-tap action above the composer while the full option list remains visible.
When no client interaction is pending, the same primary action sends a plain
`continue` message to the selected session for terminal-style agents that are
waiting for text input.
The native skeleton also mirrors the mobile-web E2EE flow: it answers
`key_exchange`, stores its mobile ECDH session in `SharedPreferences`, decrypts
`encrypted_payload`, and encrypts outbound business payloads after the shared
key is ready.

Flutter is not installed on this machine, so this source still needs
`flutter pub get` and `flutter analyze` after the SDK is installed before
treating the Flutter app as the primary Android client.

Protocol model generation should use the checked-in schema bundle at
`../../packages/protocol/schemas/easycode-protocol.schema.json`. Relay HTTP
client generation should use
`../../packages/protocol/openapi/easycode-relay.openapi.json`. Regenerate them
after TypeScript protocol or relay API changes with:

```bash
pnpm --filter @easycode/protocol schema:generate
pnpm --filter @easycode/protocol openapi:generate
```
