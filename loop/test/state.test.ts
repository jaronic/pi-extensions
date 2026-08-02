import assert from "node:assert/strict";
import test from "node:test";
import {
  createLoop,
  decodeLoopJournalEntry,
  decodeLoopState,
  failAttempt,
  isUsageLimitError,
  parseLoopInput,
  resumeLoop,
  setLoopStatus,
  settleRound,
  validateObjective,
} from "../src/state.ts";

test("parseLoopInput accepts a leading iteration count and objective", () => {
  assert.deepEqual(parseLoopInput("5 finish the migration"), {
    objective: "finish the migration",
    iterations: 5,
  });
  assert.throws(() => parseLoopInput("50"), /must not be empty/, "a bare count without an objective is rejected");
});

test("parseLoopInput rejects malformed and out-of-range iteration counts", () => {
  assert.throws(() => parseLoopInput("objective without count"), /Usage: \/loop/);
  assert.throws(() => parseLoopInput("0 fix it"), /from 1 to 50/);
  assert.throws(() => parseLoopInput("51 fix it"), /from 1 to 50/);
  assert.throws(() => parseLoopInput("abc fix it"), /Usage: \/loop/);
  assert.throws(() => parseLoopInput("-3 fix it"), /Usage: \/loop/);
  assert.throws(() => parseLoopInput("1"), /must not be empty/);
});

test("loop objective validation rejects empty and oversized input", () => {
  assert.throws(() => validateObjective("   "), /must not be empty/);
  assert.throws(() => validateObjective("x".repeat(4_001)), /too long/);
});

test("createLoop builds a running v1 state with one generation", () => {
  const created = createLoop("ship it", 3, 10, "loop-1");
  assert.deepEqual(created, {
    version: 1,
    id: "loop-1",
    generation: 1,
    status: "running",
    spec: { objective: "ship it", iterations: 3 },
    completedIterations: 0,
    roundLog: [],
    createdAt: 10,
  });
});

test("settleRound counts normal and length rounds and finishes exactly at the limit", () => {
  const created = createLoop("ship it", 2, 10, "loop-1");
  const first = settleRound(created, { status: "ok", turns: 4, summary: "wrote tests" }, 20);
  assert.equal(first.status, "running");
  assert.equal(first.completedIterations, 1);
  assert.deepEqual(first.roundLog, [{ round: 1, status: "ok", turns: 4, summary: "wrote tests", at: 20 }]);

  const second = settleRound(first, { status: "length", turns: 2, summary: "truncated" }, 30);
  assert.equal(second.status, "finished");
  assert.equal(second.completedIterations, 2);
  assert.equal(second.finishedAt, 30);
  assert.equal(second.roundLog[1]?.status, "length");
});

test("settleRound is a no-op on finished, paused, and already-exhausted loops", () => {
  const finished = settleRound(createLoop("ship", 1, 10, "loop-1"), { status: "ok", turns: 1, summary: "s" }, 20);
  assert.equal(finished.status, "finished");
  assert.deepEqual(settleRound(finished, { status: "ok", turns: 1, summary: "again" }, 30), finished);
  const paused = setLoopStatus(createLoop("ship", 3, 10, "loop-1"), "paused", "user", 15);
  assert.deepEqual(settleRound(paused, { status: "ok", turns: 1, summary: "x" }, 20), paused);
});

test("roundLog is bounded to the latest MAX_ROUND_LOG entries", () => {
  let state = createLoop("ship", 50, 10, "loop-1");
  for (let round = 1; round <= 10; round++) {
    state = settleRound(state, { status: "ok", turns: 1, summary: `round ${round}` }, 10 + round);
  }
  assert.equal(state.roundLog.length, 8);
  assert.equal(state.roundLog[0]?.round, 3);
  assert.equal(state.roundLog.at(-1)?.round, 10);
});

test("failAttempt pauses without counting the round and records the last attempt", () => {
  const created = createLoop("ship", 3, 10, "loop-1");
  const failed = failAttempt(created, { status: "error", reason: "provider overloaded; rate limit hit" }, 20);
  assert.equal(failed.status, "paused");
  assert.equal(failed.pauseReason, "usage-limit");
  assert.equal(failed.completedIterations, 0);
  assert.deepEqual(failed.lastAttempt, {
    round: 1,
    status: "error",
    reason: "provider overloaded; rate limit hit",
    at: 20,
  });
  assert.equal(failAttempt(failed, { status: "error", reason: "boom" }, 30), failed, "failAttempt is a no-op on a paused loop");
});

test("failAttempt classifies plain errors and aborts", () => {
  const created = createLoop("ship", 3, 10, "loop-1");
  assert.equal(failAttempt(created, { status: "error", reason: "tool crashed" }, 20).pauseReason, "error");
  assert.equal(failAttempt(created, { status: "aborted", reason: "aborted" }, 20).pauseReason, "abort");
  assert.equal(isUsageLimitError("quota exceeded"), true);
  assert.equal(isUsageLimitError("context length limit"), true);
  assert.equal(isUsageLimitError("tool crashed"), false);
});

test("a failed final round never finishes and resume keeps the round target", () => {
  const created = createLoop("ship", 1, 10, "loop-1");
  const failed = failAttempt(created, { status: "error", reason: "boom" }, 20);
  assert.equal(failed.status, "paused");
  const resumed = resumeLoop(failed, 30);
  assert.equal(resumed.status, "running");
  assert.equal(resumed.generation, 2);
  assert.equal(resumed.completedIterations + 1, 1, "resume retries the same round");
});

test("resumeLoop only resumes paused loops and bumps the generation", () => {
  const running = createLoop("ship", 3, 10, "loop-1");
  assert.deepEqual(resumeLoop(running, 20), running);
  const stopped = setLoopStatus(running, "stopped", "user", 15);
  assert.deepEqual(resumeLoop(stopped, 20), stopped);
  const paused = setLoopStatus(running, "paused", "user", 15);
  assert.equal(resumeLoop(paused, 20).generation, 2);
});

test("decodeLoopState accepts exact v1 state", () => {
  const stored = {
    version: 1,
    id: "loop-1",
    generation: 2,
    status: "paused",
    spec: { objective: "ship it", iterations: 3 },
    completedIterations: 1,
    roundLog: [{ round: 1, status: "ok", turns: 4, summary: "wrote tests", at: 20 }],
    lastAttempt: { round: 2, status: "error", reason: "boom", at: 30 },
    pauseReason: "error",
    createdAt: 10,
  };
  const decoded = decodeLoopState(stored);
  if (!decoded.ok) assert.fail(decoded.reason);
  assert.deepEqual(decoded.value, stored);
});

test("decodeLoopState fails closed on broken invariants", () => {
  const base = () => ({
    version: 1,
    id: "loop-1",
    generation: 1,
    status: "running",
    spec: { objective: "ship it", iterations: 3 },
    completedIterations: 0,
    roundLog: [],
    createdAt: 10,
  });
  assert.equal(decodeLoopState({ ...base(), version: 2 }).ok, false, "unsupported version");
  assert.equal(decodeLoopState({ ...base(), completedIterations: 4 }).ok, false, "completed exceeds limit");
  assert.equal(decodeLoopState({ ...base(), roundLog: [{ round: 1, status: "ok", turns: 1, summary: "s", at: 20 }] }).ok, false, "roundLog length mismatch");
  assert.equal(
    decodeLoopState({ ...base(), roundLog: [{ round: 2, status: "ok", turns: 1, summary: "s", at: 20 }], completedIterations: 1 }).ok,
    false,
    "round numbers must be contiguous from 1",
  );
  assert.equal(decodeLoopState({ ...base(), spec: { objective: "ship", iterations: 51 } }).ok, false, "iterations capped at 50");
  assert.equal(decodeLoopState({ ...base(), status: "paused" }).ok, false, "paused needs pauseReason");
  assert.equal(decodeLoopState({ ...base(), status: "finished" }).ok, false, "finished needs full iterations and finishedAt");
  assert.equal(
    decodeLoopState({ ...base(), status: "paused", pauseReason: "user", lastAttempt: { round: 2, status: "error", reason: "boom", at: 30 } }).ok,
    false,
    "lastAttempt round must be the next pending round",
  );
  assert.equal(
    decodeLoopState({ ...base(), status: "paused", pauseReason: "user", lastAttempt: { round: 1, status: "error", reason: "boom", at: 30 } }).ok,
    true,
    "lastAttempt on the pending round is valid",
  );
});

test("decodeLoopState normalizes an exhausted running loop to finished", () => {
  const decoded = decodeLoopState({
    version: 1,
    id: "loop-1",
    generation: 1,
    status: "running",
    spec: { objective: "ship it", iterations: 1 },
    completedIterations: 1,
    roundLog: [{ round: 1, status: "ok", turns: 1, summary: "s", at: 20 }],
    createdAt: 10,
  });
  if (!decoded.ok) assert.fail(decoded.reason);
  assert.equal(decoded.value.status, "finished");
  assert.ok(decoded.warning);
});

test("decodeLoopJournalEntry enforces the clear tombstone", () => {
  const clear = decodeLoopJournalEntry({ version: 1, action: "clear", loop: null });
  assert.deepEqual(clear, { ok: true, value: { version: 1, action: "clear", loop: null } });
  assert.equal(decodeLoopJournalEntry({ version: 1, action: "clear", loop: { id: "x" } }).ok, false);
  assert.equal(decodeLoopJournalEntry({ version: 1, action: "bogus", loop: null }).ok, false);
  const create = decodeLoopJournalEntry({
    version: 1,
    action: "create",
    loop: {
      version: 1,
      id: "loop-1",
      generation: 1,
      status: "running",
      spec: { objective: "ship it", iterations: 3 },
      completedIterations: 0,
      roundLog: [],
      createdAt: 10,
    },
  });
  assert.equal(create.ok, true);
});
