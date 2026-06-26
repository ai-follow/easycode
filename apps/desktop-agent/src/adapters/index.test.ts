import assert from "node:assert/strict";
import { test } from "node:test";
import { createAdapter, resolveMacAdapterConfig } from "./index.js";

test("claude-code scans common terminal process candidates", () => {
  const config = resolveMacAdapterConfig("claude-code");

  assert.deepEqual(
    config.processes?.map((processConfig) => processConfig.processName),
    ["Terminal", "iTerm2", "Warp", "WezTerm", "Ghostty"]
  );
});

test("codex keeps the GUI process and terminal process candidates", () => {
  const config = resolveMacAdapterConfig("codex");

  assert.equal(config.processes?.[0]?.processName, "Codex");
  assert.ok(config.processes?.some((processConfig) => processConfig.processName === "Terminal"));
});

test("macOS process environment override narrows adapter process discovery", () => {
  const previousProcessName = process.env.EASYCODE_MACOS_PROCESS_NAME;
  const previousAppName = process.env.EASYCODE_MACOS_APP_NAME;
  process.env.EASYCODE_MACOS_PROCESS_NAME = "CustomTerm";
  process.env.EASYCODE_MACOS_APP_NAME = "Custom Terminal";

  try {
    const config = resolveMacAdapterConfig("claude-code");
    assert.equal(config.processName, "CustomTerm");
    assert.equal(config.appName, "Custom Terminal");
    assert.deepEqual(config.processes, [
      {
        appName: "Custom Terminal",
        processName: "CustomTerm"
      }
    ]);
  } finally {
    restoreEnv("EASYCODE_MACOS_PROCESS_NAME", previousProcessName);
    restoreEnv("EASYCODE_MACOS_APP_NAME", previousAppName);
  }
});

test("createAdapter passes continue-only mode to macOS adapters", () => {
  const adapter = createAdapter("codex", {
    continueOnly: true
  });

  assert.deepEqual(adapter.capabilities(), {
    readMode: "none",
    sendMode: "clipboard-paste",
    interactionMode: "none"
  });
});

const restoreEnv = (name: string, value: string | undefined): void => {
  if (typeof value === "undefined") {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
};
