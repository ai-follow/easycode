import assert from "node:assert/strict";
import { test } from "node:test";
import { formatMobileDelivery } from "./mobileDelivery.js";

test("formats delivery state with fallback input id", () => {
  assert.deepEqual(formatMobileDelivery({
    inputId: "input_1",
    status: "delivered"
  }), {
    status: "delivered",
    summary: "input_1",
    command: undefined
  });
});

test("splits diagnostic run command from delivery detail", () => {
  assert.deepEqual(formatMobileDelivery({
    inputId: "input_2",
    status: "failed",
    detail: "macOS continue-only automation failed: Process is not running: Codex. Run: pnpm --filter @easycode/desktop-agent inspect -- --adapter codex --process Codex --continue-only-targets"
  }), {
    status: "failed",
    summary: "macOS continue-only automation failed: Process is not running: Codex",
    command: "pnpm --filter @easycode/desktop-agent inspect -- --adapter codex --process Codex --continue-only-targets"
  });
});

test("keeps delivery detail unchanged without diagnostic command", () => {
  assert.deepEqual(formatMobileDelivery({
    inputId: "input_3",
    status: "queued",
    detail: "Socket is reconnecting. Message queued."
  }), {
    status: "queued",
    summary: "Socket is reconnecting. Message queued.",
    command: undefined
  });
});
