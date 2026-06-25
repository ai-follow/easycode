import type { ClientAdapterId } from "@easycode/protocol";
import type { ClientAdapter } from "./types.js";
import { MacWindowAdapter } from "./macos-window-adapter.js";
import { MockAdapter } from "./mock-adapter.js";

export type AdapterName = ClientAdapterId | "mock";

export type MacAdapterConfig = {
  id: ClientAdapterId;
  appName: string;
  processName: string;
};

const macAdapterConfigs: Record<ClientAdapterId, MacAdapterConfig> = {
  cursor: {
    id: "cursor",
    appName: "Cursor",
    processName: "Cursor"
  },
  codex: {
    id: "codex",
    appName: "Codex",
    processName: "Codex"
  },
  "claude-code": {
    id: "claude-code",
    appName: "Claude",
    processName: "Claude"
  }
};

export const createAdapter = (name: AdapterName): ClientAdapter => {
  switch (name) {
    case "mock":
      return new MockAdapter();
    case "cursor":
    case "codex":
    case "claude-code":
      return new MacWindowAdapter(resolveMacAdapterConfig(name));
    default:
      throw new Error(`Unknown adapter: ${name satisfies never}`);
  }
};

export const resolveMacAdapterConfig = (name: AdapterName): MacAdapterConfig => {
  if (name === "mock") throw new Error("The mock adapter has no macOS process to inspect");
  return macAdapterConfigs[name];
};
