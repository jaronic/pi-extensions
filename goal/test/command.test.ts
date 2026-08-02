import assert from "node:assert/strict";
import test from "node:test";
import goalExtension from "../src/index.ts";
import { registerExclusiveWorkflow } from "../src/workflow-mode.ts";
import { ExtensionHarness } from "./harness.ts";

async function exhaustBudget(harness: ExtensionHarness): Promise<void> {
  await harness.emit("turn_start", { type: "turn_start" });
  await harness.emit("turn_end", {
    type: "turn_end",
    message: { role: "assistant", stopReason: "stop", usage: { totalTokens: 100 } },
    toolResults: [],
  });
  assert.equal(harness.statuses.get("goal"), "Goal budget reached");
}

test("pause rejects a budget-limited Goal instead of laundering it into paused", async () => {
  const harness = new ExtensionHarness();
  goalExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("goal", "--tokens 100 finish the migration");
  harness.clearPendingMessages();
  await exhaustBudget(harness);

  const entriesBeforePause = harness.entries.length;
  await harness.command("goal", "pause");

  assert.equal(harness.statuses.get("goal"), "Goal budget reached");
  assert.equal(harness.entries.length, entriesBeforePause, "rejected pause must not write a journal entry");
  assert.equal(harness.agentOperations.includes("abort"), false, "rejected pause must not abort a running agent");
  assert.match(harness.notifications.at(-1)?.message ?? "", /budget is exhausted/);
});

test("pause followed by resume cannot revive a budget-limited Goal", async () => {
  const harness = new ExtensionHarness();
  goalExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("goal", "--tokens 100 finish the migration");
  harness.clearPendingMessages();
  await exhaustBudget(harness);
  const messagesBefore = harness.sentMessages.length;

  await harness.command("goal", "pause");
  await harness.command("goal", "resume");

  assert.equal(harness.statuses.get("goal"), "Goal budget reached");
  assert.equal(harness.sentMessages.length, messagesBefore, "resume must not queue a continuation");
  assert.match(harness.notifications.at(-1)?.message ?? "", /budget is exhausted/);
});

test("editing a completed Goal back to active is rejected while Plan is active", async (t) => {
  for (const order of ["goal-first", "plan-first"] as const) {
    await t.test(order, async () => {
      const harness = new ExtensionHarness();
      let planActive = false;
      if (order === "goal-first") {
        goalExtension(harness.api);
        registerExclusiveWorkflow(harness.api.events, "plan", () => planActive);
      } else {
        registerExclusiveWorkflow(harness.api.events, "plan", () => planActive);
        goalExtension(harness.api);
      }
      await harness.emit("session_start", { type: "session_start", reason: "startup" });
      await harness.command("goal", "ship the release");
      harness.clearPendingMessages();
      await harness.tool("update_goal", {
        status: "complete",
        evidence: [{ requirement: "Ship the release", evidence: "The release shipped." }],
      });
      assert.equal(harness.statuses.get("goal"), "Goal complete (0s)");
      planActive = true;

      const entriesBeforeEdit = harness.entries.length;
      const messagesBeforeEdit = harness.sentMessages.length;
      await harness.command("goal", "edit");

      assert.equal(harness.statuses.get("goal"), "Goal complete (0s)");
      assert.equal(harness.entries.length, entriesBeforeEdit, "rejected edit must not write a journal entry");
      assert.equal(harness.sentMessages.length, messagesBeforeEdit, "rejected edit must not queue a continuation");
      assert.match(harness.notifications.at(-1)?.message ?? "", /Plan mode is active/);
    });
  }
});
