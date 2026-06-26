import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildContinueOnlyTargetDiagnostics,
  formatContinueOnlyTargetDiagnostics
} from "./continue-only-diagnostics.js";

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

test("continue-only diagnostics mark running selected process visibility", async () => {
  const diagnostics = await buildContinueOnlyTargetDiagnostics({
    processes,
    runningProcessNames: new Set(["Terminal"]),
    checkSystemEventsProcess: async (processName) => processName === "Terminal"
  });

  assert.deepEqual(diagnostics.targets, [
    {
      appName: "Codex",
      processName: "Codex",
      selected: false,
      running: false,
      systemEvents: "skipped",
      detail: undefined
    },
    {
      appName: "Terminal",
      processName: "Terminal",
      selected: true,
      running: true,
      systemEvents: "visible",
      detail: undefined
    }
  ]);
  assert.deepEqual(diagnostics.warnings, []);
});

test("continue-only diagnostics surface System Events failures without sending input", async () => {
  const diagnostics = await buildContinueOnlyTargetDiagnostics({
    processes,
    runningProcessNames: new Set(["Codex"]),
    checkSystemEventsProcess: async () => {
      throw new Error("osascript permission denied");
    }
  });

  assert.equal(diagnostics.targets[0]?.systemEvents, "error");
  assert.match(diagnostics.warnings[0] ?? "", /System Events could not inspect Codex/);
  assert.match(formatContinueOnlyTargetDiagnostics("Codex", diagnostics), /No input was sent/);
});
