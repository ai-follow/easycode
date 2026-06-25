import { randomUUID } from "node:crypto";
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
  pasteAndSubmitText
} from "./macos-automation.js";
import type { ClientAdapter } from "./types.js";

const DEFAULT_POLL_INTERVAL_MS = 2500;

type MacWindowAdapterOptions = {
  id: ClientAdapterId;
  appName: string;
  processName: string;
};

type InteractionResponseInput = Extract<UserInput, { type: "interaction_response" }>;

export class MacWindowAdapter implements ClientAdapter {
  readonly id: ClientAdapterId;
  private readonly appName: string;
  private readonly processName: string;
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
    this.pollIntervalMs = Number(process.env.EASYCODE_ACCESSIBILITY_POLL_MS ?? DEFAULT_POLL_INTERVAL_MS);
  }

  capabilities(): AdapterCapability {
    return {
      readMode: "accessibility",
      sendMode: "clipboard-paste",
      interactionMode: "accessibility"
    };
  }

  async discoverClients(): Promise<ClientTarget[]> {
    if (process.platform !== "darwin") return [];

    const windows = await discoverProcessWindows(this.processName);

    if (windows.length === 0) {
      return [
        {
          id: `${this.id}:process`,
          adapterId: this.id,
          title: this.appName,
          appName: this.appName,
          platform: "macos",
          metadata: {
            processName: this.processName,
            windowIndex: 0
          }
        }
      ];
    }

    return windows.map((window) => ({
      id: `${this.id}:window:${window.windowIndex - 1}`,
      adapterId: this.id,
      title: window.title,
      appName: this.appName,
      platform: "macos",
      metadata: {
        processName: this.processName,
        windowIndex: window.windowIndex - 1
      }
    }));
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
    const snapshot = await this.captureSnapshot(sessionId);
    this.rememberSnapshot(snapshot);
    return snapshot;
  }

  async *subscribeEvents(sessionId: string): AsyncIterable<ClientEvent> {
    this.assertSession(sessionId);
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
            detail: error instanceof Error ? error.message : String(error),
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
      await this.clickInteractionOption(input.optionId, resolveInteractionResponseLabel(input, this.interactionOptionLabelsById));
      return {
        inputId: input.inputId,
        status: "delivered",
        deliveredAt: nowIso()
      };
    }

    await pasteAndSubmitText(this.appName, input.text);
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
    const raw = await dumpAccessibilityTree(this.processName, windowIndex);
    return buildConversationSnapshotFromAccessibility({
      adapterId: this.id,
      sessionId,
      title: this.session?.title ?? this.appName,
      elements: parseAccessibilityDump(raw)
    });
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

  private async clickInteractionOption(optionId: string, label: string): Promise<void> {
    await clickButtonByLabel(this.processName, this.targetWindowIndex(), label || optionId);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
