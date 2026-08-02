import assert from "node:assert/strict";
import test from "node:test";
import loopExtension from "../src/index.ts";
import { createLoop } from "../src/state.ts";
import { registerExclusiveWorkflow } from "../src/workflow-mode.ts";
import goalExtension from "../../goal/src/index.ts";
import planExtension from "../../plan/src/index.ts";
import { InMemoryPlanArtifactStore } from "../../plan/test/harness.ts";
import { LOOP_STATE_TYPE } from "../src/protocol.ts";
import { ExtensionHarness } from "./harness.ts";

function registerPlan(harness: ExtensionHarness): InMemoryPlanArtifactStore {
  const artifactStore = new InMemoryPlanArtifactStore();
  planExtension(harness.api, { artifactStore });
  return artifactStore;
}

function loopId(harness: ExtensionHarness): string {
  const entry = harness.entries.find((candidate) => candidate.customType === LOOP_STATE_TYPE);
  if (!entry) throw new Error("no loop journal entry");
  return (entry.data as { loop: { id: string } }).loop.id;
}

test("an active Goal blocks /loop creation", async () => {
  const harness = new ExtensionHarness();
  goalExtension(harness.api);
  loopExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("goal", "keep the release pipeline green");

  await harness.command("loop", "3 fix the tests");

  assert.match(harness.notifications.at(-1)?.message ?? "", /another exclusive workflow/);
  assert.equal(harness.entries.filter((entry) => entry.customType === LOOP_STATE_TYPE).length, 0);
});

test("an active Plan blocks /loop creation", async () => {
  const harness = new ExtensionHarness();
  registerPlan(harness);
  loopExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("plan");

  await harness.command("loop", "3 fix the tests");

  assert.match(harness.notifications.at(-1)?.message ?? "", /another exclusive workflow/);
  assert.equal(harness.entries.filter((entry) => entry.customType === LOOP_STATE_TYPE).length, 0);
});

test("an active Loop blocks /goal creation and resume", async () => {
  const harness = new ExtensionHarness();
  goalExtension(harness.api);
  loopExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("loop", "3 fix the tests");

  await harness.command("goal", "switch to a goal instead");
  assert.match(harness.notifications.at(-1)?.message ?? "", /Goal cannot start/);

  await harness.command("loop", "pause");
  await harness.command("goal", "switch to a goal instead");
  assert.match(harness.notifications.at(-1)?.message ?? "", /Goal active/, "a paused Loop does not block Goal");
});

test("an active Loop blocks /plan start", async () => {
  const harness = new ExtensionHarness();
  registerPlan(harness);
  loopExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("loop", "3 fix the tests");

  await harness.command("plan");
  assert.match(harness.notifications.at(-1)?.message ?? "", /Plan cannot start/);
});

test("restore arbitration keeps Goal active and pauses the Loop (Plan > Goal > Loop)", async () => {
  // Simulate a branch whose journal carries both an active Goal and a running Loop
  // (for example a fork made before the exclusivity check existed).
  const harness = new ExtensionHarness();
  goalExtension(harness.api);
  loopExtension(harness.api);
  const api = harness.api as unknown as { appendEntry: (customType: string, data: unknown) => void };
  api.appendEntry("goal-state-v1", {
    version: 1,
    action: "set",
    goal: {
      version: 1,
      id: "goal-1",
      objective: "keep the release pipeline green",
      status: "active",
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    },
  });
  api.appendEntry(LOOP_STATE_TYPE, {
    version: 1,
    action: "create",
    loop: createLoop("fix the tests", 3, 1, "loop-1"),
  });
  await harness.emit("session_start", { type: "session_start", reason: "resume" });

  assert.match(harness.statuses.get("loop") ?? "", /Loop paused 0\/3/, "Loop yields to the active Goal on restore");
  assert.ok(harness.statuses.get("goal")?.startsWith("Goal active"), "Goal keeps its active state");
});

test("workflow queries are scoped to the session id", async () => {
  const harness = new ExtensionHarness();
  loopExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("loop", "3 fix the tests");
  harness.clearPendingMessages();
  harness.setSessionId("other-session");

  await harness.command("loop", "3 replace me");
  assert.match(harness.notifications.at(-1)?.message ?? "", /Loop active/, "a foreign session does not see the loop as active");
});

test("a legacy peer that only answers plan/goal targets still blocks a new Loop (safe direction)", async () => {
  const harness = new ExtensionHarness();
  loopExtension(harness.api);
  // Frozen legacy fixture: a listener that only understands plan/goal targets and
  // reports an active goal (as the pre-loop goal extension would).
  const unsubscribe = registerExclusiveWorkflow(harness.api.events, "goal", () => true);
  try {
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.command("loop", "3 fix the tests");
    assert.match(harness.notifications.at(-1)?.message ?? "", /another exclusive workflow/);
  } finally {
    unsubscribe();
  }
});

test("pause/stop/clear stay available while another workflow is active", async () => {
  const harness = new ExtensionHarness();
  goalExtension(harness.api);
  loopExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("loop", "3 fix the tests");

  await harness.command("loop", "pause");
  assert.equal(
    (harness.entries.findLast((entry) => entry.customType === LOOP_STATE_TYPE)?.data as { loop: { status: string } }).loop.status,
    "paused",
  );

  // A paused Loop is not an active workflow, so Goal may start now.
  await harness.command("goal", "keep the release pipeline green");
  assert.match(harness.notifications.at(-1)?.message ?? "", /Goal active/);

  await harness.command("loop", "stop");
  assert.equal(
    (harness.entries.findLast((entry) => entry.customType === LOOP_STATE_TYPE)?.data as { loop: { status: string } }).loop.status,
    "stopped",
    "stop must not be blocked by the active Goal",
  );
  await harness.command("loop", "clear");
  assert.match(harness.notifications.at(-1)?.message ?? "", /Loop cleared/);
  assert.equal(harness.statuses.get("loop"), undefined);
});
