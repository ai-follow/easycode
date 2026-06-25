import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildConversationSnapshotFromAccessibility,
  extractInteractionRequests,
  extractMessages,
  parseAccessibilityDump
} from "./macos-accessibility.js";

test("parses escaped accessibility dump rows", () => {
  const rows = parseAccessibilityDump("AXStaticText\tstatic text\tAssistant: hello\\nworld\t\t\ttrue\nAXButton\tbutton\tContinue\t\t\ttrue");

  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.name, "Assistant: hello\nworld");
  assert.equal(rows[1]?.role, "AXButton");
  assert.equal(rows[1]?.enabled, true);
});

test("builds conversation messages from useful visible text", () => {
  const elements = parseAccessibilityDump(
    [
      "AXStaticText\tstatic text\tExplorer\t\t\ttrue",
      "AXStaticText\tstatic text\tUser: build a relay\t\t\ttrue",
      "AXStaticText\tstatic text\tAssistant: done\t\t\ttrue",
      "AXStaticText\tstatic text\tAssistant: done\t\t\ttrue"
    ].join("\n")
  );

  const messages = extractMessages("cursor", "session_1", elements, "2026-01-01T00:00:00.000Z");

  assert.equal(messages.length, 2);
  assert.equal(messages[0]?.role, "user");
  assert.equal(messages[0]?.text, "build a relay");
  assert.equal(messages[1]?.role, "assistant");
  assert.equal(messages[1]?.text, "done");
});

test("combines standalone Cursor speaker labels with following message text", () => {
  const elements = parseAccessibilityDump(
    [
      "AXStaticText\tstatic text\tExplorer\t\t\ttrue",
      "AXStaticText\tstatic text\tYou\t\t\ttrue",
      "AXStaticText\tstatic text\tAdd retry handling to the relay client\t\t\ttrue",
      "AXStaticText\tstatic text\tCursor\t\t\ttrue",
      "AXStaticText\tstatic text\tI added reconnect handling and preserved message ids.\t\t\ttrue",
      "AXStaticText\tstatic text\tAsk anything\t\t\ttrue",
      "AXStaticText\tstatic text\tPress Enter to send\t\t\ttrue"
    ].join("\n")
  );

  const messages = extractMessages("cursor", "session_1", elements, "2026-01-01T00:00:00.000Z");

  assert.deepEqual(
    messages.map((message) => [message.role, message.text]),
    [
      ["user", "Add retry handling to the relay client"],
      ["assistant", "I added reconnect handling and preserved message ids."]
    ]
  );
});

test("extracts client interaction options without interpreting risk", () => {
  const elements = parseAccessibilityDump(
    [
      "AXStaticText\tstatic text\tCodex wants user input\t\t\ttrue",
      "AXButton\tbutton\tapprove\t\t\ttrue",
      "AXButton\tbutton\treject\t\t\ttrue",
      "AXButton\tbutton\tstop\t\t\ttrue",
      "AXButton\tbutton\tcontinue\t\t\ttrue",
      "AXButton\tbutton\tExplorer\t\t\ttrue"
    ].join("\n")
  );
  const messages = extractMessages("codex", "session_1", elements, "2026-01-01T00:00:00.000Z");
  const interactions = extractInteractionRequests("codex", "session_1", elements, messages);

  assert.equal(interactions.length, 1);
  assert.deepEqual(
    interactions[0]?.options.map((option) => option.label),
    ["approve", "reject", "stop", "continue"]
  );
  assert.equal(interactions[0]?.text, "Codex wants user input");
});

test("extracts interaction option phrases while ignoring navigation buttons", () => {
  const elements = parseAccessibilityDump(
    [
      "AXStaticText\tstatic text\tAssistant: command needs confirmation\t\t\ttrue",
      "AXButton\tbutton\tApprove and run\t\t\ttrue",
      "AXButton\tbutton\tContinue anyway\t\t\ttrue",
      "AXButton\tbutton\tStop generating\t\t\ttrue",
      "AXButton\tbutton\tRun and Debug\t\t\ttrue",
      "AXButton\tbutton\tSearch\t\t\ttrue"
    ].join("\n")
  );
  const messages = extractMessages("cursor", "session_1", elements, "2026-01-01T00:00:00.000Z");
  const interactions = extractInteractionRequests("cursor", "session_1", elements, messages);

  assert.equal(interactions.length, 1);
  assert.deepEqual(
    interactions[0]?.options.map((option) => option.label),
    ["Approve and run", "Continue anyway", "Stop generating"]
  );
});

test("builds a full snapshot with waiting state when buttons are present", () => {
  const snapshot = buildConversationSnapshotFromAccessibility({
    adapterId: "cursor",
    sessionId: "session_1",
    title: "Cursor",
    capturedAt: "2026-01-01T00:00:00.000Z",
    elements: parseAccessibilityDump(
      ["AXStaticText\tstatic text\tAssistant: approve the change?\t\t\ttrue", "AXButton\tbutton\tApprove\t\t\ttrue"].join("\n")
    )
  });

  assert.equal(snapshot.messages.length, 1);
  assert.equal(snapshot.pendingInteractions.length, 1);
  assert.equal(snapshot.state.status, "waiting_for_user");
});

test("parses Cursor-style confirmation fixture without standalone speaker noise", async () => {
  const raw = await readFile(new URL("../../fixtures/cursor-accessibility-confirmation.txt", import.meta.url), "utf8");
  const snapshot = buildConversationSnapshotFromAccessibility({
    adapterId: "cursor",
    sessionId: "session_fixture",
    title: "Cursor - EasyCode",
    capturedAt: "2026-01-01T00:00:00.000Z",
    elements: parseAccessibilityDump(raw)
  });

  assert.equal(snapshot.state.status, "waiting_for_user");
  assert.deepEqual(
    snapshot.messages.map((message) => [message.role, message.text]),
    [
      ["user", "Update the relay client to retry unacknowledged envelopes."],
      ["assistant", "I need approval before running pnpm test because it may take a while."]
    ]
  );
  assert.deepEqual(
    snapshot.pendingInteractions[0]?.options.map((option) => option.label),
    ["Approve and run", "Reject", "Stop"]
  );
});
