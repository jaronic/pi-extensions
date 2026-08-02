import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import todoExtension, { installTodo, requestTodoService, TODO_SERVICE_CHANNEL } from "../src/index.ts";
import { TODO_STATE_TYPE, buildTodoStateEntry } from "../src/persistence.ts";
import { freezeTodoSnapshot } from "../src/state.ts";
import { TodoHarness } from "./harness.ts";

const BOARD_A = "00000000-0000-4000-8000-000000000041";
const BOARD_B = "00000000-0000-4000-8000-000000000042";

function install(harness: TodoHarness) {
  let timestamp = 100;
  let board = 0;
  return installTodo(harness.api, {
    now: () => ++timestamp,
    createBoardId: () => board++ === 0 ? BOARD_A : BOARD_B,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stateFrom(result: any): any {
  return result.details.state;
}

function sequenceFrom(result: any): number {
  return result.details.sequence;
}

test("registered tool executes the complete lifecycle with stable IDs and read-only queries", async () => {
  const harness = new TodoHarness();
  install(harness);
  await harness.startSession();

  const initialized = await harness.tool({
    op: "init",
    list: [
      { phase: "A", items: ["One", "Two"] },
      { phase: "B", items: ["Three"] },
    ],
    // OpenAI strict schemas send all known optional fields. They are harmless for init.
    id: 1,
    content: "ignored provider filler",
    items: ["ignored"],
    phase: "ignored",
    reason: "ignored",
    note: "ignored",
    includeClosed: true,
    offset: 0,
    limit: 50,
  });
  assert.equal(sequenceFrom(initialized), 1);
  assert.deepEqual(stateFrom(initialized).phases.flatMap((phase: any) => phase.tasks.map((task: any) => task.id)), [1, 2, 3]);

  const appended = await harness.tool({ op: "append", phase: "A", items: ["Four"] });
  assert.equal(sequenceFrom(appended), 2);
  assert.equal(stateFrom(appended).phases[0].tasks[2].id, 4);

  assert.equal(sequenceFrom(await harness.tool({ op: "start", id: 3 })), 3);
  assert.equal(sequenceFrom(await harness.tool({ op: "done", id: 3, note: "checked" })), 4);
  assert.equal(sequenceFrom(await harness.tool({ op: "edit", id: 1, content: "One revised" })), 5);
  assert.equal(sequenceFrom(await harness.tool({ op: "block", id: 1, reason: "external approval" })), 6);
  assert.equal(sequenceFrom(await harness.tool({ op: "drop", id: 4, reason: "scope removed" })), 7);
  assert.equal(sequenceFrom(await harness.tool({ op: "done", id: 2, note: null })), 8);
  assert.equal(sequenceFrom(await harness.tool({ op: "reopen", id: 1, reason: "approval received" })), 9);

  const got = await harness.tool({ op: "get", id: 1 });
  assert.equal(sequenceFrom(got), 9);
  assert.match(got.content[0].text, /One revised/);
  const viewed = await harness.tool({ op: "view", includeClosed: true, offset: 0, limit: 50 });
  assert.equal(sequenceFrom(viewed), 9);
  assert.match(viewed.content[0].text, /#4 Four \[dropped: scope removed\]/);
  const strictProviderView = await harness.tool({
    op: "view",
    list: null,
    phase: null,
    items: null,
    id: null,
    content: null,
    reason: null,
    note: null,
    includeClosed: true,
    offset: 0,
    limit: 50,
  });
  assert.equal(sequenceFrom(strictProviderView), 9);
  assert.match(strictProviderView.content[0].text, /#4 Four \[dropped: scope removed\]/);

  const settled = await harness.tool({ op: "done", id: 1, note: "final verification" });
  assert.equal(sequenceFrom(settled), 10);
  assert.equal(stateFrom(settled).phases.flatMap((phase: any) => phase.tasks).every(
    (task: any) => task.status === "completed" || task.status === "dropped",
  ), true);
  assert.equal(harness.setActiveToolsCount, 0, "Todo never mutates the host active-tool set");
  assert.equal(harness.getTool().executionMode, "sequential");
});

test("tool drop accepts an atomic id array with one shared reason", async () => {
  const harness = new TodoHarness();
  install(harness);
  await harness.startSession();
  await harness.tool({ op: "init", list: [{ phase: "A", items: ["One", "Two", "Three"] }] });

  const dropped = await harness.tool({ op: "drop", id: [1, 3], reason: "scope pivoted" });
  assert.equal(dropped.details.counts.dropped, 2);
  assert.deepEqual(dropped.details.changedTaskIds, [1, 3, 2]);
  assert.equal(stateFrom(dropped).phases[0].tasks[1].status, "inProgress");
  assert.match(String(dropped.content[0].text), /Dropped 2 Todo tasks: #1, #3\./);

  const sequenceBefore = sequenceFrom(dropped);
  await assert.rejects(
    harness.tool({ op: "drop", id: [2, 1], reason: "mixed" }),
    /pending, inProgress, or blocked/,
  );
  const view = await harness.tool({ op: "view" });
  assert.equal(sequenceFrom(view), sequenceBefore, "a rejected bulk drop consumes no sequence");
  assert.equal(view.details.counts.dropped, 2);
});

test("global Todo service shares the model-visible branch board and survives restart", async () => {
  const harness = new TodoHarness();
  install(harness);

  assert.equal(harness.getActiveTools().includes("todo"), true);
  const definition = harness.getTool();
  const description = definition.description;
  const promptSnippet = definition.promptSnippet;
  const promptGuidelines = definition.promptGuidelines;
  assert.equal(typeof description, "string");
  assert.equal(typeof promptSnippet, "string");
  assert.equal(Array.isArray(promptGuidelines), true);
  if (typeof description === "string") assert.match(description, /Globally available, branch-local Todo execution ledger/);
  if (typeof promptSnippet === "string") assert.match(promptSnippet, /execution-ready branch-local checklist/);
  if (Array.isArray(promptGuidelines)) assert.match(promptGuidelines.join("\n"), /whenever you judge a persistent checklist adds value/);
  assert.equal(harness.coordinationListenerCount(TODO_SERVICE_CHANNEL), 1);
  await assert.rejects(
    requestTodoService(harness.api, {
      sessionId: "todo-session",
      operation: { op: "view", includeClosed: true },
    }),
    /not ready for an active session/,
  );

  await harness.startSession();
  const initialized = await requestTodoService(harness.api, {
    sessionId: "todo-session",
    operation: { op: "init", list: [{ phase: "Delivery", items: ["Implement", "Verify"] }] },
  });
  assert.equal(initialized.details.sequence, 1);
  assert.equal(initialized.details.state?.phases[0]?.tasks[0]?.status, "inProgress");
  const journal = harness.entries.at(-1);
  assert.equal(isRecord(journal), true);
  if (!isRecord(journal)) return;
  assert.equal(journal.customType, TODO_STATE_TYPE);
  assert.equal(isRecord(journal.data), true);
  if (!isRecord(journal.data)) return;
  assert.deepEqual(
    { version: journal.data.version, source: journal.data.source, operation: journal.data.operation },
    { version: 2, source: "service", operation: "init" },
  );

  const entryCount = harness.entries.length;
  const serviceView = await requestTodoService(harness.api, {
    sessionId: "todo-session",
    operation: { op: "view", includeClosed: true, offset: 0, limit: 50 },
  });
  assert.equal(serviceView.details.sequence, 1);
  assert.match(serviceView.content, /#1 Implement/);
  assert.equal(harness.entries.length, entryCount, "service reads do not journal checkpoints");
  const toolView = await harness.tool({ op: "view", includeClosed: true, offset: 0, limit: 50 }, { persist: false });
  assert.deepEqual(toolView.details.state, serviceView.details.state);

  const restarted = new TodoHarness();
  restarted.replaceBranch(harness.entries);
  install(restarted);
  await restarted.startSession();
  const restored = await requestTodoService(restarted.api, {
    sessionId: "todo-session",
    operation: { op: "view", includeClosed: true },
  });
  assert.equal(restored.details.sequence, 1);
  assert.match(restored.content, /#2 Verify/);

  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  assert.equal(harness.coordinationListenerCount(TODO_SERVICE_CHANNEL), 0);
  await assert.rejects(
    requestTodoService(harness.api, { sessionId: "todo-session", operation: { op: "view" } }),
    /not loaded or not ready/,
  );
  await restarted.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
});

test("service settlement wins cancellation after a synchronous commit", async () => {
  const harness = new TodoHarness();
  install(harness);
  await harness.startSession();

  const controller = new AbortController();
  const committed = requestTodoService(harness.api, {
    sessionId: "todo-session",
    operation: { op: "init", list: [{ phase: "Delivery", items: ["Commit once"] }] },
    signal: controller.signal,
  });
  controller.abort(new Error("too late"));

  const result = await committed;
  assert.equal(result.details.sequence, 1);
  assert.equal(result.details.counts.total, 1);
  assert.equal(harness.entries.length, 1);
  const view = await requestTodoService(harness.api, {
    sessionId: "todo-session",
    operation: { op: "view", includeClosed: true },
  });
  assert.equal(view.details.sequence, 1);
  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
});

test("global Todo service preserves validation, abort, persistence, and Plan gates", async () => {
  const harness = new TodoHarness();
  const service = install(harness);
  await harness.startSession();
  await requestTodoService(harness.api, {
    sessionId: "todo-session",
    operation: { op: "init", list: [{ phase: "A", items: ["One"] }] },
  });

  const beforeFailure = harness.entries.length;
  harness.failNextAppend(new Error("service journal unavailable"));
  await assert.rejects(
    requestTodoService(harness.api, {
      sessionId: "todo-session",
      operation: { op: "append", phase: "A", items: ["Two"] },
    }),
    /service journal unavailable/,
  );
  const unchanged = await requestTodoService(harness.api, {
    sessionId: "todo-session",
    operation: { op: "view", includeClosed: true },
  });
  assert.equal(unchanged.details.sequence, 1);
  assert.equal(unchanged.details.counts.total, 1);
  assert.equal(harness.entries.length, beforeFailure);

  const controller = new AbortController();
  controller.abort(new Error("caller stopped"));
  await assert.rejects(
    requestTodoService(harness.api, {
      sessionId: "todo-session",
      operation: { op: "append", phase: "A", items: ["Two"] },
      signal: controller.signal,
    }),
    /caller stopped/,
  );
  await assert.rejects(
    requestTodoService(harness.api, {
      sessionId: "other-session",
      operation: { op: "view" },
    }),
    /different session/,
  );

  service.syncPlanPhase({ sessionId: "todo-session", phase: "planning" });
  const frozenView = await requestTodoService(harness.api, {
    sessionId: "todo-session",
    operation: { op: "view" },
  });
  assert.equal(frozenView.details.sequence, 1);
  await assert.rejects(
    requestTodoService(harness.api, {
      sessionId: "todo-session",
      operation: { op: "append", phase: "A", items: ["Two"] },
    }),
    /frozen while Plan is planning/,
  );
  service.syncPlanPhase({ sessionId: "todo-session", phase: "off" });
  const appended = await requestTodoService(harness.api, {
    sessionId: "todo-session",
    operation: { op: "append", phase: "A", items: ["Two"] },
  });
  assert.equal(appended.details.sequence, 2);
  assert.equal(appended.details.counts.total, 2);
  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
});

test("invalid, aborted, and sequence-overflow tool calls are atomic", async () => {
  const harness = new TodoHarness();
  install(harness);
  await harness.startSession();
  await harness.tool({ op: "init", list: [{ phase: "A", items: ["One", "Two"] }] });

  await assert.rejects(
    harness.tool({ op: "append", phase: "A", items: ["Duplicate", "Duplicate"] }),
    /unique within the call/,
  );
  await assert.rejects(harness.tool({ op: "done", id: 2 }), /current inProgress/);
  await assert.rejects(
    harness.tool({ op: "init", list: [{ phase: "B", items: ["Replacement"] }] }),
    /cannot replace an active or blocked board; continue with the existing #IDs/,
  );
  await assert.rejects(harness.tool({ op: "get", id: 99 }), /does not exist/);
  await assert.rejects(harness.tool({ op: "append", phase: "A" }), /missing a required field/);
  await assert.rejects(
    harness.tool({ op: "append", phase: null, items: ["Three"] }),
    /missing a required field/,
  );

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(harness.tool({ op: "done", id: 1 }, { signal: controller.signal }));

  let view = await harness.tool({ op: "view", includeClosed: true, offset: 0, limit: 50 });
  assert.equal(sequenceFrom(view), 1);
  assert.equal(stateFrom(view).phases[0].tasks[0].status, "inProgress");
  assert.equal(stateFrom(view).phases[0].tasks.length, 2);

  const maxSnapshot = freezeTodoSnapshot({ sequence: Number.MAX_SAFE_INTEGER, state: stateFrom(view) });
  harness.replaceBranch([{
    type: "custom",
    customType: TODO_STATE_TYPE,
    data: buildTodoStateEntry("command", "reopen", maxSnapshot),
  }]);
  await harness.emit("session_tree", { type: "session_tree" });
  await assert.rejects(harness.tool({ op: "done", id: 1 }), /sequence cannot be incremented safely/);
  view = await harness.tool({ op: "view", includeClosed: true, offset: 0, limit: 50 });
  assert.equal(sequenceFrom(view), Number.MAX_SAFE_INTEGER);
  assert.equal(stateFrom(view).revision, 1);
  assert.equal(stateFrom(view).phases[0].tasks[0].status, "inProgress");
});

test("tool result details replay across restart and session-tree navigation", async () => {
  const first = new TodoHarness();
  install(first);
  await first.startSession();
  await first.tool({ op: "init", list: [{ phase: "A", items: ["One", "Two"] }] });
  const afterInit = [...first.entries];
  await first.tool({ op: "done", id: 1 });

  const restarted = new TodoHarness();
  restarted.replaceBranch(first.entries);
  install(restarted);
  await restarted.startSession();
  let view = await restarted.tool({ op: "view", includeClosed: true, offset: 0, limit: 50 });
  assert.equal(sequenceFrom(view), 2);
  assert.equal(stateFrom(view).phases[0].tasks[0].status, "completed");
  assert.equal(stateFrom(view).phases[0].tasks[1].status, "inProgress");

  restarted.replaceBranch(afterInit);
  await restarted.emit("session_tree", { type: "session_tree" });
  view = await restarted.tool({ op: "view", includeClosed: true, offset: 0, limit: 50 });
  assert.equal(sequenceFrom(view), 1);
  assert.equal(stateFrom(view).phases[0].tasks[0].status, "inProgress");
  assert.equal(restarted.entries.filter((entry: any) => entry.type === "custom").length, 0);
});

test("compaction keeps the bounded prompt projection recoverable without duplicate injection", async () => {
  const harness = new TodoHarness();
  install(harness);
  await harness.startSession();
  await harness.tool({ op: "init", list: [{ phase: "A", items: ["One", "Two"] }] });

  const event = { type: "before_agent_start", systemPrompt: "BASE" };
  await harness.emit("before_agent_start", event);
  assert.equal((event.systemPrompt.match(/<untrusted_todo_state/g) ?? []).length, 1);
  assert.match(event.systemPrompt, /#1 \[inProgress\] One/);

  await harness.emit("session_compact", { type: "session_compact" });
  const compacted = { type: "before_agent_start", systemPrompt: "BASE" };
  await harness.emit("before_agent_start", compacted);
  assert.equal((compacted.systemPrompt.match(/<untrusted_todo_state/g) ?? []).length, 1);
  assert.equal(harness.entries.filter((entry: any) => entry.type === "custom").length, 0);

  await harness.tool({ op: "done", id: 1 });
  await harness.tool({ op: "done", id: 2 });
  const settled = { type: "before_agent_start", systemPrompt: "BASE" };
  await harness.emit("before_agent_start", settled);
  assert.equal(settled.systemPrompt, "BASE");
});

test("clear confirms after settling the agent and commits only after journal append succeeds", async () => {
  const harness = new TodoHarness();
  install(harness);
  await harness.startSession();
  await harness.tool({ op: "init", list: [{ phase: "A", items: ["One"] }] });

  harness.queueConfirm(false);
  await harness.command("todos", "clear");
  let view = await harness.tool({ op: "view", includeClosed: true, offset: 0, limit: 50 });
  assert.ok(stateFrom(view));
  assert.equal(harness.entries.filter((entry: any) => entry.type === "custom").length, 0);

  harness.queueConfirm(true);
  harness.failNextAppend(new Error("journal unavailable"));
  await assert.rejects(harness.command("todos", "clear"), /journal unavailable/);
  view = await harness.tool({ op: "view", includeClosed: true, offset: 0, limit: 50 });
  assert.ok(stateFrom(view), "failed persistence does not change in-memory state");

  harness.setIdle(false);
  harness.queueConfirm(true);
  await harness.command("todos", "clear");
  assert.deepEqual(harness.operations.slice(-3), ["abort", "wait", "append"]);
  view = await harness.tool({ op: "view", includeClosed: true, offset: 0, limit: 50 });
  assert.equal(stateFrom(view), null);
  assert.equal(harness.entries.filter((entry: any) => entry.type === "custom" && entry.customType === TODO_STATE_TYPE).length, 1);
});

test("clear is rejected when the board is appended during the confirmation window", async () => {
  const harness = new TodoHarness();
  install(harness);
  await harness.startSession();
  await harness.tool({ op: "init", list: [{ phase: "A", items: ["One"] }] });

  harness.queueConfirmEffect(async () => {
    await harness.tool({ op: "append", phase: "A", items: ["Two"] });
  });
  await harness.command("todos", "clear");
  let view = await harness.tool({ op: "view", includeClosed: true, offset: 0, limit: 50 });
  assert.equal(sequenceFrom(view), 2);
  assert.equal(stateFrom(view).phases[0].tasks.length, 2, "a stale clear must not wipe tasks appended during confirmation");
  assert.equal(harness.entries.filter((entry: any) => entry.type === "custom" && entry.customType === TODO_STATE_TYPE).length, 0);
  assert.match(harness.notifications.at(-1)?.message ?? "", /changed while confirming/);

  harness.queueConfirm(true);
  await harness.command("todos", "clear");
  view = await harness.tool({ op: "view", includeClosed: true, offset: 0, limit: 50 });
  assert.equal(stateFrom(view), null, "a fresh confirmation still clears the current board");
  assert.equal(harness.entries.filter((entry: any) => entry.type === "custom" && entry.customType === TODO_STATE_TYPE).length, 1);
});

test("clear is rejected when a new board is initialized during the confirmation window", async () => {
  const harness = new TodoHarness();
  install(harness);
  await harness.startSession();
  await harness.tool({ op: "init", list: [{ phase: "A", items: ["One"] }] });

  harness.queueConfirmEffect(async () => {
    await harness.tool({ op: "done", id: 1 });
    await harness.tool({ op: "init", list: [{ phase: "B", items: ["Fresh"] }] });
  });
  await harness.command("todos", "clear");
  const view = await harness.tool({ op: "view", includeClosed: true, offset: 0, limit: 50 });
  assert.ok(stateFrom(view), "a stale clear must not wipe a board initialized during confirmation");
  assert.equal(stateFrom(view).phases[0].name, "B");
  assert.equal(stateFrom(view).phases[0].tasks[0].content, "Fresh");
  assert.equal(harness.entries.filter((entry: any) => entry.type === "custom" && entry.customType === TODO_STATE_TYPE).length, 0);
  assert.match(harness.notifications.at(-1)?.message ?? "", /changed while confirming/);
});

test("reopen command parses a stable ID, interrupts streaming, and journals the transition", async () => {
  const harness = new TodoHarness();
  install(harness);
  await harness.startSession();
  await harness.tool({ op: "init", list: [{ phase: "A", items: ["One"] }] });
  await harness.tool({ op: "block", id: 1, reason: "waiting" });
  harness.setIdle(false);
  await harness.command("todos", "reopen 1 dependency arrived");
  assert.deepEqual(harness.operations.slice(-3), ["abort", "wait", "append"]);
  const view = await harness.tool({ op: "view", includeClosed: true, offset: 0, limit: 50 });
  assert.equal(stateFrom(view).phases[0].tasks[0].status, "inProgress");
  assert.equal(stateFrom(view).phases[0].tasks[0].statusDetail, "dependency arrived");
  await assert.rejects(harness.command("todos", "reopen 0 invalid"), /Usage|positive|safe integer/);
});

test("TUI widget controls, settled visibility, and semantic colors remain isolated", async () => {
  const harness = new TodoHarness({ terminalWidth: 16, terminalRows: 12 });
  harness.statuses.set("goal", "Goal stays");
  harness.widgets.set("plan", ["Plan stays"]);
  install(harness);
  await harness.startSession();
  await harness.tool({ op: "init", list: [{ phase: "A", items: ["A very long current task", "Second"] }] });
  assert.equal(harness.statuses.get("todo"), undefined);
  assert.ok(harness.widgets.get("todo"));
  assert.equal(harness.widgets.get("todo")?.every((line) => visibleWidth(line) <= 16), true);
  assert.equal(harness.statuses.get("goal"), "Goal stays");
  assert.deepEqual(harness.widgets.get("plan"), ["Plan stays"]);
  assert.equal(harness.themeColors.includes("accent"), true);

  await harness.command("todos", "hide");
  assert.equal(harness.widgets.get("todo"), undefined);
  await harness.command("todos", "show");
  assert.ok(harness.widgets.get("todo"));
  await harness.command("todos", "toggle");
  assert.equal(harness.widgets.get("todo"), undefined);
  await harness.command("todos", "toggle");
  assert.ok(harness.widgets.get("todo"));

  harness.queueCustomDialog("\u001b");
  await harness.command("todos", "status");
  const frame = harness.customFrames.at(-1);
  assert.ok(frame);
  assert.equal(frame.every((line) => visibleWidth(line) <= 16), true);

  await harness.tool({ op: "done", id: 1 });
  assert.ok(harness.widgets.get("todo"), "open board keeps the widget visible");
  const settledResult = await harness.tool({ op: "done", id: 2 });
  assert.equal(harness.widgets.get("todo"), undefined, "settled board clears the widget immediately");
  assert.equal(harness.statuses.get("todo"), undefined);
  assert.match(settledResult.content[0].text, /Todo board settled\./);
  assert.match(settledResult.content[0].text, /Settled recap:/);
  assert.match(settledResult.content[0].text, /✓ #1 A very long current task/);
  assert.match(settledResult.content[0].text, /✓ #2 Second/);
  await harness.emit("agent_start", { type: "agent_start" });
  assert.equal(harness.widgets.get("todo"), undefined);
  assert.equal(harness.statuses.get("todo"), undefined);
});

test("headless modes keep the tool usable and reject UI-only slash operations", async () => {
  for (const mode of ["print", "json"] as const) {
    const harness = new TodoHarness({ mode, hasUI: false });
    install(harness);
    await harness.startSession();
    const initialized = await harness.tool({ op: "init", list: [{ phase: "A", items: ["One"] }] });
    assert.equal(sequenceFrom(initialized), 1);
    assert.equal(harness.statuses.size, 0);
    assert.equal(harness.widgets.size, 0);
    await assert.rejects(harness.command("todos", "status"), /unavailable|requires/);
    await assert.rejects(harness.command("todos", "show"), /requires/);
    await assert.rejects(harness.command("todos", "clear"), /requires/);
  }

  const rpc = new TodoHarness({ mode: "rpc", hasUI: true });
  install(rpc);
  await rpc.startSession();
  await rpc.tool({ op: "init", list: [{ phase: "A", items: ["One"] }] });
  await rpc.command("todos", "status");
  assert.match(rpc.notifications.at(-1)?.message ?? "", /Todo board/);
});

test("future-version recovery hides supported projections, fails closed, and recovers on branch change", async () => {
  const seed = new TodoHarness();
  install(seed);
  await seed.startSession();
  await seed.tool({ op: "init", list: [{ phase: "A", items: ["One"] }] });

  const harness = new TodoHarness();
  harness.replaceBranch([
    ...seed.entries,
    { type: "custom", customType: "todo-state-v3", data: { version: 3 } },
  ]);
  const service = install(harness);
  assert.equal(harness.coordinationListenerCount(TODO_SERVICE_CHANNEL), 1);
  await harness.startSession();
  assert.equal(harness.statuses.get("todo"), undefined);
  assert.equal(harness.widgets.get("todo"), undefined);
  const blockedPrompt = { type: "before_agent_start", systemPrompt: "BASE" };
  await harness.emit("before_agent_start", blockedPrompt);
  assert.equal(blockedPrompt.systemPrompt, "BASE");
  await assert.rejects(harness.tool({ op: "view", includeClosed: true, offset: 0, limit: 50 }), /unsupported version v3/);
  await assert.rejects(harness.tool({ op: "init", list: [{ phase: "A", items: ["One"] }] }), /unsupported version v3/);
  await assert.rejects(harness.command("todos", "status"), /unsupported version v3/);

  harness.replaceBranch(seed.entries);
  await harness.emit("session_tree", { type: "session_tree" });
  const recovered = await harness.tool({ op: "view", includeClosed: true, offset: 0, limit: 50 });
  assert.equal(sequenceFrom(recovered), 1);
  assert.equal(harness.statuses.get("todo"), undefined);

  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  assert.equal(harness.coordinationListenerCount(TODO_SERVICE_CHANNEL), 0);
  assert.equal(service.lifetime.aborted, true);
  assert.equal(harness.statuses.get("todo"), undefined);
  assert.equal(harness.widgets.get("todo"), undefined);
  await seed.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
});

test("tool renderers provide compact, expanded, and error-safe semantic output", async () => {
  const harness = new TodoHarness();
  install(harness);
  await harness.startSession();
  const tool = harness.getTool() as any;
  const theme = harness.context.ui.theme;

  const callLines = tool.renderCall({ op: "init", list: [{ phase: "A", items: ["One", "Two"] }] }, theme).render(80);
  assert.match(callLines.join("\n"), /Todo.*init 2 items/);
  const result = await harness.tool({ op: "init", list: [{ phase: "A", items: ["One", "Two"] }] });
  const compact = tool.renderResult(result, { expanded: false }, theme, { isError: false }).render(80).join("\n");
  assert.match(compact, /✓.*#1 One/);
  const expanded = tool.renderResult(result, { expanded: true }, theme, { isError: false }).render(80).join("\n");
  assert.match(expanded, /Initialized Todo board with 2 tasks/);
  assert.match(expanded, /Phase: A\./);
  const failure = tool.renderResult(
    { content: [{ type: "text", text: "Todo failed safely" }], details: {} },
    { expanded: false },
    theme,
    { isError: true },
  ).render(80).join("\n");
  assert.match(failure, /Todo failed safely/);
  assert.equal(harness.themeColors.includes("toolTitle"), true);
  assert.equal(harness.themeColors.includes("success"), true);
  assert.equal(harness.themeColors.includes("error"), true);
});

test("slash command completions expose the documented surface", () => {
  const harness = new TodoHarness();
  install(harness);
  assert.deepEqual(harness.commandCompletions("todos", "re"), [{ value: "reopen", label: "reopen" }]);
  assert.deepEqual(harness.commandCompletions("todos", ""), [
    { value: "status", label: "status" },
    { value: "show", label: "show" },
    { value: "hide", label: "hide" },
    { value: "toggle", label: "toggle" },
    { value: "clear", label: "clear" },
    { value: "reopen", label: "reopen" },
  ]);
});

test("direct Todo service shares the compatibility board and fails closed after shutdown", async () => {
  const harness = new TodoHarness();
  const service = install(harness);
  assert.ok(Object.isFrozen(service));
  await harness.startSession();

  const initialized = service.execute({
    sessionId: "todo-session",
    operation: { op: "init", list: [{ phase: "Delivery", items: ["Implement"] }] },
  });
  assert.equal(initialized.details.sequence, 1);
  const compatible = await requestTodoService(harness.api, {
    sessionId: "todo-session",
    operation: { op: "view", includeClosed: true },
  });
  assert.equal(compatible.details.sequence, 1);
  assert.deepEqual(compatible.details.state, initialized.details.state);

  service.syncPlanPhase({ sessionId: "todo-session", phase: "awaitingApproval" });
  assert.throws(
    () => service.execute({
      sessionId: "todo-session",
      operation: { op: "append", phase: "Delivery", items: ["Verify"] },
    }),
    /frozen while Plan is awaitingApproval/,
  );
  assert.throws(
    () => service.syncPlanPhase({ sessionId: "todo-session", phase: "off", forged: true } as never),
    /unknown fields/,
  );
  service.syncPlanPhase({ sessionId: "todo-session", phase: "off" });

  await harness.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
  assert.equal(service.lifetime.aborted, true);
  assert.throws(
    () => service.execute({ sessionId: "todo-session", operation: { op: "view" } }),
    /shut down/,
  );
});

test("Plan handoff commits the transferred board and points execution at its #IDs", async () => {
  const harness = new TodoHarness();
  const service = install(harness);
  await harness.startSession();

  service.syncPlanPhase({ sessionId: "todo-session", phase: "awaitingApproval" });
  const handoff = service.handoffPlan({
    sessionId: "todo-session",
    phase: "Ship safely",
    items: ["Inspect", "Verify"],
  });
  assert.match(handoff.content, /Initialized Todo board with 2 tasks/);
  assert.match(handoff.content, /Approved Plan steps are already on this board/);
  assert.match(handoff.content, /instead of initializing a new board/);
  assert.equal(handoff.details.sequence, 1);
  service.syncPlanPhase({ sessionId: "todo-session", phase: "off" });

  const view = await requestTodoService(harness.api, {
    sessionId: "todo-session",
    operation: { op: "view", includeClosed: true },
  });
  assert.equal(view.details.sequence, 1);
  assert.deepEqual(
    stateFrom(view).phases.map((phase: { name: string }) => phase.name),
    ["Ship safely"],
  );
});

test("Plan handoff accepts steps of 240 emoji code points", async () => {
  const harness = new TodoHarness();
  const service = install(harness);
  await harness.startSession();

  service.syncPlanPhase({ sessionId: "todo-session", phase: "awaitingApproval" });
  const emoji = "😀".repeat(240);
  const handoff = service.handoffPlan({
    sessionId: "todo-session",
    phase: "Emoji steps",
    items: [emoji],
  });
  assert.equal(handoff.details.sequence, 1);
  assert.equal(handoff.details.state?.phases[0]?.tasks[0]?.content, emoji);
  assert.match(handoff.content, /Initialized Todo board with 1 tasks/);
  service.syncPlanPhase({ sessionId: "todo-session", phase: "off" });

  const view = await requestTodoService(harness.api, {
    sessionId: "todo-session",
    operation: { op: "view", includeClosed: true },
  });
  assert.equal(view.details.state?.phases[0]?.tasks[0]?.content, emoji);
});
