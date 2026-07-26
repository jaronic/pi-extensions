import assert from "node:assert/strict";
import test from "node:test";
import {
  approvePlanWithExternalProgress,
  createPlanningState,
  decodePlanJournalEntry,
  decodePlanState,
  refinePlan,
  reportPlanBlocked,
  resumeBlockedPlan,
  submitPlan,
  updatePlanStep,
  type PlanState,
} from "../src/state.ts";

function storedPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    phase: "executing",
    summary: "Ship safely",
    plan: "Inspect and implement.",
    steps: [
      { id: "step-1", text: "Inspect", status: "completed" },
      { id: "step-2", text: "Implement", status: "inProgress" },
    ],
    enteredWithTools: ["read", "bash"],
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function legacyExecuting(state: PlanState, now: number): PlanState {
  if (state.phase !== "awaitingApproval") throw new Error("Expected a submitted Plan.");
  return {
    ...state,
    phase: "executing",
    progress: { kind: "local", steps: state.steps.map((step) => ({ id: step.id, status: "pending" })) },
    updatedAt: now,
  };
}

test("plan lifecycle preserves the pre-plan tool snapshot", () => {
  const planning = createPlanningState(["read", "bash", "read", "submit_plan"], 10);
  assert.equal(planning.phase, "planning");
  assert.deepEqual(planning.enteredWithTools, ["read", "bash"]);

  const awaiting = submitPlan(
    planning,
    { summary: "Ship safely", plan: "1. Inspect\n2. Implement", steps: ["Inspect", "Implement"] },
    20,
  );
  assert.equal(awaiting.phase, "awaitingApproval");
  assert.deepEqual(awaiting.steps.map((step) => step.id), ["step-1", "step-2"]);

  const executing = approvePlanWithExternalProgress(awaiting, "todo", "execution", 30);
  assert.equal(executing.phase, "executing");
  assert.deepEqual(executing.enteredWithTools, ["read", "bash"]);
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
  assert.equal(decodePlanState({ ...blocked, blocker: { ...blocked.blocker!, summary: ` ${blocked.blocker!.summary}` } }).ok, false);

  const resumed = resumeBlockedPlan(blocked, 30);
  assert.equal(resumed.phase, "planning");
  assert.equal(resumed.blocker?.summary, blocked.blocker?.summary);
  const submitted = submitPlan(resumed, { summary: "Sign release", plan: "Use the supplied credential.", steps: ["Sign release"] }, 40);
  assert.equal(submitted.blocker, undefined);
  assert.throws(() => reportPlanBlocked(submitted, blocked.blocker!), /only be blocked during planning/);
});

test("step updates enforce execution phase, known IDs, and a single in-progress step", () => {
  const awaiting = submitPlan(
    createPlanningState(["read"], 10),
    { summary: "Do it", plan: "Execute two steps", steps: ["One", "Two"] },
    20,
  );
  assert.throws(() => updatePlanStep(awaiting, "step-1", "inProgress"), /local execution/);
  let executing = legacyExecuting(awaiting, 30);
  executing = updatePlanStep(executing, "step-1", "inProgress", 40);
  executing = updatePlanStep(executing, "step-2", "inProgress", 50);
  assert.equal(executing.progress?.kind, "local");
  if (executing.progress?.kind !== "local") throw new Error("Expected local progress.");
  assert.equal(executing.progress.steps[0].status, "pending");
  assert.equal(executing.progress.steps[1].status, "inProgress");
  assert.throws(() => updatePlanStep(executing, "missing", "completed"), /Unknown plan step/);
});

test("legacy local progress updates preserve every submitted step", () => {
  const awaiting = submitPlan(
    createPlanningState([], 10),
    { summary: "Do it", plan: "Execute", steps: ["One"] },
    20,
  );
  const executing = legacyExecuting(awaiting, 30);
  const completed = updatePlanStep(executing, "step-1", "completed", 40);
  assert.equal(completed.progress?.kind, "local");
  assert.equal(completed.progress?.kind === "local" && completed.progress.steps.every((step) => step.status === "completed"), true);
});

test("refine returns an awaiting plan to read-only planning", () => {
  const awaiting = submitPlan(
    createPlanningState(["read"], 10),
    { summary: "Do it", plan: "Execute", steps: ["One"] },
    20,
  );
  assert.equal(refinePlan(awaiting, 30).phase, "planning");
  assert.throws(() => refinePlan(createPlanningState([], 10)), /submitted plan/);
});

test("submission validation rejects empty and excessive plans", () => {
  const planning = createPlanningState([], 10);
  assert.throws(() => submitPlan(planning, { summary: "x", plan: "x", steps: [] }), /at least one/);
  assert.throws(
    () => submitPlan(planning, { summary: "x", plan: "x", steps: Array.from({ length: 51 }, () => "step") }),
    /at most 50/,
  );
});

test("submission enforces the aggregate UTF-8 payload limit", () => {
  const planning = createPlanningState([], 10);
  assert.throws(
    () => submitPlan(planning, { summary: "x", plan: "🙂".repeat(11_000), steps: ["ship"] }),
    /byte limit/,
  );
});

test("decodePlanState accepts exact v1 state and rejects unsafe persisted data", () => {
  const decoded = decodePlanState(storedPlan());
  if (!decoded.ok) assert.fail(decoded.reason);
  assert.equal(decoded.value.phase, "executing");

  const tooManySteps = Array.from({ length: 51 }, (_, index) => ({
    id: `step-${index + 1}`,
    text: "step",
    status: "pending",
  }));
  const duplicateSteps = [
    { id: "step-1", text: "One", status: "pending" },
    { id: "step-1", text: "Two", status: "pending" },
  ];
  const multipleInProgress = [
    { id: "step-1", text: "One", status: "inProgress" },
    { id: "step-2", text: "Two", status: "inProgress" },
  ];
  for (const invalid of [
    null,
    storedPlan({ version: 2 }),
    storedPlan({ version: undefined }),
    storedPlan({ plan: "x".repeat(20_001) }),
    storedPlan({ plan: "🙂".repeat(11_000) }),
    storedPlan({ steps: tooManySteps }),
    storedPlan({ steps: duplicateSteps }),
    storedPlan({ steps: multipleInProgress }),
    storedPlan({ enteredWithTools: ["read", "read"] }),
    storedPlan({ enteredWithTools: Array.from({ length: 257 }, (_, index) => `tool-${index}`) }),
    storedPlan({ updatedAt: 0 }),
    storedPlan({ forged: true }),
  ]) {
    assert.equal(decodePlanState(invalid).ok, false);
  }
});

test("decodePlanState enforces exact current progress payloads", () => {
  const executing = legacyExecuting(
    submitPlan(createPlanningState(["read"], 1), { summary: "Strict", plan: "Execute", steps: ["Verify"] }, 2),
    3,
  );
  assert.equal(decodePlanState(executing).ok, true);
  assert.equal(decodePlanState({ ...executing, forged: true }).ok, false);
  assert.equal(decodePlanState({ ...executing, steps: [{ ...executing.steps[0], status: "pending" }] }).ok, false);
  assert.equal(decodePlanState({
    ...executing,
    progress: { kind: "local", steps: [{ id: "step-1", status: "pending", forged: true }] },
  }).ok, false);
  assert.equal(decodePlanState({
    ...executing,
    progress: { kind: "external", providerId: "todo", executionId: "execution", forged: true },
  }).ok, false);
});

test("decodePlanState accepts both new and submitted planning states", () => {
  const draft = decodePlanState({
    version: 1,
    phase: "planning",
    enteredWithTools: ["read"],
    steps: [],
    createdAt: 1,
    updatedAt: 2,
  });
  assert.equal(draft.ok, true);
  assert.equal(decodePlanState(storedPlan({ phase: "planning" })).ok, true);
});

test("decodePlanJournalEntry enforces version, tombstones, and action phase", () => {
  assert.equal(decodePlanJournalEntry({ version: 2, action: "step", state: storedPlan() }).ok, false);
  assert.equal(decodePlanJournalEntry({ version: 1, action: "complete", state: storedPlan() }).ok, false);
  assert.equal(decodePlanJournalEntry({ version: 1, action: "submit", state: storedPlan() }).ok, false);
  assert.deepEqual(decodePlanJournalEntry({ version: 1, action: "complete", state: null }), {
    ok: true,
    value: { version: 3, action: "complete", state: null },
  });
  assert.equal(decodePlanJournalEntry({ version: 1, action: "complete", state: null, forged: true }).ok, false);
});

test("planPath restores cross-platform previews and clears only during refinement", () => {
  const awaiting = {
    ...submitPlan(createPlanningState(["read"], 1), { summary: "Path", plan: "## Path", steps: ["Verify"] }, 2),
    planPath: "/tmp/plan-preview.md",
  };
  assert.equal(decodePlanState(awaiting).ok, true);
  assert.equal(decodePlanState({ ...awaiting, planPath: "C:\\Plans\\preview.md" }).ok, true);
  assert.equal(refinePlan(awaiting, 3).planPath, undefined);
  assert.equal(approvePlanWithExternalProgress(awaiting, "todo", "execution", 3).planPath, awaiting.planPath);
  assert.equal(updatePlanStep({ ...legacyExecuting(awaiting, 3) }, "step-1", "inProgress", 4).planPath, awaiting.planPath);

  for (const planPath of ["relative.md", "C:relative.md", "/tmp/preview.txt", "/tmp/preview\0.md", "x".repeat(4_097)]) {
    assert.equal(decodePlanState({ ...awaiting, planPath }).ok, false, planPath);
  }
});
