import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import {
  boundPlanText,
  renderPlan,
  renderPlanStepUpdate,
  renderPlanWidget,
  summarizePlanState,
} from "../src/output.ts";
import type { PlanState } from "../src/state.ts";

function planState(stepCount = 1, stepText = "Implement"): PlanState {
  return {
    version: 4,
    phase: "executing",
    summary: "Ship safely",
    plan: "Implement and verify.",
    steps: Array.from({ length: stepCount }, (_, index) => ({
      id: `step-${index + 1}`,
      text: stepText,
    })),
    progress: {
      kind: "local",
      steps: Array.from({ length: stepCount }, (_, index) => ({ id: `step-${index + 1}`, status: "pending" as const })),
    },
    enteredWithTools: ["read"],
    createdAt: 1,
    updatedAt: 2,
  };
}

test("boundPlanText enforces byte and line limits without duplicating content", () => {
  const source = Array.from({ length: 2_100 }, (_, index) => `line ${index}`).join("\n");
  const bounded = boundPlanText(source);
  assert.ok(bounded.truncation);
  assert.equal(bounded.truncation.totalLines, 2_100);
  assert.ok(Buffer.byteLength(bounded.text) <= DEFAULT_MAX_BYTES);
  assert.ok(bounded.text.split("\n").length <= DEFAULT_MAX_LINES);
  assert.match(bounded.text, /Plan output truncated/);
  assert.equal("content" in bounded.truncation, false);
});

test("Plan result details omit the full plan and step text", () => {
  const details = summarizePlanState(planState(), false);
  assert.equal("plan" in details, false);
  assert.deepEqual(details.steps, [{ id: "step-1", status: "pending" }]);
});

test("Plan step updates are compact and use Todo-style ordinals", () => {
  const state: PlanState = {
    ...planState(3),
    steps: [
      { id: "step-1", text: "Inspect" },
      { id: "step-2", text: "Implement" },
      { id: "step-3", text: "Verify" },
    ],
    progress: {
      kind: "local",
      steps: [
        { id: "step-1", status: "completed" },
        { id: "step-2", status: "inProgress" },
        { id: "step-3", status: "pending" },
      ],
    },
  };
  const update = renderPlanStepUpdate(state, "step-2");
  assert.equal(update, "Started #2: Implement.\nProgress: 1/3 completed · 0 blocked.");
  assert.doesNotMatch(update, /Plan:|Execution steps:|Ship safely/);

  const completed: PlanState = {
    ...state,
    progress: {
      kind: "local",
      steps: state.steps.map((step) => ({ id: step.id, status: "completed" as const })),
    },
  };
  assert.equal(
    renderPlanStepUpdate(completed, "step-3"),
    "Completed #3: Verify.\nProgress: 3/3 completed · 0 blocked · Plan mode exited.",
  );
});

test("Plan widgets bound both step count and displayed step text", () => {
  const lines = renderPlanWidget(planState(25, "x".repeat(500)));
  assert.equal(lines.length, 22);
  assert.match(lines.at(-1) ?? "", /5 more step/);
  assert.ok(lines[1].length < 160);
});

test("Plan result details include planPath only for submitted artifacts", () => {
  const withoutPath = summarizePlanState(planState(), false);
  assert.equal("planPath" in withoutPath, false);
  const withPath = summarizePlanState({ ...planState(), planPath: "/tmp/preview.md" }, false);
  assert.equal(withPath.planPath, "/tmp/preview.md");
  assert.equal("plan" in withPath, false);
  assert.deepEqual(withPath.steps, [{ id: "step-1", status: "pending" }]);
});

test("blocked Plan output exposes evidence and resolution paths without execution steps", () => {
  const blocked: PlanState = {
    ...planState(),
    phase: "blocked",
    summary: undefined,
    plan: undefined,
    steps: [],
    progress: undefined,
    blocker: {
      summary: "No signing credential is available.",
      blockingFacts: ["The credential store is empty."],
      evidenceSources: ["credential-store read result"],
      resolutions: [{ kind: "prerequisite", label: "Provide credential", description: "Add a signing key." }],
    },
  };
  assert.match(renderPlan(blocked), /Verified blocking facts/);
  assert.match(renderPlan(blocked), /User resolution paths/);
  assert.deepEqual(renderPlanWidget(blocked), ["Plan blocked", "! No signing credential is available."]);
  assert.deepEqual(summarizePlanState(blocked, false).blocker, blocked.blocker);
});
