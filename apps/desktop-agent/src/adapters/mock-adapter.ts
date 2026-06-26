import { randomUUID } from "node:crypto";
import type {
  AdapterCapability,
  AttachedSession,
  ClientEvent,
  ClientMessage,
  ClientTarget,
  ConversationSnapshot,
  DeliveryReceipt,
  InteractionRequest,
  UserInput
} from "@easycode/protocol";
import { nowIso } from "@easycode/protocol";
import type { ClientAdapter } from "./types.js";
import { AsyncEventQueue } from "./event-queue.js";

export class MockAdapter implements ClientAdapter {
  readonly id = "cursor" as const;

  private session?: AttachedSession;
  private readonly messages: ClientMessage[] = [];
  private readonly pendingInteractions = new Map<string, InteractionRequest>();
  private readonly queue = new AsyncEventQueue<ClientEvent>();

  capabilities(): AdapterCapability {
    return {
      readMode: "structured",
      sendMode: "official-api",
      interactionMode: "official-api"
    };
  }

  async discoverClients(): Promise<ClientTarget[]> {
    return [
      {
        id: "mock-cursor-window",
        adapterId: this.id,
        title: "Mock Cursor Session",
        appName: "Mock Cursor",
        platform: "mock",
        metadata: {
          purpose: "End-to-end protocol validation"
        }
      }
    ];
  }

  async attach(target: ClientTarget): Promise<AttachedSession> {
    this.session = {
      sessionId: `session_${randomUUID()}`,
      targetId: target.id,
      adapterId: this.id,
      title: target.title,
      attachedAt: nowIso()
    };

    this.addMessage("system", "Mock session attached. Send text from the mobile client. Type /request to simulate a client interaction.");
    this.emitState("idle", "Mock adapter ready");
    return this.session;
  }

  async getSnapshot(sessionId: string): Promise<ConversationSnapshot> {
    this.assertSession(sessionId);
    return {
      sessionId,
      adapterId: this.id,
      title: this.session?.title ?? "Mock Session",
      messages: [...this.messages],
      pendingInteractions: [...this.pendingInteractions.values()],
      state: {
        status: "idle",
        detail: "Mock adapter snapshot",
        updatedAt: nowIso()
      },
      capturedAt: nowIso()
    };
  }

  subscribeEvents(sessionId: string): AsyncIterable<ClientEvent> {
    this.assertSession(sessionId);
    return this.queue;
  }

  async sendInput(sessionId: string, input: UserInput): Promise<DeliveryReceipt> {
    this.assertSession(sessionId);

    if (input.type === "text") {
      this.addMessage("user", input.text);
      if (input.text.trim() === "/fail-delivery") {
        return {
          inputId: input.inputId,
          status: "failed",
          detail: "macOS continue-only automation failed: Process is not running: Codex. Run: pnpm --filter @easycode/desktop-agent inspect -- --adapter codex --process Codex --continue-only-targets",
          deliveredAt: nowIso()
        };
      }

      if (input.text.trim() === "/request") {
        const request: InteractionRequest = {
          id: `interaction_${randomUUID()}`,
          text: "Mock client is asking for a user decision. EasyCode only relays these options.",
          options: [
            { id: "approve", label: "approve", value: "approve" },
            { id: "reject", label: "reject", value: "reject" },
            { id: "stop", label: "stop", value: "stop" },
            { id: "continue", label: "continue", value: "continue" }
          ],
          raw: {
            source: "mock-adapter"
          }
        };
        this.pendingInteractions.set(request.id, request);
        this.queue.push({ type: "interaction_request", payload: request });
        this.emitState("waiting_for_user", "Mock interaction request emitted");
      } else {
        this.emitState("streaming", "Mock assistant response");
        setTimeout(() => {
          this.addMessage("assistant", `Echo from desktop client: ${input.text}`);
          this.emitState("idle", "Mock response complete");
        }, 350);
      }
    } else {
      const request = this.pendingInteractions.get(input.requestId);
      this.pendingInteractions.delete(input.requestId);
      this.addMessage("client", `Interaction response delivered: ${input.optionId}${request ? ` for "${request.text}"` : ""}`);
      this.emitState("idle", "Interaction response delivered");
    }

    return {
      inputId: input.inputId,
      status: "delivered",
      deliveredAt: nowIso()
    };
  }

  private addMessage(role: ClientMessage["role"], text: string): void {
    const message: ClientMessage = {
      id: `message_${randomUUID()}`,
      role,
      text,
      createdAt: nowIso()
    };
    this.messages.push(message);
    this.queue.push({ type: "message", payload: message });
  }

  private emitState(status: "idle" | "streaming" | "waiting_for_user", detail: string): void {
    this.queue.push({
      type: "session_state",
      payload: {
        status,
        detail,
        updatedAt: nowIso()
      }
    });
  }

  private assertSession(sessionId: string): void {
    if (!this.session || this.session.sessionId !== sessionId) {
      throw new Error(`Unknown mock session: ${sessionId}`);
    }
  }
}
