import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import goalExtension from "../../goal/src/index.ts";
import planExtension from "../src/index.ts";
import { blockedDecision, ExtensionHarness } from "./harness.ts";
import type { PlanExtensionDependencies } from "../src/index.ts";
import { InMemoryPlanArtifactStore } from "./harness.ts";
import type { TodoService } from "pi-todo-dev";

function registerTestPlan(
  harness: ExtensionHarness,
  overrides: Partial<PlanExtensionDependencies> = {},
): InMemoryPlanArtifactStore | PlanExtensionDependencies["artifactStore"] {
  const artifactStore = overrides.artifactStore ?? new InMemoryPlanArtifactStore();
  planExtension(harness.api, { ...overrides, artifactStore });
  return artifactStore;
}

test("starting Plan without a Goal changes mode without queuing a turn", async () => {
  const harness = new ExtensionHarness();
  goalExtension(harness.api);
  registerTestPlan(harness);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  assert.deepEqual(harness.commandCompletions("plan", "rev"), [{ value: "review", label: "review" }]);

  await harness.command("plan");

  assert.equal(harness.sentMessages.length, 0, "/plan must not trigger an LLM turn");
  assert.equal(harness.entries.some((entry) => entry.customType === "goal-state-v1"), false);
  assert.equal(harness.widgets.get("goal"), undefined);
  assert.equal(harness.statuses.get("plan"), "Plan");
  assert.equal(harness.widgets.get("plan"), undefined);
  assert.equal(harness.getActiveTools().includes("submit_plan"), true);
  assert.equal(
    harness.notifications.at(-1)?.message,
    "Plan mode active: workspace mutation and arbitrary shell execution are disabled. Send the request you want planned.",
  );
});
test("Plan clarification delegates selection, cancellation, and headless replies to Request", async (t) => {
  const choice = {
    question: "Which rollout path should the Plan use?",
    options: [
      { label: "Canary", description: "Validate a small cohort first." },
      { label: "Full rollout", description: "Deploy to every target together." },
    ],
  };

  await t.test("selection", async () => {
    const harness = new ExtensionHarness();
    registerTestPlan(harness);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.command("plan");
    await harness.tool("request_plan_choice", choice);
    harness.setCustomInputs("\x1b[B", "\r");
    await harness.emit("agent_settled", { type: "agent_settled" });

    assert.equal(harness.customViews.length, 1);
    assert.match(harness.customViews[0]?.join("\n") ?? "", /Which rollout path should the Plan use/);
    assert.equal(harness.notifications.at(-1)?.message, "Plan choice 2 recorded: Full rollout. Read-only planning resumed.");
  });

  await t.test("cancellation", async () => {
    const harness = new ExtensionHarness();
    registerTestPlan(harness);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.command("plan");
    await harness.tool("request_plan_choice", choice);
    harness.setCustomInputs("\x1b");
    await harness.emit("agent_settled", { type: "agent_settled" });

    assert.equal(harness.notifications.at(-1)?.message, "Plan remains awaiting your decision.");
    await harness.tool("answer_plan_choice", { selection: 2 });
  });

  await t.test("headless reply", async () => {
    const harness = new ExtensionHarness(undefined, false);
    registerTestPlan(harness);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.command("plan");
    await harness.tool("request_plan_choice", choice);
    await harness.emit("agent_settled", { type: "agent_settled" });

    assert.equal(harness.customViews.length, 0);
    await harness.tool("answer_plan_choice", { selection: 1 });
  });
});


test("blocked Plan results stay read-only and resume with the recorded evidence", async () => {
  const harness = new ExtensionHarness();
  registerTestPlan(harness);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("plan");

  await harness.tool("report_plan_blocked", {
    summary: "A signing credential is required before a release plan can be approved.",
    blockingFacts: ["The configured credential store contains no signing key."],
    evidenceSources: ["config/signing.ts", "credential-store read result"],
    resolutions: [
      { kind: "prerequisite", label: "Provide credential", description: "Add a valid signing key to the configured store." },
      { kind: "alternative", label: "Defer signed release", description: "Plan an unsigned internal build instead." },
    ],
  });

  assert.equal(harness.statuses.get("plan"), "Plan blocked");
  assert.deepEqual(harness.widgets.get("plan"), ["! A signing credential is required before a release plan can be approved."]);
  assert.equal(harness.getActiveTools().includes("submit_plan"), false);
  assert.equal(harness.getActiveTools().includes("report_plan_blocked"), false);
  assert.equal(
    blockedDecision(await harness.emit("tool_call", { type: "tool_call", toolName: "write", toolCallId: "blocked-write", input: {} }))?.block,
    true,
  );
  await harness.command("plan", "status");
  assert.match(harness.notifications.at(-1)?.message ?? "", /Verified blocking facts/);

  await harness.command("plan", "resume");
  assert.ok(harness.getActiveTools().includes("submit_plan"));
  assert.ok(harness.getActiveTools().includes("report_plan_blocked"));
  const promptResults = await harness.emit("before_agent_start", { type: "before_agent_start", systemPrompt: "BASE" });
  const promptResult = promptResults.at(-1);
  const systemPrompt = promptResult && typeof promptResult === "object" && "systemPrompt" in promptResult && typeof promptResult.systemPrompt === "string"
    ? promptResult.systemPrompt
    : "";
  assert.match(systemPrompt, /A prior planning attempt could not form an approvable implementation plan/);
  assert.match(systemPrompt, /credential-store read result/);
});

test("Goal continuation remains paused while Plan is blocked", async () => {
  const harness = new ExtensionHarness();
  goalExtension(harness.api);
  registerTestPlan(harness);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("goal", "--tokens 50k ship safely");
  harness.clearPendingMessages();
  await harness.command("plan");
  await harness.tool("report_plan_blocked", {
    summary: "A signing credential is unavailable.",
    blockingFacts: ["The credential store has no signing key."],
    evidenceSources: ["credential-store read result"],
    resolutions: [{ kind: "prerequisite", label: "Provide credential", description: "Add the required signing key." }],
  });
  await harness.emit("agent_start", { type: "agent_start" });
  const before = harness.sentMessages.length;
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop", usage: { totalTokens: 100 } }],
  });
  assert.equal(harness.sentMessages.length, before);
});

test("Goal and Plan coexist through planning, approval, execution, and continuation", async () => {
  const harness = new ExtensionHarness();
  goalExtension(harness.api);
  registerTestPlan(harness);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  assert.equal(harness.statuses.get("goal"), undefined);
  assert.equal(harness.statuses.get("plan"), undefined);
  assert.equal(harness.widgets.get("plan"), undefined);
  assert.equal(harness.widgets.get("goal"), undefined);

  assert.deepEqual(harness.getActiveTools(), [
    "read",
    "bash",
    "edit",
    "write",
    "unknown_writer",
    "create_goal",
    "ask",
    "todo",
  ]);

  await harness.command("goal", "--tokens 50k ship the feature with verification");
  assert.equal(harness.statuses.get("goal"), "Goal active (0s · 0 / 50K)");
  assert.equal(harness.widgets.get("goal"), undefined);
  assert.equal(harness.sentMessages.length, 1, "setting a Goal queues exactly one initial turn");
  assert.ok(harness.getActiveTools().includes("get_goal"));
  assert.ok(harness.getActiveTools().includes("update_goal"));

  harness.clearPendingMessages();
  await harness.emit("agent_start", { type: "agent_start" });
  await harness.command("plan");
  assert.equal(harness.statuses.get("goal"), "Goal active (0s · 0 / 50K)");
  assert.equal(harness.statuses.get("plan"), "Plan");
  assert.equal(harness.widgets.get("goal"), undefined);
  assert.equal(harness.widgets.get("plan"), undefined);
  assert.equal(harness.sentMessages.length, 1, "entering Plan must not queue a planning turn");
  assert.deepEqual(harness.getActiveTools(), [
    "read",
    "grep",
    "find",
    "ls",
    "create_goal",
    "ask",
    "get_goal",
    "submit_plan",
    "report_plan_blocked",
    "request_plan_choice",
  ]);

  for (const toolName of ["bash", "edit", "write", "unknown_writer", "update_goal"]) {
    const decisions = await harness.emit("tool_call", {
      type: "tool_call",
      toolName,
      toolCallId: `blocked-${toolName}`,
      input: {},
    });
    assert.equal(blockedDecision(decisions)?.block, true, `${toolName} must be blocked before approval`);
  }
  assert.equal(
    blockedDecision(
      await harness.emit("tool_call", { type: "tool_call", toolName: "read", toolCallId: "safe-read", input: {} }),
    ),
    undefined,
  );

  harness.clearPendingMessages();
  await harness.emit("agent_start", { type: "agent_start" });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop", usage: { totalTokens: 100 } }],
  });
  assert.equal(harness.sentMessages.length, 1, "Goal automatic continuation is suppressed while Plan is read-only");

  await harness.tool("submit_plan", {
    summary: "Ship safely",
    plan: "Inspect, implement, and verify.",
    steps: ["Inspect", "Implement", "Verify"],
  });
  assert.equal(harness.statuses.get("plan"), "Plan");
  assert.deepEqual(harness.widgets.get("plan"), ["· step-1 Inspect", "· step-2 Implement", "· step-3 Verify"]);
  assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls", "create_goal", "ask", "get_goal"]);
  assert.equal(
    blockedDecision(
      await harness.emit("tool_call", { type: "tool_call", toolName: "submit_plan", toolCallId: "again", input: {} }),
    )?.block,
    true,
  );

  harness.clearPendingMessages();
  await harness.command("plan", "approve");
  assert.equal(harness.statuses.get("plan"), undefined);
  assert.equal(harness.widgets.get("plan"), undefined);
  assert.equal(harness.sentMessages.length, 2, "approval queues only the structured execution turn");
  for (const toolName of ["bash", "edit", "write", "unknown_writer", "update_goal", "update_plan_step"]) {
    assert.ok(harness.getActiveTools().includes(toolName), `${toolName} must be active during approved execution`);
  }

  harness.clearPendingMessages();
  await harness.emit("agent_start", { type: "agent_start" });
  const beforeAutomatic = harness.sentMessages.length;
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop", usage: { totalTokens: 100 } }],
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop", usage: { totalTokens: 100 } }],
  });
  assert.equal(
    harness.sentMessages.length,
    beforeAutomatic + 1,
    "Goal keeps at most one automatic continuation queued after Plan approval",
  );
});

test("cancelling a submitted Plan keeps Goal active and queues one continuation", async () => {
  const harness = new ExtensionHarness();
  goalExtension(harness.api);
  registerTestPlan(harness);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });

  await harness.command("goal", "continue after the submitted plan is cancelled");
  harness.clearPendingMessages();
  await harness.emit("agent_start", { type: "agent_start" });
  await harness.command("plan");
  harness.clearPendingMessages();
  await harness.emit("agent_start", { type: "agent_start" });

  const messagesBeforeCancel = harness.sentMessages.length;
  const result = await harness.tool("submit_plan", {
    summary: "Cancelled plan",
    plan: "Do not execute after cancellation.",
    steps: ["Must not run"],
  });
  assert.ok(result && typeof result === "object" && "terminate" in result && result.terminate === true);
  await harness.command("plan", "cancel");
  assert.match(harness.statuses.get("goal") ?? "", /^Goal active/);
  assert.equal(harness.widgets.get("goal"), undefined);
  assert.equal(harness.statuses.get("plan"), undefined);
  assert.equal(harness.widgets.get("plan"), undefined);
  assert.equal(
    harness.notifications.some((notification) => notification.message === "Goal paused because Plan was cancelled."),
    false,
  );
  assert.equal(
    harness.sentMessages.length,
    messagesBeforeCancel + 1,
    "Plan cancellation must release exactly one Goal continuation",
  );
  const continuation = harness.sentMessages.at(-1);
  assert.ok(continuation);
  function isHiddenGoalContinuation(value: unknown): value is {
    customType: "goal-continuation-v1";
    display: false;
  } {
    if (!value || typeof value !== "object") return false;
    return "customType" in value
      && value.customType === "goal-continuation-v1"
      && "display" in value
      && value.display === false;
  }
  assert.ok(isHiddenGoalContinuation(continuation.message));

  const messagesBeforeEnd = harness.sentMessages.length;
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop" }],
  });
  assert.equal(harness.sentMessages.length, messagesBeforeEnd, "the original Plan turn must not queue a duplicate continuation");
});

test("mode switches settle the current agent before queuing the next phase", async () => {
  const harness = new ExtensionHarness();
  goalExtension(harness.api);
  registerTestPlan(harness);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });

  await harness.command("goal", "coordinate an interrupted planning flow");
  harness.agentOperations.length = 0;
  harness.setIdle(false);
  harness.deferWaitForIdle();
  const pendingPlanCommand = harness.command("plan");
  await Promise.resolve();

  assert.deepEqual(harness.agentOperations, ["abort", "wait"]);
  assert.equal(harness.sentMessages.length, 1, "/plan must not queue while the current agent settles");
  assert.equal(harness.statuses.get("plan"), "Plan");
  assert.equal(harness.widgets.get("plan"), undefined);
  assert.deepEqual(harness.getActiveTools(), [
    "read",
    "grep",
    "find",
    "ls",
    "create_goal",
    "ask",
    "get_goal",
    "submit_plan",
    "report_plan_blocked",
    "request_plan_choice",
  ]);

  harness.releaseWaitForIdle();
  await pendingPlanCommand;
  assert.deepEqual(harness.agentOperations, ["abort", "wait"]);
  assert.equal(harness.abortCount, 1);
  assert.equal(harness.waitForIdleCount, 1);
  assert.equal(harness.sentMessages.length, 1);
  assert.match(harness.statuses.get("goal") ?? "", /^Goal active/);
  assert.equal(harness.statuses.get("plan"), "Plan");
  assert.equal(harness.widgets.get("goal"), undefined);
  assert.equal(harness.widgets.get("plan"), undefined);

  harness.clearPendingMessages();
  await harness.emit("agent_start", { type: "agent_start" });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "aborted" }],
  });
  assert.match(harness.statuses.get("goal") ?? "", /^Goal active/);
  assert.equal(harness.sentMessages.length, 1, "Plan-controlled abort must not pause or continue Goal");

  await harness.emit("agent_start", { type: "agent_start" });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "error", errorMessage: "stream ended before a terminal response event" }],
  });
  assert.match(harness.statuses.get("goal") ?? "", /^Goal active/);
  assert.equal(harness.sentMessages.length, 1, "Plan-controlled stream errors must remain owned by Plan");

  harness.agentOperations.length = 0;
  harness.setIdle(false);
  await harness.command("plan", "resume");
  assert.deepEqual(harness.agentOperations, ["abort", "wait", "send"]);
  assert.equal(harness.sentMessages.length, 2);

  harness.agentOperations.length = 0;
  await harness.command("goal", "pause");
  assert.deepEqual(harness.agentOperations, ["abort", "wait"]);
  assert.equal(harness.statuses.get("goal"), "Goal paused");
  assert.equal(harness.widgets.get("goal"), undefined);

  await harness.command("plan", "cancel");
  assert.equal(harness.statuses.get("plan"), undefined);
  assert.equal(harness.widgets.get("plan"), undefined);
});

test("Goal terminal state stops continuation while the final turn remains accounted", async () => {
  const harness = new ExtensionHarness();
  goalExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("goal", "finish completely");
  harness.clearPendingMessages();
  await harness.emit("agent_start", { type: "agent_start" });
  await harness.emit("turn_start", { type: "turn_start" });
  await harness.tool("update_goal", {
    status: "complete",
    evidence: [{ requirement: "Finish completely", evidence: "The test established every terminal condition." }],
  });
  await harness.emit("turn_end", {
    type: "turn_end",
    message: { role: "assistant", stopReason: "stop", usage: { totalTokens: 321 } },
    toolResults: [],
  });
  const messagesBeforeEnd = harness.sentMessages.length;
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop", usage: { totalTokens: 321 } }],
  });
  assert.equal(harness.sentMessages.length, messagesBeforeEnd);

  const lastGoalEntry = [...harness.entries].reverse().find((entry) => entry.customType === "goal-state-v1");
  assert.ok(lastGoalEntry);
  assert.ok(lastGoalEntry.data && typeof lastGoalEntry.data === "object" && "goal" in lastGoalEntry.data);
  const goal = lastGoalEntry.data.goal;
  assert.ok(goal && typeof goal === "object" && "status" in goal && "tokensUsed" in goal);
  assert.equal(goal.status, "complete");
  assert.equal(goal.tokensUsed, 321);
});

test("Goal suppresses no-action automatic continuations and re-arms on explicit resume", async () => {
  const harness = new ExtensionHarness();
  goalExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("goal", "keep making concrete progress");
  harness.clearPendingMessages();

  await harness.emit("agent_start", { type: "agent_start" });
  const messagesBeforeNoAction = harness.sentMessages.length;
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop" }],
  });

  assert.equal(harness.sentMessages.length, messagesBeforeNoAction);
  assert.match(harness.statuses.get("goal") ?? "", /^Goal active/);
  assert.match(harness.notifications.at(-1)?.message ?? "", /automatic continuation stopped.*no tool calls/);

  await harness.command("goal", "resume");
  assert.equal(harness.sentMessages.length, messagesBeforeNoAction + 1);
  harness.clearPendingMessages();
  await harness.emit("agent_start", { type: "agent_start" });
  await harness.emit("tool_call", {
    type: "tool_call",
    toolName: "read",
    toolCallId: "productive-read",
    input: { path: "goal/src/index.ts" },
  });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop" }],
  });
  assert.equal(harness.sentMessages.length, messagesBeforeNoAction + 2);
});

test("Goal terminal updates require evidence or a structured blocker", async () => {
  const harness = new ExtensionHarness();
  goalExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("goal", "finish only with evidence");

  await assert.rejects(
    harness.tool("update_goal", { status: "complete" }),
    /completion requires.*requirement-to-evidence entries/,
  );
  await assert.rejects(
    harness.tool("update_goal", {
      status: "blocked",
      reason: "A credential is unavailable.",
      attempted: [],
      unblocksWhen: "The user supplies the credential.",
    }),
    /blocked Goal requires.*attempted actions/,
  );
  assert.match(harness.statuses.get("goal") ?? "", /^Goal active/);

  const result = await harness.tool("update_goal", {
    status: "blocked",
    reason: "The required signing credential is unavailable.",
    attempted: ["Checked the configured environment and credential store."],
    unblocksWhen: "The user supplies or installs the signing credential.",
  });
  assert.equal(harness.statuses.get("goal"), "Goal blocked");
  assert.match(JSON.stringify(result), /required signing credential/);
  assert.match(JSON.stringify(result), /unblocksWhen/);
});

test("headless Plan waits for an explicit command and restores tools on cancel", async () => {
  const originalTools = ["read", "bash", "edit", "write", "unknown_writer"];
  const harness = new ExtensionHarness(originalTools, false);
  registerTestPlan(harness);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("plan");
  assert.equal(harness.sentMessages.length, 0);

  harness.clearPendingMessages();
  await harness.emit("agent_start", { type: "agent_start" });
  await harness.tool("submit_plan", {
    summary: "Headless plan",
    plan: "Inspect and execute only after approval.",
    steps: ["Inspect", "Execute"],
  });
  assert.equal(harness.sentMessages.length, 0, "headless submission must not wait on or invent a dialog choice");
  assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls", "ask"]);

  await harness.command("plan", "approve");
  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.getActiveTools(), [...originalTools, "ask", "todo", "update_plan_step"]);
  harness.clearPendingMessages();
  await harness.command("plan", "cancel");
  assert.deepEqual(harness.getActiveTools(), [...originalTools, "ask", "todo"]);
});

test("Goal reload and abort pause automatic continuation", async () => {
  const harness = new ExtensionHarness();
  goalExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("goal", "survive lifecycle transitions");
  assert.equal(harness.sentMessages.length, 1);

  harness.clearPendingMessages();
  await harness.emit("agent_start", { type: "agent_start" });
  await harness.emit("session_start", { type: "session_start", reason: "reload" });
  assert.equal(harness.sentMessages.length, 1, "reload must not silently restart the Goal");
  assert.equal(harness.getActiveTools().includes("update_goal"), false);

  await harness.command("goal", "resume");
  assert.equal(harness.sentMessages.length, 2);
  harness.clearPendingMessages();
  await harness.emit("agent_start", { type: "agent_start" });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "aborted" }],
  });
  assert.equal(harness.sentMessages.length, 2, "an aborted Goal turn must not queue a continuation");

  const lastGoalEntry = [...harness.entries].reverse().find((entry) => entry.customType === "goal-state-v1");
  assert.ok(lastGoalEntry);
  assert.ok(lastGoalEntry.data && typeof lastGoalEntry.data === "object" && "goal" in lastGoalEntry.data);
  const goal = lastGoalEntry.data.goal;
  assert.ok(goal && typeof goal === "object" && "status" in goal);
  assert.equal(goal.status, "paused");
});

test("Goal defers agent errors until settlement and pauses non-usage failures", async () => {
  const harness = new ExtensionHarness();
  goalExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("goal", "survive transient provider errors");
  harness.clearPendingMessages();

  await harness.emit("agent_start", { type: "agent_start" });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "error", errorMessage: "Connection error." }],
  });
  assert.match(harness.statuses.get("goal") ?? "", /^Goal active/);
  assert.equal(harness.sentMessages.length, 1, "the runtime owns retries before agent_settled");

  await harness.emit("agent_settled", { type: "agent_settled" });
  assert.equal(harness.statuses.get("goal"), "Goal paused");
});

test("a successful runtime retry clears the pending Goal error", async () => {
  const harness = new ExtensionHarness();
  goalExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("goal", "recover from a transient provider error");
  harness.clearPendingMessages();

  await harness.emit("agent_start", { type: "agent_start" });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "error", errorMessage: "Connection error." }],
  });
  await harness.emit("agent_start", { type: "agent_start" });
  await harness.emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop" }],
  });
  await harness.emit("agent_settled", { type: "agent_settled" });

  assert.match(harness.statuses.get("goal") ?? "", /^Goal active/);
  assert.equal(harness.sentMessages.length, 2, "Goal queues one continuation after the successful retry");
});

test("Goal footer status follows the user lifecycle and hides only after clear", async () => {
  const harness = new ExtensionHarness();
  goalExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  assert.equal(harness.statuses.get("goal"), undefined);
  assert.equal(harness.widgets.get("goal"), undefined);

  await harness.command("goal", "finish a visible user journey");
  assert.equal(harness.statuses.get("goal"), "Goal active (0s)");
  assert.equal(harness.widgets.get("goal"), undefined);
  harness.clearPendingMessages();

  await harness.command("goal", "pause");
  assert.equal(harness.statuses.get("goal"), "Goal paused");
  assert.equal(harness.getActiveTools().includes("get_goal"), false);
  assert.equal(harness.getActiveTools().includes("update_goal"), false);

  await harness.command("goal", "resume");
  assert.equal(harness.statuses.get("goal"), "Goal active (0s)");
  harness.clearPendingMessages();
  await harness.tool("update_goal", {
    status: "complete",
    evidence: [{ requirement: "Finish the visible journey", evidence: "The lifecycle assertions reached the terminal path." }],
  });
  assert.equal(harness.statuses.get("goal"), "Goal complete (0s)");

  await harness.command("goal", "clear");
  assert.equal(harness.statuses.get("goal"), undefined);
  assert.equal(harness.widgets.get("goal"), undefined);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  assert.equal(harness.statuses.get("goal"), undefined, "cleared Goal must stay hidden after restore");
  assert.equal(harness.widgets.get("goal"), undefined, "cleared Goal status widget must stay hidden after restore");
});

test("Goal footer ticks live and completion reports the settled duration", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1_000 });
  const harness = new ExtensionHarness();
  goalExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("goal", "measure the active execution time");
  harness.clearPendingMessages();

  await harness.emit("turn_start", { type: "turn_start" });
  assert.equal(harness.statuses.get("goal"), "Goal active (0s)");
  t.mock.timers.tick(2_100);
  assert.equal(harness.statuses.get("goal"), "Goal active (2s)");

  const result = await harness.tool("update_goal", {
    status: "complete",
    evidence: [{ requirement: "Measure active execution time", evidence: "The live timer reported two elapsed seconds." }],
  });

  assert.equal(harness.statuses.get("goal"), "Goal complete (2s)");
  assert.equal(harness.notifications.at(-1)?.message, "Goal completed in 2s.");
  assert.match(JSON.stringify(result), /Goal completed in 2s\./);
  assert.match(JSON.stringify(result), /completionEvidence/);
  assert.match(JSON.stringify(result), /live timer reported two elapsed seconds/);

  await harness.emit("turn_end", {
    type: "turn_end",
    message: { role: "assistant", stopReason: "stop", usage: { totalTokens: 25 } },
    toolResults: [],
  });
  const lastGoalEntry = [...harness.entries].reverse().find((entry) => entry.customType === "goal-state-v1");
  assert.ok(lastGoalEntry?.data && typeof lastGoalEntry.data === "object" && "goal" in lastGoalEntry.data);
  const settledGoal = lastGoalEntry.data.goal;
  assert.ok(settledGoal && typeof settledGoal === "object" && "timeUsedSeconds" in settledGoal && "tokensUsed" in settledGoal);
  assert.equal(settledGoal.timeUsedSeconds, 2);
  assert.equal(settledGoal.tokensUsed, 25);
  t.mock.timers.reset();
});

test("submit_plan returns a compact summary before awaiting explicit approval", async () => {
  const originalTools = ["read", "bash", "edit", "write", "unknown_writer"];
  const harness = new ExtensionHarness(originalTools);
  registerTestPlan(harness);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  assert.equal(harness.statuses.get("plan"), undefined);
  assert.equal(harness.widgets.get("plan"), undefined);

  await harness.command("plan");
  assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls", "ask", "submit_plan", "report_plan_blocked", "request_plan_choice"]);
  assert.equal(harness.statuses.get("plan"), "Plan");
  assert.equal(harness.widgets.get("plan"), undefined);
  harness.clearPendingMessages();
  await harness.emit("agent_start", { type: "agent_start" });
  const submission = await harness.tool("submit_plan", {
    summary: "Visible plan",
    plan: "## Objective\n\nExpose the complete submitted plan before approval.\n\n## Evidence\n\nThe approval result must preserve this section.",
    steps: ["Implement and verify"],
  });
  assert.ok(submission && typeof submission === "object" && "content" in submission);
  assert.ok(Array.isArray(submission.content));
  const firstContent = submission.content[0];
  assert.ok(firstContent && typeof firstContent === "object" && "text" in firstContent);
  assert.equal(typeof firstContent.text, "string");
  const approvalPreview = firstContent.text;
  assert.match(approvalPreview, /Plan submitted: Visible plan\./);
  assert.match(approvalPreview, /Review opens automatically after this turn settles\./);
  assert.match(approvalPreview, /Use \/plan review to reopen it/);
  assert.doesNotMatch(approvalPreview, /Objective|Expose the complete submitted plan before approval\.|Evidence|Execution steps:/);
  assert.ok("details" in submission && submission.details && typeof submission.details === "object");
  const details = submission.details as { planPath?: unknown };
  if (typeof details.planPath !== "string") throw new Error("Submitted Plan details must expose an artifact path.");
  assert.equal(approvalPreview.includes(details.planPath), false);
  assert.equal(harness.statuses.get("plan"), "Plan");
  assert.deepEqual(harness.widgets.get("plan"), ["· step-1 Implement and verify"]);

  const messagesBeforeResume = harness.sentMessages.length;
  const abortsBeforeResume = harness.abortCount;
  await harness.command("plan", "resume");
  assert.equal(harness.sentMessages.length, messagesBeforeResume);
  assert.equal(harness.abortCount, abortsBeforeResume);
  assert.equal(
    harness.notifications.at(-1)?.message,
    "The submitted plan needs /plan approve, /plan refine, or /plan cancel.",
  );

  await harness.command("plan", "approve");
  assert.equal(harness.statuses.get("plan"), undefined);
  assert.equal(harness.widgets.get("plan"), undefined);
  await harness.tool("update_plan_step", { id: "step-1", status: "inProgress" }, { toolCallId: "progress-1" });
  assert.ok(harness.getActiveTools().includes("update_plan_step"));
  await harness.tool("update_plan_step", { id: "step-1", status: "completed" }, { toolCallId: "progress-2" });
  assert.equal(harness.statuses.get("plan"), undefined);
  assert.equal(harness.widgets.get("plan"), undefined);
  assert.deepEqual(harness.getActiveTools(), [...originalTools, "ask", "todo"]);
});

test("/plan review reopens a submitted plan after Stay and can approve it", async () => {
  const harness = new ExtensionHarness();
  registerTestPlan(harness);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("plan");
  harness.clearPendingMessages();
  await harness.emit("agent_start", { type: "agent_start" });
  await harness.tool("submit_plan", {
    summary: "Review again",
    plan: [
      "## Objective",
      "",
      "Keep the complete submitted body recoverable in the review window.",
      "",
      ...Array.from({ length: 60 }, (_, index) => `Review detail line ${index + 1}`),
    ].join("\n"),
    steps: ["Review", "Execute"],
  });

  const messagesBeforeReview = harness.sentMessages.length;
  harness.setCustomResponses("Stay in plan mode");
  harness.setCustomInputs("\u001b[B", "\u001b[B", "\u001b[B", "\u001b[C");
  await harness.command("plan", "review");
  assert.equal(harness.customViews.length, 1);
  assert.match(harness.customViews[0].join("\n"), /Keep the complete submitted body recoverable/);
  assert.match(harness.customViews[0].join("\n"), /Stay in plan mode/);
  assert.match(harness.customViews[0].join("\n"), /Plan review.*Awaiting approval.*actions/);
  assert.match(harness.customViews[0].join("\n"), /Outline/);
  assert.match(harness.customViews[0].join("\n"), /█/);
  assert.match(harness.customViews[0].join("\n"), /░/);
  assert.match(harness.customViews[0].join("\n"), /Lines 4–/);
  assert.match(harness.customViews[0].join("\n"), /\u001b\[1m.*Refine plan/);
  assert.ok((harness.customViews[0].join("\n").match(/\u001b\[1m/g) ?? []).length >= 2, "title and selection use bold contrast");
  assert.match(harness.customViews[0].join("\n"), /\u001b\[32m/, "Execute uses success color");
  assert.match(harness.customViews[0].join("\n"), /\u001b\[31m/, "Cancel uses error color");
  assert.match(harness.customViews[0].join("\n"), /4\. Stay in plan mode/);
  assert.match(harness.customViews[0].join("\n"), /5\. Cancel plan/);
  assert.ok(harness.customViews[0].every((line) => visibleWidth(line) === 100), "every framed row fills the dialog width");
  assert.equal(harness.notifications.at(-1)?.message, "Plan remains awaiting approval.");
  assert.equal(harness.sentMessages.length, messagesBeforeReview);
  assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls", "ask"]);

  harness.setCustomResponses("Execute plan");
  await harness.command("plan", "review");
  assert.equal(harness.customViews.length, 2, "review can be reopened after choosing Stay");
  assert.equal(harness.sentMessages.length, messagesBeforeReview + 1);
  assert.ok(harness.getActiveTools().includes("update_plan_step"));
  assert.equal(harness.notifications.at(-1)?.message, "Plan approved; original tools restored and execution queued.");
});

test("a settled submitted turn opens review automatically and Copy keeps it open", async () => {
  const copiedTexts: string[] = [];
  const harness = new ExtensionHarness();
  registerTestPlan(harness, {
    copyText: async (text) => {
      copiedTexts.push(text);
    },
  });
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("plan");
  harness.clearPendingMessages();
  await harness.emit("agent_start", { type: "agent_start" });
  await harness.tool("submit_plan", {
    summary: "Automatically review",
    plan: "Copy this complete submitted Plan without closing its review window.",
    steps: ["Review", "Execute"],
  });

  assert.equal(harness.customViews.length, 0, "submit_plan remains nonblocking during tool execution");
  harness.setCustomResponses("Stay in plan mode");
  harness.setCustomInputs("\u001b[C", "\u001b[C", "\r");
  await harness.emit("agent_settled", { type: "agent_settled" });

  assert.equal(harness.customViews.length, 1, "the settled submitted turn opens review exactly once");
  assert.equal(harness.customCompletionStates[0], false, "Copy does not complete or close the review component");
  assert.equal(copiedTexts.length, 1);
  assert.match(copiedTexts[0], /Copy this complete submitted Plan/);
  assert.match(harness.customViews[0].join("\n").replace(/\u001b\[[0-9;]*m/g, ""), /⧉ 3\. Copy plan/);
  assert.match(harness.customViews[0].join("\n"), /c copy/);
  assert.equal(harness.notifications.at(-1)?.message, "Plan remains awaiting approval.");
  assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls", "ask"]);

  await harness.emit("agent_settled", { type: "agent_settled" });
  assert.equal(harness.customViews.length, 1, "later settled events do not reopen the same submission");
});

test("session-tree navigation reconciles Plan coordination regardless of extension load order", async () => {
  const harness = new ExtensionHarness();
  registerTestPlan(harness);
  goalExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("goal", "remain active across session-tree navigation");
  harness.clearPendingMessages();
  await harness.command("plan");
  assert.equal(harness.getActiveTools().includes("update_goal"), false);

  const goalEntries = harness.entries.filter((entry) => entry.customType === "goal-state-v1");
  harness.entries.splice(0, harness.entries.length, ...goalEntries);
  harness.clearPendingMessages();
  harness.setSessionId("session-2");
  await harness.emit("session_tree", { type: "session_tree" });

  assert.equal(harness.statuses.get("plan"), undefined);
  assert.equal(harness.widgets.get("plan"), undefined);
  assert.match(harness.statuses.get("goal") ?? "", /^Goal active/);
  assert.equal(harness.getActiveTools().includes("submit_plan"), false);
  assert.equal(harness.getActiveTools().includes("update_goal"), true);
});

test("tool failures reject instead of returning successful error-shaped results", async () => {
  const harness = new ExtensionHarness([], false);
  goalExtension(harness.api);
  registerTestPlan(harness);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });

  await assert.rejects(harness.tool("update_goal", { status: "complete" }), /No active goal/);
  await assert.rejects(harness.tool("submit_plan", {
    summary: "Invalid phase",
    plan: "Must not submit.",
    steps: ["No-op"],
  }), /planning phase/);

  await harness.tool("create_goal", { objective: "finish one goal" });
  await assert.rejects(harness.tool("create_goal", { objective: "replace silently" }), /unfinished goal/);
  harness.clearPendingMessages();

  await harness.command("plan");
  harness.clearPendingMessages();
  await harness.emit("agent_start", { type: "agent_start" });
  const entriesBeforeInvalidSubmission = harness.entries.length;
  await assert.rejects(harness.tool("submit_plan", {
    summary: "Oversized",
    plan: "🙂".repeat(11_000),
    steps: ["No-op"],
  }), /byte limit/);
  assert.equal(harness.entries.length, entriesBeforeInvalidSubmission);
  await assert.rejects(harness.tool("update_plan_step", { id: "step-1", status: "completed" }), /No approved plan/);
});

test("submit_plan returns without waiting and remains recoverable until an explicit command", async () => {
  const harness = new ExtensionHarness();
  registerTestPlan(harness);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("plan");
  harness.clearPendingMessages();
  await harness.emit("agent_start", { type: "agent_start" });

  const messagesBeforeSubmission = harness.sentMessages.length;
  const submission = await harness.tool("submit_plan", {
    summary: "Wait safely",
    plan: "Return this complete plan before waiting for explicit approval.",
    steps: ["Execute"],
  });

  assert.ok(submission && typeof submission === "object" && "terminate" in submission && submission.terminate === true);
  assert.equal(harness.sentMessages.length, messagesBeforeSubmission);
  assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls", "ask"]);
  assert.equal(harness.statuses.get("plan"), "Plan");
  assert.match(harness.widgets.get("plan")?.[0] ?? "", /^· step-1 Execute$/);

  await harness.command("plan", "approve");
  assert.ok(harness.getActiveTools().includes("update_plan_step"));
});

test("malformed latest journal entries do not resurrect earlier Goal or Plan state", async () => {
  const goalHarness = new ExtensionHarness();
  goalExtension(goalHarness.api);
  const goal = {
    version: 1,
    id: "goal-1",
    objective: "must not resurrect",
    status: "active",
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  goalHarness.entries.push(
    { type: "custom", customType: "goal-state-v1", data: { version: 1, action: "set", goal } },
    { type: "custom", customType: "goal-state-v1", data: { version: 2, action: "set", goal } },
  );
  await goalHarness.emit("session_start", { type: "session_start", reason: "startup" });
  assert.equal(goalHarness.widgets.get("goal"), undefined);
  assert.equal(goalHarness.getActiveTools().includes("update_goal"), false);
  assert.match(goalHarness.notifications.at(-1)?.message ?? "", /not restored safely/);

  const planHarness = new ExtensionHarness();
  registerTestPlan(planHarness);
  const state = {
    version: 1,
    phase: "planning",
    steps: [],
    enteredWithTools: ["read"],
    createdAt: 1,
    updatedAt: 1,
  };
  planHarness.entries.push(
    { type: "custom", customType: "plan-state-v1", data: { version: 1, action: "start", state } },
    { type: "custom", customType: "plan-state-v2", data: { version: 2, action: "start", state } },
  );
  await planHarness.emit("session_start", { type: "session_start", reason: "startup" });
  assert.equal(planHarness.widgets.get("plan"), undefined);
  assert.equal(planHarness.getActiveTools().includes("submit_plan"), false);
  assert.match(planHarness.notifications.at(-1)?.message ?? "", /not restored/);
});

test("Plan preserves observable external tool additions and removals", async () => {
  const harness = new ExtensionHarness(["read", "bash"]);
  registerTestPlan(harness);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("plan");

  harness.api.setActiveTools([...harness.getActiveTools(), "lsp", "external_writer"]);
  await harness.emit("before_agent_start", { type: "before_agent_start", systemPrompt: "base" });
  assert.equal(harness.getActiveTools().includes("lsp"), true);
  assert.equal(harness.getActiveTools().includes("external_writer"), false);

  harness.api.setActiveTools(harness.getActiveTools().filter((tool) => tool !== "read"));
  await harness.emit("before_agent_start", { type: "before_agent_start", systemPrompt: "base" });
  assert.equal(harness.getActiveTools().includes("read"), false);

  await harness.command("plan", "cancel");
  assert.deepEqual(harness.getActiveTools(), ["bash", "ask", "todo", "lsp", "external_writer"]);
});

test("artifact persistence failures roll back planning state and retry safely", async () => {
  const harness = new ExtensionHarness();
  const store = new InMemoryPlanArtifactStore();
  registerTestPlan(harness, { artifactStore: store });
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("plan");
  const submission = { summary: "Transactional", plan: "## Transactional", steps: ["Verify"] };
  const submitEntries = () => harness.entries.filter((entry) => {
    return entry.customType === "plan-state-v3"
      && entry.data && typeof entry.data === "object"
      && "action" in entry.data && entry.data.action === "submit";
  });

  store.failNextWrite(new Error("writer failed"));
  await assert.rejects(harness.tool("submit_plan", submission), /writer failed/);
  assert.equal(submitEntries().length, 0);
  assert.ok(harness.getActiveTools().includes("submit_plan"));

  store.returnNextPath("relative.md");
  await assert.rejects(harness.tool("submit_plan", submission), /must be absolute/);
  assert.deepEqual(store.discardedPaths, ["relative.md"]);
  assert.equal(submitEntries().length, 0);

  harness.failNextAppendEntry(new Error("append failed"));
  await assert.rejects(harness.tool("submit_plan", submission), /append failed/);
  assert.equal(submitEntries().length, 0);
  assert.equal(store.files.size, 0);
  assert.ok(harness.getActiveTools().includes("submit_plan"));
});

test("artifact persistence rejects concurrent and stale Plan submissions", async () => {
  const harness = new ExtensionHarness();
  const store = new InMemoryPlanArtifactStore();
  registerTestPlan(harness, { artifactStore: store });
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("plan");
  const submission = { summary: "Concurrent", plan: "## Concurrent", steps: ["Verify"] };
  const deferred = store.deferNextWrite();
  const first = harness.tool("submit_plan", submission);
  await Promise.resolve();
  await assert.rejects(harness.tool("submit_plan", submission), /A Plan submission is already being persisted\./);
  deferred.resolve();
  await first;
  const submitEntries = harness.entries.filter((entry) => {
    return entry.customType === "plan-state-v3"
      && entry.data && typeof entry.data === "object"
      && "action" in entry.data && entry.data.action === "submit";
  });
  assert.equal(submitEntries.length, 1);

  const staleHarness = new ExtensionHarness();
  const staleStore = new InMemoryPlanArtifactStore();
  registerTestPlan(staleHarness, { artifactStore: staleStore });
  await staleHarness.emit("session_start", { type: "session_start", reason: "startup" });
  await staleHarness.command("plan");
  const staleWrite = staleStore.deferNextWrite();
  const staleSubmission = staleHarness.tool("submit_plan", submission);
  await Promise.resolve();
  await staleHarness.command("plan", "cancel");
  staleWrite.resolve();
  await assert.rejects(staleSubmission, /Plan state changed while the submitted Plan was being persisted\./);
  assert.equal(staleStore.files.size, 0);
  assert.equal(
    staleHarness.entries.some((entry) => entry.customType === "plan-state-v3" && entry.data && typeof entry.data === "object" && "action" in entry.data && entry.data.action === "submit"),
    false,
  );
});

test("Todo update failures leave Plan execution active and permit a retry", async () => {
  const harness = new ExtensionHarness();
  let status: "pending" | "inProgress" | "completed" | "blocked" = "pending";
  let failUpdate = false;
  const todoService: TodoService = {
    lifetime: new AbortController().signal,
    execute() {
      throw new Error("Todo board is not used by Plan progress.");
    },
    syncPlanPhase() {},
    progress: {
      async open(request) {
        return { executionId: request.executionId, revision: 1, steps: [{ id: "step-1", status }] };
      },
      async read(request) {
        return { executionId: request.executionId, revision: 1, steps: [{ id: "step-1", status }] };
      },
      async update(request) {
        if (failUpdate) throw new Error("Todo update unavailable");
        status = request.status;
        return { executionId: request.executionId, revision: status === "pending" ? 1 : 2, steps: [{ id: "step-1", status }] };
      },
      async close() {},
    },
  };
  registerTestPlan(harness, { todoService });
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("plan");
  await harness.tool("submit_plan", {
    summary: "Transactional progress",
    plan: "Advance only after Todo commits progress.",
    steps: ["Verify"],
  });
  await harness.command("plan", "approve");
  assert.equal(harness.widgets.get("plan"), undefined, "Todo owns the managed progress projection");
  assert.equal(harness.statuses.get("plan"), undefined);

  failUpdate = true;
  await assert.rejects(
    harness.tool("update_plan_step", { id: "step-1", status: "inProgress" }),
    /Todo update unavailable/,
  );
  assert.equal(status, "pending");
  assert.ok(harness.getActiveTools().includes("update_plan_step"));

  failUpdate = false;
  await harness.tool("update_plan_step", { id: "step-1", status: "inProgress" });
  assert.equal(status, "inProgress");
  await harness.tool("update_plan_step", { id: "step-1", status: "completed" });
  assert.equal(status, "completed");
  assert.equal(harness.widgets.get("plan"), undefined);
  assert.equal(harness.getActiveTools().includes("update_plan_step"), false);
});

test("legacy v1 local progress restores and completes through the v3 journal", async () => {
  const harness = new ExtensionHarness(["read", "bash", "edit"]);
  registerTestPlan(harness);
  harness.entries.push({
    type: "custom",
    customType: "plan-state-v1",
    data: {
      version: 1,
      action: "approve",
      state: {
        version: 1,
        phase: "executing",
        summary: "Legacy execution",
        plan: "Finish restored work.",
        steps: [{ id: "step-1", text: "Verify", status: "inProgress" }],
        enteredWithTools: ["read", "bash", "edit"],
        createdAt: 1,
        updatedAt: 2,
      },
    },
  });
  await harness.emit("session_start", { type: "session_start", reason: "resume" });
  assert.deepEqual(harness.widgets.get("plan"), ["→ step-1 Verify"]);
  assert.ok(harness.getActiveTools().includes("update_plan_step"));

  await harness.tool("update_plan_step", { id: "step-1", status: "completed" });
  assert.equal(harness.widgets.get("plan"), undefined);
  assert.deepEqual(harness.getActiveTools(), ["read", "bash", "edit", "ask", "todo"]);
  assert.equal(harness.entries.at(-1)?.customType, "plan-state-v3");
  assert.deepEqual(harness.entries.at(-1)?.data, { version: 3, action: "complete", state: null });
});

test("Todo close failure cannot roll back a durable Plan cancellation", async () => {
  const originalTools = ["read", "bash", "edit"];
  const harness = new ExtensionHarness(originalTools);
  const todoService: TodoService = {
    lifetime: new AbortController().signal,
    execute() {
      throw new Error("Todo board is not used by Plan progress.");
    },
    syncPlanPhase() {},
    progress: {
      async open(request) {
        return {
          executionId: request.executionId,
          revision: 1,
          steps: [{ id: "step-1", status: "pending" }],
        };
      },
      async read(request) {
        return {
          executionId: request.executionId,
          revision: 1,
          steps: [{ id: "step-1", status: "pending" }],
        };
      },
      async update(request) {
        return {
          executionId: request.executionId,
          revision: 2,
          steps: [{ id: "step-1", status: request.status }],
        };
      },
      async close() {
        throw new Error("cleanup unavailable");
      },
    },
  };
  registerTestPlan(harness, { todoService });
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("plan");
  await harness.tool("submit_plan", {
    summary: "Cancelable Todo progress",
    plan: "Cancel safely.",
    steps: ["Verify"],
  });
  await harness.command("plan", "approve");
  assert.equal(harness.statuses.get("plan"), undefined);

  await harness.command("plan", "cancel");
  assert.equal(harness.statuses.get("plan"), undefined);
  assert.deepEqual(harness.getActiveTools(), [...originalTools, "ask"]);
  assert.ok(harness.notifications.some((notification) => notification.message.includes("Todo managed progress close failed after Plan exited: cleanup unavailable")));
  assert.deepEqual(harness.entries.at(-1)?.data, { version: 3, action: "cancel", state: null });
});
