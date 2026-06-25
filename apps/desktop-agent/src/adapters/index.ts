import type { ClientAdapterId } from "@easycode/protocol";
import type { ClientAdapter } from "./types.js";
import { MacWindowAdapter } from "./macos-window-adapter.js";
import { MockAdapter } from "./mock-adapter.js";

export type AdapterName = ClientAdapterId | "mock";

export const createAdapter = (name: AdapterName): ClientAdapter => {
  switch (name) {
    case "mock":
      return new MockAdapter();
    case "cursor":
      return new MacWindowAdapter({
        id: "cursor",
        appName: "Cursor",
        processName: "Cursor"
      });
    case "codex":
      return new MacWindowAdapter({
        id: "codex",
        appName: "Codex",
        processName: "Codex"
      });
    case "claude-code":
      return new MacWindowAdapter({
        id: "claude-code",
        appName: "Claude",
        processName: "Claude"
      });
    default:
      throw new Error(`Unknown adapter: ${name satisfies never}`);
  }
};
