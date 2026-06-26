import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMobileLaunchParams } from "./mobileLaunchParams.js";

test("parses launch params for mobile pairing prefill", () => {
  const params = parseMobileLaunchParams(
    "?server=http%3A%2F%2F192.168.1.80%3A8787&code=123456",
    "http://localhost:8787"
  );

  assert.deepEqual(params, {
    serverUrl: "http://192.168.1.80:8787",
    pairingCode: "123456"
  });
});

test("ignores invalid launch params", () => {
  const params = parseMobileLaunchParams(
    "?server=javascript%3Aalert%281%29&code=abc123",
    "http://localhost:8787"
  );

  assert.deepEqual(params, {
    serverUrl: "http://localhost:8787",
    pairingCode: ""
  });
});
