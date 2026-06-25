import assert from "node:assert/strict";
import test from "node:test";
import type { ClientTarget } from "@easycode/protocol";
import { formatTargets, selectTarget } from "./target-selection.js";

const targets: ClientTarget[] = [
  {
    id: "cursor:window:0",
    adapterId: "cursor",
    title: "Cursor - easycode",
    appName: "Cursor",
    platform: "macos"
  },
  {
    id: "cursor:window:1",
    adapterId: "cursor",
    title: "Cursor - another-project",
    appName: "Cursor",
    platform: "macos"
  }
];

test("selects the first target by default", () => {
  assert.equal(selectTarget(targets, {}).id, "cursor:window:0");
});

test("selects by id, index, or title substring", () => {
  assert.equal(selectTarget(targets, { targetId: "cursor:window:1" }).id, "cursor:window:1");
  assert.equal(selectTarget(targets, { targetIndex: 1 }).id, "cursor:window:1");
  assert.equal(selectTarget(targets, { targetTitle: "another" }).id, "cursor:window:1");
});

test("throws when requested target does not exist", () => {
  assert.throws(() => selectTarget(targets, { targetId: "missing" }), /No target matched id/);
  assert.throws(() => selectTarget(targets, { targetIndex: 5 }), /No target at zero-based index/);
  assert.throws(() => selectTarget(targets, { targetTitle: "missing" }), /No target title contained/);
});

test("formats discovered targets for CLI output", () => {
  assert.match(formatTargets(targets), /0: Cursor - easycode \[cursor:window:0\]/);
  assert.match(formatTargets(targets), /1: Cursor - another-project \[cursor:window:1\]/);
});
