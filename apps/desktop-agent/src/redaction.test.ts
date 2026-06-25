import assert from "node:assert/strict";
import test from "node:test";
import { redactSensitiveText } from "./redaction.js";

test("redacts common secret token shapes", () => {
  const input = [
    "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz1234567890",
    "ANTHROPIC_API_KEY='sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234567890'",
    "GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456",
    "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
    "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "CUSTOM_API_KEY=plain-local-secret",
    "clientSecret: local-client-secret",
    "password: hunter2"
  ].join("\n");

  const output = redactSensitiveText(input);

  assert.doesNotMatch(output, /sk-proj/);
  assert.doesNotMatch(output, /sk-ant/);
  assert.doesNotMatch(output, /ghp_/);
  assert.doesNotMatch(output, /AKIAIOSFODNN7EXAMPLE/);
  assert.doesNotMatch(output, /plain-local-secret/);
  assert.doesNotMatch(output, /local-client-secret/);
  assert.doesNotMatch(output, /hunter2/);
  assert.match(output, /OPENAI_API_KEY=\[redacted\]/);
  assert.match(output, /CUSTOM_API_KEY=\[redacted\]/);
  assert.match(output, /clientSecret: \[redacted\]/);
  assert.match(output, /Authorization: Bearer \[redacted\]/);
});

test("redacts local identity paths and email addresses", () => {
  const input = [
    "/Users/alice/projects/easycode",
    "/home/bob/work/easycode",
    "C:\\Users\\Carol\\work\\easycode",
    "alice@example.com"
  ].join("\n");

  const output = redactSensitiveText(input);

  assert.ok(output.includes("/Users/[redacted]/projects/easycode"));
  assert.ok(output.includes("/home/[redacted]/work/easycode"));
  assert.ok(output.includes("C:\\Users\\[redacted]\\work\\easycode"));
  assert.ok(output.includes("[redacted-email]"));
  assert.doesNotMatch(output, /alice|bob|Carol|example\.com/);
});

test("preserves ordinary accessibility text", () => {
  const input = [
    "AXStaticText\tstatic text\tUser: build a relay\t\t\ttrue",
    "AXStaticText\tstatic text\tAssistant: done\t\t\ttrue",
    "AXButton\tbutton\tApprove\t\t\ttrue"
  ].join("\n");

  assert.equal(redactSensitiveText(input), input);
});
