import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { promisify } from "node:util";
import type {
  AdapterCapability,
  AttachedSession,
  ClientAdapterId,
  ClientEvent,
  ClientTarget,
  ConversationSnapshot,
  DeliveryReceipt,
  InteractionRequest,
  UserInput
} from "@easycode/protocol";
import { nowIso } from "@easycode/protocol";
import {
  buildConversationSnapshotFromAccessibility,
  parseAccessibilityDump
} from "./macos-accessibility.js";
import {
  clickButtonByLabel,
  discoverProcessWindows,
  dumpAccessibilityTree,
  pasteAndSubmitText,
  pasteAndSubmitTextToProcess
} from "./macos-automation.js";
import type { ClientAdapter } from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 2500;
const PROCESS_LIST_TIMEOUT_MS = 3000;

const execFileAsync = promisify(execFile);

type MacWindowAdapterOptions = {
  id: ClientAdapterId;
  appName: string;
  processName: string;
  processes?: MacProcessConfig[];
  continueOnly?: boolean;
};

export type MacProcessConfig = {
  appName: string;
  processName: string;
};

type InteractionResponseInput = Extract<UserInput, { type: "interaction_response" }>;

export class MacWindowAdapter implements ClientAdapter {
  readonly id: ClientAdapterId;
  private readonly appName: string;
  private readonly processName: string;
  private readonly processes: MacProcessConfig[];
  private readonly continueOnly: boolean;
  private readonly pollIntervalMs: number;
  private session?: AttachedSession;
  private target?: ClientTarget;
  private readonly seenMessageIds = new Set<string>();
  private readonly seenInteractionIds = new Set<string>();
  private readonly interactionOptionLabelsById = new Map<string, string>();

  constructor(options: MacWindowAdapterOptions) {
    this.id = options.id;
    this.appName = options.appName;
    this.processName = options.processName;
    this.processes = options.processes ?? [
      {
        appName: options.appName,
        processName: options.processName
      }
    ];
    this.continueOnly = options.continueOnly ?? false;
    this.pollIntervalMs = Number(process.env.EASYCODE_ACCESSIBILITY_POLL_MS ?? DEFAULT_POLL_INTERVAL_MS);
  }

  capabilities(): AdapterCapability {
    if (this.continueOnly) {
      return {
        readMode: "none",
        sendMode: "clipboard-paste",
        interactionMode: "none"
      };
    }

    return {
      readMode: "accessibility",
      sendMode: "clipboard-paste",
      interactionMode: "accessibility"
    };
  }

  async discoverClients(): Promise<ClientTarget[]> {
    if (process.platform !== "darwin") return [];
    if (this.continueOnly) {
      const runningProcessNames = await safeListRunningMacProcessNames();
      return selectContinueOnlyProcessConfigs(this.processes, runningProcessNames).map((processConfig) =>
        this.processTarget(processConfig, runningProcessNames.has(processConfig.processName))
      );
    }

    const targets: ClientTarget[] = [];

    for (const processConfig of this.processes) {
      const windows = await safeDiscoverProcessWindows(processConfig.processName);
      targets.push(...windows.map((window) => this.windowTarget(processConfig, window)));
    }

    if (targets.length > 0) return targets;

    const fallbackProcess = this.processes[0] ?? {
      appName: this.appName,
      processName: this.processName
    };
    const prefix = this.processes.length > 1 ? `${this.id}:${targetIdSegment(fallbackProcess.processName)}` : this.id;
    return [
      {
        id: `${prefix}:process`,
        adapterId: this.id,
        title: fallbackProcess.appName,
        appName: fallbackProcess.appName,
        platform: "macos",
        metadata: {
          appName: fallbackProcess.appName,
          processName: fallbackProcess.processName,
          windowIndex: 0
        }
      }
    ];
  }

  async attach(target: ClientTarget): Promise<AttachedSession> {
    this.target = target;
    this.seenMessageIds.clear();
    this.seenInteractionIds.clear();
    this.interactionOptionLabelsById.clear();
    this.session = {
      sessionId: `session_${randomUUID()}`,
      targetId: target.id,
      adapterId: this.id,
      title: target.title,
      attachedAt: nowIso()
    };
    return this.session;
  }

  async getSnapshot(sessionId: string): Promise<ConversationSnapshot> {
    this.assertSession(sessionId);
    if (this.continueOnly) return this.continueOnlySnapshot(sessionId);
    const snapshot = await this.captureSnapshotOrError(sessionId);
    this.rememberSnapshot(snapshot);
    return snapshot;
  }

  async *subscribeEvents(sessionId: string): AsyncIterable<ClientEvent> {
    this.assertSession(sessionId);
    if (this.continueOnly) {
      yield {
        type: "session_state",
        payload: {
          status: "idle",
          detail: "Continue-only mode: waiting for mobile text input",
          updatedAt: nowIso()
        }
      };
      return;
    }

    yield {
      type: "session_state",
      payload: {
        status: "attached",
        detail: "Polling macOS accessibility tree",
        updatedAt: nowIso()
      }
    };

    while (true) {
      await sleep(this.pollIntervalMs);

      try {
        const snapshot = await this.captureSnapshot(sessionId);
        for (const message of snapshot.messages) {
          if (this.seenMessageIds.has(message.id)) continue;
          this.seenMessageIds.add(message.id);
          yield {
            type: "message",
            payload: message
          };
        }

        for (const interaction of snapshot.pendingInteractions) {
          rememberInteractionOptionLabels(this.interactionOptionLabelsById, [interaction]);
          if (this.seenInteractionIds.has(interaction.id)) continue;
          this.seenInteractionIds.add(interaction.id);
          yield {
            type: "interaction_request",
            payload: interaction
          };
        }

        yield {
          type: "session_state",
          payload: snapshot.state
        };
      } catch (error) {
        yield {
          type: "session_state",
          payload: {
            status: "error",
            detail: formatMacosAutomationError(this.id, error, this.targetProcessName()),
            updatedAt: nowIso()
          }
        };
      }
    }
  }

  async sendInput(sessionId: string, input: UserInput): Promise<DeliveryReceipt> {
    this.assertSession(sessionId);

    if (process.platform !== "darwin") {
      return {
        inputId: input.inputId,
        status: "failed",
        detail: "macOS automation is only available on darwin.",
        deliveredAt: nowIso()
      };
    }

    if (input.type === "interaction_response") {
      try {
        await this.clickInteractionOption(input.optionId, resolveInteractionResponseLabel(input, this.interactionOptionLabelsById));
      } catch (error) {
        throw this.formatDeliveryError(error);
      }
      return {
        inputId: input.inputId,
        status: "delivered",
        deliveredAt: nowIso()
      };
    }

    try {
      if (this.usesProcessLevelPaste()) {
        await pasteAndSubmitTextToProcess(this.targetProcessName(), input.text, this.targetAppName());
      } else {
        await pasteAndSubmitText(this.targetProcessName(), this.targetWindowIndex(), input.text);
      }
    } catch (error) {
      throw this.formatDeliveryError(error);
    }
    return {
      inputId: input.inputId,
      status: "delivered",
      deliveredAt: nowIso()
    };
  }

  private assertSession(sessionId: string): void {
    if (!this.session || this.session.sessionId !== sessionId) {
      throw new Error(`Unknown ${this.id} session: ${sessionId}`);
    }
  }

  private async captureSnapshot(sessionId: string): Promise<ConversationSnapshot> {
    if (process.platform !== "darwin") {
      return buildConversationSnapshotFromAccessibility({
        adapterId: this.id,
        sessionId,
        title: this.session?.title ?? this.appName,
        elements: [],
        stateDetail: "macOS accessibility capture is only available on darwin"
      });
    }

    const windowIndex = this.targetWindowIndex();
    const raw = await dumpAccessibilityTree(this.targetProcessName(), windowIndex);
    return buildConversationSnapshotFromAccessibility({
      adapterId: this.id,
      sessionId,
      title: this.session?.title ?? this.appName,
      elements: parseAccessibilityDump(raw)
    });
  }

  private continueOnlySnapshot(sessionId: string): ConversationSnapshot {
    const capturedAt = nowIso();
    const title = this.session?.title ?? this.appName;
    return {
      sessionId,
      adapterId: this.id,
      title,
      messages: [
        {
          id: `message_${this.id}_${sessionId}_continue_only`,
          role: "system",
          text: "Continue-only mode is attached. Mobile can send Continue without reading this desktop window.",
          createdAt: capturedAt,
          raw: {
            source: "continue-only"
          }
        }
      ],
      pendingInteractions: [],
      state: {
        status: "idle",
        title,
        detail: "Continue-only mode: no macOS accessibility capture is required",
        updatedAt: capturedAt
      },
      capturedAt
    };
  }

  private async captureSnapshotOrError(sessionId: string): Promise<ConversationSnapshot> {
    try {
      return await this.captureSnapshot(sessionId);
    } catch (error) {
      return this.errorSnapshot(sessionId, error);
    }
  }

  private errorSnapshot(sessionId: string, error: unknown): ConversationSnapshot {
    const capturedAt = nowIso();
    const title = this.session?.title ?? this.appName;
    return {
      sessionId,
      adapterId: this.id,
      title,
      messages: [],
      pendingInteractions: [],
      state: {
        status: "error",
        title,
        detail: formatMacosAutomationError(this.id, error, this.targetProcessName()),
        updatedAt: capturedAt
      },
      capturedAt
    };
  }

  private rememberSnapshot(snapshot: ConversationSnapshot): void {
    for (const message of snapshot.messages) this.seenMessageIds.add(message.id);
    for (const interaction of snapshot.pendingInteractions) this.seenInteractionIds.add(interaction.id);
    rememberInteractionOptionLabels(this.interactionOptionLabelsById, snapshot.pendingInteractions);
  }

  private targetWindowIndex(): number {
    const rawIndex = this.target?.metadata?.windowIndex;
    return typeof rawIndex === "number" ? rawIndex + 1 : 1;
  }

  private targetProcessName(): string {
    const processName = this.target?.metadata?.processName;
    return typeof processName === "string" && processName.length > 0 ? processName : this.processName;
  }

  private targetAppName(): string {
    const appName = this.target?.metadata?.appName;
    return typeof appName === "string" && appName.length > 0 ? appName : this.appName;
  }

  private usesProcessLevelPaste(): boolean {
    return this.continueOnly || this.target?.metadata?.continueOnly === true;
  }

  private async clickInteractionOption(optionId: string, label: string): Promise<void> {
    await clickButtonByLabel(this.targetProcessName(), this.targetWindowIndex(), label || optionId);
  }

  private formatDeliveryError(error: unknown): Error {
    return new Error(formatMacosAutomationError(this.id, error, this.targetProcessName(), {
      continueOnly: this.usesProcessLevelPaste()
    }));
  }

  private windowTarget(processConfig: MacProcessConfig, window: { title: string; windowIndex: number }): ClientTarget {
    const prefix = this.processes.length > 1 ? `${this.id}:${targetIdSegment(processConfig.processName)}` : this.id;
    return {
      id: `${prefix}:window:${window.windowIndex - 1}`,
      adapterId: this.id,
      title: window.title,
      appName: processConfig.appName,
      platform: "macos",
      metadata: {
        appName: processConfig.appName,
        processName: processConfig.processName,
        windowIndex: window.windowIndex - 1
      }
    };
  }

  private processTarget(processConfig: MacProcessConfig, running?: boolean): ClientTarget {
    const prefix = this.processes.length > 1 ? `${this.id}:${targetIdSegment(processConfig.processName)}` : this.id;
    return {
      id: `${prefix}:process`,
      adapterId: this.id,
      title: processConfig.appName,
      appName: processConfig.appName,
      platform: "macos",
      metadata: {
        appName: processConfig.appName,
        processName: processConfig.processName,
        windowIndex: 0,
        continueOnly: true,
        running
      }
    };
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const safeDiscoverProcessWindows = async (processName: string): Promise<Array<{ title: string; windowIndex: number }>> => {
  try {
    return await discoverProcessWindows(processName);
  } catch {
    return [];
  }
};

export const selectContinueOnlyProcessConfigs = (
  processes: MacProcessConfig[],
  runningProcessNames: ReadonlySet<string>
): MacProcessConfig[] => {
  if (runningProcessNames.size === 0) return processes;
  const runningProcesses = processes.filter((processConfig) => runningProcessNames.has(processConfig.processName));
  return runningProcesses.length > 0 ? runningProcesses : processes;
};

const safeListRunningMacProcessNames = async (): Promise<Set<string>> => {
  try {
    return await listRunningMacProcessNames();
  } catch {
    return new Set();
  }
};

export const listRunningMacProcessNames = async (): Promise<Set<string>> => {
  const { stdout } = await execFileAsync("ps", ["-axo", "comm="], {
    maxBuffer: 1024 * 1024,
    timeout: PROCESS_LIST_TIMEOUT_MS
  });
  return new Set(
    stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((command) => basename(command))
  );
};

export const rememberInteractionOptionLabels = (
  labelsByOptionId: Map<string, string>,
  interactions: Array<Pick<InteractionRequest, "options">>
): void => {
  for (const interaction of interactions) {
    for (const option of interaction.options) {
      labelsByOptionId.set(option.id, option.label);
    }
  }
};

export const resolveInteractionResponseLabel = (
  input: InteractionResponseInput,
  labelsByOptionId: ReadonlyMap<string, string>
): string => {
  if (typeof input.value === "string" && input.value.trim().length > 0) return input.value;
  const remembered = labelsByOptionId.get(input.optionId);
  if (remembered) return remembered;
  if (typeof input.value !== "undefined" && input.value !== null) return String(input.value);
  return input.optionId;
};

export const formatMacosAutomationError = (
  adapterId: ClientAdapterId,
  error: unknown,
  processName?: string,
  options: {
    continueOnly?: boolean;
  } = {}
): string => {
  const message = error instanceof Error ? error.message : String(error);
  const processArg = processName ? ` --process ${quoteCommandArg(processName)}` : "";
  const diagnosticFlag = options.continueOnly ? "--continue-only-targets" : "--continue-probe";
  const prefix = options.continueOnly ? "macOS continue-only automation failed" : "macOS accessibility automation failed";
  return [
    `${prefix}: ${message.replace(/\s+/g, " ").trim()}`,
    `Run: pnpm --filter @easycode/desktop-agent inspect -- --adapter ${adapterId}${processArg} ${diagnosticFlag}`
  ].join(". ");
};

const targetIdSegment = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "process";

const quoteCommandArg = (value: string): string => {
  if (/^[A-Za-z0-9._:/-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
};
