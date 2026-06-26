import assert from "node:assert/strict";
import test from "node:test";
import {
  formatMacosAutomationError,
  MacWindowAdapter,
  rememberInteractionOptionLabels,
  resolveInteractionResponseLabel,
  selectContinueOnlyProcessConfigs
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

test("formats macOS automation errors with an inspect continue probe command", () => {
  const detail = formatMacosAutomationError(
    "claude-code",
    new Error("osascript timed out"),
    "Custom Terminal"
  );

  assert.match(detail, /macOS accessibility automation failed: osascript timed out/);
  assert.match(detail, /--adapter claude-code/);
  assert.match(detail, /--process 'Custom Terminal'/);
  assert.match(detail, /--continue-probe/);
});

test("formats continue-only automation errors with process diagnostics command", () => {
  const detail = formatMacosAutomationError(
    "codex",
    new Error("Process is not running: Codex"),
    "Codex",
    {
      continueOnly: true
    }
  );

  assert.match(detail, /macOS continue-only automation failed: Process is not running: Codex/);
  assert.match(detail, /--adapter codex/);
  assert.match(detail, /--process Codex/);
  assert.match(detail, /--continue-only-targets/);
});

test("continue-only mode reports send-only capabilities and a synthetic snapshot", async () => {
  const adapter = new MacWindowAdapter({
    id: "codex",
    appName: "Codex",
    processName: "Codex",
    continueOnly: true
  });

  assert.deepEqual(adapter.capabilities(), {
    readMode: "none",
    sendMode: "clipboard-paste",
    interactionMode: "none"
  });

  const session = await adapter.attach({
    id: "codex:process",
    adapterId: "codex",
    title: "Codex",
    appName: "Codex",
    platform: "macos",
    metadata: {
      processName: "Codex",
      windowIndex: 0
    }
  });
  const snapshot = await adapter.getSnapshot(session.sessionId);

  assert.equal(snapshot.state.status, "idle");
  assert.equal(snapshot.pendingInteractions.length, 0);
  assert.match(snapshot.messages[0]?.text ?? "", /Continue-only mode/);
});

test("continue-only discovery selects running process candidates when present", () => {
  const processes = [
    {
      appName: "Codex",
      processName: "Codex"
    },
    {
      appName: "Terminal",
      processName: "Terminal"
    },
    {
      appName: "Ghostty",
      processName: "Ghostty"
    }
  ];

  assert.deepEqual(selectContinueOnlyProcessConfigs(processes, new Set(["Terminal"])), [
    {
      appName: "Terminal",
      processName: "Terminal"
    }
  ]);
});

test("continue-only discovery keeps configured candidates when running detection has no match", () => {
  const processes = [
    {
      appName: "Codex",
      processName: "Codex"
    },
    {
      appName: "Terminal",
      processName: "Terminal"
    }
  ];

  assert.deepEqual(selectContinueOnlyProcessConfigs(processes, new Set(["Safari"])), processes);
  assert.deepEqual(selectContinueOnlyProcessConfigs(processes, new Set()), processes);
});
