import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

export type MobilePairingUrlOptions = {
  mobileUrl: string;
  relayUrl: string;
  pairingCode: string;
};

export type MobilePairingTargetOptions = {
  serverUrl: string;
  mobileUrl?: string;
  mobileServerUrl?: string;
  lanHost?: string;
  mobilePort?: number;
};

export type MobilePairingTarget = {
  mobileUrl?: string;
  relayUrl: string;
  lanHost?: string;
};

export const buildMobilePairingUrl = ({
  mobileUrl,
  relayUrl,
  pairingCode
}: MobilePairingUrlOptions): string => {
  const url = new URL(mobileUrl);
  url.searchParams.set("server", relayUrl);
  url.searchParams.set("code", pairingCode);
  return url.toString();
};

export const resolveMobilePairingTarget = ({
  serverUrl,
  mobileUrl,
  mobileServerUrl,
  lanHost,
  mobilePort = 5173
}: MobilePairingTargetOptions): MobilePairingTarget => {
  const resolvedLanHost = resolveLanHost(lanHost);
  const inferredMobileUrl = resolvedLanHost ? buildLanMobileUrl(resolvedLanHost, mobilePort) : undefined;
  return {
    mobileUrl: mobileUrl ?? inferredMobileUrl,
    relayUrl: mobileServerUrl ?? lanReachableServerUrl(serverUrl, resolvedLanHost),
    lanHost: resolvedLanHost
  };
};

export const resolveLanHost = (
  lanHost: string | undefined,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()
): string | undefined => {
  const trimmed = lanHost?.trim();
  if (!trimmed) return undefined;
  if (trimmed.toLowerCase() !== "auto") return normalizeHost(trimmed);
  return pickLanIpv4Address(interfaces);
};

export const pickLanIpv4Address = (
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>
): string | undefined => {
  const candidates = Object.values(interfaces)
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254."))
    .map((entry) => entry.address);

  return candidates.find(isPrivateIpv4Address) ?? candidates[0];
};

const buildLanMobileUrl = (lanHost: string, mobilePort: number): string =>
  `http://${formatHostForUrl(lanHost)}:${mobilePort}`;

const lanReachableServerUrl = (serverUrl: string, lanHost: string | undefined): string => {
  if (!lanHost) return serverUrl;

  const url = new URL(serverUrl);
  if (!isLocalHostname(url.hostname)) return serializeUrl(url);

  url.hostname = lanHost;
  return serializeUrl(url);
};

const normalizeHost = (value: string): string => {
  const parsed = new URL(value.includes("://") ? value : `http://${value}`);
  return parsed.hostname;
};

const formatHostForUrl = (host: string): string => host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

const serializeUrl = (url: URL): string => {
  const serialized = url.toString();
  return url.pathname === "/" && !url.search && !url.hash ? serialized.replace(/\/$/, "") : serialized;
};

const isLocalHostname = (hostname: string): boolean =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "0.0.0.0" ||
  hostname === "::1" ||
  hostname === "[::1]";

const isPrivateIpv4Address = (address: string): boolean => {
  const [first, second] = address.split(".").map((part) => Number(part));
  if (typeof first !== "number" || typeof second !== "number") return false;
  if (!Number.isInteger(first) || !Number.isInteger(second)) return false;
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
};
