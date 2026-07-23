import assert from "node:assert/strict";
import test from "node:test";
import {
  accountGoalTurn,
  createGoal,
  editGoal,
  formatElapsed,
  formatTokens,
  decodeGoalJournalEntry,
  decodeGoalState,
  normalizeTokenBudget,
  parseGoalInput,
  setGoalStatus,
  tokenDeltaFromMessage,
  validateObjective,
} from "../src/state.ts";

const STORED_GOAL = {
  version: 1,
  id: "goal-1",
  objective: "keep focus",
  status: "active",
  tokenBudget: 100,
  tokensUsed: 10,
  timeUsedSeconds: 4,
  createdAt: 1,
  updatedAt: 2,
} as const;

test("parseGoalInput accepts plain and budgeted objectives", () => {
  assert.deepEqual(parseGoalInput("  finish the migration  "), { objective: "finish the migration" });
  assert.deepEqual(parseGoalInput("--tokens=50k finish the migration"), {
    objective: "finish the migration",
    tokenBudget: 50_000,
  });
  assert.deepEqual(parseGoalInput("finish --tokens 1.5m migration"), {
    objective: "finish migration",
    tokenBudget: 1_500_000,
  });
});

test("goal input validation rejects empty, oversized, and invalid budgets", () => {
  assert.throws(() => validateObjective("   "), /must not be empty/);
  assert.throws(() => validateObjective("x".repeat(4_001)), /too long/);
  assert.throws(() => parseGoalInput("ship --tokens nope"), /positive safe integer/);
  assert.throws(() => normalizeTokenBudget(1.5), /positive integer/);
});

test("goal state transitions reactivate completed goals but preserve exhausted budgets", () => {
  const created = createGoal("ship it", 100, 10, "goal-1");
  assert.deepEqual(created, {
    version: 1,
    id: "goal-1",
    objective: "ship it",
    status: "active",
    tokenBudget: 100,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 10,
    updatedAt: 10,
  });
  const completed = setGoalStatus(created, "complete", 11);
  assert.equal(editGoal(completed, "ship it with docs", 12).status, "active");
  const exhausted = accountGoalTurn(created, 100, 1, 12);
  assert.equal(editGoal(exhausted, "ship it differently", 13).status, "budgetLimited");
});

test("accountGoalTurn enforces budgets but preserves final complete status", () => {
  const created = createGoal("ship it", 100, 10, "goal-1");
  const limited = accountGoalTurn(created, 100, 7, 20);
  assert.equal(limited.status, "budgetLimited");
  assert.equal(limited.tokensUsed, 100);
  assert.equal(limited.timeUsedSeconds, 7);

  const completed = setGoalStatus(created, "complete", 15);
  const accounted = accountGoalTurn(completed, 25, 3, 20);
  assert.equal(accounted.status, "complete");
  assert.equal(accounted.tokensUsed, 25);
});

test("tokenDeltaFromMessage uses total tokens and supports split usage fields", () => {
  assert.equal(tokenDeltaFromMessage({ usage: { totalTokens: 42 } }), 42);
  assert.equal(tokenDeltaFromMessage({ usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2 } }), 20);
  assert.equal(tokenDeltaFromMessage({}), 0);
});

test("decodeGoalState accepts exact v1 state and fails closed on unsafe fields", () => {
  const decoded = decodeGoalState(STORED_GOAL);
  if (!decoded.ok) assert.fail(decoded.reason);
  assert.deepEqual(decoded.value, STORED_GOAL);

  for (const invalid of [
    null,
    { ...STORED_GOAL, version: 2 },
    { ...STORED_GOAL, version: undefined },
    { ...STORED_GOAL, objective: "x".repeat(4_001) },
    { ...STORED_GOAL, tokenBudget: -1 },
    { ...STORED_GOAL, tokenBudget: Number.MAX_SAFE_INTEGER + 1 },
    { ...STORED_GOAL, tokensUsed: -1 },
    { ...STORED_GOAL, updatedAt: 0 },
  ]) {
    assert.equal(decodeGoalState(invalid).ok, false);
  }
});

test("decodeGoalState restores unsafe statuses without activating work", () => {
  const unknown = decodeGoalState({ ...STORED_GOAL, status: "future-status" });
  if (!unknown.ok) assert.fail(unknown.reason);
  assert.equal(unknown.value.status, "paused");
  assert.match(unknown.warning ?? "", /restored as paused/);

  const exhausted = decodeGoalState({ ...STORED_GOAL, tokensUsed: 100 });
  if (!exhausted.ok) assert.fail(exhausted.reason);
  assert.equal(exhausted.value.status, "budgetLimited");
});

test("decodeGoalJournalEntry enforces journal version and clear tombstones", () => {
  assert.equal(decodeGoalJournalEntry({ version: 2, action: "set", goal: STORED_GOAL }).ok, false);
  assert.equal(decodeGoalJournalEntry({ version: 1, action: "clear", goal: STORED_GOAL }).ok, false);
  assert.deepEqual(decodeGoalJournalEntry({ version: 1, action: "clear", goal: null }), {
    ok: true,
    value: { version: 1, action: "clear", goal: null },
  });
});

test("usage formatting remains compact", () => {
  assert.equal(formatTokens(12_340), "12.3K");
  assert.equal(formatTokens(1_250_000), "1.3M");
  assert.equal(formatElapsed(59), "59s");
  assert.equal(formatElapsed(5_460), "1h 31m");
});
