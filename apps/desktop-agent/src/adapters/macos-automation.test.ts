import assert from "node:assert/strict";
import test from "node:test";
import {
  checkProcessExistsInSystemEventsScript,
  clickButtonByLabelScript,
  pasteAndSubmitTextScript,
  pasteAndSubmitTextToProcessScript
} from "./macos-automation.js";

test("click button automation matches labels exposed through name, value, or description", () => {
  const script = clickButtonByLabelScript();

  assert.match(script, /candidateName is buttonLabel/);
  assert.match(script, /candidateValue is buttonLabel/);
  assert.match(script, /candidateDescription is buttonLabel/);
});

test("paste automation targets the selected process window before writing clipboard text", () => {
  const script = pasteAndSubmitTextScript();

  assert.match(script, /set windowIndex to \(item 2 of argv\) as integer/);
  assert.match(script, /set targetWindow to window windowIndex/);
  assert.match(script, /set the clipboard to item 3 of argv/);
  assert.match(script, /perform action "AXRaise" of window windowIndex/);
  assert.match(script, /on error errorMessage number errorNumber/);
  assert.match(script, /set the clipboard to previousClipboard/);
  assert.match(script, /error errorMessage number errorNumber/);
});

test("process-level paste automation avoids window object access for continue-only mode", () => {
  const script = pasteAndSubmitTextToProcessScript();

  assert.doesNotMatch(script, /windowIndex/);
  assert.doesNotMatch(script, /window windowIndex/);
  assert.match(script, /set appName to item 2 of argv/);
  assert.match(script, /tell application appName to activate/);
  assert.match(script, /set frontmost to true/);
  assert.match(script, /set the clipboard to item 3 of argv/);
  assert.match(script, /on error errorMessage number errorNumber/);
  assert.match(script, /set the clipboard to previousClipboard/);
  assert.match(script, /error errorMessage number errorNumber/);
});

test("system events process check does not send input", () => {
  const script = checkProcessExistsInSystemEventsScript();

  assert.match(script, /exists process processName/);
  assert.doesNotMatch(script, /keystroke/);
  assert.doesNotMatch(script, /key code/);
  assert.doesNotMatch(script, /set the clipboard/);
});
