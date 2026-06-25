# EasyCode Architecture

## Principle

EasyCode is a transport layer between mobile devices and desktop AI coding
clients. It does not decide whether an action is safe. If a client asks for an
approval, rejection, stop, continue, or any other interaction, EasyCode forwards
that request as data and returns the user's selected response.

## Components

- Desktop Agent: discovers client windows, attaches to a selected session,
  observes client events, and delivers user input.
- Relay Server: authenticates paired devices and forwards typed envelopes over
  WebSocket.
- Mobile App: renders session messages and client-provided interaction options,
  then sends text or selected options back to the desktop agent.
- Protocol Package: defines the only contract shared by all components.

## Adapter contract

Every client integration must implement the same interface:

```ts
interface ClientAdapter {
  id: "codex" | "claude-code" | "cursor";
  discoverClients(): Promise<ClientTarget[]>;
  attach(target: ClientTarget): Promise<AttachedSession>;
  getSnapshot(sessionId: string): Promise<ConversationSnapshot>;
  subscribeEvents(sessionId: string): AsyncIterable<ClientEvent>;
  sendInput(sessionId: string, input: UserInput): Promise<DeliveryReceipt>;
}
```

Adapters report capabilities instead of hiding gaps. For example, a macOS
automation adapter may support `sendMode: "clipboard-paste"` before it supports
structured reading.

## macOS accessibility adapter

The first real-client path uses macOS Accessibility instead of private client
storage. The adapter discovers windows with System Events, dumps the selected
window's accessibility tree, converts useful visible text into `message` events,
and converts client-exposed decision buttons into `interaction_request` events.

This keeps the relay semantics intact: EasyCode does not decide what an approval
means. It forwards option labels and values exposed by the target client, and it
clicks the matching accessible button when the mobile user selects one.

Cursor should be the first real-client validation target. After Cursor is stable,
the same adapter can be tuned for Codex and Claude by adjusting process names,
filtering rules, and client-specific selectors.

`@easycode/desktop-agent` also exposes an `inspect` command that captures the
same accessibility data without connecting to the relay. This is the preferred
way to collect Cursor fixtures and tune parser rules before changing the live
adapter path.

## Relay semantics

The server treats payloads as opaque protocol messages. It may validate envelope
shape, persist metadata, and fan out messages, but it must not interpret
client-specific option labels such as approve, reject, continue, or stop.
The protocol also accepts `encrypted_payload` envelopes. Those payloads expose
only encryption metadata and ciphertext to the relay; desktop and mobile clients
will need a separate end-to-end key exchange before the main app path can switch
from cleartext payloads to encrypted payloads.
`@easycode/e2ee` owns the shared AES-GCM payload encryption helpers so desktop,
mobile web, and future Flutter code use the same P-256 ECDH key exchange,
HKDF key derivation, base64url encoding, and authenticated-data format.
When E2EE is enabled, the desktop relay client sends a clear `key_exchange`
hello and queues business payloads until the mobile client responds with its own
`key_exchange` payload. After both sides derive the shared key, business
payloads are sent as `encrypted_payload`; relay `ack`, `error`, `ping`, and
`key_exchange` messages stay cleartext transport/control frames.

Pairing creation can be protected with `EASYCODE_RELAY_ADMIN_TOKEN`. When set,
desktop agents must send the same value as a bearer token or
`x-easycode-relay-token` header to create a pairing. Claiming an existing
pairing uses a short one-time pairing code.
Either side can revoke an active pairing through `DELETE /v1/pairings/:pairId`
with its pair token; the relay closes existing sockets for that pair.

Each accepted envelope receives a per-pair `serverSeq`. Reconnecting clients can
pass `afterSeq` to `/v1/ws` to receive only missed backlog items. This is a
transport cursor, not a business-level acknowledgment.
The reconnect backlog is bounded by `EASYCODE_RELAY_BACKLOG_LIMIT`, and pairing
codes expire according to `EASYCODE_PAIRING_TTL_MS`. The duplicate envelope id
window is bounded separately by `EASYCODE_RELAY_DEDUPE_LIMIT`.
The relay sends an `ack` payload back to the sending socket after it accepts an
envelope. This only means the relay accepted the envelope for forwarding. It is
not a desktop-client delivery receipt; adapter-level handling is still reported
with `delivery_state` events.

The mobile web client persists its relay URL and mobile pairing token in local
storage after a successful claim. On socket close it reconnects with exponential
backoff and includes the latest stored `afterSeq` cursor. It also keeps a
bounded in-memory outbound queue and retries unacknowledged envelopes with the
same id after reconnect.
Browser WebSocket APIs cannot attach custom headers, so the mobile token travels
in the WebSocket URL query. Desktop and other non-browser clients should send
their pair token as an `Authorization: Bearer ...` header.

The relay sends WebSocket heartbeat pings and terminates clients that do not
respond by the next interval. This lets desktop and mobile clients fall back to
their reconnect behavior instead of silently hanging on dead sockets.

The desktop relay client also reconnects automatically and queues a bounded set
of outbound envelopes while disconnected. Each queued envelope keeps its id
until the relay returns an `ack`, so a reconnect can safely retry with the same
id and let the relay deduplicate already accepted input.
If the relay rejects the desktop socket with 401 or 403, the client treats the
pairing as invalid and stops reconnecting.

Hosted relays can restrict browser access with `EASYCODE_ALLOWED_ORIGINS`. This
is HTTP CORS and WebSocket Origin hardening for the mobile web client, not a
replacement for pairing and socket tokens. Non-browser desktop or native clients
may omit Origin and still authenticate with their pair token.

When `EASYCODE_RELAY_FANOUT=redis`, accepted envelopes are still persisted and
sequenced by the selected relay store, then published through Redis pub/sub so
other relay nodes can deliver them to local sockets for the same pair. The
origin node ignores its own fanout message and delivers directly to its local
recipients.
`/ready` checks both the selected relay store and the Redis fanout bus when
fanout is configured.

## Relay storage roadmap

The relay store interface is asynchronous so memory and PostgreSQL drivers share
the same HTTP handlers, WebSocket upgrade path, and message flow.

The initial PostgreSQL store owns durable pairing identity, hashed pair tokens,
one-time pairing codes, sequence allocation, and persisted envelope metadata.
The initial schema lives in `infra/postgres/001_initial_relay.sql`.

Redis owns low-latency runtime fanout for multi-node relay deployments.
PostgreSQL remains the durable source of truth when Redis evicts data or
restarts.

## Production backlog

- Harden Redis fanout for production multi-node deployments.
- Persist or recover E2EE key state so mobile reloads and desktop restarts can
  decrypt encrypted replay backlog items.
- Add Tauri shell that embeds the desktop agent core and permissions UI.
- Harden Cursor conversation extraction with resilient selectors and fixtures
  captured from real Cursor accessibility trees.
- Add native Flutter Android build once the Flutter SDK is installed.
