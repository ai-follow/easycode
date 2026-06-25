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

## Relay semantics

The server treats payloads as opaque protocol messages. It may validate envelope
shape, persist metadata, and fan out messages, but it must not interpret
client-specific option labels such as approve, reject, continue, or stop.

## Production backlog

- Replace in-memory relay store with PostgreSQL and Redis implementations.
- Add end-to-end encryption for envelope payloads after the pairing handshake.
- Add Tauri shell that embeds the desktop agent core and permissions UI.
- Implement real Cursor conversation extraction through accessibility tree
  inspection and resilient UI selectors.
- Add native Flutter Android build once the Flutter SDK is installed.
