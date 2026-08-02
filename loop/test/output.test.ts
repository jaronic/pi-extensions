import assert from "node:assert/strict";
import test from "node:test";
import { createLoop, failAttempt, setLoopStatus, settleRound } from "../src/state.ts";
import { loopStatusLabel, renderLoopStatus, renderLoopWidget } from "../src/output.ts";

function sampleLoop() {
  const created = createLoop("Refactor the auth module to use token refresh", 10, 1_700_000_000_000, "loop-1");
  return settleRound(created, { status: "ok", turns: 4, summary: "Extracted refresh logic and updated tests" }, 1_700_000_100_000);
}

test("loopStatusLabel renders statuses with optional pause reasons", () => {
  assert.equal(loopStatusLabel("running"), "running");
  assert.equal(loopStatusLabel("finished"), "finished");
  assert.equal(loopStatusLabel("paused", "user"), "paused (paused by user)");
  assert.equal(loopStatusLabel("stopped", "user"), "stopped (paused by user)");
  assert.equal(loopStatusLabel("paused", "usage-limit"), "paused (usage limit)");
  assert.equal(loopStatusLabel("paused", "send-failed"), "paused (continuation send failed)");
});

test("renderLoopWidget returns an empty array without a loop", () => {
  assert.deepEqual(renderLoopWidget(null), []);
});

test("renderLoopWidget headings track status and round counts", () => {
  assert.equal(renderLoopWidget(createLoop("ship", 5, 10, "loop-1"))[0], "Loop 0/5");
  let state = createLoop("ship", 5, 10, "loop-1");
  for (let round = 1; round <= 5; round++) {
    state = settleRound(state, { status: "ok", turns: 1, summary: "s" }, 10 + round);
  }
  assert.equal(renderLoopWidget(state)[0], "Loop finished 5/5");
  const progressed = settleRound(createLoop("ship", 5, 10, "loop-1"), { status: "ok", turns: 2, summary: "s" }, 20);
  const paused = setLoopStatus(progressed, "paused", "user", 40);
  assert.equal(renderLoopWidget(paused)[0], "Loop paused 1/5");
  const stopped = setLoopStatus(progressed, "stopped", "user", 40);
  assert.equal(renderLoopWidget(stopped)[0], "Loop stopped 1/5");
});

test("renderLoopWidget lists round summaries with glyphs, truncation, and collapse hint", () => {
  const loop = sampleLoop();
  const lines = renderLoopWidget(loop);
  assert.equal(lines[1], "Objective: Refactor the auth module to use token refresh");
  assert.match(lines[2] ?? "", /^✓ 1\. Extracted refresh logic and updated tests$/);

  const longSummary = "x".repeat(200);
  const withLong = settleRound(sampleLoop(), { status: "length", turns: 1, summary: longSummary }, 2_000_000_000_000);
  const last = renderLoopWidget(withLong).at(-1);
  assert.ok(last?.startsWith("○ 2. "));
  assert.ok((last?.length ?? 0) <= 72 + 10, "round rows are bounded");

  const many = createLoop("ship", 50, 10, "loop-1");
  let state = many;
  for (let round = 1; round <= 7; round++) {
    state = settleRound(state, { status: "ok", turns: 1, summary: `round ${round}` }, 10 + round);
  }
  const collapsed = renderLoopWidget(state);
  assert.equal(collapsed.filter((line) => /^[✓○] /.test(line)).length, 5, "widget shows at most 5 rounds");
  assert.equal(collapsed.at(-1), "… 2 more round(s)");
});

test("renderLoopWidget shows pause reason and last failed round when paused", () => {
  const paused = setLoopStatus(sampleLoop(), "paused", "usage-limit", 2_000_000_000_000);
  const lines = renderLoopWidget(paused);
  assert.ok(lines.includes("! usage limit"));
});

test("renderLoopStatus renders full status text with round details", () => {
  assert.equal(renderLoopStatus(null), "Loop: off");
  const loop = sampleLoop();
  const text = renderLoopStatus(loop);
  assert.match(text, /Loop: running \(1\/10\)/);
  assert.match(text, /Objective: Refactor the auth module/);
  assert.match(text, /1\. \[ok\] Extracted refresh logic and updated tests · 4 turns · /);
});

test("renderLoopStatus includes pause reason and last failed round", () => {
  const progressed = settleRound(createLoop("Refactor the auth module", 10, 10, "loop-1"), { status: "ok", turns: 4, summary: "Extracted refresh logic" }, 20);
  const paused = failAttempt(progressed, { status: "error", reason: "rate limit hit" }, 30);
  const text = renderLoopStatus(paused);
  assert.match(text, /Loop: paused \(usage limit\) \(1\/10\)/);
  assert.match(text, /Last failed round: 2/);
});
