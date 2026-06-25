import { createServer, type Server } from "node:http";
import assert from "node:assert/strict";
import test from "node:test";
import { createRequestHandler } from "./http.js";
import { RelayStore } from "./store.js";

test("health and readiness endpoints expose deployment-safe status", async () => {
  const fixture = await startRelayHttp({
    adminToken: "secret",
    heartbeatIntervalMs: 12345,
    serviceVersion: "test-version",
    startedAt: new Date("2026-01-01T00:00:00.000Z")
  });

  try {
    const health = await fetchJson(`${fixture.url}/health`);
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.service, "easycode-relay");
    assert.equal(health.body.version, "test-version");
    assert.equal(health.body.adminTokenConfigured, true);
    assert.equal(health.body.heartbeatIntervalMs, 12345);
    assert.equal(typeof health.body.uptimeSeconds, "number");
    assert.equal(health.body.pairings, 0);
    assert.equal(health.body.connections, 0);

    const ready = await fetchJson(`${fixture.url}/ready`);
    assert.equal(ready.status, 200);
    assert.deepEqual(ready.body, {
      ready: true,
      checks: {
        store: true
      }
    });
  } finally {
    await fixture.close();
  }
});

test("pairing creation requires the configured admin token", async () => {
  const fixture = await startRelayHttp({
    adminToken: "secret"
  });

  try {
    const unauthorized = await fetchJson(`${fixture.url}/v1/pairings`, {
      method: "POST"
    });
    assert.equal(unauthorized.status, 401);

    const authorized = await fetchJson(`${fixture.url}/v1/pairings`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret"
      }
    });
    assert.equal(authorized.status, 201);
    assert.equal(typeof authorized.body.pairingCode, "string");
    assert.equal(typeof authorized.body.desktopToken, "string");
  } finally {
    await fixture.close();
  }
});

test("pairing revocation requires a pair token", async () => {
  const fixture = await startRelayHttp();

  try {
    const pairing = await fetchJson(`${fixture.url}/v1/pairings`, {
      method: "POST"
    });
    const pairId = pairing.body.pairId;
    const desktopToken = pairing.body.desktopToken;
    const pairingCode = pairing.body.pairingCode;
    assert.equal(typeof pairId, "string");
    assert.equal(typeof desktopToken, "string");
    assert.equal(typeof pairingCode, "string");

    const unauthorized = await fetchJson(`${fixture.url}/v1/pairings/${pairId}`, {
      method: "DELETE",
      headers: {
        authorization: "Bearer wrong-token"
      }
    });
    assert.equal(unauthorized.status, 401);

    const revoked = await fetch(`${fixture.url}/v1/pairings/${pairId}`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${desktopToken}`
      }
    });
    assert.equal(revoked.status, 204);

    const claimAfterRevoke = await fetchJson(`${fixture.url}/v1/pairings/${pairingCode}/claim`, {
      method: "POST"
    });
    assert.equal(claimAfterRevoke.status, 404);
  } finally {
    await fixture.close();
  }
});

test("cors defaults to wildcard and can restrict allowed origins", async () => {
  const openFixture = await startRelayHttp();
  try {
    const open = await fetch(`${openFixture.url}/health`, {
      headers: {
        origin: "https://mobile.example"
      }
    });
    assert.equal(open.headers.get("access-control-allow-origin"), "*");
  } finally {
    await openFixture.close();
  }

  const restrictedFixture = await startRelayHttp({
    allowedOrigins: ["https://allowed.example"]
  });
  try {
    const allowed = await fetch(`${restrictedFixture.url}/health`, {
      headers: {
        origin: "https://allowed.example"
      }
    });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://allowed.example");
    assert.equal(allowed.headers.get("vary"), "Origin");

    const deniedPreflight = await fetch(`${restrictedFixture.url}/v1/pairings`, {
      method: "OPTIONS",
      headers: {
        origin: "https://denied.example"
      }
    });
    assert.equal(deniedPreflight.status, 403);
    assert.equal(deniedPreflight.headers.get("access-control-allow-origin"), null);
  } finally {
    await restrictedFixture.close();
  }
});

type HandlerOptions = Parameters<typeof createRequestHandler>[1];

const startRelayHttp = async (options: HandlerOptions = {}): Promise<{ url: string; close: () => Promise<void> }> => {
  const server = createServer(createRequestHandler(new RelayStore(), options));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("Failed to bind relay test server");

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server)
  };
};

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

const fetchJson = async (
  url: string,
  init?: RequestInit
): Promise<{ status: number; body: Record<string, unknown> }> => {
  const response = await fetch(url, init);
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>
  };
};
