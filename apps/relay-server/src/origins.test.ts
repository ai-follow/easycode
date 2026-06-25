import assert from "node:assert/strict";
import test from "node:test";
import { isOriginAllowed, normalizeAllowedOrigins, parseAllowedOrigins } from "./origins.js";

test("parses and normalizes allowed origins", () => {
  assert.deepEqual(parseAllowedOrigins(" https://a.example,https://b.example ,, "), [
    "https://a.example",
    "https://b.example"
  ]);
  assert.deepEqual(normalizeAllowedOrigins(undefined), []);
});

test("allows wildcard or unset origins", () => {
  assert.equal(isOriginAllowed("https://mobile.example", undefined), true);
  assert.equal(isOriginAllowed("https://mobile.example", ["*"]), true);
});

test("restricts configured origins", () => {
  assert.equal(isOriginAllowed("https://allowed.example", ["https://allowed.example"]), true);
  assert.equal(isOriginAllowed("https://denied.example", ["https://allowed.example"]), false);
  assert.equal(isOriginAllowed(undefined, ["https://allowed.example"]), false);
});
