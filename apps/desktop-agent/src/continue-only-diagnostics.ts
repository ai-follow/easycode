import {
  checkProcessExistsInSystemEvents
} from "./adapters/macos-automation.js";
import {
  listRunningMacProcessNames,
  selectContinueOnlyProcessConfigs,
  type MacProcessConfig
} from "./adapters/macos-window-adapter.js";

export type ContinueOnlyTargetDiagnostic = {
  appName: string;
  processName: string;
  selected: boolean;
  running: boolean;
  systemEvents: "visible" | "not-visible" | "error" | "skipped";
  detail?: string;
};

export type ContinueOnlyDiagnostics = {
  targets: ContinueOnlyTargetDiagnostic[];
  warnings: string[];
};

type BuildContinueOnlyDiagnosticsOptions = {
  processes: MacProcessConfig[];
  runningProcessNames: ReadonlySet<string>;
  checkSystemEventsProcess: (processName: string) => Promise<boolean>;
};

export const diagnoseContinueOnlyTargets = async (
  processes: MacProcessConfig[]
): Promise<ContinueOnlyDiagnostics> => {
  const warnings: string[] = [];
  let runningProcessNames = new Set<string>();

  try {
    runningProcessNames = await listRunningMacProcessNames();
  } catch (error) {
    warnings.push(`Could not read the macOS process list: ${formatError(error)}`);
  }

  const diagnostics = await buildContinueOnlyTargetDiagnostics({
    processes,
    runningProcessNames,
    checkSystemEventsProcess: checkProcessExistsInSystemEvents
  });
  return {
    targets: diagnostics.targets,
    warnings: [...warnings, ...diagnostics.warnings]
  };
};

export const buildContinueOnlyTargetDiagnostics = async ({
  processes,
  runningProcessNames,
  checkSystemEventsProcess
}: BuildContinueOnlyDiagnosticsOptions): Promise<ContinueOnlyDiagnostics> => {
  const selectedProcesses = selectContinueOnlyProcessConfigs(processes, runningProcessNames);
  const selectedProcessNames = new Set(selectedProcesses.map((processConfig) => processConfig.processName));
  const warnings: string[] = [];
  const targets: ContinueOnlyTargetDiagnostic[] = [];

  for (const processConfig of processes) {
    const running = runningProcessNames.has(processConfig.processName);
    let systemEvents: ContinueOnlyTargetDiagnostic["systemEvents"] = "skipped";
    let detail: string | undefined;

    if (running) {
      try {
        systemEvents = await checkSystemEventsProcess(processConfig.processName) ? "visible" : "not-visible";
      } catch (error) {
        systemEvents = "error";
        detail = formatError(error);
        warnings.push(`System Events could not inspect ${processConfig.processName}: ${detail}`);
      }
    }

    targets.push({
      appName: processConfig.appName,
      processName: processConfig.processName,
      selected: selectedProcessNames.has(processConfig.processName),
      running,
      systemEvents,
      detail
    });
  }

  return { targets, warnings };
};

export const formatContinueOnlyTargetDiagnostics = (
  appName: string,
  diagnostics: ContinueOnlyDiagnostics
): string => {
  const lines = [
    `Continue-only targets for ${appName}:`,
    ...diagnostics.targets.map((target, index) => {
      const markers = [
        target.selected ? "selected" : "candidate",
        target.running ? "running" : "not running",
        `system events: ${formatSystemEventsStatus(target.systemEvents)}`
      ];
      const detail = target.detail ? ` (${target.detail})` : "";
      return `${index}: ${target.appName} process=${target.processName} [${markers.join(", ")}]${detail}`;
    })
  ];

  if (diagnostics.warnings.length > 0) {
    lines.push("", "Warnings:", ...diagnostics.warnings.map((warning) => `- ${warning}`));
  }

  lines.push("", "No input was sent.");
  return lines.join("\n");
};

const formatSystemEventsStatus = (status: ContinueOnlyTargetDiagnostic["systemEvents"]): string => {
  switch (status) {
    case "visible":
      return "visible";
    case "not-visible":
      return "not visible";
    case "error":
      return "error";
    case "skipped":
      return "skipped";
  }
};

const formatError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim();
};
