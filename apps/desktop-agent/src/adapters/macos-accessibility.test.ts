import assert from "node:assert/strict";
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
