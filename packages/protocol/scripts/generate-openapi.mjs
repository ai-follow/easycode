import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateProtocolJsonSchema } from "./generate-json-schema.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(scriptDir, "..");
const openApiPath = resolve(packageRoot, "openapi/easycode-relay.openapi.json");

export const generateRelayOpenApi = () => ({
  openapi: "3.1.0",
  info: {
    title: "EasyCode Relay API",
    version: "0.1.0",
    description: "HTTP and WebSocket upgrade contract for the EasyCode relay."
  },
  servers: [
    {
      url: "http://localhost:8787",
      description: "Local development relay"
    }
  ],
  paths: {
    "/health": {
      get: {
        operationId: "getHealth",
        summary: "Return relay health and runtime metadata.",
        responses: {
          "200": jsonResponse("Relay health", "HealthResponse")
        }
      }
    },
    "/ready": {
      get: {
        operationId: "getReadiness",
        summary: "Return readiness for deployment probes.",
        responses: {
          "200": jsonResponse("Relay is ready", "ReadinessResponse"),
          "503": jsonResponse("Relay is not ready", "ReadinessResponse")
        }
      }
    },
    "/v1/pairings": {
      post: {
        operationId: "createPairing",
        summary: "Create a desktop pairing and one-time mobile claim code.",
        description: "Requires the admin bearer token or x-easycode-relay-token header when the relay is configured with EASYCODE_RELAY_ADMIN_TOKEN.",
        security: [
          { AdminBearer: [] },
          { AdminTokenHeader: [] },
          {}
        ],
        responses: {
          "201": jsonResponse("Pairing created", "CreatePairingResponse"),
          "401": jsonResponse("Missing or invalid admin token", "ErrorResponse")
        }
      }
    },
    "/v1/pairings/{pairId}": {
      delete: {
        operationId: "revokePairing",
        summary: "Revoke an active pairing with either device pair token.",
        security: [
          { PairTokenBearer: [] }
        ],
        parameters: [
          pathParameter("pairId", "Pair id returned by createPairing or claimPairing.")
        ],
        responses: {
          "204": {
            description: "Pairing revoked"
          },
          "401": jsonResponse("Missing or invalid pair token", "ErrorResponse")
        }
      }
    },
    "/v1/pairings/{pairingCode}/claim": {
      post: {
        operationId: "claimPairing",
        summary: "Claim a one-time pairing code from a mobile client.",
        parameters: [
          {
            ...pathParameter("pairingCode", "Six-digit one-time pairing code displayed by the desktop agent."),
            schema: {
              type: "string",
              pattern: "^[0-9]{6}$"
            }
          }
        ],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false
              }
            }
          }
        },
        responses: {
          "200": jsonResponse("Pairing claimed", "ClaimPairingResponse"),
          "404": jsonResponse("Pairing code not found, expired, already claimed, or revoked", "ErrorResponse")
        }
      }
    },
    "/v1/ws": {
      get: {
        operationId: "connectRelayWebSocket",
        summary: "Upgrade to the relay WebSocket for a paired desktop or mobile device.",
        description: "Desktop clients should send the pair token as a bearer token or x-easycode-relay-token header. Browser mobile clients send the mobile token in the token query parameter because browser WebSocket APIs cannot set custom headers.",
        security: [
          { PairTokenBearer: [] },
          { PairTokenHeader: [] },
          { MobileTokenQuery: [] }
        ],
        parameters: [
          queryParameter("pairId", "Pair id to connect."),
          {
            ...queryParameter("role", "Device role for this socket."),
            schema: {
              $ref: "#/components/schemas/DeviceRole"
            }
          },
          {
            ...queryParameter("token", "Mobile pair token for browser WebSocket clients."),
            required: false
          },
          {
            ...queryParameter("afterSeq", "Optional positive server sequence cursor for replay recovery."),
            required: false,
            schema: {
              type: "integer",
              minimum: 1
            }
          }
        ],
        responses: {
          "101": {
            description: "WebSocket upgrade accepted. Messages are JSON RelayEnvelope objects."
          },
          "401": {
            description: "Missing or invalid pair token"
          },
          "403": {
            description: "Origin not allowed"
          }
        }
      }
    }
  },
  components: {
    securitySchemes: {
      AdminBearer: {
        type: "http",
        scheme: "bearer",
        description: "Admin token for pairing creation when configured."
      },
      AdminTokenHeader: {
        type: "apiKey",
        in: "header",
        name: "x-easycode-relay-token",
        description: "Admin token header alternative for pairing creation."
      },
      PairTokenBearer: {
        type: "http",
        scheme: "bearer",
        description: "Desktop or mobile pair token."
      },
      PairTokenHeader: {
        type: "apiKey",
        in: "header",
        name: "x-easycode-relay-token",
        description: "Pair token header alternative for non-browser clients."
      },
      MobileTokenQuery: {
        type: "apiKey",
        in: "query",
        name: "token",
        description: "Mobile pair token for browser WebSocket clients."
      }
    },
    schemas: {
      ...generateProtocolJsonSchema().definitions,
      ErrorResponse: {
        type: "object",
        properties: {
          error: {
            type: "string"
          }
        },
        required: ["error"],
        additionalProperties: false
      },
      HealthResponse: {
        type: "object",
        properties: {
          ok: {
            type: "boolean",
            const: true
          },
          service: {
            type: "string",
            const: "easycode-relay"
          },
          version: {
            type: "string"
          },
          uptimeSeconds: {
            type: "integer",
            minimum: 0
          },
          startedAt: {
            type: "string",
            format: "date-time"
          },
          adminTokenConfigured: {
            type: "boolean"
          },
          heartbeatIntervalMs: {
            type: "integer",
            minimum: 1
          },
          pairings: {
            type: "integer",
            minimum: 0
          },
          connections: {
            type: "integer",
            minimum: 0
          }
        },
        required: ["ok", "service", "version", "uptimeSeconds", "startedAt", "adminTokenConfigured", "pairings", "connections"],
        additionalProperties: false
      },
      ReadinessResponse: {
        type: "object",
        properties: {
          ready: {
            type: "boolean"
          },
          checks: {
            type: "object",
            additionalProperties: {
              type: "boolean"
            }
          },
          errors: {
            type: "object",
            additionalProperties: {
              type: "string"
            }
          }
        },
        required: ["ready", "checks"],
        additionalProperties: false
      }
    }
  }
});

export const stringifyRelayOpenApi = () => `${JSON.stringify(generateRelayOpenApi(), null, 2)}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await mkdir(dirname(openApiPath), { recursive: true });
  await writeFile(openApiPath, stringifyRelayOpenApi());
  console.log(`Wrote ${openApiPath}`);
}

function jsonResponse(description, schemaName) {
  return {
    description,
    content: {
      "application/json": {
        schema: {
          $ref: `#/components/schemas/${schemaName}`
        }
      }
    }
  };
}

function pathParameter(name, description) {
  return {
    name,
    in: "path",
    required: true,
    description,
    schema: {
      type: "string",
      minLength: 1
    }
  };
}

function queryParameter(name, description) {
  return {
    name,
    in: "query",
    required: true,
    description,
    schema: {
      type: "string",
      minLength: 1
    }
  };
}
