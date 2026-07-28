import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import goalExtension from "../../goal/src/index.ts";
import planExtension from "../src/index.ts";
import { blockedDecision, ExtensionHarness } from "./harness.ts";
import type { PlanExtensionDependencies } from "../src/index.ts";
import { InMemoryPlanArtifactStore } from "./harness.ts";
import type { TodoService, TodoToolDetails } from "pi-todo-dev";

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

test("Goal and Plan reject overlapping activation in either load order", async (t) => {
  for (const order of ["goal-first", "plan-first"] as const) {
    await t.test(order, async () => {
      const harness = new ExtensionHarness();
      if (order === "goal-first") {
        goalExtension(harness.api);
        registerTestPlan(harness);
      } else {
        registerTestPlan(harness);
        goalExtension(harness.api);
      }
      await harness.emit("session_start", { type: "session_start", reason: "startup" });

      await harness.command("goal", "ship safely");
      harness.clearPendingMessages();
      await harness.command("plan");
      assert.match(harness.statuses.get("goal") ?? "", /^Goal active/);
      assert.equal(harness.statuses.get("plan"), undefined);
      assert.equal(harness.notifications.at(-1)?.message, "Plan cannot start while Goal mode is active. Pause, complete, or clear Goal first.");

      await harness.command("goal", "pause");
      await harness.command("plan");
      assert.equal(harness.statuses.get("plan"), "Plan");
      assert.equal(harness.getActiveTools().includes("create_goal"), false);

      await harness.command("goal", "resume");
      assert.equal(harness.statuses.get("goal"), "Goal paused");
      assert.equal(harness.notifications.at(-1)?.message, "Goal cannot resume while Plan mode is active. Approve or cancel Plan first.");
      await assert.rejects(
        harness.tool("create_goal", { objective: "must not overlap" }),
        /Goal cannot start while Plan mode is active/,
      );

      await harness.command("plan", "cancel");
      await harness.command("goal", "resume");
      assert.match(harness.statuses.get("goal") ?? "", /^Goal active/);
      assert.equal(harness.statuses.get("plan"), undefined);
    });
  }
});

test("Plan approval exits Plan and creates an ordinary Todo board", async () => {
  const harness = new ExtensionHarness();
  registerTestPlan(harness);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("plan");
  await harness.tool("submit_plan", {
    summary: "Ship safely",
    plan: "Inspect, implement, and verify.",
    steps: ["Inspect", "Implement", "Verify"],
  });

  harness.clearPendingMessages();
  await harness.command("plan", "approve");

  assert.equal(harness.statuses.get("plan"), undefined);
  assert.equal(harness.widgets.get("plan"), undefined);
  assert.equal(harness.getActiveTools().includes("update_plan_step"), false);
  assert.equal(harness.getActiveTools().includes("todo"), true);
  assert.equal(harness.sentMessages.length, 1, "approval queues one execution turn");
  const execution = harness.sentMessages[0]?.message;
  assert.ok(execution && typeof execution === "object" && "customType" in execution);
  assert.equal(execution.customType, "plan-execution-v1");

  const viewed = await harness.tool("todo", { op: "view" });
  assert.ok(viewed && typeof viewed === "object" && "content" in viewed && Array.isArray(viewed.content));
  const text = viewed.content[0]?.text ?? "";
  assert.match(text, /→ #1 Inspect/);
  assert.match(text, /○ #2 Implement/);
  assert.match(text, /○ #3 Verify/);
});

test("starting Plan settles the current non-Goal agent without queuing a planning turn", async () => {
  const harness = new ExtensionHarness();
  registerTestPlan(harness);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  harness.setIdle(false);
  harness.deferWaitForIdle();

  const pendingPlanCommand = harness.command("plan");
  await Promise.resolve();
  assert.deepEqual(harness.agentOperations, ["abort", "wait"]);
  assert.equal(harness.sentMessages.length, 0);

  harness.releaseWaitForIdle();
  await pendingPlanCommand;
  assert.equal(harness.statuses.get("plan"), "Plan");
  assert.equal(harness.sentMessages.length, 0);
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

test("headless Plan waits for explicit approval and restores tools into Todo execution", async () => {
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
  assert.equal(harness.sentMessages.length, 0, "headless submission must not invent an approval choice");
  assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls", "ask"]);

  await harness.command("plan", "approve");
  assert.equal(harness.sentMessages.length, 1);
  assert.deepEqual(harness.getActiveTools(), [...originalTools, "ask", "todo"]);
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
  assert.deepEqual(harness.widgets.get("plan"), ["· 1. Implement and verify"]);

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
  assert.equal(harness.getActiveTools().includes("update_plan_step"), false);
  const todoView = await harness.tool("todo", { op: "view" });
  assert.ok(todoView && typeof todoView === "object" && "content" in todoView && Array.isArray(todoView.content));
  assert.match(todoView.content[0]?.text ?? "", /→ #1 Implement and verify/);
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
  assert.equal(harness.notifications.at(-1)?.message, "Plan remains awaiting approval. Send your change requests, then use /plan refine <feedback>; approve when no changes remain.");
  assert.equal(harness.sentMessages.length, messagesBeforeReview);
  assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls", "ask"]);

  harness.setCustomResponses("Execute plan");
  await harness.command("plan", "review");
  assert.equal(harness.customViews.length, 2, "review can be reopened after choosing Stay");
  assert.equal(harness.sentMessages.length, messagesBeforeReview + 1);
  assert.equal(harness.getActiveTools().includes("update_plan_step"), false);
  assert.equal(harness.getActiveTools().includes("todo"), true);
  assert.equal(harness.notifications.at(-1)?.message, "Plan approved; steps transferred to Todo, Plan exited, and execution queued.");
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
  assert.equal(harness.notifications.at(-1)?.message, "Plan remains awaiting approval. Send your change requests, then use /plan refine <feedback>; approve when no changes remain.");
  assert.deepEqual(harness.getActiveTools(), ["read", "grep", "find", "ls", "ask"]);

  await harness.emit("agent_settled", { type: "agent_settled" });
  assert.equal(harness.customViews.length, 1, "later settled events do not reopen the same submission");
});

test("restoring conflicting active Goal and Plan state pauses Goal regardless of load order", async (t) => {
  for (const order of ["goal-first", "plan-first"] as const) {
    await t.test(order, async (subtest) => {
      subtest.mock.timers.enable({ apis: ["setTimeout"] });
      const harness = new ExtensionHarness();
      if (order === "goal-first") {
        goalExtension(harness.api);
        registerTestPlan(harness);
      } else {
        registerTestPlan(harness);
        goalExtension(harness.api);
      }
      const goal = {
        version: 1,
        id: "goal-restored",
        objective: "restore safely",
        status: "active",
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
      };
      const plan = {
        version: 4,
        phase: "planning",
        steps: [],
        enteredWithTools: ["read"],
        createdAt: 1,
        updatedAt: 1,
      };
      harness.entries.push(
        { type: "custom", customType: "goal-state-v1", data: { version: 1, action: "set", goal } },
        { type: "custom", customType: "plan-state-v4", data: { version: 4, action: "start", state: plan } },
      );

      await harness.emit("session_start", { type: "session_start", reason: "startup" });
      subtest.mock.timers.tick(0);
      assert.equal(harness.statuses.get("plan"), "Plan");
      assert.equal(harness.statuses.get("goal"), "Goal paused");
      assert.equal(harness.getActiveTools().includes("update_goal"), false);
      assert.match(harness.notifications.at(-1)?.message ?? "", /Restored Goal was paused because Plan mode is active/);
      subtest.mock.timers.reset();
    });
  }
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
  await harness.command("goal", "pause");

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
  assert.match(harness.widgets.get("plan")?.[0] ?? "", /^· 1\. Execute$/);

  await harness.command("plan", "approve");
  assert.equal(harness.getActiveTools().includes("update_plan_step"), false);
  assert.equal(harness.getActiveTools().includes("todo"), true);
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
    return entry.customType === "plan-state-v4"
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
    return entry.customType === "plan-state-v4"
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
    staleHarness.entries.some((entry) => entry.customType === "plan-state-v4" && entry.data && typeof entry.data === "object" && "action" in entry.data && entry.data.action === "submit"),
    false,
  );
});

test("Todo handoff failures keep the submitted Plan recoverable and permit retry", async () => {
  const harness = new ExtensionHarness();
  let failHandoff = true;
  let handoffCalls = 0;
  const handoffPhases: string[] = [];
  const syncedPhases: string[] = [];
  const handoffState = {
    version: 1 as const,
    boardId: "todo-handoff",
    revision: 1,
    nextTaskId: 2,
    phases: [{
      name: "Plan",
      tasks: [{ id: 1, content: "Verify", status: "inProgress" as const, createdAt: 1, updatedAt: 1 }],
    }],
    createdAt: 1,
    updatedAt: 1,
  };
  const handoffDetails: TodoToolDetails = {
    kind: "pi-extensions:todo-tool-details",
    version: 1,
    sequence: 1,
    op: "init",
    boardId: "todo-handoff",
    revision: 1,
    changedTaskIds: [1],
    counts: { total: 1, pending: 0, inProgress: 1, blocked: 0, completed: 0, dropped: 0 },
    state: handoffState,
  };
  const todoService: TodoService = {
    lifetime: new AbortController().signal,
    execute() {
      throw new Error("Todo service execution is outside this test.");
    },
    handoffPlan(request) {
      handoffCalls += 1;
      handoffPhases.push(request.phase);
      if (failHandoff) throw new Error("Todo handoff unavailable");
      return {
        content: "Todo · Plan · 0/1 completed\n→ #1 Verify",
        details: handoffDetails,
      };
    },
    syncPlanPhase(input) {
      syncedPhases.push(input.phase);
    },
  };
  registerTestPlan(harness, { todoService });
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("plan");
  await harness.tool("submit_plan", {
    summary: "Transactional handoff",
    plan: "Transfer only after Todo commits the ordinary board.",
    steps: ["Verify"],
  });

  await assert.rejects(harness.command("plan", "approve"), /Todo handoff unavailable/);
  assert.equal(handoffCalls, 1);
  assert.equal(harness.statuses.get("plan"), "Plan");
  assert.equal(harness.sentMessages.length, 0);
  const rollbackEntry = harness.entries.at(-1)?.data;
  assert.ok(rollbackEntry && typeof rollbackEntry === "object");
  assert.equal("version" in rollbackEntry ? rollbackEntry.version : undefined, 4);
  assert.equal("action" in rollbackEntry ? rollbackEntry.action : undefined, "submit");
  assert.ok("state" in rollbackEntry && rollbackEntry.state && typeof rollbackEntry.state === "object");

  failHandoff = false;
  await harness.command("plan", "approve");
  assert.equal(handoffCalls, 2);
  assert.deepEqual(handoffPhases, ["Transactional handoff", "Transactional handoff"]);
  assert.equal(harness.statuses.get("plan"), undefined);
  assert.equal(harness.sentMessages.length, 1);
  assert.equal(syncedPhases.at(-1), "off");
});

test("legacy executing Plan journals restore as already handed off", async () => {
  const originalTools = ["read", "bash", "edit"];
  const harness = new ExtensionHarness(originalTools);
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
        enteredWithTools: originalTools,
        createdAt: 1,
        updatedAt: 2,
      },
    },
  });

  await harness.emit("session_start", { type: "session_start", reason: "resume" });
  assert.equal(harness.statuses.get("plan"), undefined);
  assert.equal(harness.widgets.get("plan"), undefined);
  assert.equal(harness.getActiveTools().includes("update_plan_step"), false);
  assert.deepEqual(harness.getActiveTools(), [...originalTools, "ask", "todo"]);
});
