import {
  EncryptedRelayPayloadSchema,
  KeyExchangePayloadSchema,
  RelayPayloadSchema,
  type EncryptedRelayPayload,
  type KeyExchangePayload,
  type RelayEnvelope,
  type RelayPayload,
  type RelaySource
} from "@easycode/protocol";

export type E2eeRole = "desktop" | "mobile";

export const E2EE_KEY_EXCHANGE_SUITE = "p256-hkdf-sha256-aes-256-gcm";
export const E2EE_PAYLOAD_VERSION = 1;
export const E2EE_PAYLOAD_SUITE = "aes-256-gcm";

export type CleartextRelayPayload = Exclude<RelayPayload, EncryptedRelayPayload | KeyExchangePayload>;

export const RELAY_PAYLOAD_KINDS_SENT_CLEAR = [
  "ack",
  "error",
  "ping",
  "key_exchange",
  "encrypted_payload"
] as const satisfies readonly RelayPayload["kind"][];

export const shouldEncryptRelayPayload = (payload: RelayPayload): payload is CleartextRelayPayload =>
  !RELAY_PAYLOAD_KINDS_SENT_CLEAR.includes(payload.kind as typeof RELAY_PAYLOAD_KINDS_SENT_CLEAR[number]);

export type RelayPayloadKey = {
  keyId: string;
  key: CryptoKey;
};

export type DeriveRelayPayloadKeyOptions = {
  secret: Uint8Array;
  pairId: string;
  keyId?: string;
};

export type RelayPayloadAadInput = {
  envelopeId: string;
  pairId: string;
  source: RelaySource;
  createdAt: string;
};

export type RelayEnvelopeAadInput = Pick<RelayEnvelope, "id" | "pairId" | "source" | "createdAt">;

export type EncryptRelayPayloadOptions = RelayPayloadKey & {
  aad?: Uint8Array;
};

export type DecryptRelayPayloadOptions = {
  key: CryptoKey;
  aad?: Uint8Array;
};

export type CreateKeyExchangePayloadOptions = {
  phase: KeyExchangePayload["phase"];
  keyId: string;
  publicKey: CryptoKey;
};

export type DeriveRelayPayloadKeyFromPeerOptions = {
  privateKey: CryptoKey;
  peerPublicKey: CryptoKey | string;
  pairId: string;
  keyId?: string;
};

export type RelayE2eeSessionOptions = {
  role: E2eeRole;
  pairId: string;
  keyId?: string;
};

export type SerializedRelayE2eeSession = {
  version: 1;
  role: E2eeRole;
  pairId: string;
  keyId: string;
  publicKey: string;
  privateKeyJwk: JsonWebKey;
  peerPublicKey?: string;
};

const keyInfo = new TextEncoder().encode("easycode relay payload encryption v1");

export const generateRelayKeySecret = (): Uint8Array => {
  const secret = new Uint8Array(32);
  crypto.getRandomValues(secret);
  return secret;
};

export class RelayE2eeSession {
  private payloadKey?: RelayPayloadKey;

  private constructor(
    private readonly role: E2eeRole,
    private readonly pairId: string,
    private readonly keyId: string,
    private readonly keyPair: CryptoKeyPair,
    private peerPublicKey?: string
  ) {}

  static async create(options: RelayE2eeSessionOptions): Promise<RelayE2eeSession> {
    return new RelayE2eeSession(
      options.role,
      options.pairId,
      options.keyId ?? defaultPayloadKeyId(options.pairId),
      await generateKeyExchangeKeyPair()
    );
  }

  static async restore(state: SerializedRelayE2eeSession): Promise<RelayE2eeSession> {
    if (state.version !== E2EE_PAYLOAD_VERSION) {
      throw new Error(`Unsupported relay E2EE session version: ${state.version}`);
    }
    const keyPair: CryptoKeyPair = {
      privateKey: await importKeyExchangePrivateKey(state.privateKeyJwk),
      publicKey: await importKeyExchangePublicKey(state.publicKey)
    };
    const session = new RelayE2eeSession(
      state.role,
      state.pairId,
      state.keyId,
      keyPair,
      state.peerPublicKey
    );
    if (state.peerPublicKey) await session.derivePayloadKey(state.peerPublicKey);
    return session;
  }

  get ready(): boolean {
    return Boolean(this.payloadKey);
  }

  async createHello(): Promise<KeyExchangePayload> {
    return createKeyExchangePayload({
      phase: this.role === "desktop" ? "desktop_hello" : "mobile_hello",
      keyId: this.keyId,
      publicKey: this.keyPair.publicKey
    });
  }

  async handleKeyExchange(payload: KeyExchangePayload): Promise<void> {
    const parsed = KeyExchangePayloadSchema.parse(payload);
    if (parsed.suite !== E2EE_KEY_EXCHANGE_SUITE) {
      throw new Error(`Unsupported key exchange suite: ${parsed.suite}`);
    }
    if (parsed.keyId !== this.keyId) {
      throw new Error(`Unexpected key exchange key id: ${parsed.keyId}`);
    }
    const expectedPhase = this.role === "desktop" ? "mobile_hello" : "desktop_hello";
    if (parsed.phase !== expectedPhase) {
      throw new Error(`Unexpected key exchange phase for ${this.role}: ${parsed.phase}`);
    }
    await this.derivePayloadKey(parsed.publicKey);
  }

  async serialize(): Promise<SerializedRelayE2eeSession> {
    return {
      version: E2EE_PAYLOAD_VERSION,
      role: this.role,
      pairId: this.pairId,
      keyId: this.keyId,
      publicKey: await exportKeyExchangePublicKey(this.keyPair.publicKey),
      privateKeyJwk: await exportKeyExchangePrivateKey(this.keyPair.privateKey),
      ...(this.peerPublicKey ? { peerPublicKey: this.peerPublicKey } : {})
    };
  }

  async encryptEnvelopePayload(
    envelope: RelayEnvelopeAadInput,
    payload: CleartextRelayPayload
  ): Promise<EncryptedRelayPayload> {
    if (!this.payloadKey) throw new Error("Relay E2EE session is not ready");
    return encryptRelayPayload(payload, {
      ...this.payloadKey,
      aad: relayEnvelopeAad(envelope)
    });
  }

  async decryptEnvelopePayload(envelope: RelayEnvelope): Promise<CleartextRelayPayload> {
    if (!this.payloadKey) throw new Error("Relay E2EE session is not ready");
    if (envelope.payload.kind !== "encrypted_payload") {
      throw new Error(`Expected encrypted relay payload, got ${envelope.payload.kind}`);
    }
    return decryptRelayPayload(envelope.payload, {
      key: this.payloadKey.key,
      aad: relayEnvelopeAad(envelope)
    });
  }

  private async derivePayloadKey(peerPublicKey: string): Promise<void> {
    this.peerPublicKey = peerPublicKey;
    this.payloadKey = await deriveRelayPayloadKeyFromPeer({
      privateKey: this.keyPair.privateKey,
      peerPublicKey,
      pairId: this.pairId,
      keyId: this.keyId
    });
  }
}

export const generateKeyExchangeKeyPair = async (): Promise<CryptoKeyPair> => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "ECDH",
      namedCurve: "P-256"
    },
    true,
    ["deriveBits"]
  );
  if (keyPair instanceof CryptoKey) throw new Error("ECDH key generation returned a single key");
  return keyPair;
};

export const exportKeyExchangePublicKey = async (publicKey: CryptoKey): Promise<string> => {
  const exported = await crypto.subtle.exportKey("spki", publicKey);
  return base64UrlEncode(new Uint8Array(exported));
};

export const exportKeyExchangePrivateKey = async (privateKey: CryptoKey): Promise<JsonWebKey> =>
  crypto.subtle.exportKey("jwk", privateKey);

export const importKeyExchangePublicKey = async (publicKey: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "spki",
    toArrayBuffer(base64UrlDecode(publicKey)),
    {
      name: "ECDH",
      namedCurve: "P-256"
    },
    true,
    []
  );

export const importKeyExchangePrivateKey = async (privateKey: JsonWebKey): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    "jwk",
    privateKey,
    {
      name: "ECDH",
      namedCurve: "P-256"
    },
    true,
    ["deriveBits"]
  );

export const createKeyExchangePayload = async (
  options: CreateKeyExchangePayloadOptions
): Promise<KeyExchangePayload> =>
  KeyExchangePayloadSchema.parse({
    kind: "key_exchange",
    version: E2EE_PAYLOAD_VERSION,
    suite: E2EE_KEY_EXCHANGE_SUITE,
    phase: options.phase,
    keyId: options.keyId,
    publicKey: await exportKeyExchangePublicKey(options.publicKey)
  });

export const deriveRelayPayloadKeyFromPeer = async (
  options: DeriveRelayPayloadKeyFromPeerOptions
): Promise<RelayPayloadKey> => {
  const peerPublicKey = typeof options.peerPublicKey === "string"
    ? await importKeyExchangePublicKey(options.peerPublicKey)
    : options.peerPublicKey;
  const sharedSecret = await crypto.subtle.deriveBits(
    {
      name: "ECDH",
      public: peerPublicKey
    },
    options.privateKey,
    256
  );
  return deriveRelayPayloadKey({
    secret: new Uint8Array(sharedSecret),
    pairId: options.pairId,
    keyId: options.keyId
  });
};

export const deriveRelayPayloadKey = async (options: DeriveRelayPayloadKeyOptions): Promise<RelayPayloadKey> => {
  if (options.secret.byteLength < 32) {
    throw new Error("Relay payload key derivation requires at least 32 bytes of secret material");
  }

  const salt = new TextEncoder().encode(`easycode pair ${options.pairId}`);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(options.secret),
    "HKDF",
    false,
    ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info: keyInfo
    },
    keyMaterial,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    ["encrypt", "decrypt"]
  );

  return {
    keyId: options.keyId ?? `pair:${options.pairId}:payload:v1`,
    key
  };
};

export const relayPayloadAad = (input: RelayPayloadAadInput): Uint8Array =>
  new TextEncoder().encode(stableJson({
    createdAt: input.createdAt,
    envelopeId: input.envelopeId,
    pairId: input.pairId,
    source: input.source,
    version: E2EE_PAYLOAD_VERSION
  }));

export const relayEnvelopeAad = (envelope: RelayEnvelopeAadInput): Uint8Array =>
  relayPayloadAad({
    envelopeId: envelope.id,
    pairId: envelope.pairId,
    source: envelope.source,
    createdAt: envelope.createdAt
  });

export const encryptRelayPayload = async (
  payload: CleartextRelayPayload,
  options: EncryptRelayPayloadOptions
): Promise<EncryptedRelayPayload> => {
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const plaintext = new TextEncoder().encode(stableJson(payload));
  const ciphertext = await crypto.subtle.encrypt(
    aesGcmParams(nonce, options.aad),
    options.key,
    toArrayBuffer(plaintext)
  );

  return EncryptedRelayPayloadSchema.parse({
    kind: "encrypted_payload",
    version: E2EE_PAYLOAD_VERSION,
    suite: E2EE_PAYLOAD_SUITE,
    keyId: options.keyId,
    nonce: base64UrlEncode(nonce),
    ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
    ...(options.aad ? { aad: base64UrlEncode(options.aad) } : {})
  });
};

export const decryptRelayPayload = async (
  payload: EncryptedRelayPayload,
  options: DecryptRelayPayloadOptions
): Promise<CleartextRelayPayload> => {
  const encrypted = EncryptedRelayPayloadSchema.parse(payload);
  if (encrypted.suite !== E2EE_PAYLOAD_SUITE) {
    throw new Error(`Unsupported relay payload encryption suite: ${encrypted.suite}`);
  }

  const plaintext = await crypto.subtle.decrypt(
    aesGcmParams(
      base64UrlDecode(encrypted.nonce),
      options.aad ?? (encrypted.aad ? base64UrlDecode(encrypted.aad) : undefined)
    ),
    options.key,
    toArrayBuffer(base64UrlDecode(encrypted.ciphertext))
  );
  const parsedJson = safeJson(new TextDecoder().decode(plaintext));
  const parsedPayload = RelayPayloadSchema.parse(parsedJson);
  if (parsedPayload.kind === "encrypted_payload") {
    throw new Error("Decrypted relay payload cannot be encrypted_payload");
  }
  if (parsedPayload.kind === "key_exchange") {
    throw new Error("Decrypted relay payload cannot be key_exchange");
  }
  return parsedPayload as CleartextRelayPayload;
};

export const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
};

export const base64UrlDecode = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("Invalid base64url value");
  const padded = value.padEnd(Math.ceil(value.length / 4) * 4, "=").replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const aesGcmParams = (nonce: Uint8Array, aad?: Uint8Array): AesGcmParams => ({
  name: "AES-GCM",
  iv: toArrayBuffer(nonce),
  ...(aad ? { additionalData: toArrayBuffer(aad) } : {})
});

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

const safeJson = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

const stableJson = (value: unknown): string => JSON.stringify(sortJson(value));

const defaultPayloadKeyId = (pairId: string): string => `pair:${pairId}:payload:v1`;

const sortJson = (value: unknown): unknown => {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(sortJson);
  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) output[key] = sortJson(input[key]);
  return output;
};
