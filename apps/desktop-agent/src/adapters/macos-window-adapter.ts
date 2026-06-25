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
import type { ClientAdapter } from "./types.js";

const execFileAsync = promisify(execFile);

type MacWindowAdapterOptions = {
  id: ClientAdapterId;
  appName: string;
  processName: string;
};

export class MacWindowAdapter implements ClientAdapter {
  readonly id: ClientAdapterId;
  private readonly appName: string;
  private readonly processName: string;
  private session?: AttachedSession;

  constructor(options: MacWindowAdapterOptions) {
    this.id = options.id;
    this.appName = options.appName;
    this.processName = options.processName;
  }

  capabilities(): AdapterCapability {
    return {
      readMode: "none",
      sendMode: "clipboard-paste",
      interactionMode: "none"
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
    return {
      sessionId,
      adapterId: this.id,
      title: this.session?.title ?? this.appName,
      messages: [],
      pendingInteractions: [],
      state: {
        status: "attached",
        detail: "macOS adapter can deliver input. Structured reading is not implemented yet.",
        updatedAt: nowIso()
      },
      capturedAt: nowIso()
    };
  }

  async *subscribeEvents(sessionId: string): AsyncIterable<ClientEvent> {
    this.assertSession(sessionId);
    yield {
      type: "session_state",
      payload: {
        status: "attached",
        detail: "Waiting for mobile input",
        updatedAt: nowIso()
      }
    };
  }

  async sendInput(sessionId: string, input: UserInput): Promise<DeliveryReceipt> {
    this.assertSession(sessionId);

    if (input.type !== "text") {
      return {
        inputId: input.inputId,
        status: "failed",
        detail: "This adapter cannot deliver interaction responses yet.",
        deliveredAt: nowIso()
      };
    }

    if (process.platform !== "darwin") {
      return {
        inputId: input.inputId,
        status: "failed",
        detail: "macOS automation is only available on darwin.",
        deliveredAt: nowIso()
      };
    }

    const escapedAppName = this.appName.replaceAll('"', '\\"');
    const script = `
      on run argv
        set the clipboard to item 1 of argv
        tell application "${escapedAppName}" to activate
        delay 0.2
        tell application "System Events"
          keystroke "v" using command down
          key code 36
        end tell
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
