import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMobileWebSocketUrl, nextReconnectAttempt, reconnectDelayMs } from "./mobileConnection.js";

test("builds mobile websocket urls with browser-compatible token query", () => {
  const wsUrl = new URL(buildMobileWebSocketUrl({
    relayUrl: "http://localhost:8787",
    pairId: "pair_test",
    mobileToken: "mobile_token_test",
    afterSeq: 42
  }));

  assert.equal(wsUrl.protocol, "ws:");
  assert.equal(wsUrl.pathname, "/v1/ws");
  assert.equal(wsUrl.searchParams.get("pairId"), "pair_test");
  assert.equal(wsUrl.searchParams.get("role"), "mobile");
  assert.equal(wsUrl.searchParams.get("token"), "mobile_token_test");
  assert.equal(wsUrl.searchParams.get("afterSeq"), "42");
});

test("builds secure mobile websocket urls for https relays and omits invalid cursors", () => {
  const wsUrl = new URL(buildMobileWebSocketUrl({
    relayUrl: "https://relay.example/root",
    pairId: "pair_test",
    mobileToken: "mobile_token_test",
    afterSeq: 0
  }));

  assert.equal(wsUrl.protocol, "wss:");
  assert.equal(wsUrl.origin, "wss://relay.example");
  assert.equal(wsUrl.pathname, "/v1/ws");
  assert.equal(wsUrl.searchParams.has("afterSeq"), false);
});

test("computes capped reconnect attempts and delays", () => {
  assert.equal(nextReconnectAttempt(0), 1);
  assert.equal(nextReconnectAttempt(4), 5);
  assert.equal(nextReconnectAttempt(5), 5);
  assert.equal(nextReconnectAttempt(Number.NaN), 1);

  assert.equal(reconnectDelayMs({ attempt: 1 }), 1000);
  assert.equal(reconnectDelayMs({ attempt: 2 }), 2000);
  assert.equal(reconnectDelayMs({ attempt: 5 }), 10000);
  assert.equal(reconnectDelayMs({ attempt: 99 }), 10000);
  assert.equal(reconnectDelayMs({ attempt: 3, baseMs: 250, maxMs: 1000 }), 1000);
});
