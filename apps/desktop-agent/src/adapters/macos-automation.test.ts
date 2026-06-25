import assert from "node:assert/strict";
import test from "node:test";
import { clickButtonByLabelScript } from "./macos-automation.js";

test("click button automation matches labels exposed through name, value, or description", () => {
  const script = clickButtonByLabelScript();

  assert.match(script, /candidateName is buttonLabel/);
  assert.match(script, /candidateValue is buttonLabel/);
  assert.match(script, /candidateDescription is buttonLabel/);
});
