import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  AdapterCapabilitySchema,
  AttachedSessionSchema,
  ClaimPairingResponseSchema,
  ClientAdapterIdSchema,
  ClientEventSchema,
  ClientMessageSchema,
  ClientTargetSchema,
  ConversationSnapshotSchema,
  CreatePairingResponseSchema,
  DeliveryReceiptSchema,
  DeliveryStateSchema,
  DeviceRoleSchema,
  EncryptedRelayPayloadSchema,
  InteractionRequestSchema,
  KeyExchangePayloadSchema,
  RelayEnvelopeSchema,
  RelayPayloadSchema,
  RelaySourceSchema,
  SessionStateSchema,
  UserInputSchema
} from "../dist/index.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const schemaPath = resolve(packageRoot, "schemas/easycode-protocol.schema.json");

const protocolSchemas = [
  ["ClientAdapterId", ClientAdapterIdSchema],
  ["DeviceRole", DeviceRoleSchema],
  ["RelaySource", RelaySourceSchema],
  ["AdapterCapability", AdapterCapabilitySchema],
  ["ClientTarget", ClientTargetSchema],
  ["AttachedSession", AttachedSessionSchema],
  ["ClientMessage", ClientMessageSchema],
  ["InteractionRequest", InteractionRequestSchema],
  ["SessionState", SessionStateSchema],
  ["DeliveryState", DeliveryStateSchema],
  ["DeliveryReceipt", DeliveryReceiptSchema],
  ["UserInput", UserInputSchema],
  ["ClientEvent", ClientEventSchema],
  ["ConversationSnapshot", ConversationSnapshotSchema],
  ["EncryptedRelayPayload", EncryptedRelayPayloadSchema],
  ["KeyExchangePayload", KeyExchangePayloadSchema],
  ["RelayPayload", RelayPayloadSchema],
  ["RelayEnvelope", RelayEnvelopeSchema],
  ["CreatePairingResponse", CreatePairingResponseSchema],
  ["ClaimPairingResponse", ClaimPairingResponseSchema]
];

export const generateProtocolJsonSchema = () => {
  const definitions = {};
  for (const [name, zodSchema] of protocolSchemas) {
    const converted = zodToJsonSchema(zodSchema, {
      name,
      $refStrategy: "none",
      target: "jsonSchema7"
    });
    const definition = converted.definitions?.[name];
    if (!definition) throw new Error(`Failed to generate JSON Schema definition for ${name}`);
    definitions[name] = definition;
  }

  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://easycode.dev/schemas/easycode-protocol.schema.json",
    title: "EasyCode Protocol",
    description: "Generated JSON Schema bundle for EasyCode relay protocol payloads and API responses.",
    anyOf: [
      { $ref: "#/definitions/RelayEnvelope" },
      { $ref: "#/definitions/RelayPayload" },
      { $ref: "#/definitions/CreatePairingResponse" },
      { $ref: "#/definitions/ClaimPairingResponse" }
    ],
    definitions
  };
};

export const stringifyProtocolJsonSchema = () => `${JSON.stringify(generateProtocolJsonSchema(), null, 2)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await mkdir(dirname(schemaPath), { recursive: true });
  await writeFile(schemaPath, stringifyProtocolJsonSchema());
  console.log(`Wrote ${schemaPath}`);
}
