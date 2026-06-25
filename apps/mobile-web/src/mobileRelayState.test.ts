import assert from "node:assert/strict";
import { test } from "node:test";
import type { ClientMessage, InteractionRequest, RelayPayload } from "@easycode/protocol";
import { applyMobileRelayPayload, emptyMobileRelayState, removePendingInteraction } from "./mobileRelayState.js";

const now = "2026-01-01T00:00:00.000Z";

test("mobile relay state applies snapshots and dedupes messages", () => {
  const message = clientMessage("message_1", "hello");
  const payload: RelayPayload = {
    kind: "session_snapshot",
    sessionId: "session_1",
    snapshot: {
      sessionId: "session_1",
      adapterId: "cursor",
      title: "Cursor",
      messages: [message, message],
      pendingInteractions: [],
      state: {
        status: "idle",
        updatedAt: now
      },
      capturedAt: now
    }
  };

  const state = applyMobileRelayPayload(emptyMobileRelayState(), payload);

  assert.equal(state.selectedSessionId, "session_1");
  assert.equal(state.sessions.session_1?.messages.length, 1);
  assert.deepEqual(state.sessions.session_1?.messages[0], message);
});

test("mobile relay state dedupes interaction requests and removes answered requests", () => {
  const request: InteractionRequest = {
    id: "interaction_1",
    text: "Choose",
    options: [
      {
        id: "continue",
        label: "continue",
        value: "continue"
      }
    ]
  };
  const payload: RelayPayload = {
    kind: "client_event",
    sessionId: "session_1",
    event: {
      type: "interaction_request",
      payload: request
    }
  };

  const withDuplicate = applyMobileRelayPayload(applyMobileRelayPayload(emptyMobileRelayState(), payload), payload);
  const answered = removePendingInteraction(withDuplicate, "session_1", "interaction_1");

  assert.equal(withDuplicate.sessions.session_1?.pendingInteractions.length, 1);
  assert.equal(answered.sessions.session_1?.pendingInteractions.length, 0);
});

test("mobile relay state keeps only the newest delivery states", () => {
  let state = emptyMobileRelayState();
  for (let index = 0; index < 25; index += 1) {
    state = applyMobileRelayPayload(state, {
      kind: "client_event",
      sessionId: "session_1",
      event: {
        type: "delivery_state",
        payload: {
          inputId: `input_${index}`,
          status: "delivered",
          updatedAt: now
        }
      }
    });
  }

  const deliveries = state.sessions.session_1?.deliveries ?? [];
  assert.equal(deliveries.length, 20);
  assert.equal(deliveries[0]?.inputId, "input_5");
  assert.equal(deliveries.at(-1)?.inputId, "input_24");
});

test("mobile relay state ignores transport payloads", () => {
  const initial = emptyMobileRelayState();
  const next = applyMobileRelayPayload(initial, {
    kind: "ack",
    refId: "env_1"
  });

  assert.equal(next, initial);
});

const clientMessage = (id: string, text: string): ClientMessage => ({
  id,
  role: "assistant",
  text,
  createdAt: now
});
