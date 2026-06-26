import type { ClientAdapterId } from "@easycode/protocol";
import type { ClientAdapter } from "./types.js";
import { MacWindowAdapter } from "./macos-window-adapter.js";
import { MockAdapter } from "./mock-adapter.js";

export type AdapterName = ClientAdapterId | "mock";

export type CreateAdapterOptions = {
  continueOnly?: boolean;
};

export type MacAdapterConfig = {
  id: ClientAdapterId;
  appName: string;
  processName: string;
  processes?: MacProcessConfig[];
};

export type MacProcessConfig = {
  appName: string;
  processName: string;
};

const terminalProcesses: MacProcessConfig[] = [
  {
    appName: "Terminal",
    processName: "Terminal"
  },
  {
    appName: "iTerm",
    processName: "iTerm2"
  },
  {
    appName: "Warp",
    processName: "Warp"
  },
  {
    appName: "WezTerm",
    processName: "WezTerm"
  },
  {
    appName: "Ghostty",
    processName: "Ghostty"
  }
];

const macAdapterConfigs: Record<ClientAdapterId, MacAdapterConfig> = {
  cursor: {
    id: "cursor",
    appName: "Cursor",
    processName: "Cursor"
  },
  codex: {
    id: "codex",
    appName: "Codex",
    processName: "Codex",
    processes: [
      {
        appName: "Codex",
        processName: "Codex"
      },
      ...terminalProcesses
    ]
  },
  "claude-code": {
    id: "claude-code",
    appName: "Claude Code",
    processName: "Terminal",
    processes: terminalProcesses
  }
};

export const createAdapter = (name: AdapterName, options: CreateAdapterOptions = {}): ClientAdapter => {
  switch (name) {
    case "mock":
      return new MockAdapter();
    case "cursor":
    case "codex":
    case "claude-code":
      return new MacWindowAdapter({
        ...resolveMacAdapterConfig(name),
        continueOnly: options.continueOnly
      });
    default:
      throw new Error(`Unknown adapter: ${name satisfies never}`);
  }
};

export const resolveMacAdapterConfig = (name: AdapterName): MacAdapterConfig => {
  if (name === "mock") throw new Error("The mock adapter has no macOS process to inspect");
  return withProcessOverride(macAdapterConfigs[name]);
};

const withProcessOverride = (config: MacAdapterConfig): MacAdapterConfig => {
  const processName = process.env.EASYCODE_MACOS_PROCESS_NAME?.trim();
  if (!processName) return config;

  const appName = process.env.EASYCODE_MACOS_APP_NAME?.trim() || processName;
  return {
    ...config,
    appName,
    processName,
    processes: [
      {
        appName,
        processName
      }
    ]
  };
};
