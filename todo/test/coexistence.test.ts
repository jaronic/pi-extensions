import assert from "node:assert/strict";
import test from "node:test";
import goalExtension from "../../goal/src/index.ts";
import planExtension from "../../plan/src/index.ts";
import requestExtension from "../../request/src/index.ts";
import loopExtension from "../../loop/src/index.ts";
import todoExtension, { installTodo, TODO_SERVICE_CHANNEL, type TodoPhase, type TodoTask } from "../src/index.ts";
import { REQUEST_UI_CHANNEL } from "../../request/src/protocol.ts";
import { TodoHarness } from "./harness.ts";
const BOARD = "00000000-0000-4000-8000-000000000051";

function loadTodo(harness: TodoHarness): void {
  let now = 1;
  installTodo(harness.api, { now: () => ++now, createBoardId: () => BOARD });
}

function loadPlan(harness: TodoHarness): void {
  planExtension(harness.api, {
    copyText: async () => undefined,
    artifactStore: {
      write: async () => "/tmp/pi-extensions-plan-handoff.md",
      discard: async () => undefined,
      cleanupEphemeral: async () => undefined,
    },
  });
}

for (const order of ["plan-only", "dependencies-first", "plan-first"] as const) {
  test(`direct Plan dependency composition registers every shared surface once (${order})`, () => {
    const harness = new TodoHarness();
    if (order === "dependencies-first") {
      requestExtension(harness.api);
      todoExtension(harness.api);
      loadPlan(harness);
    } else if (order === "plan-first") {
      loadPlan(harness);
      requestExtension(harness.api);
      todoExtension(harness.api);
    } else {
      loadPlan(harness);
    }

    assert.deepEqual(
      [...harness.toolRegistrationCounts.entries()].sort(),
      [
        ["answer_plan_choice", 1],
        ["ask", 1],
        ["report_plan_blocked", 1],
        ["request_plan_choice", 1],
        ["submit_plan", 1],
        ["todo", 1],
      ],
    );
    assert.deepEqual([...harness.commandRegistrationCounts.entries()].sort(), [["plan", 1], ["todos", 1]]);
    assert.deepEqual([...harness.coordinationRegistrationCounts.entries()].sort(), [
      ["pi-extensions:exclusive-workflow:v1", 1],
      [REQUEST_UI_CHANNEL, 1],
      [TODO_SERVICE_CHANNEL, 1],
    ]);
    assert.deepEqual([...harness.lifecycleRegistrationCounts.entries()].sort(), [
      ["agent_settled", 1],
      ["agent_start", 1],
      ["before_agent_start", 2],
      ["context", 1],
      ["session_compact", 1],
      ["session_shutdown", 3],
      ["session_start", 3],
      ["session_tree", 2],
      ["tool_call", 1],
      ["tool_result", 1],
    ]);
  });
}

for (const order of ["todo-first", "plan-first"] as const) {
  test(`Plan coexistence freezes Todo mutation and restores it (${order})`, async () => {
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
    await harness.tool({ op: "init", list: [{ phase: "Todo", items: ["Inspect", "Implement"] }] });

    await harness.command("plan");
    assert.equal(harness.widgets.get("todo"), undefined);
    await assert.rejects(
      harness.tool({ op: "append", phase: "Todo", items: ["Forbidden duplicate tracking"] }),
      /frozen while Plan is planning/,
    );
    const read = await harness.tool({ op: "view", includeClosed: true, offset: 0, limit: 50 });
    assert.equal(read.details.sequence, 1);

    await harness.command("plan", "cancel");
    const appended = await harness.tool({ op: "append", phase: "Todo", items: ["Verify"] });
    assert.equal(appended.details.sequence, 2);
  });
}

for (const order of ["todo-first", "plan-first"] as const) {
  test(`approved Plan phases append to the ordinary Todo board (${order})`, async () => {
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
      summary: "Todo handoff",
      plan: "Inspect, then implement.",
      steps: ["Inspect", "Implement"],
    });
    await harness.command("plan", "approve");

    assert.equal(harness.statuses.get("plan"), undefined);
    assert.equal(harness.widgets.get("plan"), undefined);
    assert.ok(!harness.getActiveTools().includes("update_plan_step"));
    const widget = harness.widgets.get("todo")?.join("\n") ?? "";
    assert.match(widget, /Todo · Ordinary · 0\/3 completed/);
    assert.match(widget, /→.*#1.*Keep this board/);
    assert.match(widget, /○.*#2.*Inspect/);
    assert.match(widget, /○.*#3.*Implement/);

    const board = await harness.tool({ op: "view", includeClosed: true, offset: 0, limit: 50 });
    assert.equal(board.details.sequence, 2);
    assert.deepEqual(board.details.state?.phases.map((phase: TodoPhase) => phase.name), ["Ordinary", "Todo handoff"]);
    assert.deepEqual(
      board.details.state?.phases.flatMap((phase: TodoPhase) => phase.tasks.map((task: TodoTask) => [task.id, task.status])),
      [[1, "inProgress"], [2, "pending"], [3, "pending"]],
    );

    const prompt = { type: "before_agent_start", systemPrompt: "BASE" };
    await harness.emit("before_agent_start", prompt);
    assert.equal((prompt.systemPrompt.match(/<untrusted_todo_state/g) ?? []).length, 1);
    assert.equal(prompt.systemPrompt.includes("<untrusted_execution_progress"), false);

    await harness.tool({ op: "done", id: 1 });
    await harness.tool({ op: "done", id: 2 });
    await harness.tool({ op: "done", id: 3 });
    const settled = await harness.tool({ op: "view", includeClosed: true, offset: 0, limit: 50 });
    assert.equal(settled.details.counts.completed, 3);
  });
}

test("approved Todo handoff restores without reviving Plan execution", async () => {
  const original = new TodoHarness({ initialTools: ["read", "bash", "edit", "write"] });
  loadTodo(original);
  loadPlan(original);
  await original.startSession();
  await original.command("plan");
  await original.executeTool("submit_plan", {
    summary: "Reloadable handoff",
    plan: "Inspect, then verify.",
    steps: ["Inspect", "Verify"],
  });
  await original.command("plan", "approve");
  await original.tool({ op: "done", id: 1 });

  const restored = new TodoHarness({ initialTools: ["read", "bash", "edit", "write"] });
  restored.replaceBranch(original.entries);
  loadPlan(restored);
  loadTodo(restored);
  await restored.startSession("resume");

  assert.equal(restored.statuses.get("plan"), undefined);
  assert.equal(restored.widgets.get("plan"), undefined);
  assert.ok(!restored.getActiveTools().includes("update_plan_step"));
  const board = await restored.tool({ op: "view", includeClosed: true, offset: 0, limit: 50 });
  assert.deepEqual(
    board.details.state?.phases[0]?.tasks.map((task: TodoTask) => [task.content, task.status]),
    [["Inspect", "completed"], ["Verify", "inProgress"]],
  );
  const prompt = { type: "before_agent_start", systemPrompt: "BASE" };
  await restored.emit("before_agent_start", prompt);
  assert.match(prompt.systemPrompt, /#2 \[inProgress\] Verify/);
});

test("cancelling before approval leaves the ordinary Todo board unchanged", async () => {
  const harness = new TodoHarness({ initialTools: ["read", "bash", "edit", "write"] });
  loadTodo(harness);
  loadPlan(harness);
  await harness.startSession();
  await harness.tool({ op: "init", list: [{ phase: "Ordinary", items: ["Resume me"] }] });
  await harness.command("plan");
  await harness.executeTool("submit_plan", {
    summary: "Cancelled candidate",
    plan: "Do not transfer.",
    steps: ["Must not appear"],
  });
  await harness.command("plan", "cancel");

  const unchanged = await harness.tool({ op: "view", includeClosed: true, offset: 0, limit: 50 });
  assert.equal(unchanged.details.sequence, 1);
  assert.deepEqual(unchanged.details.state?.phases[0]?.tasks.map((task: TodoTask) => task.content), ["Resume me"]);
  const appended = await harness.tool({ op: "append", phase: "Ordinary", items: ["Continue"] });
  assert.equal(appended.details.sequence, 2);
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

test("Loop and Todo coexist without cross-talk", async () => {
  const harness = new TodoHarness();
  loadTodo(harness);
  loopExtension(harness.api);
  await harness.startSession();
  await harness.tool({ op: "init", list: [{ phase: "Todo", items: ["Inspect"] }] });
  await harness.command("loop", "2 fix the tests");

  assert.match(harness.statuses.get("loop") ?? "", /Loop 0\/2/);
  const read = await harness.tool({ op: "view", includeClosed: true, offset: 0, limit: 50 });
  assert.equal(read.details.sequence, 1, "Loop creation does not touch the Todo board");
  const appended = await harness.tool({ op: "append", phase: "Todo", items: ["Verify"] });
  assert.equal(appended.details.sequence, 2, "Todo mutations keep working while a Loop is active");
  assert.match(harness.widgets.get("loop")?.[0] ?? "", /Objective: fix the tests/);
});
