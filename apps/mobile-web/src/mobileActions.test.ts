import assert from "node:assert/strict";
import { test } from "node:test";
import type { InteractionRequest } from "@easycode/protocol";
import { DEFAULT_CONTINUE_TEXT, selectMobileQuickAction, selectPrimaryInteractionAction } from "./mobileActions.js";

test("selects continue-like options as the primary interaction action", () => {
  const request = interaction("interaction_1", ["Reject", "Continue anyway", "Approve and run"]);

  const action = selectPrimaryInteractionAction([request]);

  assert.equal(action?.request.id, "interaction_1");
  assert.equal(action?.option.label, "Continue anyway");
});

test("falls back to approve or run options when no continue-like option exists", () => {
  const request = interaction("interaction_1", ["Reject", "Approve and run", "Stop"]);

  const action = selectPrimaryInteractionAction([request]);

  assert.equal(action?.option.label, "Approve and run");
});

test("does not promote stop or reject options", () => {
  const request = interaction("interaction_1", ["Reject", "Stop generating", "Cancel"]);

  const action = selectPrimaryInteractionAction([request]);

  assert.equal(action, undefined);
});

test("chooses the strongest action across pending requests", () => {
  const first = interaction("interaction_1", ["Approve"]);
  const second = interaction("interaction_2", ["Continue"]);

  const action = selectPrimaryInteractionAction([first, second]);

  assert.equal(action?.request.id, "interaction_2");
  assert.equal(action?.option.label, "Continue");
});

test("uses a generic continue text action when an active session has no pending interactions", () => {
  const action = selectMobileQuickAction([], true);

  assert.equal(action?.type, "continue_text");
  assert.equal(action?.label, "Continue");
  assert.equal(action?.text, DEFAULT_CONTINUE_TEXT);
});

test("does not use generic continue when the client is asking for a non-primary decision", () => {
  const action = selectMobileQuickAction([interaction("interaction_1", ["Reject", "Stop"])], true);

  assert.equal(action, undefined);
});

test("does not use generic continue before a session is selected", () => {
  const action = selectMobileQuickAction([], false);

  assert.equal(action, undefined);
});

const interaction = (id: string, labels: string[]): InteractionRequest => ({
  id,
  text: "Client request",
  options: labels.map((label) => ({
    id: `option_${label.toLowerCase().replace(/\W+/g, "_")}`,
    label,
    value: label
  }))
});
