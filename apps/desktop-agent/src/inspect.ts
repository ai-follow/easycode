#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { buildConversationSnapshotFromAccessibility, parseAccessibilityDump } from "./adapters/macos-accessibility.js";
import { discoverProcessWindows, dumpAccessibilityTree } from "./adapters/macos-automation.js";
import type { AdapterName } from "./adapters/index.js";
import { resolveMacAdapterConfig } from "./adapters/index.js";
import {
  diagnoseContinueOnlyTargets,
  formatContinueOnlyTargetDiagnostics
} from "./continue-only-diagnostics.js";
import { redactSensitiveText } from "./redaction.js";

type InspectOptions = {
  adapterName: AdapterName;
  processName?: string;
  windowIndex: number;
  raw: boolean;
  json: boolean;
  listWindows: boolean;
  continueProbe: boolean;
  continueOnlyTargets: boolean;
  redact: boolean;
  inputPath?: string;
  outputPath?: string;
};

type ContinueProbe =
  | {
    canSend: true;
    mode: "interaction_response";
    label: string;
    requestId: string;
    optionId: string;
  }
  | {
    canSend: true;
    mode: "text";
    label: "Continue";
    text: typeof DEFAULT_CONTINUE_TEXT;
  }
  | {
    canSend: false;
    mode: "none";
    reason: string;
    pendingOptionLabels?: string[];
  };

const DEFAULT_CONTINUE_TEXT = "continue";
const CONTINUE_PROBE_PATTERNS = [
  /\b(continue|proceed|resume|retry)\b/i,
  /\b(approve|allow|accept|yes|ok|okay|run)\b/i
] as const;

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
    processName: args.includes("--process") ? get("--process", "") : undefined,
    windowIndex: Number.isInteger(windowIndex) && windowIndex > 0 ? windowIndex : 1,
    raw: args.includes("--raw"),
    json: args.includes("--json"),
    listWindows: args.includes("--list-windows"),
    continueProbe: args.includes("--continue-probe"),
    continueOnlyTargets: args.includes("--continue-only-targets"),
    redact: !args.includes("--no-redact"),
    inputPath: args.includes("--input") ? get("--input", "") : undefined,
    outputPath: args.includes("--output") ? get("--output", "") : undefined
  };
};

const main = async (): Promise<void> => {
  const options = parseArgs();
  const config = resolveMacAdapterConfig(options.adapterName);
  if (options.continueOnlyTargets) {
    console.log(await formatContinueOnlyTargets(config, options.processName, options.json));
    return;
  }

  if (options.listWindows) {
    console.log(await formatInspectableWindows(config, options.processName));
    return;
  }

  const capture = await captureRawAccessibility(options, config);
  const raw = options.redact ? redactSensitiveText(capture.raw) : capture.raw;
  const title = options.redact ? redactSensitiveText(capture.title) : capture.title;
  const target = options.redact ? redactSerializable(capture.target) : capture.target;
  const warnings = options.redact ? capture.warnings.map(redactSensitiveText) : capture.warnings;

  const elements = parseAccessibilityDump(raw);
  const snapshot = buildConversationSnapshotFromAccessibility({
    adapterId: config.id,
    sessionId: `inspect_${config.id}`,
    title,
    elements
  });
  const continueProbe = options.continueProbe ? buildContinueProbe(snapshot.pendingInteractions) : undefined;

  const result = options.continueProbe
    ? options.json
      ? JSON.stringify({ target, warnings, elementCount: elements.length, snapshot, continueProbe }, null, 2)
      : formatContinueProbe(capture.appName, title, continueProbe, warnings)
    : options.raw
    ? raw
    : options.json
      ? JSON.stringify({ target, warnings, elementCount: elements.length, snapshot }, null, 2)
      : formatSummary(capture.appName, title, elements.length, snapshot.messages.length, snapshot.pendingInteractions.length, options.redact, warnings);

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
  interactionCount: number,
  redact: boolean,
  warnings: string[] = []
): string =>
  [
    `App: ${appName}`,
    `Window: ${title}`,
    `Accessibility elements: ${elementCount}`,
    `Parsed messages: ${messageCount}`,
    `Parsed interaction requests: ${interactionCount}`,
    "",
    redact
      ? "Inspect output is redacted by default. Use --no-redact only for private local debugging."
      : "Redaction disabled. Do not share this output unless you have reviewed it.",
    ...formatWarnings(warnings),
    "Use --json for parsed snapshot details, --raw --output fixture.txt for a raw dump, or --input fixture.txt to replay one."
  ].join("\n");

const buildContinueProbe = (
  pendingInteractions: ReturnType<typeof buildConversationSnapshotFromAccessibility>["pendingInteractions"]
): ContinueProbe => {
  let best:
    | {
      requestId: string;
      optionId: string;
      label: string;
      patternIndex: number;
      requestIndex: number;
      optionIndex: number;
    }
    | undefined;

  pendingInteractions.forEach((request, requestIndex) => {
    request.options.forEach((option, optionIndex) => {
      const patternIndex = CONTINUE_PROBE_PATTERNS.findIndex((pattern) => pattern.test(option.label));
      if (patternIndex < 0) return;
      if (
        !best ||
        patternIndex < best.patternIndex ||
        (patternIndex === best.patternIndex && requestIndex < best.requestIndex) ||
        (patternIndex === best.patternIndex && requestIndex === best.requestIndex && optionIndex < best.optionIndex)
      ) {
        best = {
          requestId: request.id,
          optionId: option.id,
          label: option.label,
          patternIndex,
          requestIndex,
          optionIndex
        };
      }
    });
  });

  if (best) {
    return {
      canSend: true,
      mode: "interaction_response",
      label: best.label,
      requestId: best.requestId,
      optionId: best.optionId
    };
  }

  if (pendingInteractions.length > 0) {
    return {
      canSend: false,
      mode: "none",
      reason: "Pending client interaction has no continue/approve-style option, so EasyCode will not replace it with generic text.",
      pendingOptionLabels: pendingInteractions.flatMap((request) => request.options.map((option) => option.label))
    };
  }

  return {
    canSend: true,
    mode: "text",
    label: "Continue",
    text: DEFAULT_CONTINUE_TEXT
  };
};

const formatContinueProbe = (
  appName: string,
  title: string,
  probe: ContinueProbe | undefined,
  warnings: string[] = []
): string => {
  if (!probe) throw new Error("Continue probe was not computed");
  const header = [`App: ${appName}`, `Window: ${title}`];
  if (probe.mode === "interaction_response") {
    return [
      ...header,
      "Continue action: client interaction option",
      `Option: ${probe.label}`,
      `Request id: ${probe.requestId}`,
      `Option id: ${probe.optionId}`,
      ...formatWarnings(warnings),
      "No input was sent."
    ].join("\n");
  }
  if (probe.mode === "text") {
    return [
      ...header,
      "Continue action: text input",
      `Text: ${probe.text}`,
      ...formatWarnings(warnings),
      "No input was sent."
    ].join("\n");
  }
  return [
    ...header,
    "Continue action: unavailable",
    `Reason: ${probe.reason}`,
    ...(probe.pendingOptionLabels?.length ? [`Pending options: ${probe.pendingOptionLabels.join(", ")}`] : []),
    ...formatWarnings(warnings),
    "No input was sent."
  ].join("\n");
};

const formatWarnings = (warnings: string[]): string[] =>
  warnings.length > 0
    ? [
      "",
      "Warnings:",
      ...warnings.map((warning) => `- ${warning}`)
    ]
    : [];

const formatInspectableWindows = async (
  config: ReturnType<typeof resolveMacAdapterConfig>,
  processName?: string
): Promise<string> => {
  if (process.platform !== "darwin") {
    throw new Error("Live window discovery is only available on macOS. Use --input fixture.txt to replay a saved dump.");
  }

  const { windows, warnings } = await discoverInspectableWindows(config, processName);
  if (windows.length === 0) {
    return [
      `No windows found for ${inspectableProcesses(config, processName).map((item) => item.processName).join(", ")}.`,
      ...formatWarnings(warnings)
    ].join("\n");
  }

  return [
    `Inspectable windows for ${config.appName}:`,
    ...windows.map((window) => `${window.processName}:${window.windowIndex}: ${window.title || "(untitled)"} (${window.appName})`),
    ...formatWarnings(warnings)
  ].join("\n");
};

const formatContinueOnlyTargets = async (
  config: ReturnType<typeof resolveMacAdapterConfig>,
  processName: string | undefined,
  json: boolean
): Promise<string> => {
  if (process.platform !== "darwin") {
    throw new Error("Live continue-only diagnostics are only available on macOS.");
  }

  const diagnostics = await diagnoseContinueOnlyTargets(inspectableProcesses(config, processName));
  if (json) {
    return JSON.stringify({
      adapterId: config.id,
      appName: config.appName,
      targets: diagnostics.targets,
      warnings: diagnostics.warnings
    }, null, 2);
  }

  return formatContinueOnlyTargetDiagnostics(config.appName, diagnostics);
};

const redactSerializable = <T>(value: T): T => {
  try {
    return JSON.parse(redactSensitiveText(JSON.stringify(value))) as T;
  } catch {
    return value;
  }
};

const captureRawAccessibility = async (
  options: InspectOptions,
  config: ReturnType<typeof resolveMacAdapterConfig>
): Promise<{ raw: string; title: string; appName: string; target: unknown; warnings: string[] }> => {
  if (options.inputPath) {
    const raw = await readFile(options.inputPath, "utf8");
    return {
      raw,
      title: options.inputPath,
      appName: config.appName,
      warnings: [],
      target: {
        source: "fixture",
        path: options.inputPath
      }
    };
  }

  if (process.platform !== "darwin") {
    throw new Error("Live accessibility inspection is only available on macOS. Use --input fixture.txt to replay a saved dump.");
  }

  const { windows, warnings } = await discoverInspectableWindows(config, options.processName);
  if (windows.length === 0) {
    const warningDetail = warnings.length > 0 ? ` ${warnings.join(" ")}` : "";
    throw new Error(`No windows found for ${inspectableProcesses(config, options.processName).map((item) => item.processName).join(", ")}.${warningDetail}`);
  }

  const target = windows.find((window) => window.windowIndex === options.windowIndex) ?? windows[0];
  if (!target) throw new Error(`No inspectable window found for ${options.processName ?? config.appName}`);

  return {
    raw: await dumpAccessibilityTree(target.processName, target.windowIndex),
    title: target.title,
    appName: target.appName,
    warnings,
    target
  };
};

type InspectableProcess = {
  appName: string;
  processName: string;
};

type InspectableWindow = InspectableProcess & {
  title: string;
  windowIndex: number;
};

const inspectableProcesses = (
  config: ReturnType<typeof resolveMacAdapterConfig>,
  processName?: string
): InspectableProcess[] => {
  const processes = config.processes && config.processes.length > 0
    ? config.processes
    : [
      {
        appName: config.appName,
        processName: config.processName
      }
    ];

  if (!processName) return processes;
  const selected = processes.filter((processConfig) =>
    processConfig.processName === processName || processConfig.appName === processName
  );
  if (selected.length > 0) return selected;
  return [
    {
      appName: processName,
      processName
    }
  ];
};

const discoverInspectableWindows = async (
  config: ReturnType<typeof resolveMacAdapterConfig>,
  processName?: string
): Promise<{ windows: InspectableWindow[]; warnings: string[] }> => {
  const windows: InspectableWindow[] = [];
  const warnings: string[] = [];
  for (const processConfig of inspectableProcesses(config, processName)) {
    let processWindows: Awaited<ReturnType<typeof discoverProcessWindows>>;
    try {
      processWindows = await discoverProcessWindows(processConfig.processName);
    } catch (error) {
      warnings.push(`Skipped ${processConfig.processName}: ${formatDiscoveryError(error)}`);
      continue;
    }
    windows.push(
      ...processWindows.map((window) => ({
        ...processConfig,
        title: window.title,
        windowIndex: window.windowIndex
      }))
    );
  }
  return { windows, warnings };
};

const formatDiscoveryError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Command failed: osascript")) {
    return "osascript could not read this process's windows; check macOS Accessibility permission or use --process to skip this candidate.";
  }
  return message.replace(/\s+/g, " ").trim();
};

main().catch((error) => {
  console.error(`[inspect] fatal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
