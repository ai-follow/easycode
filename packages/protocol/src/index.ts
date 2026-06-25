import { z } from "zod";

export const ClientAdapterIdSchema = z.enum(["codex", "claude-code", "cursor"]);
export type ClientAdapterId = z.infer<typeof ClientAdapterIdSchema>;

export const DeviceRoleSchema = z.enum(["desktop", "mobile"]);
export type DeviceRole = z.infer<typeof DeviceRoleSchema>;

export const PAIRING_REVOKED_CLOSE_CODE = 4001;
export const PAIRING_REVOKED_CLOSE_REASON = "Pairing revoked";

export const RelaySourceSchema = z.enum(["desktop", "mobile", "server"]);
export type RelaySource = z.infer<typeof RelaySourceSchema>;

export const AdapterCapabilitySchema = z.object({
  readMode: z.enum(["structured", "accessibility", "ocr", "none"]),
  sendMode: z.enum(["official-api", "accessibility", "clipboard-paste", "none"]),
  interactionMode: z.enum(["official-api", "accessibility", "none"])
});
export type AdapterCapability = z.infer<typeof AdapterCapabilitySchema>;

export const ClientTargetSchema = z.object({
  id: z.string().min(1),
  adapterId: ClientAdapterIdSchema,
  title: z.string().min(1),
  appName: z.string().min(1),
  platform: z.enum(["macos", "windows", "linux", "mock"]),
  metadata: z.record(z.unknown()).optional()
});
export type ClientTarget = z.infer<typeof ClientTargetSchema>;

export const AttachedSessionSchema = z.object({
  sessionId: z.string().min(1),
  targetId: z.string().min(1),
  adapterId: ClientAdapterIdSchema,
  title: z.string().min(1),
  attachedAt: z.string().datetime()
});
export type AttachedSession = z.infer<typeof AttachedSessionSchema>;

export const ClientMessageSchema = z.object({
  id: z.string().min(1),
  role: z.enum(["user", "assistant", "system", "tool", "client"]),
  text: z.string(),
  createdAt: z.string().datetime(),
  raw: z.unknown().optional()
});
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

export const InteractionRequestSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  options: z.array(
    z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      value: z.unknown().optional()
    })
  ),
  raw: z.unknown().optional()
});
export type InteractionRequest = z.infer<typeof InteractionRequestSchema>;

export const SessionStateSchema = z.object({
  status: z.enum(["discovering", "attached", "idle", "streaming", "waiting_for_user", "error", "closed"]),
  title: z.string().optional(),
  detail: z.string().optional(),
  updatedAt: z.string().datetime()
});
export type SessionState = z.infer<typeof SessionStateSchema>;

export const DeliveryStateSchema = z.object({
  inputId: z.string().min(1),
  status: z.enum(["queued", "delivered", "failed"]),
  detail: z.string().optional(),
  updatedAt: z.string().datetime()
});
export type DeliveryState = z.infer<typeof DeliveryStateSchema>;

export const DeliveryReceiptSchema = z.object({
  inputId: z.string().min(1),
  status: z.enum(["delivered", "failed"]),
  detail: z.string().optional(),
  deliveredAt: z.string().datetime()
});
export type DeliveryReceipt = z.infer<typeof DeliveryReceiptSchema>;

export const UserInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    inputId: z.string().min(1),
    text: z.string()
  }),
  z.object({
    type: z.literal("interaction_response"),
    inputId: z.string().min(1),
    requestId: z.string().min(1),
    optionId: z.string().min(1),
    value: z.unknown().optional()
  })
]);
export type UserInput = z.infer<typeof UserInputSchema>;

export const ClientEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("message"),
    payload: ClientMessageSchema
  }),
  z.object({
    type: z.literal("interaction_request"),
    payload: InteractionRequestSchema
  }),
  z.object({
    type: z.literal("session_state"),
    payload: SessionStateSchema
  }),
  z.object({
    type: z.literal("delivery_state"),
    payload: DeliveryStateSchema
  })
]);
export type ClientEvent = z.infer<typeof ClientEventSchema>;

export const ConversationSnapshotSchema = z.object({
  sessionId: z.string().min(1),
  adapterId: ClientAdapterIdSchema,
  title: z.string(),
  messages: z.array(ClientMessageSchema),
  pendingInteractions: z.array(InteractionRequestSchema),
  state: SessionStateSchema,
  capturedAt: z.string().datetime()
});
export type ConversationSnapshot = z.infer<typeof ConversationSnapshotSchema>;

export const EncryptedRelayPayloadSchema = z.object({
  kind: z.literal("encrypted_payload"),
  version: z.literal(1),
  suite: z.enum(["xchacha20poly1305-ietf", "aes-256-gcm"]),
  keyId: z.string().min(1),
  nonce: z.string().min(1),
  ciphertext: z.string().min(1),
  aad: z.string().min(1).optional()
});
export type EncryptedRelayPayload = z.infer<typeof EncryptedRelayPayloadSchema>;

export const RelayPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("desktop_status"),
    targets: z.array(ClientTargetSchema),
    sessions: z.array(AttachedSessionSchema),
    capabilities: z.record(AdapterCapabilitySchema)
  }),
  z.object({
    kind: z.literal("session_snapshot"),
    sessionId: z.string().min(1),
    snapshot: ConversationSnapshotSchema
  }),
  z.object({
    kind: z.literal("client_event"),
    sessionId: z.string().min(1),
    event: ClientEventSchema
  }),
  z.object({
    kind: z.literal("user_input"),
    sessionId: z.string().min(1),
    input: UserInputSchema
  }),
  z.object({
    kind: z.literal("ack"),
    refId: z.string().min(1)
  }),
  z.object({
    kind: z.literal("error"),
    message: z.string(),
    refId: z.string().optional()
  }),
  z.object({
    kind: z.literal("ping"),
    nonce: z.string().min(1)
  }),
  EncryptedRelayPayloadSchema
]);
export type RelayPayload = z.infer<typeof RelayPayloadSchema>;

export const RelayEnvelopeSchema = z.object({
  id: z.string().min(1),
  pairId: z.string().min(1),
  serverSeq: z.number().int().positive().optional(),
  source: RelaySourceSchema,
  createdAt: z.string().datetime(),
  payload: RelayPayloadSchema
});
export type RelayEnvelope = z.infer<typeof RelayEnvelopeSchema>;

export const CreatePairingResponseSchema = z.object({
  pairId: z.string().min(1),
  pairingCode: z.string().min(4),
  desktopToken: z.string().min(16),
  expiresAt: z.string().datetime()
});
export type CreatePairingResponse = z.infer<typeof CreatePairingResponseSchema>;

export const ClaimPairingResponseSchema = z.object({
  pairId: z.string().min(1),
  mobileToken: z.string().min(16),
  expiresAt: z.string().datetime()
});
export type ClaimPairingResponse = z.infer<typeof ClaimPairingResponseSchema>;

export const createId = (prefix: string, random: () => string): string => `${prefix}_${random()}`;

export const nowIso = (): string => new Date().toISOString();
