import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDevLanCommands,
  formatDevLanCommand,
  parseDevLanArgs
} from "./dev-lan-commands.mjs";

test("dev-lan defaults to codex continue-only with LAN pairing", () => {
  const options = parseDevLanArgs([]);
  const { commands, serverUrl } = buildDevLanCommands(options);

  assert.equal(serverUrl, "http://localhost:8787");
  assert.deepEqual(commands[0], {
    label: "relay",
    command: "pnpm",
    args: ["--filter", "@easycode/relay-server", "dev"],
    env: {
      PORT: "8787"
    }
  });
  assert.deepEqual(commands[1]?.args, [
    "--filter",
    "@easycode/mobile-web",
    "exec",
    "vite",
    "--host",
    "0.0.0.0",
    "--port",
    "5173",
    "--strictPort"
  ]);
  assert.deepEqual(commands[2]?.args, [
    "--filter",
    "@easycode/desktop-agent",
    "dev",
    "--",
    "--adapter",
    "codex",
    "--server",
    "http://localhost:8787",
    "--lan-host",
    "auto",
    "--mobile-port",
    "5173",
    "--continue-only"
  ]);
});

test("dev-lan passes real-client target selection and pairing state", () => {
  const options = parseDevLanArgs([
    "--adapter",
    "claude-code",
    "--target-index",
    "2",
    "--server-port",
    "8899",
    "--mobile-port",
    "5199",
    "--lan-host",
    "192.168.1.80",
    "--pairing-state-file",
    "/tmp/easycode-pairing.json",
    "--e2ee",
    "--reset-pairing"
  ]);
  const { commands } = buildDevLanCommands(options);

  assert.deepEqual(commands[2]?.args, [
    "--filter",
    "@easycode/desktop-agent",
    "dev",
    "--",
    "--adapter",
    "claude-code",
    "--server",
    "http://localhost:8899",
    "--lan-host",
    "192.168.1.80",
    "--mobile-port",
    "5199",
    "--continue-only",
    "--e2ee",
    "--reset-pairing",
    "--target-index",
    "2",
    "--pairing-state-file",
    "/tmp/easycode-pairing.json"
  ]);
});

test("dev-lan dry-run formatting quotes arguments with spaces", () => {
  const options = parseDevLanArgs([
    "--target-title",
    "my project",
    "--dry-run"
  ]);
  const { commands } = buildDevLanCommands(options);

  assert.equal(options.dryRun, true);
  assert.match(formatDevLanCommand(commands[2]), /--target-title 'my project'/);
});
