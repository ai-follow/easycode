#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { buildConversationSnapshotFromAccessibility, parseAccessibilityDump } from "./adapters/macos-accessibility.js";
import { discoverProcessWindows, dumpAccessibilityTree } from "./adapters/macos-automation.js";
import type { AdapterName } from "./adapters/index.js";
import { resolveMacAdapterConfig } from "./adapters/index.js";

type InspectOptions = {
  adapterName: AdapterName;
  windowIndex: number;
  raw: boolean;
  json: boolean;
  inputPath?: string;
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
    inputPath: args.includes("--input") ? get("--input", "") : undefined,
    outputPath: args.includes("--output") ? get("--output", "") : undefined
  };
};

const main = async (): Promise<void> => {
  const options = parseArgs();
  const config = resolveMacAdapterConfig(options.adapterName);
  const capture = await captureRawAccessibility(options, config);

  const elements = parseAccessibilityDump(capture.raw);
  const snapshot = buildConversationSnapshotFromAccessibility({
    adapterId: config.id,
    sessionId: `inspect_${config.id}`,
    title: capture.title,
    elements
  });

  const result = options.raw
    ? capture.raw
    : options.json
      ? JSON.stringify({ target: capture.target, elementCount: elements.length, snapshot }, null, 2)
      : formatSummary(config.appName, capture.title, elements.length, snapshot.messages.length, snapshot.pendingInteractions.length);

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
    "Use --json for parsed snapshot details, --raw --output fixture.txt for a raw dump, or --input fixture.txt to replay one."
  ].join("\n");

const captureRawAccessibility = async (
  options: InspectOptions,
  config: ReturnType<typeof resolveMacAdapterConfig>
): Promise<{ raw: string; title: string; target: unknown }> => {
  if (options.inputPath) {
    const raw = await readFile(options.inputPath, "utf8");
    return {
      raw,
      title: options.inputPath,
      target: {
        source: "fixture",
        path: options.inputPath
      }
    };
  }

  if (process.platform !== "darwin") {
    throw new Error("Live accessibility inspection is only available on macOS. Use --input fixture.txt to replay a saved dump.");
  }

  const windows = await discoverProcessWindows(config.processName);
  if (windows.length === 0) {
    throw new Error(`No windows found for process ${config.processName}. Is ${config.appName} running?`);
  }

  const target = windows.find((window) => window.windowIndex === options.windowIndex) ?? windows[0];
  if (!target) throw new Error(`No inspectable window found for ${config.processName}`);

  return {
    raw: await dumpAccessibilityTree(config.processName, target.windowIndex),
    title: target.title,
    target
  };
};

main().catch((error) => {
  console.error(`[inspect] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
