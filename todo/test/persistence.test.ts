import assert from "node:assert/strict";
import test from "node:test";
import {
  TODO_STATE_TYPE,
  TODO_TOOL_DETAILS_KIND,
  buildTodoStateEntry,
  buildTodoToolDetails,
  decodeTodoStateEntry,
  decodeTodoToolDetails,
  restoreTodoSnapshot,
} from "../src/persistence.ts";
import { freezeTodoSnapshot, transitionTodo, type TodoSnapshot } from "../src/state.ts";
import type { TodoOperation } from "../src/output.ts";

const BOARD = "00000000-0000-4000-8000-000000000011";

function snapshots(): { initial: TodoSnapshot; completed: TodoSnapshot } {
  const initialized = transitionTodo(
    null,
    { op: "init", list: [{ phase: "Delivery", items: ["Implement", "Verify"] }] },
    10,
    () => BOARD,
  ).state;
  assert.ok(initialized);
  const initial = freezeTodoSnapshot({ sequence: 1, state: initialized });
  const done = transitionTodo(initialized, { op: "done", id: 1, note: "checked" }, 20, () => BOARD).state;
  assert.ok(done);
  return { initial, completed: freezeTodoSnapshot({ sequence: 2, state: done }) };
}

function toolEntry(snapshot: TodoSnapshot, op: TodoOperation = "init", changedTaskIds: number[] = []): unknown {
  return {
    type: "message",
    message: {
      role: "toolResult",
      toolName: "todo",
      isError: false,
      details: buildTodoToolDetails(snapshot, op, changedTaskIds),
    },
  };
}

function stateEntry(snapshot: TodoSnapshot, operation: "clear" | "reopen" = "reopen"): unknown {
  return { type: "custom", customType: TODO_STATE_TYPE, data: buildTodoStateEntry("command", operation, snapshot) };
}

test("tool details and v2 state entries decode to frozen canonical state", () => {
  const { completed } = snapshots();
  const details = decodeTodoToolDetails(JSON.parse(JSON.stringify(buildTodoToolDetails(completed, "done", [1]))));
  assert.equal(details.kind, "valid");
  if (details.kind !== "valid") return;
  assert.equal(details.value.version, 1);
  assert.equal(details.value.op, "done");
  assert.deepEqual(details.value.changedTaskIds, [1]);
  assert.equal(Object.isFrozen(details.value), true);
  assert.equal(Object.isFrozen(details.value.state?.phases[0]?.tasks[0]), true);

  const entry = decodeTodoStateEntry(JSON.parse(JSON.stringify(buildTodoStateEntry("command", "reopen", completed))));
  assert.equal(entry.kind, "valid");
  if (entry.kind === "valid") {
    assert.equal(entry.value.version, 2);
    assert.equal(entry.value.source, "command");
    assert.equal(entry.value.operation, "reopen");
    assert.equal(Object.isFrozen(entry.value.state), true);
  }
});

test("strict persisted decoders reject unknown fields, malformed bounds, and foreign details", () => {
  const { initial, completed } = snapshots();
  const details = { ...buildTodoToolDetails(initial, "init", []), extra: true };
  assert.equal(decodeTodoToolDetails(details).kind, "malformed");
  assert.equal(decodeTodoToolDetails({ kind: "someone-else", version: 1 }).kind, "foreign");
  assert.deepEqual(decodeTodoToolDetails({ kind: TODO_TOOL_DETAILS_KIND, version: 2 }), { kind: "unsupported", version: 2 });
  assert.equal(decodeTodoStateEntry({ ...buildTodoStateEntry("command", "reopen", initial), sequence: -1 }).kind, "malformed");
  assert.equal(decodeTodoStateEntry({ version: 2 }).kind, "malformed");
  assert.equal(decodeTodoStateEntry({ ...buildTodoStateEntry("command", "reopen", initial), extra: true }).kind, "malformed");
  assert.equal(decodeTodoStateEntry({ ...buildTodoStateEntry("command", "reopen", initial), operation: "init" }).kind, "malformed");
  assert.equal(decodeTodoStateEntry({ ...buildTodoStateEntry("service", "init", initial), operation: "clear" }).kind, "malformed");
  const malformedSuccess = restoreTodoSnapshot([
    toolEntry(initial),
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "todo",
        isError: "false",
        details: buildTodoToolDetails(completed, "done", [1]),
      },
    },
  ]);
  assert.equal(malformedSuccess.snapshot.sequence, 1);
  assert.match(malformedSuccess.warning ?? "", /ignored/);
});

test("restore chooses the highest valid sequence across tool details and custom entries", () => {
  const { initial, completed } = snapshots();
  const branch = [
    toolEntry(completed, "done", [1]),
    { type: "message", message: { role: "toolResult", toolName: "todo", isError: true, details: buildTodoToolDetails(initial, "init", []) } },
    stateEntry(initial),
    { type: "custom", customType: TODO_STATE_TYPE, data: { bad: true } },
    { type: "message", message: { role: "toolResult", toolName: "other", isError: false, details: buildTodoToolDetails(initial, "init", []) } },
  ];
  const restored = restoreTodoSnapshot(branch);
  assert.equal(restored.snapshot.sequence, 2);
  assert.equal(restored.snapshot.state?.phases[0]?.tasks[0]?.status, "completed");
  assert.match(restored.warning ?? "", /ignored/);
});

test("restore ignores malformed newer records and warns on equal-sequence conflicts", () => {
  const { initial, completed } = snapshots();
  const malformedNewer = {
    ...buildTodoToolDetails(completed, "done", [1]),
    sequence: 999,
    state: { invalid: true },
  };
  const fallback = restoreTodoSnapshot([
    toolEntry(initial),
    { type: "message", message: { role: "toolResult", toolName: "todo", isError: false, details: malformedNewer } },
  ]);
  assert.equal(fallback.snapshot.sequence, 1);
  assert.match(fallback.warning ?? "", /ignored/);

  const conflictSnapshot = freezeTodoSnapshot({ sequence: 1, state: completed.state });
  const conflict = restoreTodoSnapshot([stateEntry(initial), stateEntry(conflictSnapshot)]);
  assert.equal(conflict.snapshot.state?.phases[0]?.tasks[0]?.status, "inProgress");
  assert.match(conflict.warning ?? "", /conflicted/);

  const duplicate = restoreTodoSnapshot([stateEntry(initial), stateEntry(initial)]);
  assert.equal(duplicate.warning, undefined);
  assert.equal(duplicate.snapshot.sequence, 1);
});

test("restore migrates legacy v1 command entries and accepts current v2 service entries", () => {
  const { initial, completed } = snapshots();
  const restored = restoreTodoSnapshot([
    {
      type: "custom",
      customType: "todo-state-v1",
      data: { version: 1, sequence: initial.sequence, action: "reopen", state: initial.state },
    },
    {
      type: "custom",
      customType: TODO_STATE_TYPE,
      data: buildTodoStateEntry("service", "done", completed),
    },
  ]);
  assert.equal(restored.snapshot.sequence, 2);
  assert.equal(restored.snapshot.state?.phases[0]?.tasks[0]?.status, "completed");
  assert.equal(restored.warning, undefined);
});

test("future persisted versions block mutation while retaining the latest supported snapshot", () => {
  const { initial } = snapshots();
  const restored = restoreTodoSnapshot([
    toolEntry(initial),
    { type: "custom", customType: "todo-state-v3", data: { version: 3 } },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "todo",
        isError: false,
        details: { kind: TODO_TOOL_DETAILS_KIND, version: 3 },
      },
    },
  ]);
  assert.equal(restored.snapshot.sequence, 1);
  assert.match(restored.blockedReason ?? "", /unsupported version v3/);
});

test("branch replacement naturally recovers forked, navigated, and empty histories", () => {
  const { initial, completed } = snapshots();
  assert.equal(restoreTodoSnapshot([toolEntry(initial), toolEntry(completed, "done", [1])]).snapshot.sequence, 2);
  const forked = restoreTodoSnapshot([toolEntry(initial)]);
  assert.equal(forked.snapshot.sequence, 1);
  assert.equal(forked.snapshot.state?.phases[0]?.tasks[0]?.status, "inProgress");
  assert.deepEqual(restoreTodoSnapshot([]).snapshot, { sequence: 0, state: null });
});
