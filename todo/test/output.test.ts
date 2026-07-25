import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  buildTodoGet,
  buildTodoMutationText,
  buildTodoView,
  todoFooter,
  todoWidget,
} from "../src/output.ts";
import {
  MAX_MODEL_OUTPUT_BYTES,
  MAX_WIDGET_ROWS,
  freezeTodoSnapshot,
  todoCounts,
  transitionTodo,
  type TodoSnapshot,
  type TodoState,
} from "../src/state.ts";

const BOARD = "00000000-0000-4000-8000-000000000031";

function stateWith(items: string[]): TodoState {
  const state = transitionTodo(null, { op: "init", list: [{ phase: "Work", items }] }, 10, () => BOARD).state;
  assert.ok(state);
  return state;
}

function snapshot(state: TodoState | null, sequence = 1): TodoSnapshot {
  return freezeTodoSnapshot({ sequence, state });
}

test("mutation output is compact and names the active pointer", () => {
  const initialized = transitionTodo(null, {
    op: "init",
    list: [{ phase: "Work", items: ["Inspect", "Implement", "Verify"] }],
  }, 10, () => BOARD);
  assert.ok(initialized.state);
  const initText = buildTodoMutationText("init", snapshot(initialized.state), initialized);
  assert.match(initText, /Initialized Todo board with 3 tasks/);
  assert.match(initText, /Active: #1 Inspect/);
  assert.ok(Buffer.byteLength(initText, "utf8") < 512);

  const completed = transitionTodo(initialized.state, { op: "done", id: 1, note: "checked" }, 11, () => BOARD);
  assert.ok(completed.state);
  const doneText = buildTodoMutationText("done", snapshot(completed.state, 2), completed);
  assert.match(doneText, /Completed #1: Inspect/);
  assert.match(doneText, /Active: #2 Implement/);
});

test("view defaults to open tasks and supports phase, closed, offset, and limit", () => {
  let state = stateWith(["One", "Two", "Three", "Four"]);
  state = transitionTodo(state, { op: "done", id: 1 }, 11, () => BOARD).state!;
  state = transitionTodo(state, { op: "drop", id: 4, reason: "removed" }, 12, () => BOARD).state!;
  const current = snapshot(state, 3);

  const open = buildTodoView(current, { phase: null, includeClosed: false, offset: 0, limit: 50 });
  assert.match(open.text, /→ #2 Two \[inProgress\]/);
  assert.match(open.text, /○ #3 Three \[pending\]/);
  assert.equal(open.text.includes("#1 One"), false);
  assert.equal(open.text.includes("#4 Four"), false);
  assert.equal(open.page.returned, 2);
  assert.equal(open.page.matched, 2);
  assert.equal(open.page.nextOffset, undefined);

  const page = buildTodoView(current, { phase: "Work", includeClosed: true, offset: 1, limit: 2 });
  assert.equal(page.page.returned, 2);
  assert.equal(page.page.matched, 4);
  assert.equal(page.page.nextOffset, 3);
  assert.match(page.text, /Page: 2 shown of 4 matched · next offset 3/);
  assert.match(page.text, /#2 Two/);
  assert.match(page.text, /#3 Three/);

  const missing = buildTodoView(current, { phase: "Missing", includeClosed: false, offset: 0, limit: 50 });
  assert.equal(missing.page.matched, 0);
  assert.match(missing.text, /No matching Todo tasks/);
});

test("get returns one exact task and rejects unknown IDs", () => {
  const current = snapshot(stateWith(["Inspect"]));
  const text = buildTodoGet(current, 1);
  assert.match(text, /Todo #1 · Work/);
  assert.match(text, /→ #1 Inspect \[inProgress\]/);
  assert.throws(() => buildTodoGet(current, 99), /does not exist/);
});

test("tool-facing output is UTF-8 byte bounded with structured truncation metadata", () => {
  const items = Array.from({ length: 100 }, (_, index) => `${index}-${"🧪".repeat(115)}`);
  const current = snapshot(stateWith(items));
  const view = buildTodoView(current, { phase: null, includeClosed: true, offset: 0, limit: 50 });
  assert.ok(Buffer.byteLength(view.text, "utf8") <= MAX_MODEL_OUTPUT_BYTES);
  assert.ok(view.truncation);
  assert.equal(view.truncation.outputBytes <= MAX_MODEL_OUTPUT_BYTES, true);
  assert.equal(view.page.returned < 50, true);
  assert.equal(view.page.nextOffset, view.page.returned);
  assert.match(view.text, /Todo output truncated by bytes: requested page is .*; limit is .*\./);
});

test("footer and widget use phase context, runnable ordering, semantic colors, and bounded rows", () => {
  let state = stateWith(Array.from({ length: 20 }, (_, index) => `Task ${index + 1}`));
  state = transitionTodo(state, { op: "done", id: 1 }, 11, () => BOARD).state!;
  state = transitionTodo(state, { op: "block", id: 2, reason: "external" }, 12, () => BOARD).state!;
  assert.deepEqual(todoCounts(state), {
    total: 20,
    pending: 17,
    inProgress: 1,
    blocked: 1,
    completed: 1,
    dropped: 0,
  });
  assert.deepEqual(todoFooter(state), { text: "Todo 1/20 · #3 Task 3", color: "accent" });

  const colors: string[] = [];
  const theme = { fg: (color: string, text: string) => { colors.push(color); return text; } } as any;
  const lines = todoWidget(state, theme, 40);
  assert.equal(lines.length <= MAX_WIDGET_ROWS, true);
  assert.match(lines[0] ?? "", /Todo · Work · 1\/20 completed/);
  assert.equal(lines.every((line) => visibleWidth(line) <= 40), true);
  assert.equal(lines.at(-1)?.includes("more"), true);

  let orderedState = stateWith(["One", "Two", "Three", "Four"]);
  orderedState = transitionTodo(orderedState, { op: "done", id: 1 }, 11, () => BOARD).state!;
  orderedState = transitionTodo(orderedState, { op: "block", id: 2, reason: "external" }, 12, () => BOARD).state!;
  const orderedLines = todoWidget(orderedState, theme, 80);
  const pendingIndex = orderedLines.findIndex((line) => line.includes("#4"));
  const blockedIndex = orderedLines.findIndex((line) => line.includes("#2"));
  assert.equal(pendingIndex > 0 && blockedIndex > pendingIndex, true);
  assert.equal(colors.includes("accent"), true);
  assert.equal(colors.includes("warning"), true);
  assert.equal(todoFooter(null), undefined);
});
