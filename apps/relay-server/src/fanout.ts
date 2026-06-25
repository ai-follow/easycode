import { randomUUID } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import { RelayEnvelopeSchema, type RelayEnvelope } from "@easycode/protocol";

export type RelayFanoutMessage = {
  originId: string;
  envelope: RelayEnvelope;
};

export type RelayFanoutBus = {
  publish(message: RelayFanoutMessage): Promise<void>;
  subscribe(handler: (message: RelayFanoutMessage) => void | Promise<void>): Promise<void>;
  healthCheck?(): Promise<void>;
  close?(): Promise<void>;
};

export type RelayFanoutBusOptions = {
  redisUrl?: string;
  channel?: string;
};

const DEFAULT_REDIS_CHANNEL = "easycode:relay:fanout";

export const createRelayFanoutBus = (
  driver: string | undefined,
  options: RelayFanoutBusOptions = {}
): RelayFanoutBus | undefined => {
  if (!driver || driver === "none") return undefined;
  if (driver === "redis") return new RedisRelayFanoutBus(options);
  throw new Error(`Unsupported relay fanout driver "${driver}". Use "none" or "redis".`);
};

export class InMemoryRelayFanoutBus implements RelayFanoutBus {
  private readonly handlers = new Set<(message: RelayFanoutMessage) => void | Promise<void>>();

  async publish(message: RelayFanoutMessage): Promise<void> {
    await Promise.all([...this.handlers].map((handler) => handler(message)));
  }

  async subscribe(handler: (message: RelayFanoutMessage) => void | Promise<void>): Promise<void> {
    this.handlers.add(handler);
  }

  async close(): Promise<void> {
    this.handlers.clear();
  }

  async healthCheck(): Promise<void> {
    return undefined;
  }
}

export class RedisRelayFanoutBus implements RelayFanoutBus {
  private readonly publisher: RedisClientType;
  private readonly subscriber: RedisClientType;
  private readonly channel: string;
  private connecting?: Promise<void>;

  constructor(options: RelayFanoutBusOptions = {}) {
    const redisUrl = requiredRedisUrl(options.redisUrl);
    this.publisher = createClient({ url: redisUrl });
    this.subscriber = this.publisher.duplicate();
    this.channel = options.channel ?? DEFAULT_REDIS_CHANNEL;
  }

  async publish(message: RelayFanoutMessage): Promise<void> {
    await this.connect();
    await this.publisher.publish(this.channel, JSON.stringify(message));
  }

  async subscribe(handler: (message: RelayFanoutMessage) => void | Promise<void>): Promise<void> {
    await this.connect();
    await this.subscriber.subscribe(this.channel, async (raw) => {
      const parsed = parseFanoutMessage(raw);
      if (!parsed) return;
      await handler(parsed);
    });
  }

  async close(): Promise<void> {
    await Promise.allSettled([
      this.publisher.isOpen ? this.publisher.quit() : Promise.resolve(),
      this.subscriber.isOpen ? this.subscriber.quit() : Promise.resolve()
    ]);
  }

  async healthCheck(): Promise<void> {
    await this.connect();
    await this.publisher.ping();
  }

  private async connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    if (this.publisher.isOpen && this.subscriber.isOpen) return;

    this.connecting = Promise.all([
      this.publisher.isOpen ? Promise.resolve() : this.publisher.connect(),
      this.subscriber.isOpen ? Promise.resolve() : this.subscriber.connect()
    ]).then(() => undefined).finally(() => {
      this.connecting = undefined;
    });

    return this.connecting;
  }
}

export const relayNodeId = (): string => `relay_${randomUUID()}`;

const parseFanoutMessage = (raw: string): RelayFanoutMessage | undefined => {
  try {
    const parsed = JSON.parse(raw) as Partial<RelayFanoutMessage>;
    if (typeof parsed.originId !== "string") return undefined;
    const envelope = RelayEnvelopeSchema.safeParse(parsed.envelope);
    if (!envelope.success) return undefined;
    return {
      originId: parsed.originId,
      envelope: envelope.data
    };
  } catch {
    return undefined;
  }
};

const requiredRedisUrl = (redisUrl: string | undefined): string => {
  if (redisUrl) return redisUrl;
  throw new Error("Redis relay fanout requires EASYCODE_REDIS_URL or RelayFanoutBusOptions.redisUrl");
};
