import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type {
  AdapterCapability,
  AttachedSession,
  ClientAdapterId,
  ClientEvent,
  ClientTarget,
  ConversationSnapshot,
  DeliveryReceipt,
  UserInput
} from "@easycode/protocol";
import { nowIso } from "@easycode/protocol";
import {
  buildConversationSnapshotFromAccessibility,
  parseAccessibilityDump
} from "./macos-accessibility.js";
import type { ClientAdapter } from "./types.js";

const execFileAsync = promisify(execFile);
const DEFAULT_POLL_INTERVAL_MS = 2500;

type MacWindowAdapterOptions = {
  id: ClientAdapterId;
  appName: string;
  processName: string;
};

export class MacWindowAdapter implements ClientAdapter {
  readonly id: ClientAdapterId;
  private readonly appName: string;
  private readonly processName: string;
  private readonly pollIntervalMs: number;
  private session?: AttachedSession;
  private target?: ClientTarget;
  private readonly seenMessageIds = new Set<string>();
  private readonly seenInteractionIds = new Set<string>();

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

    const script = `
      tell application "System Events"
        if not (exists process "${this.processName}") then
          return ""
        end if
        set output to ""
        tell process "${this.processName}"
          repeat with w in windows
            set output to output & (name of w as text) & linefeed
          end repeat
        end tell
        return output
      end tell
    `;

    const { stdout } = await runOsa(script);
    const names = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (names.length === 0) {
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

    return names.map((title, index) => ({
      id: `${this.id}:window:${index}`,
      adapterId: this.id,
      title,
      appName: this.appName,
      platform: "macos",
      metadata: {
        processName: this.processName,
        windowIndex: index
      }
    }));
  }

  async attach(target: ClientTarget): Promise<AttachedSession> {
    this.target = target;
    this.seenMessageIds.clear();
    this.seenInteractionIds.clear();
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
      await this.clickInteractionOption(input.optionId, String(input.value ?? input.optionId));
      return {
        inputId: input.inputId,
        status: "delivered",
        deliveredAt: nowIso()
      };
    }

    const escapedAppName = this.appName.replaceAll('"', '\\"');
    const script = `
      on run argv
        set previousClipboard to the clipboard
        set the clipboard to item 1 of argv
        tell application "${escapedAppName}" to activate
        delay 0.2
        tell application "System Events"
          keystroke "v" using command down
          key code 36
        end tell
        delay 0.1
        set the clipboard to previousClipboard
      end run
    `;

    await runOsa(script, [input.text]);
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
  }

  private targetWindowIndex(): number {
    const rawIndex = this.target?.metadata?.windowIndex;
    return typeof rawIndex === "number" ? rawIndex + 1 : 1;
  }

  private async clickInteractionOption(optionId: string, label: string): Promise<void> {
    const script = `
      on run argv
        set processName to item 1 of argv
        set windowIndex to (item 2 of argv) as integer
        set buttonLabel to item 3 of argv
        tell application "System Events"
          if not (exists process processName) then error "Process is not running: " & processName
          tell process processName
            set frontmost to true
            repeat with candidate in entire contents of window windowIndex
              try
                if role of candidate is "AXButton" then
                  set candidateName to ""
                  try
                    set candidateName to name of candidate as text
                  end try
                  if candidateName is buttonLabel then
                    click candidate
                    return "clicked"
                  end if
                end if
              end try
            end repeat
          end tell
        end tell
        error "Button not found: " & buttonLabel
      end run
    `;

    await runOsa(script, [this.processName, String(this.targetWindowIndex()), label || optionId]);
  }
}

const runOsa = async (script: string, args: string[] = []): Promise<{ stdout: string; stderr: string }> => {
  const result = await execFileAsync("osascript", ["-e", script, ...args], {
    timeout: 10000,
    maxBuffer: 1024 * 1024
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr
  };
};

const dumpAccessibilityTree = async (processName: string, windowIndex: number): Promise<string> => {
  const script = `
    on sanitize(rawValue)
      set valueText to ""
      try
        set valueText to rawValue as text
      end try
      set AppleScript's text item delimiters to "\\\\"
      set parts to every text item of valueText
      set AppleScript's text item delimiters to "\\\\\\\\"
      set valueText to parts as text
      set AppleScript's text item delimiters to tab
      set parts to every text item of valueText
      set AppleScript's text item delimiters to "\\\\t"
      set valueText to parts as text
      set AppleScript's text item delimiters to linefeed
      set parts to every text item of valueText
      set AppleScript's text item delimiters to "\\\\n"
      set valueText to parts as text
      set AppleScript's text item delimiters to return
      set parts to every text item of valueText
      set AppleScript's text item delimiters to "\\\\n"
      set valueText to parts as text
      set AppleScript's text item delimiters to ""
      return valueText
    end sanitize

    on run argv
      set processName to item 1 of argv
      set windowIndex to (item 2 of argv) as integer
      tell application "System Events"
        if not (exists process processName) then error "Process is not running: " & processName
        tell process processName
          set frontmost to true
          set targetWindow to window windowIndex
          set output to ""
          repeat with elementRef in entire contents of targetWindow
            set roleValue to ""
            set roleDescriptionValue to ""
            set nameValue to ""
            set elementValue to ""
            set descriptionValue to ""
            set enabledValue to "false"
            try
              set roleValue to role of elementRef as text
            end try
            try
              set roleDescriptionValue to role description of elementRef as text
            end try
            try
              set nameValue to name of elementRef as text
            end try
            try
              set elementValue to value of elementRef as text
            end try
            try
              set descriptionValue to description of elementRef as text
            end try
            try
              if enabled of elementRef is true then set enabledValue to "true"
            end try
            set output to output & sanitize(roleValue) & tab & sanitize(roleDescriptionValue) & tab & sanitize(nameValue) & tab & sanitize(elementValue) & tab & sanitize(descriptionValue) & tab & enabledValue & linefeed
          end repeat
          return output
        end tell
      end tell
    end run
  `;

  const { stdout } = await runOsa(script, [processName, String(windowIndex)]);
  return stdout;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
