import assert from "node:assert/strict";
import test from "node:test";
import {
  rememberInteractionOptionLabels,
  resolveInteractionResponseLabel
} from "./macos-window-adapter.js";

test("remembers interaction option labels for later option-id-only responses", () => {
  const labels = new Map<string, string>();
  rememberInteractionOptionLabels(labels, [
    {
      options: [
        {
          id: "option_approve",
          label: "Approve and run",
          value: {
            action: "approve"
          }
        },
        {
          id: "option_stop",
          label: "Stop",
          value: "stop"
        }
      ]
    }
  ]);

  assert.equal(labels.get("option_approve"), "Approve and run");
  assert.equal(labels.get("option_stop"), "Stop");
});

test("resolves interaction response labels from value, remembered option, then option id", () => {
  const labels = new Map([
    ["option_approve", "Approve and run"],
    ["option_object", "Continue anyway"]
  ]);

  assert.equal(resolveInteractionResponseLabel({
    type: "interaction_response",
    inputId: "input_1",
    requestId: "request_1",
    optionId: "option_approve"
  }, labels), "Approve and run");

  assert.equal(resolveInteractionResponseLabel({
    type: "interaction_response",
    inputId: "input_2",
    requestId: "request_1",
    optionId: "option_explicit",
    value: "Reject"
  }, labels), "Reject");

  assert.equal(resolveInteractionResponseLabel({
    type: "interaction_response",
    inputId: "input_3",
    requestId: "request_1",
    optionId: "option_object",
    value: {
      action: "continue"
    }
  }, labels), "Continue anyway");

  assert.equal(resolveInteractionResponseLabel({
    type: "interaction_response",
    inputId: "input_4",
    requestId: "request_1",
    optionId: "approve"
  }, labels), "approve");
});
