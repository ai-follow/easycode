export const parseDevLanArgs = (args) => {
  const get = (name, fallback) => {
    const index = args.indexOf(name);
    const value = args[index + 1];
    return index >= 0 && typeof value === "string" ? value : fallback;
  };
  const getOptional = (name) => {
    const index = args.indexOf(name);
    const value = args[index + 1];
    return index >= 0 && typeof value === "string" ? value : undefined;
  };

  return {
    help: args.includes("--help") || args.includes("-h"),
    dryRun: args.includes("--dry-run"),
    adapter: get("--adapter", "codex"),
    continueOnly: !args.includes("--full-accessibility"),
    e2ee: args.includes("--e2ee"),
    resetPairing: args.includes("--reset-pairing"),
    lanHost: get("--lan-host", "auto"),
    serverPort: parsePort(get("--server-port", "8787"), 8787),
    mobilePort: parsePort(get("--mobile-port", "5173"), 5173),
    target: getOptional("--target"),
    targetIndex: parseOptionalIndex(getOptional("--target-index")),
    targetTitle: getOptional("--target-title"),
    pairingStateFile: getOptional("--pairing-state-file")
  };
};

export const buildDevLanCommands = (options) => {
  const serverUrl = `http://localhost:${options.serverPort}`;
  const desktopArgs = [
    "--adapter",
    options.adapter,
    "--server",
    serverUrl,
    "--lan-host",
    options.lanHost,
    "--mobile-port",
    String(options.mobilePort)
  ];

  if (options.continueOnly) desktopArgs.push("--continue-only");
  if (options.e2ee) desktopArgs.push("--e2ee");
  if (options.resetPairing) desktopArgs.push("--reset-pairing");
  if (options.target) desktopArgs.push("--target", options.target);
  if (typeof options.targetIndex === "number") desktopArgs.push("--target-index", String(options.targetIndex));
  if (options.targetTitle) desktopArgs.push("--target-title", options.targetTitle);
  if (options.pairingStateFile) desktopArgs.push("--pairing-state-file", options.pairingStateFile);

  return {
    serverUrl,
    commands: [
      {
        label: "relay",
        command: "pnpm",
        args: ["--filter", "@easycode/relay-server", "dev"],
        env: {
          PORT: String(options.serverPort)
        }
      },
      {
        label: "mobile",
        command: "pnpm",
        args: [
          "--filter",
          "@easycode/mobile-web",
          "exec",
          "vite",
          "--host",
          "0.0.0.0",
          "--port",
          String(options.mobilePort),
          "--strictPort"
        ]
      },
      {
        label: "desktop",
        command: "pnpm",
        args: ["--filter", "@easycode/desktop-agent", "dev", "--", ...desktopArgs]
      }
    ]
  };
};

export const formatDevLanCommand = (command) => {
  const envPrefix = command.env
    ? `${Object.entries(command.env).map(([name, value]) => `${name}=${value}`).join(" ")} `
    : "";
  return `[${command.label}] ${envPrefix}${command.command} ${command.args.map(quoteArg).join(" ")}`;
};

export const devLanHelp = () => `Usage: pnpm dev:lan -- [options]

Starts the relay server, mobile web client, and desktop agent for same-LAN phone testing.

Options:
  --adapter <name>          codex, cursor, claude-code, or mock (default: codex)
  --full-accessibility      Use the adapter's accessibility read mode instead of continue-only
  --target <id>             Pass through to desktop agent target selection
  --target-index <index>    Pass through to desktop agent target selection
  --target-title <text>     Pass through to desktop agent target selection
  --pairing-state-file <p>  Pass through to desktop agent pairing state
  --lan-host <host|auto>    Host used in printed mobile pairing URL (default: auto)
  --server-port <port>      Relay port (default: 8787)
  --mobile-port <port>      Preferred mobile web port (default: 5173; tries higher ports if busy)
  --e2ee                    Enable encrypted relay payloads
  --reset-pairing           Reset saved desktop pairing before creating a new one
  --dry-run                 Print child commands without starting them
`;

const parsePort = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
};

const parseOptionalIndex = (value) => {
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

const quoteArg = (value) => {
  if (/^[A-Za-z0-9._:/=-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
};
