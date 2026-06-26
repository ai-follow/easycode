export type MobileLaunchParams = {
  serverUrl: string;
  pairingCode: string;
};

export const parseMobileLaunchParams = (search: string, defaultServerUrl: string): MobileLaunchParams => {
  const params = new URLSearchParams(search);
  const rawServer = params.get("server")?.trim();
  const rawCode = params.get("code")?.trim() ?? "";

  return {
    serverUrl: isHttpUrl(rawServer) ? rawServer : defaultServerUrl,
    pairingCode: /^\d{6}$/.test(rawCode) ? rawCode : ""
  };
};

const isHttpUrl = (value: string | undefined): value is string => {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
};
