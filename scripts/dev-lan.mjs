#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  buildDevLanCommands,
  devLanHelp,
  formatDevLanCommand,
  parseDevLanArgs
} from "./dev-lan-commands.mjs";

const options = parseDevLanArgs(process.argv.slice(2));
const root = new URL("..", import.meta.url);

if (options.help) {
  console.log(devLanHelp());
  process.exit(0);
}

const children = [];
let shuttingDown = false;

const shutdown = (signal) => {
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
};

process.on("SIGINT", () => {
  shutdown("SIGINT");
  process.exit(130);
});
process.on("SIGTERM", () => {
  shutdown("SIGTERM");
  process.exit(143);
});

await run();

async function run() {
  const runOptions = options.dryRun ? options : await resolveRuntimeOptions(options);
  const { commands, serverUrl } = buildDevLanCommands(runOptions);

  if (options.dryRun) {
    for (const command of commands) console.log(formatDevLanCommand(command));
    return;
  }

  const relay = spawnManaged(commands[0]);
  children.push(relay);
  const mobile = spawnManaged(commands[1]);
  children.push(mobile);

  try {
    await Promise.all([
      waitForHttp(`${serverUrl}/health`, "relay", relay),
      waitForHttp(`http://localhost:${runOptions.mobilePort}`, "mobile web", mobile)
    ]);
  } catch (error) {
    console.error(`[dev:lan] ${error instanceof Error ? error.message : String(error)}`);
    shutdown("SIGTERM");
    process.exit(1);
  }

  children.push(spawnManaged(commands[2]));
}

async function resolveRuntimeOptions(currentOptions) {
  const mobilePort = await findAvailablePort(currentOptions.mobilePort);
  if (mobilePort !== currentOptions.mobilePort) {
    console.error(
      `[dev:lan] Mobile web port ${currentOptions.mobilePort} is in use; using ${mobilePort} instead.`
    );
  }
  return {
    ...currentOptions,
    mobilePort
  };
}

function spawnManaged({ label, command, args, env }) {
  const child = spawn(command, args, {
    cwd: root,
    env: {
      ...process.env,
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => writePrefixed(label, chunk));
  child.stderr.on("data", (chunk) => writePrefixed(label, chunk));
  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    console.error(`[${label}] exited ${signal ? `signal=${signal}` : `code=${code}`}`);
    shutdown("SIGTERM");
    process.exitCode = code ?? 1;
  });
  return child;
}

async function waitForHttp(url, label, child, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${label} exited before it became ready`);
    }
    try {
      const response = await fetch(url);
      if (response.ok || response.status < 500) return;
    } catch {
      // Retry until timeout; child process output carries startup failures.
    }
    await sleep(150);
  }
  throw new Error(`Timed out waiting for ${label} at ${url}`);
}

async function findAvailablePort(startPort, maxAttempts = 50) {
  const lastPort = Math.min(65535, startPort + maxAttempts - 1);
  for (let port = startPort; port <= lastPort; port += 1) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available mobile web port found from ${startPort} to ${lastPort}`);
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "0.0.0.0", port }, () => {
      server.close(() => resolve(true));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writePrefixed(label, chunk) {
  for (const line of chunk.split(/\r?\n/)) {
    if (line.length > 0) console.log(`[${label}] ${line}`);
  }
}
