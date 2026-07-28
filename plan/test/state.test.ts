import assert from "node:assert/strict";
import test from "node:test";
import {
  createPlanningState,
  decodePlanJournalEntry,
  decodePlanState,
  planHandoffPhaseName,
  refinePlan,
  reportPlanBlocked,
  resumeBlockedPlan,
  submitPlan,
} from "../src/state.ts";

function legacyState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    phase: "awaitingApproval",
    summary: "Ship safely",
    plan: "Inspect and implement.",
    steps: [
      { id: "step-1", text: "Inspect", status: "pending" },
      { id: "step-2", text: "Implement", status: "pending" },
    ],
    enteredWithTools: ["read", "bash"],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

test("Plan lifecycle stores approval steps as Todo-ready text", () => {
  const planning = createPlanningState(["read", "bash", "read", "submit_plan"], 10);
  assert.equal(planning.version, 4);
  assert.equal(planning.phase, "planning");
  assert.deepEqual(planning.enteredWithTools, ["read", "bash"]);

  const awaiting = submitPlan(
    planning,
    { summary: "Ship safely", plan: "1. Inspect\n2. Implement", steps: ["Inspect", "Implement"] },
    20,
  );
  assert.equal(awaiting.phase, "awaitingApproval");
  assert.deepEqual(awaiting.steps, ["Inspect", "Implement"]);
  assert.deepEqual(awaiting.enteredWithTools, ["read", "bash"]);
});

test("blocked Plan results preserve evidence and resume only into read-only planning", () => {
  const blocked = reportPlanBlocked(createPlanningState(["read", "bash"], 10), {
    summary: "The required signing credential is unavailable.",
    blockingFacts: ["The configured credential store contains no signing key."],
    evidenceSources: ["config/signing.ts", "credential-store read result"],
    resolutions: [
      { kind: "prerequisite", label: "Provide signing credential", description: "Add a valid signing key to the configured credential store." },
      { kind: "alternative", label: "Defer signed release", description: "Plan an unsigned internal build instead." },
    ],
  }, 20);
  assert.equal(blocked.phase, "blocked");
  assert.equal(blocked.plan, undefined);
  assert.equal(blocked.steps.length, 0);
  assert.equal(blocked.blocker?.resolutions[0]?.kind, "prerequisite");
  assert.equal(decodePlanState(blocked).ok, true);
  assert.equal(decodePlanState({ ...blocked, blocker: { ...blocked.blocker!, blockingFacts: [] } }).ok, false);

  const resumed = resumeBlockedPlan(blocked, 30);
  assert.equal(resumed.phase, "planning");
  assert.equal(resumed.blocker?.summary, blocked.blocker?.summary);
  const submitted = submitPlan(resumed, { summary: "Sign release", plan: "Use the supplied credential.", steps: ["Sign release"] }, 40);
  assert.equal(submitted.blocker, undefined);
  assert.throws(() => reportPlanBlocked(submitted, blocked.blocker!), /only be blocked during planning/);
});

test("refine returns an awaiting plan to read-only planning", () => {
  const awaiting = submitPlan(
    createPlanningState(["read"], 10),
    { summary: "Do it", plan: "Execute", steps: ["One"] },
    20,
  );
  const refined = refinePlan(awaiting, 30);
  assert.equal(refined.phase, "planning");
  assert.equal(refined.planPath, undefined);
  assert.throws(() => refinePlan(createPlanningState([], 10)), /submitted plan/);
});

test("submission validation matches ordinary Todo task constraints", () => {
  const planning = createPlanningState([], 10);
  assert.throws(() => submitPlan(planning, { summary: "x", plan: "x", steps: [] }), /at least one/);
  assert.throws(
    () => submitPlan(planning, { summary: "x", plan: "x", steps: Array.from({ length: 51 }, (_, index) => `step ${index}`) }),
    /at most 50/,
  );
  assert.throws(
    () => submitPlan(planning, { summary: "x", plan: "x", steps: ["duplicate", "duplicate"] }),
    /must be unique/,
  );
  assert.throws(
    () => submitPlan(planning, { summary: "x", plan: "x", steps: ["x".repeat(241)] }),
    /240 character limit/,
  );
});

test("submission enforces the aggregate UTF-8 payload limit", () => {
  assert.throws(
    () => submitPlan(createPlanningState([], 10), { summary: "x", plan: "🙂".repeat(11_000), steps: ["ship"] }),
    /byte limit/,
  );
});

test("planHandoffPhaseName derives a Todo-safe phase summary", () => {
  assert.equal(planHandoffPhaseName("Ship safely"), "Ship safely");
  assert.equal(planHandoffPhaseName("Fix\u0000 the \u202E bug\n now"), "Fix the bug now");
  assert.equal(planHandoffPhaseName(undefined), "Plan");
  assert.equal(planHandoffPhaseName(""), "Plan");
  assert.equal(planHandoffPhaseName(" \u2028\t "), "Plan");

  const exact = "a".repeat(80);
  assert.equal(planHandoffPhaseName(exact), exact);

  const truncated = planHandoffPhaseName("b".repeat(81));
  assert.equal(truncated, `${"b".repeat(79)}…`);
  assert.equal(truncated.length, 80);

  const surrogateSafe = planHandoffPhaseName(`${"c".repeat(78)}🙂🙂`);
  assert.equal(surrogateSafe, `${"c".repeat(78)}…`);

  const trailingSpace = planHandoffPhaseName(`${"d".repeat(78)} tail`);
  assert.equal(trailingSpace, `${"d".repeat(78)}…`);
});

test("decodePlanState accepts exact v4 and migrates non-executing legacy state", () => {
  const current = submitPlan(
    createPlanningState(["read"], 1),
    { summary: "Strict", plan: "Execute", steps: ["Inspect", "Verify"] },
    2,
  );
  assert.equal(decodePlanState(current).ok, true);
  assert.equal(decodePlanState({ ...current, forged: true }).ok, false);
  assert.equal(decodePlanState({ ...current, steps: ["Inspect", "Inspect"] }).ok, false);
  assert.equal(decodePlanState({ ...current, version: 3 }).ok, false);

  const migrated = decodePlanState(legacyState());
  if (!migrated.ok) assert.fail(migrated.reason);
  assert.equal(migrated.value.version, 4);
  assert.deepEqual(migrated.value.steps, ["Inspect", "Implement"]);
  assert.equal(decodePlanState(legacyState({ phase: "executing" })).ok, false);
  assert.equal(decodePlanState(legacyState({ enteredWithTools: ["read", "read"] })).ok, false);
  assert.equal(decodePlanState(legacyState({ updatedAt: 0 })).ok, false);
});

test("decodePlanJournalEntry treats legacy execution as completed Plan ownership", () => {
  const executing = legacyState({ phase: "executing" });
  assert.deepEqual(decodePlanJournalEntry({ version: 1, action: "approve", state: executing }), {
    ok: true,
    value: { version: 4, action: "approve", state: null },
  });
  assert.deepEqual(decodePlanJournalEntry({ version: 1, action: "complete", state: null }), {
    ok: true,
    value: { version: 4, action: "approve", state: null },
  });
  assert.equal(decodePlanJournalEntry({ version: 1, action: "submit", state: executing }).ok, false);
  assert.equal(decodePlanJournalEntry({ version: 4, action: "approve", state: executing }).ok, false);
  assert.equal(decodePlanJournalEntry({ version: 4, action: "approve", state: null, forged: true }).ok, false);
});

test("current journal enforces terminal tombstones and action phases", () => {
  const awaiting = submitPlan(
    createPlanningState(["read"], 1),
    { summary: "Journal", plan: "Execute", steps: ["Verify"] },
    2,
  );
  assert.equal(decodePlanJournalEntry({ version: 4, action: "submit", state: awaiting }).ok, true);
  assert.equal(decodePlanJournalEntry({ version: 4, action: "start", state: awaiting }).ok, false);
  assert.deepEqual(decodePlanJournalEntry({ version: 4, action: "cancel", state: null }), {
    ok: true,
    value: { version: 4, action: "cancel", state: null },
  });
});

test("planPath restores cross-platform previews and clears only during refinement", () => {
  const awaiting = {
    ...submitPlan(createPlanningState(["read"], 1), { summary: "Path", plan: "## Path", steps: ["Verify"] }, 2),
    planPath: "/tmp/plan-preview.md",
  };
  assert.equal(decodePlanState(awaiting).ok, true);
  assert.equal(decodePlanState({ ...awaiting, planPath: "C:\\Plans\\preview.md" }).ok, true);
  assert.equal(refinePlan(awaiting, 3).planPath, undefined);

  for (const planPath of ["relative.md", "C:relative.md", "/tmp/preview.txt", "/tmp/preview\0.md", "x".repeat(4_097)]) {
    assert.equal(decodePlanState({ ...awaiting, planPath }).ok, false, planPath);
  }
});
