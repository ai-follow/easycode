export type MobileWebSocketUrlOptions = {
  relayUrl: string;
  pairId: string;
  mobileToken: string;
  afterSeq?: number;
};

export type ReconnectDelayOptions = {
  attempt: number;
  baseMs?: number;
  maxMs?: number;
};

export const buildMobileWebSocketUrl = (options: MobileWebSocketUrlOptions): string => {
  const wsUrl = new URL("/v1/ws", options.relayUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.searchParams.set("pairId", options.pairId);
  wsUrl.searchParams.set("role", "mobile");
  wsUrl.searchParams.set("token", options.mobileToken);
  if (typeof options.afterSeq === "number" && Number.isInteger(options.afterSeq) && options.afterSeq > 0) {
    wsUrl.searchParams.set("afterSeq", String(options.afterSeq));
  }
  return wsUrl.toString();
};

export const nextReconnectAttempt = (currentAttempt: number, maxAttempt = 5): number => {
  const normalized = Number.isInteger(currentAttempt) && currentAttempt > 0 ? currentAttempt : 0;
  const normalizedMax = Number.isInteger(maxAttempt) && maxAttempt > 0 ? maxAttempt : 5;
  return Math.min(normalized + 1, normalizedMax);
};

export const reconnectDelayMs = (options: ReconnectDelayOptions): number => {
  const baseMs = positiveIntOrDefault(options.baseMs, 1000);
  const maxMs = positiveIntOrDefault(options.maxMs, 10000);
  const attempt = Number.isInteger(options.attempt) && options.attempt > 0 ? options.attempt : 1;
  return Math.min(baseMs * 2 ** (attempt - 1), maxMs);
};

const positiveIntOrDefault = (value: number | undefined, fallback: number): number =>
  Number.isInteger(value) && typeof value === "number" && value > 0 ? value : fallback;
