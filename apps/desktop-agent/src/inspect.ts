#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { buildConversationSnapshotFromAccessibility, parseAccessibilityDump } from "./adapters/macos-accessibility.js";
import { discoverProcessWindows, dumpAccessibilityTree } from "./adapters/macos-automation.js";
import type { AdapterName } from "./adapters/index.js";
import { resolveMacAdapterConfig } from "./adapters/index.js";

type InspectOptions = {
  adapterName: AdapterName;
  windowIndex: number;
  raw: boolean;
  json: boolean;
  outputPath?: string;
};

const parseArgs = (): InspectOptions => {
  const args = process.argv.slice(2);
  const get = (name: string, fallback: string): string => {
    const index = args.indexOf(name);
    const value = args[index + 1];
    return index >= 0 && typeof value === "string" ? value : fallback;
  };

  const windowIndex = Number(get("--window", "1"));
  return {
    adapterName: get("--adapter", "cursor") as AdapterName,
    windowIndex: Number.isInteger(windowIndex) && windowIndex > 0 ? windowIndex : 1,
    raw: args.includes("--raw"),
    json: args.includes("--json"),
    outputPath: args.includes("--output") ? get("--output", "") : undefined
  };
};

const main = async (): Promise<void> => {
  const options = parseArgs();
  const config = resolveMacAdapterConfig(options.adapterName);

  if (process.platform !== "darwin") {
    throw new Error("Accessibility inspection is only available on macOS");
  }

  const windows = await discoverProcessWindows(config.processName);
  if (windows.length === 0) {
    throw new Error(`No windows found for process ${config.processName}. Is ${config.appName} running?`);
  }

  const target = windows.find((window) => window.windowIndex === options.windowIndex) ?? windows[0];
  if (!target) throw new Error(`No inspectable window found for ${config.processName}`);

  const raw = await dumpAccessibilityTree(config.processName, target.windowIndex);
  const elements = parseAccessibilityDump(raw);
  const snapshot = buildConversationSnapshotFromAccessibility({
    adapterId: config.id,
    sessionId: `inspect_${config.id}`,
    title: target.title,
    elements
  });

  const result = options.raw
    ? raw
    : options.json
      ? JSON.stringify({ target, elementCount: elements.length, snapshot }, null, 2)
      : formatSummary(config.appName, target.title, elements.length, snapshot.messages.length, snapshot.pendingInteractions.length);

  if (options.outputPath) {
    await writeFile(options.outputPath, result, "utf8");
    console.log(`Wrote ${options.outputPath}`);
    return;
  }

  console.log(result);
};

const formatSummary = (
  appName: string,
  title: string,
  elementCount: number,
  messageCount: number,
  interactionCount: number
): string =>
  [
    `App: ${appName}`,
    `Window: ${title}`,
    `Accessibility elements: ${elementCount}`,
    `Parsed messages: ${messageCount}`,
    `Parsed interaction requests: ${interactionCount}`,
    "",
    "Use --json for parsed snapshot details or --raw --output fixture.txt for a raw dump."
  ].join("\n");

main().catch((error) => {
  console.error(`[inspect] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
