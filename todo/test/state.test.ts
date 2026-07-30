import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_TODO_TASKS,
  decodeTodoState,
  findTodoTask,
  todoBoardStatus,
  todoCounts,
  transitionTodo,
  type TodoState,
} from "../src/state.ts";

const BOARD_A = "00000000-0000-4000-8000-000000000001";
const BOARD_B = "00000000-0000-4000-8000-000000000002";

function initState(
  list: Array<{ phase: string; items: string[] }> = [{ phase: "Implementation", items: ["Inspect", "Implement", "Verify"] }],
  boardId = BOARD_A,
  now = 100,
): TodoState {
  const transition = transitionTodo(null, { op: "init", list }, now, () => boardId);
  assert.ok(transition.state);
  return transition.state;
}

function task(state: TodoState, id: number) {
  const found = findTodoTask(state, id)?.task;
  assert.ok(found, `missing task #${id}`);
  return found;
}

function clone(value: unknown): any {
  return JSON.parse(JSON.stringify(value));
}

function rejectionReason(value: unknown): string {
  const decoded = decodeTodoState(value);
  assert.equal(decoded.ok, false);
  return decoded.ok ? "" : decoded.reason;
}

test("init preserves every explicit item, assigns stable IDs, and starts the first task", () => {
  const state = initState([
    { phase: "Discovery", items: ["Inspect API", "Inspect tests"] },
    { phase: "Delivery", items: ["Implement", "Verify"] },
  ]);

  assert.deepEqual(state.phases.map((phase) => phase.tasks.map((item) => item.content)), [
    ["Inspect API", "Inspect tests"],
    ["Implement", "Verify"],
  ]);
  assert.deepEqual(state.phases.flatMap((phase) => phase.tasks.map((item) => item.id)), [1, 2, 3, 4]);
  assert.equal(task(state, 1).status, "inProgress");
  assert.deepEqual([task(state, 2).status, task(state, 3).status, task(state, 4).status], ["pending", "pending", "pending"]);
  assert.equal(state.nextTaskId, 5);
  assert.equal(state.revision, 1);
  assert.equal(todoBoardStatus(state), "active");
});

test("init accepts exactly 100 tasks and rejects 101 without truncation", () => {
  const hundred = Array.from({ length: MAX_TODO_TASKS }, (_, index) => `Task ${index + 1}`);
  const state = initState([{ phase: "Full scope", items: hundred }]);
  assert.equal(todoCounts(state).total, 100);
  assert.equal(state.phases[0]?.tasks.at(-1)?.content, "Task 100");

  const oversized = [...hundred, "Task 101"];
  assert.throws(
    () => transitionTodo(null, { op: "init", list: [{ phase: "Too much", items: oversized }] }, 100, () => BOARD_A),
    /1 to 100 tasks|100 task limit/,
  );
});

test("init rejects open boards and creates a new generation after settlement", () => {
  const first = initState([{ phase: "One", items: ["Ship"] }]);
  assert.throws(
    () => transitionTodo(first, { op: "init", list: [{ phase: "Replacement", items: ["Wrong"] }] }, 101, () => BOARD_B),
    /cannot replace an active or blocked board/,
  );
  const completed = transitionTodo(first, { op: "done", id: 1, note: "verified" }, 102, () => BOARD_B).state;
  assert.ok(completed);
  assert.equal(todoBoardStatus(completed), "settled");
  const replacement = transitionTodo(
    completed,
    { op: "init", list: [{ phase: "New", items: ["Fresh"] }] },
    103,
    () => BOARD_B,
  ).state;
  assert.ok(replacement);
  assert.equal(replacement.boardId, BOARD_B);
  assert.equal(replacement.revision, 1);
  assert.equal(task(replacement, 1).content, "Fresh");
  assert.equal(findTodoTask(replacement, 2), undefined);
});

test("append extends existing and new phases atomically without consuming IDs on failure", () => {
  const initial = initState([{ phase: "A", items: ["One"] }]);
  const appended = transitionTodo(initial, { op: "append", phase: "A", items: ["Two", "Three"] }, 110, () => BOARD_A);
  assert.ok(appended.state);
  assert.deepEqual(appended.effect, { kind: "appended", ids: [2, 3] });
  assert.deepEqual(appended.state.phases[0]?.tasks.map((item) => item.id), [1, 2, 3]);
  const withPhase = transitionTodo(appended.state, { op: "append", phase: "B", items: ["Four"] }, 111, () => BOARD_A).state;
  assert.ok(withPhase);
  assert.deepEqual(withPhase.phases.map((phase) => phase.name), ["A", "B"]);
  assert.equal(withPhase.nextTaskId, 5);

  assert.throws(
    () => transitionTodo(withPhase, { op: "append", phase: "B", items: ["Duplicate", "Duplicate"] }, 112, () => BOARD_A),
    /unique within the call/,
  );
  assert.equal(withPhase.nextTaskId, 5);
  assert.equal(todoCounts(withPhase).total, 4);
});

test("append revives a settled board with continuous IDs and preserved history", () => {
  const initial = initState([{ phase: "A", items: ["One", "Two"] }]);
  const doneState = transitionTodo(initial, { op: "done", id: 1 }, 101, () => BOARD_A).state;
  assert.ok(doneState);
  const settled = transitionTodo(doneState, { op: "drop", id: 2, reason: "out of scope" }, 102, () => BOARD_A).state;
  assert.ok(settled);
  assert.equal(todoBoardStatus(settled), "settled");

  const revived = transitionTodo(settled, { op: "append", phase: "B", items: ["Three"] }, 103, () => BOARD_A);
  assert.ok(revived.state);
  assert.deepEqual(revived.effect, { kind: "appended", ids: [3] });
  assert.equal(revived.state.boardId, BOARD_A);
  assert.equal(revived.state.nextTaskId, 4);
  assert.equal(todoBoardStatus(revived.state), "active");
  assert.equal(task(revived.state, 1).status, "completed");
  assert.equal(task(revived.state, 2).status, "dropped");
  assert.equal(task(revived.state, 3).status, "inProgress");
});

test("drop applies id arrays atomically with a shared reason", () => {
  const initial = initState([{ phase: "A", items: ["One", "Two"] }, { phase: "B", items: ["Three", "Four"] }]);
  const bulk = transitionTodo(initial, { op: "drop", id: [1, 3], reason: "scope pivoted" }, 101, () => BOARD_A);
  assert.ok(bulk.state);
  assert.deepEqual(bulk.effect, { kind: "bulkDropped", ids: [1, 3] });
  assert.deepEqual(bulk.changedTaskIds, [1, 3, 2]);
  assert.equal(task(bulk.state, 1).status, "dropped");
  assert.equal(task(bulk.state, 1).statusDetail, "scope pivoted");
  assert.equal(task(bulk.state, 3).status, "dropped");
  assert.equal(task(bulk.state, 3).statusDetail, "scope pivoted");
  assert.equal(task(bulk.state, 2).status, "inProgress");

  const single = transitionTodo(bulk.state, { op: "drop", id: 4, reason: "not needed" }, 102, () => BOARD_A);
  assert.deepEqual(single.effect, { kind: "statusChanged", id: 4, from: "pending", to: "dropped" });
  assert.ok(single.state);

  // One closed, missing, or duplicated target rejects the whole call without
  // consuming a revision or changing any task.
  const revisionBefore = single.state.revision;
  assert.throws(
    () => transitionTodo(single.state, { op: "drop", id: [2, 1], reason: "mixed" }, 103, () => BOARD_A),
    /pending, inProgress, or blocked/,
  );
  assert.throws(
    () => transitionTodo(single.state, { op: "drop", id: [2, 99], reason: "missing" }, 103, () => BOARD_A),
    /#99 does not exist/,
  );
  assert.throws(
    () => transitionTodo(single.state, { op: "drop", id: [2, 2], reason: "dup" }, 103, () => BOARD_A),
    /must be unique/,
  );
  assert.throws(
    () => transitionTodo(single.state, { op: "drop", id: [], reason: "empty" }, 103, () => BOARD_A),
    /1 to 100 task IDs/,
  );
  assert.equal(single.state.revision, revisionBefore);
  assert.equal(task(single.state, 2).status, "inProgress");
});

test("start enforces one active task and supports explicit cross-phase switching", () => {
  const initial = initState([
    { phase: "A", items: ["One", "Two"] },
    { phase: "B", items: ["Three"] },
  ]);
  const switched = transitionTodo(initial, { op: "start", id: 3 }, 120, () => BOARD_A);
  assert.ok(switched.state);
  assert.equal(task(switched.state, 1).status, "pending");
  assert.equal(task(switched.state, 3).status, "inProgress");
  assert.deepEqual(switched.changedTaskIds, [1, 3]);
  assert.equal(todoCounts(switched.state).inProgress, 1);

  const noChange = transitionTodo(switched.state, { op: "start", id: 3 }, 121, () => BOARD_A);
  assert.equal(noChange.state, switched.state);
  assert.equal(noChange.effect.kind, "noChange");
  assert.equal(noChange.state?.revision, switched.state.revision);
});

test("done accepts only the active task, records evidence, and promotes in board order", () => {
  const initial = initState();
  assert.throws(() => transitionTodo(initial, { op: "done", id: 2 }, 130, () => BOARD_A), /current inProgress/);
  const first = transitionTodo(initial, { op: "done", id: 1, note: "unit test passed" }, 131, () => BOARD_A);
  assert.ok(first.state);
  assert.equal(task(first.state, 1).status, "completed");
  assert.equal(task(first.state, 1).statusDetail, "unit test passed");
  assert.equal(task(first.state, 1).completedAt, 131);
  assert.equal(task(first.state, 2).status, "inProgress");
  assert.deepEqual(first.changedTaskIds, [1, 2]);

  const second = transitionTodo(first.state, { op: "done", id: 2 }, 132, () => BOARD_A).state;
  assert.ok(second);
  const third = transitionTodo(second, { op: "done", id: 3 }, 133, () => BOARD_A).state;
  assert.ok(third);
  assert.equal(todoBoardStatus(third), "settled");
  assert.equal(todoCounts(third).completed, 3);
});

test("block, drop, reopen, and edit preserve truthful status semantics", () => {
  const initial = initState();
  const blocked = transitionTodo(initial, { op: "block", id: 1, reason: "waiting for user choice" }, 140, () => BOARD_A).state;
  assert.ok(blocked);
  assert.equal(task(blocked, 1).status, "blocked");
  assert.equal(task(blocked, 2).status, "inProgress");
  assert.throws(() => transitionTodo(blocked, { op: "block", id: 1, reason: "again" }, 141, () => BOARD_A), /current inProgress/);

  const dropped = transitionTodo(blocked, { op: "drop", id: 3, reason: "user removed scope" }, 142, () => BOARD_A).state;
  assert.ok(dropped);
  assert.equal(task(dropped, 3).status, "dropped");
  assert.equal(todoCounts(dropped).completed, 0);
  assert.equal(todoCounts(dropped).dropped, 1);
  assert.throws(() => transitionTodo(dropped, { op: "edit", id: 3, content: "Rewrite" }, 143, () => BOARD_A), /open task/);

  const edited = transitionTodo(dropped, { op: "edit", id: 2, content: "Implement corrected scope" }, 144, () => BOARD_A).state;
  assert.ok(edited);
  assert.equal(task(edited, 2).content, "Implement corrected scope");

  const completed = transitionTodo(edited, { op: "done", id: 2 }, 145, () => BOARD_A).state;
  assert.ok(completed);
  assert.equal(todoBoardStatus(completed), "blocked");
  const reopened = transitionTodo(completed, { op: "reopen", id: 1, reason: "user answered" }, 146, () => BOARD_A).state;
  assert.ok(reopened);
  assert.equal(task(reopened, 1).status, "inProgress");
  assert.equal(task(reopened, 1).completedAt, undefined);
  assert.equal(task(reopened, 1).statusDetail, "user answered");
});

test("transition timestamps remain monotonic when the system clock moves backward", () => {
  const initial = initState(undefined, BOARD_A, 500);
  const next = transitionTodo(initial, { op: "done", id: 1 }, 100, () => BOARD_A).state;
  assert.ok(next);
  assert.equal(next.updatedAt, 500);
  assert.equal(task(next, 1).updatedAt, 500);
  assert.equal(task(next, 1).completedAt, 500);
});

test("input normalization rejects duplicates, surrounding-only emptiness, and terminal controls", () => {
  assert.throws(
    () => transitionTodo(null, { op: "init", list: [{ phase: "A\nB", items: ["One"] }] }, 1, () => BOARD_A),
    /terminal or bidirectional controls/,
  );
  assert.throws(
    () => transitionTodo(null, { op: "init", list: [{ phase: "A", items: ["One\u202e"] }] }, 1, () => BOARD_A),
    /terminal or bidirectional controls/,
  );
  assert.throws(
    () => transitionTodo(null, { op: "init", list: [{ phase: "A", items: ["  "] }] }, 1, () => BOARD_A),
    /must not be empty/,
  );
  assert.throws(
    () => transitionTodo(null, { op: "init", list: [{ phase: "A", items: ["One", "One"] }] }, 1, () => BOARD_A),
    /unique within its phase/,
  );
});

test("strict decoder rejects invalid state and mutations fail atomically at safe-integer boundaries", () => {
  const state = initState();
  const unknown = clone(state);
  unknown.extra = true;
  assert.equal(decodeTodoState(unknown).ok, false);

  const duplicateId = clone(state);
  duplicateId.phases[0].tasks[1].id = 1;
  assert.match(rejectionReason(duplicateId), /IDs must be unique/);

  const twoActive = clone(state);
  twoActive.phases[0].tasks[1].status = "inProgress";
  assert.match(rejectionReason(twoActive), /at most one/);

  const noActive = clone(state);
  noActive.phases[0].tasks[0].status = "pending";
  assert.match(rejectionReason(noActive), /exactly one/);

  const badTime = clone(state);
  badTime.phases[0].tasks[0].updatedAt = state.updatedAt + 1;
  assert.match(rejectionReason(badTime), /timestamps/);

  const revisionLimit = clone(state);
  revisionLimit.revision = Number.MAX_SAFE_INTEGER;
  const decodedRevisionLimit = decodeTodoState(revisionLimit);
  assert.equal(decodedRevisionLimit.ok, true);
  if (!decodedRevisionLimit.ok) return;
  const revisionBefore = JSON.stringify(decodedRevisionLimit.value);
  assert.throws(
    () => transitionTodo(decodedRevisionLimit.value, { op: "done", id: 1 }, 101, () => BOARD_A),
    /revision cannot be incremented safely/,
  );
  assert.equal(JSON.stringify(decodedRevisionLimit.value), revisionBefore);

  const idLimit = clone(state);
  idLimit.nextTaskId = Number.MAX_SAFE_INTEGER;
  const decodedIdLimit = decodeTodoState(idLimit);
  assert.equal(decodedIdLimit.ok, true);
  if (!decodedIdLimit.ok) return;
  const idBefore = JSON.stringify(decodedIdLimit.value);
  assert.throws(
    () => transitionTodo(decodedIdLimit.value, { op: "append", phase: "Implementation", items: ["Overflow"] }, 101, () => BOARD_A),
    /nextTaskId cannot be incremented safely/,
  );
  assert.equal(JSON.stringify(decodedIdLimit.value), idBefore);
});

test("decoder returns a recursively frozen canonical copy and reducer does not mutate its input", () => {
  const original = initState();
  const decoded = decodeTodoState(clone(original));
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  assert.notEqual(decoded.value, original);
  assert.equal(Object.isFrozen(decoded.value), true);
  assert.equal(Object.isFrozen(decoded.value.phases), true);
  assert.equal(Object.isFrozen(decoded.value.phases[0]), true);
  assert.equal(Object.isFrozen(decoded.value.phases[0]?.tasks), true);
  assert.equal(Object.isFrozen(decoded.value.phases[0]?.tasks[0]), true);

  const before = JSON.stringify(original);
  transitionTodo(original, { op: "done", id: 1 }, 200, () => BOARD_A);
  assert.equal(JSON.stringify(original), before);
  assert.equal(task(original, 1).status, "inProgress");
});

test("UTF-8 state size limit rejects large multilingual boards atomically", () => {
  const large = Array.from({ length: 100 }, (_, index) => `${index}-${"界".repeat(230)}`);
  assert.throws(
    () => transitionTodo(null, { op: "init", list: [{ phase: "Large", items: large }] }, 1, () => BOARD_A),
    /byte limit/,
  );
});
