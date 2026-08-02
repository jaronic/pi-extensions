import assert from "node:assert/strict";
import test from "node:test";
import { createLoop } from "../src/state.ts";
import { loopContextBlock, loopRoundPrompt } from "../src/prompts.ts";

test("loopContextBlock embeds the objective with XML escaping and iteration numbers", () => {
  const loop = createLoop("use a <b> & keep it", 5, 10, "loop-1");
  const block = loopContextBlock(loop, 2);
  assert.match(block, /Loop iteration 2 of 5:/);
  assert.match(block, /<untrusted_objective>/);
  assert.match(block, /use a &lt;b&gt; &amp; keep it/);
  assert.doesNotMatch(block, /<b>/);
  assert.match(block, /no way to declare the task finished early/);
});

test("loopRoundPrompt carries the round and objective with escaping", () => {
  const loop = createLoop("fix <crash>", 3, 10, "loop-1");
  const prompt = loopRoundPrompt(loop, 3);
  assert.match(prompt, /iteration 3 of 3/);
  assert.match(prompt, /fix &lt;crash&gt;/);
  assert.match(prompt, /iteration control is owned by the runtime/);
});

test("long objectives are clamped in both prompts", () => {
  const loop = createLoop("x".repeat(2_000), 3, 10, "loop-1");
  assert.equal(loopContextBlock(loop, 1).includes("x".repeat(1_000)), false);
  assert.equal(loopRoundPrompt(loop, 1).includes("x".repeat(1_000)), false);
});
