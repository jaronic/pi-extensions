import assert from "node:assert/strict";
import test from "node:test";
import goalExtension from "../../goal/src/index.ts";
import planExtension from "../../plan/src/index.ts";
import requestExtension from "../../request/src/index.ts";
import todoExtension from "../src/index.ts";
import { PLAN_COORDINATION_CHANNEL, type PlanCoordinationSignal } from "../src/protocol.ts";
import { TodoHarness } from "./harness.ts";

const BOARD = "00000000-0000-4000-8000-000000000051";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function loadTodo(harness: TodoHarness): void {
  let now = 1;
  todoExtension(harness.api, { now: () => ++now, createBoardId: () => BOARD });
}

function loadPlan(harness: TodoHarness): void {
  planExtension(harness.api, {
    copyText: async () => undefined,
    artifactStore: {
      write: async () => "/tmp/pi-extensions-managed-plan.md",
      discard: async () => undefined,
      cleanupEphemeral: async () => undefined,
    },
  });
}

function planSignal(sessionId: string, phase: PlanCoordinationSignal["phase"]): PlanCoordinationSignal {
  return {
    version: 1,
    sessionId,
    phase,
    readOnly: phase === "planning" || phase === "awaitingClarification" || phase === "awaitingApproval" || phase === "blocked",
    awaitingApproval: phase === "awaitingApproval",
    willTriggerTurn: false,
    reason: "test",
  };
}

for (const order of ["todo-first", "plan-first"] as const) {
  test(`Plan coexistence freezes Todo mutation and restores it (${order})`, async () => {
    const harness = new TodoHarness({
      initialTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    });
    if (order === "todo-first") {
      loadTodo(harness);
      planExtension(harness.api, { copyText: async () => undefined });
    } else {
      planExtension(harness.api, { copyText: async () => undefined });
      loadTodo(harness);
    }
    await harness.startSession();
    await harness.tool({ op: "init", list: [{ phase: "Todo", items: ["Inspect", "Implement"] }] });
    assert.ok(harness.getActiveTools().includes("todo"));
    assert.match(harness.statuses.get("todo") ?? "", /Todo 0\/2/);

    await harness.command("plan");
    assert.equal(harness.statuses.get("todo"), undefined);
    assert.equal(harness.widgets.get("todo"), undefined);
    await assert.rejects(
      harness.tool({ op: "append", phase: "Todo", items: ["Forbidden duplicate tracking"] }),
      /frozen while Plan is planning/,
    );
    const read = await harness.tool({ op: "view", includeClosed: true, offset: 0, limit: 50 });
    assert.equal(read.details.sequence, 1, "read-only Todo inspection remains internally safe");

    const event = { type: "before_agent_start", systemPrompt: "BASE" };
    await harness.emit("before_agent_start", event);
    assert.match(event.systemPrompt, /Plan mode is active in its read-only planning phase/);
    assert.equal(event.systemPrompt.includes("<untrusted_todo_state"), false);

    await harness.command("plan", "cancel");
    assert.ok(harness.getActiveTools().includes("todo"));
    assert.match(harness.statuses.get("todo") ?? "", /Todo 0\/2/);
    const appended = await harness.tool({ op: "append", phase: "Todo", items: ["Verify"] });
    assert.equal(appended.details.sequence, 2);
  });
}

for (const order of ["todo-first", "plan-first"] as const) {
  test(`Todo owns approved Plan progress without duplicating its ordinary board (${order})`, async () => {
    const harness = new TodoHarness({
      initialTools: ["read", "grep", "find", "ls", "bash", "edit", "write"],
    });
    if (order === "todo-first") {
      loadTodo(harness);
      loadPlan(harness);
    } else {
      loadPlan(harness);
      loadTodo(harness);
    }
    await harness.startSession();
    await harness.tool({ op: "init", list: [{ phase: "Ordinary", items: ["Keep this board"] }] });

    await harness.command("plan");
    await harness.executeTool("submit_plan", {
      summary: "Managed execution",
      plan: "Inspect, then implement.",
      steps: ["Inspect", "Implement"],
    });
    await harness.command("plan", "approve");

    assert.match(harness.statuses.get("plan") ?? "", /Plan · todo/);
    assert.match(harness.statuses.get("todo") ?? "", /Todo · Plan 0\/2/);
    assert.equal(harness.widgets.get("plan"), undefined, "Plan relinquishes its local progress widget");
    assert.match(harness.widgets.get("todo")?.join("\n") ?? "", /Todo · Plan · 0\/2 completed/);
    const prompt = { type: "before_agent_start", systemPrompt: "BASE" };
    await harness.emit("before_agent_start", prompt);
    assert.equal((prompt.systemPrompt.match(/<untrusted_execution_progress/g) ?? []).length, 1);
    assert.match(prompt.systemPrompt, /Mutable execution progress is owned by provider todo/);
    assert.match(prompt.systemPrompt, /step-1 \[pending\] Inspect/);
    assert.equal(prompt.systemPrompt.includes("<untrusted_todo_state"), false);

    await harness.executeTool("update_plan_step", { id: "step-1", status: "inProgress" }, { toolCallId: "progress-1" });
    assert.match(harness.statuses.get("todo") ?? "", /step-1 Inspect/);
    await harness.executeTool("update_plan_step", { id: "step-1", status: "completed" }, { toolCallId: "progress-2" });
    assert.match(harness.statuses.get("todo") ?? "", /Plan 1\/2/);
    await harness.executeTool("update_plan_step", { id: "step-2", status: "completed" }, { toolCallId: "progress-3" });

    assert.equal(harness.statuses.get("plan"), undefined);
    assert.match(harness.statuses.get("todo") ?? "", /Todo 0\/1/);
    assert.ok(harness.getActiveTools().includes("todo"));
    const ordinary = await harness.tool({ op: "view", includeClosed: true, offset: 0, limit: 50 });
    assert.equal(ordinary.details.sequence, 1);
    assert.equal(ordinary.details.state.phases[0]?.tasks[0]?.content, "Keep this board");
  });
}

test("managed Plan progress restores across reload before execution resumes", async () => {
  const original = new TodoHarness({ initialTools: ["read", "bash", "edit", "write"] });
  loadTodo(original);
  loadPlan(original);
  await original.startSession();
  await original.tool({ op: "init", list: [{ phase: "Ordinary", items: ["Keep after reload"] }] });
  await original.command("plan");
  await original.executeTool("submit_plan", {
    summary: "Reloadable execution",
    plan: "Inspect, then verify.",
    steps: ["Inspect", "Verify"],
  });
  await original.command("plan", "approve");
  await original.executeTool("update_plan_step", { id: "step-1", status: "completed" }, { toolCallId: "reload-step-1" });

  const restored = new TodoHarness({ initialTools: ["read", "bash", "edit", "write"] });
  restored.replaceBranch(original.entries);
  loadPlan(restored);
  loadTodo(restored);
  await restored.startSession("resume");
  assert.match(restored.statuses.get("plan") ?? "", /Plan · todo/);
  assert.match(restored.statuses.get("todo") ?? "", /Plan 1\/2/);
  assert.equal(restored.widgets.get("plan"), undefined);
  const prompt = { type: "before_agent_start", systemPrompt: "BASE" };
  await restored.emit("before_agent_start", prompt);
  assert.match(prompt.systemPrompt, /Counts: total=2 pending=1 inProgress=0 blocked=0 completed=1/);
  assert.match(prompt.systemPrompt, /step-2 \[pending\] Verify/);

  await restored.executeTool("update_plan_step", { id: "step-2", status: "completed" }, { toolCallId: "reload-step-2" });
  assert.equal(restored.statuses.get("plan"), undefined);
  assert.match(restored.statuses.get("todo") ?? "", /Todo 0\/1/);
  const ordinary = await restored.tool({ op: "view", includeClosed: true, offset: 0, limit: 50 });
  assert.equal(ordinary.details.state.phases[0]?.tasks[0]?.content, "Keep after reload");
});

test("restored external ownership fails closed when its provider is unavailable", async () => {
  const original = new TodoHarness({ initialTools: ["read", "bash", "edit", "write"] });
  loadTodo(original);
  loadPlan(original);
  await original.startSession();
  await original.command("plan");
  await original.executeTool("submit_plan", {
    summary: "Provider outage",
    plan: "Verify without changing ownership.",
    steps: ["Verify"],
  });
  await original.command("plan", "approve");

  const restored = new TodoHarness({ initialTools: ["read", "bash", "edit", "write"] });
  restored.replaceBranch(original.entries);
  loadPlan(restored);
  await restored.startSession("resume");
  await assert.rejects(
    restored.executeTool("update_plan_step", { id: "step-1", status: "completed" }, { toolCallId: "provider-missing" }),
    /Progress provider todo is unavailable/,
  );
  assert.match(restored.statuses.get("plan") ?? "", /Plan · todo/);
  assert.equal(restored.widgets.get("plan"), undefined);
  assert.ok(restored.getActiveTools().includes("update_plan_step"));
});

test("cancelling an externally tracked Plan closes Todo managed progress", async () => {
  const harness = new TodoHarness({ initialTools: ["read", "bash", "edit", "write"] });
  loadTodo(harness);
  loadPlan(harness);
  await harness.startSession();
  await harness.tool({ op: "init", list: [{ phase: "Ordinary", items: ["Resume me"] }] });
  await harness.command("plan");
  await harness.executeTool("submit_plan", {
    summary: "Cancelable execution",
    plan: "Inspect.",
    steps: ["Inspect"],
  });
  await harness.command("plan", "approve");
  assert.match(harness.statuses.get("todo") ?? "", /Todo · Plan 0\/1/);

  await harness.command("plan", "cancel");
  assert.equal(harness.statuses.get("plan"), undefined);
  assert.match(harness.statuses.get("todo") ?? "", /Todo 0\/1/);
  const managedEntries = harness.entries.filter(
    (entry) => isRecord(entry) && entry.type === "custom" && entry.customType === "todo-managed-progress-v1",
  );
  assert.equal(managedEntries.length, 2);
  const latestManaged = managedEntries.at(-1);
  assert.ok(isRecord(latestManaged));
  const latestManagedData = latestManaged.data;
  assert.ok(isRecord(latestManagedData));
  assert.equal(latestManagedData.state, null);
});

test("no-op /plan cancel resynchronizes stale Todo Plan state", async () => {
  const harness = new TodoHarness({ sessionId: "current" });
  loadTodo(harness);
  planExtension(harness.api, { copyText: async () => undefined });
  await harness.startSession();

  harness.api.events.emit(PLAN_COORDINATION_CHANNEL, planSignal("current", "awaitingApproval"));
  await harness.command("plan", "cancel");

  assert.equal(harness.notifications.at(-1)?.message, "Plan mode is already off.");
  const initialized = await harness.tool({ op: "init", list: [{ phase: "Todo", items: ["Create board"] }] });
  assert.equal(initialized.details.sequence, 1);
});

test("Todo ignores foreign-session Plan signals and reacts to current-session signals", async () => {
  const harness = new TodoHarness({ sessionId: "current" });
  loadTodo(harness);
  await harness.startSession();
  await harness.tool({ op: "init", list: [{ phase: "A", items: ["One"] }] });

  harness.api.events.emit(PLAN_COORDINATION_CHANNEL, planSignal("other", "planning"));
  const edited = await harness.tool({ op: "edit", id: 1, content: "Still mutable" });
  assert.equal(edited.details.sequence, 2);

  harness.api.events.emit(PLAN_COORDINATION_CHANNEL, planSignal("current", "awaitingApproval"));
  harness.api.events.emit(PLAN_COORDINATION_CHANNEL, planSignal("other", "planning"));
  await harness.emit("session_tree", { type: "session_tree" });
  await assert.rejects(harness.tool({ op: "done", id: 1 }), /frozen while Plan is awaitingApproval/);
  assert.equal(harness.statuses.get("todo"), undefined);

  harness.api.events.emit(PLAN_COORDINATION_CHANNEL, planSignal("current", "blocked"));
  await assert.rejects(harness.tool({ op: "done", id: 1 }), /frozen while Plan is blocked/);

  harness.api.events.emit(PLAN_COORDINATION_CHANNEL, planSignal("current", "off"));
  const completed = await harness.tool({ op: "done", id: 1 });
  assert.equal(completed.details.sequence, 3);
});

test("clear confirmation behaves identically with and without Request adapters", async (t) => {
  await t.test("native confirm", async () => {
    const harness = new TodoHarness();
    loadTodo(harness);
    await harness.startSession();
    await harness.tool({ op: "init", list: [{ phase: "A", items: ["One"] }] });
    harness.queueConfirm(true);
    await harness.command("todos", "clear");
    const view = await harness.tool({ op: "view", includeClosed: true, offset: 0, limit: 50 });
    assert.equal(view.details.state, null);
  });

  await t.test("Request unified confirm", async () => {
    const harness = new TodoHarness();
    loadTodo(harness);
    requestExtension(harness.api);
    await harness.startSession();
    await harness.tool({ op: "init", list: [{ phase: "A", items: ["One"] }] });
    harness.queueCustomDialog("\r");
    await harness.command("todos", "clear");
    const view = await harness.tool({ op: "view", includeClosed: true, offset: 0, limit: 50 });
    assert.equal(view.details.state, null);
    assert.match(harness.customFrames.flat().join("\n"), /Clear Todo board/);
  });
});

test("Goal and Todo inject one independent prompt projection and retain separate lifecycles", async () => {
  const harness = new TodoHarness();
  goalExtension(harness.api);
  loadTodo(harness);
  await harness.startSession();
  await harness.executeTool("create_goal", {
    objective: "Keep the long-running release objective active until separately verified.",
    tokenBudget: 10_000,
  });
  await harness.tool({ op: "init", list: [{ phase: "Current turn", items: ["Inspect", "Verify"] }] });
  assert.ok(harness.getActiveTools().includes("todo"));

  const event = { type: "before_agent_start", systemPrompt: "BASE" };
  await harness.emit("before_agent_start", event);
  assert.equal((event.systemPrompt.match(/<untrusted_objective>/g) ?? []).length, 1);
  assert.equal((event.systemPrompt.match(/<untrusted_todo_state/g) ?? []).length, 1);

  await harness.tool({ op: "done", id: 1 });
  await harness.tool({ op: "done", id: 2 });
  const goal = await harness.executeTool("get_goal", {});
  assert.equal(goal.details.goal.status, "active", "settling Todo does not complete Goal");
  const afterTodo = { type: "before_agent_start", systemPrompt: "BASE" };
  await harness.emit("before_agent_start", afterTodo);
  assert.equal((afterTodo.systemPrompt.match(/<untrusted_objective>/g) ?? []).length, 1);
  assert.equal(afterTodo.systemPrompt.includes("<untrusted_todo_state"), false);
});
