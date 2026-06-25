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

export type ClientAdapter = {
  id: ClientAdapterId;
  capabilities(): AdapterCapability;
  discoverClients(): Promise<ClientTarget[]>;
  attach(target: ClientTarget): Promise<AttachedSession>;
  getSnapshot(sessionId: string): Promise<ConversationSnapshot>;
  subscribeEvents(sessionId: string): AsyncIterable<ClientEvent>;
  sendInput(sessionId: string, input: UserInput): Promise<DeliveryReceipt>;
};
