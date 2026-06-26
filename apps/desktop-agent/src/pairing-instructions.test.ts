import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMobilePairingUrl,
  pickLanIpv4Address,
  resolveLanHost,
  resolveMobilePairingTarget
} from "./pairing-instructions.js";

test("builds a mobile pairing url with relay server and code query params", () => {
  const url = buildMobilePairingUrl({
    mobileUrl: "http://192.168.1.80:5173/",
    relayUrl: "http://192.168.1.80:8787",
    pairingCode: "123456"
  });

  assert.equal(url, "http://192.168.1.80:5173/?server=http%3A%2F%2F192.168.1.80%3A8787&code=123456");
});

test("preserves existing mobile url query params", () => {
  const url = buildMobilePairingUrl({
    mobileUrl: "https://easycode.example/mobile?theme=dark",
    relayUrl: "https://relay.example",
    pairingCode: "654321"
  });

  assert.equal(
    url,
    "https://easycode.example/mobile?theme=dark&server=https%3A%2F%2Frelay.example&code=654321"
  );
});

test("resolves explicit lan host into mobile and relay urls", () => {
  assert.deepEqual(resolveMobilePairingTarget({
    serverUrl: "http://localhost:8787",
    lanHost: "192.168.1.80"
  }), {
    mobileUrl: "http://192.168.1.80:5173",
    relayUrl: "http://192.168.1.80:8787",
    lanHost: "192.168.1.80"
  });
});

test("resolves lan mobile url with custom mobile port", () => {
  assert.deepEqual(resolveMobilePairingTarget({
    serverUrl: "http://localhost:8787",
    lanHost: "192.168.1.80",
    mobilePort: 8181
  }), {
    mobileUrl: "http://192.168.1.80:8181",
    relayUrl: "http://192.168.1.80:8787",
    lanHost: "192.168.1.80"
  });
});

test("keeps explicit mobile urls and hosted relay urls", () => {
  assert.deepEqual(resolveMobilePairingTarget({
    serverUrl: "https://relay.example",
    mobileUrl: "https://mobile.example",
    lanHost: "192.168.1.80"
  }), {
    mobileUrl: "https://mobile.example",
    relayUrl: "https://relay.example",
    lanHost: "192.168.1.80"
  });
});

test("auto lan host prefers private ipv4 addresses", () => {
  const interfaces = {
    utun: [
      {
        address: "100.64.1.10",
        netmask: "255.255.0.0",
        family: "IPv4" as const,
        mac: "00:00:00:00:00:00",
        internal: false,
        cidr: "100.64.1.10/16"
      }
    ],
    en0: [
      {
        address: "192.168.1.80",
        netmask: "255.255.255.0",
        family: "IPv4" as const,
        mac: "00:00:00:00:00:01",
        internal: false,
        cidr: "192.168.1.80/24"
      }
    ]
  };

  assert.equal(pickLanIpv4Address(interfaces), "192.168.1.80");
  assert.equal(resolveLanHost("auto", interfaces), "192.168.1.80");
});

test("normalizes explicit lan host values", () => {
  assert.equal(resolveLanHost("http://192.168.1.80:5173"), "192.168.1.80");
  assert.equal(resolveLanHost("my-mac.local"), "my-mac.local");
});
