export const MAX_TODO_PHASES = 20;
export const MAX_TODO_TASKS = 100;
export const MAX_ITEMS_PER_APPEND = 50;
export const MAX_PHASE_NAME_CHARS = 80;
export const MAX_TASK_CONTENT_CHARS = 240;
export const MAX_STATUS_DETAIL_CHARS = 500;
export const MAX_BOARD_ID_CHARS = 128;
export const MAX_TODO_STATE_BYTES = 60 * 1024;
export const MAX_TODO_ENVELOPE_BYTES = 64 * 1024;
export const MAX_MODEL_OUTPUT_BYTES = 16 * 1024;
export const MAX_MODEL_OUTPUT_LINES = 200;
export const DEFAULT_VIEW_LIMIT = 20;
export const MAX_VIEW_LIMIT = 50;
export const MAX_PROMPT_OPEN_TASKS = 20;
export const MAX_WIDGET_ROWS = 12;

const FORBIDDEN_DISPLAY_CODE_POINT = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028-\u202E\u2066-\u206F]/u;
const TODO_STATUSES = ["pending", "inProgress", "blocked", "completed", "dropped"] as const;

export type TodoStatus = typeof TODO_STATUSES[number];

export interface TodoTask {
  readonly id: number;
  readonly content: string;
  readonly status: TodoStatus;
  readonly statusDetail?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly completedAt?: number;
}

export interface TodoPhase {
  readonly name: string;
  readonly tasks: readonly TodoTask[];
}

export interface TodoState {
  readonly version: 1;
  readonly boardId: string;
  readonly revision: number;
  readonly nextTaskId: number;
  readonly phases: readonly TodoPhase[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface TodoSnapshot {
  readonly sequence: number;
  readonly state: TodoState | null;
}

export interface TodoCounts {
  readonly total: number;
  readonly pending: number;
  readonly inProgress: number;
  readonly blocked: number;
  readonly completed: number;
  readonly dropped: number;
}

export type TodoBoardStatus = "empty" | "active" | "blocked" | "settled";

export type TodoTransitionInput =
  | { readonly op: "init"; readonly list: readonly { readonly phase: unknown; readonly items: readonly unknown[] }[] }
  | { readonly op: "append"; readonly phase: unknown; readonly items: readonly unknown[] }
  | { readonly op: "start"; readonly id: unknown }
  | { readonly op: "done"; readonly id: unknown; readonly note?: unknown }
  | { readonly op: "block"; readonly id: unknown; readonly reason: unknown }
  | { readonly op: "drop"; readonly id: unknown; readonly reason: unknown }
  | { readonly op: "reopen"; readonly id: unknown; readonly reason: unknown }
  | { readonly op: "edit"; readonly id: unknown; readonly content: unknown }
  | { readonly op: "clear" };

export type TodoTransitionEffect =
  | { readonly kind: "initialized" }
  | { readonly kind: "cleared" }
  | { readonly kind: "appended"; readonly ids: readonly number[] }
  | { readonly kind: "statusChanged"; readonly id: number; readonly from: TodoStatus; readonly to: TodoStatus }
  | { readonly kind: "bulkDropped"; readonly ids: readonly number[] }
  | { readonly kind: "edited"; readonly id: number }
  | { readonly kind: "noChange" };

export interface TodoTransition {
  readonly state: TodoState | null;
  readonly changedTaskIds: readonly number[];
  readonly effect: TodoTransitionEffect;
}

export type TodoStateDecode =
  | { readonly ok: true; readonly value: TodoState }
  | { readonly ok: false; readonly reason: string };

interface MutableCandidateTask {
  id: number;
  content: string;
  status: TodoStatus;
  statusDetail?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

interface MutableCandidatePhase {
  name: string;
  tasks: MutableCandidateTask[];
}

interface MutableCandidateState {
  version: 1;
  boardId: string;
  revision: number;
  nextTaskId: number;
  phases: MutableCandidatePhase[];
  createdAt: number;
  updatedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) {
    throw new Error(`${label} contains an unknown field.`);
  }
}

function assertSafeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return value as number;
}

function normalizeText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  if (FORBIDDEN_DISPLAY_CODE_POINT.test(value)) {
    throw new Error(`${label} must be single-line text without terminal or bidirectional controls.`);
  }
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  if (normalized.length > maximum) throw new Error(`${label} exceeds the ${maximum} character limit.`);
  return normalized;
}

export function normalizePhaseName(value: unknown, label = "Todo phase"): string {
  return normalizeText(value, label, MAX_PHASE_NAME_CHARS);
}

export function normalizeTaskContent(value: unknown, label = "Todo task"): string {
  return normalizeText(value, label, MAX_TASK_CONTENT_CHARS);
}

export function normalizeStatusDetail(value: unknown, label = "Todo status detail"): string {
  return normalizeText(value, label, MAX_STATUS_DETAIL_CHARS);
}

export function normalizeTaskId(value: unknown, label = "Todo task ID"): number {
  return assertSafeInteger(value, label, 1);
}

function normalizeDropIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [normalizeTaskId(value)];
  if (value.length === 0 || value.length > MAX_TODO_TASKS) {
    throw new Error(`Todo drop requires 1 to ${MAX_TODO_TASKS} task IDs.`);
  }
  const ids = value.map((entry, index) => normalizeTaskId(entry, `Todo drop task ID ${index + 1}`));
  if (new Set(ids).size !== ids.length) throw new Error("Todo drop task IDs must be unique.");
  return ids;
}

function normalizeBoardId(value: unknown): string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > MAX_BOARD_ID_CHARS) {
    throw new Error(`Todo boardId must be non-empty trimmed text within ${MAX_BOARD_ID_CHARS} characters.`);
  }
  if (FORBIDDEN_DISPLAY_CODE_POINT.test(value)) {
    throw new Error("Todo boardId contains a forbidden control character.");
  }
  return value;
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function freezeTask(task: MutableCandidateTask): TodoTask {
  return Object.freeze({
    id: task.id,
    content: task.content,
    status: task.status,
    ...(task.statusDetail === undefined ? {} : { statusDetail: task.statusDetail }),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.completedAt === undefined ? {} : { completedAt: task.completedAt }),
  });
}

function freezePhase(phase: MutableCandidatePhase): TodoPhase {
  return Object.freeze({
    name: phase.name,
    tasks: Object.freeze(phase.tasks.map(freezeTask)),
  });
}

function canonicalizeTodoState(value: unknown): TodoState {
  if (!isRecord(value)) throw new Error("Todo state must be an object.");
  assertExactKeys(
    value,
    ["version", "boardId", "revision", "nextTaskId", "phases", "createdAt", "updatedAt"],
    "Todo state",
  );
  if (value.version !== 1) throw new Error("Todo state version must be 1.");
  const boardId = normalizeBoardId(value.boardId);
  const revision = assertSafeInteger(value.revision, "Todo revision", 1);
  const nextTaskId = assertSafeInteger(value.nextTaskId, "Todo nextTaskId", 1);
  const createdAt = assertSafeInteger(value.createdAt, "Todo createdAt");
  const updatedAt = assertSafeInteger(value.updatedAt, "Todo updatedAt");
  if (updatedAt < createdAt) throw new Error("Todo state updatedAt must not precede createdAt.");
  if (!Array.isArray(value.phases) || value.phases.length === 0 || value.phases.length > MAX_TODO_PHASES) {
    throw new Error(`Todo state must contain 1 to ${MAX_TODO_PHASES} phases.`);
  }

  const phaseNames = new Set<string>();
  const taskIds = new Set<number>();
  let taskCount = 0;
  let maximumTaskId = 0;
  let pendingCount = 0;
  let activeCount = 0;
  const phases: MutableCandidatePhase[] = value.phases.map((phaseValue, phaseIndex) => {
    if (!isRecord(phaseValue)) throw new Error(`Todo phase ${phaseIndex + 1} must be an object.`);
    assertExactKeys(phaseValue, ["name", "tasks"], `Todo phase ${phaseIndex + 1}`);
    const name = normalizePhaseName(phaseValue.name, `Todo phase ${phaseIndex + 1} name`);
    if (phaseValue.name !== name) throw new Error(`Todo phase ${phaseIndex + 1} name must not have surrounding whitespace.`);
    if (phaseNames.has(name)) throw new Error("Todo phase names must be unique.");
    phaseNames.add(name);
    if (!Array.isArray(phaseValue.tasks) || phaseValue.tasks.length === 0) {
      throw new Error(`Todo phase ${phaseIndex + 1} must contain at least one task.`);
    }
    const taskContents = new Set<string>();
    const tasks: MutableCandidateTask[] = phaseValue.tasks.map((taskValue, taskIndex) => {
      if (!isRecord(taskValue)) throw new Error(`Todo task ${taskIndex + 1} must be an object.`);
      assertExactKeys(
        taskValue,
        ["id", "content", "status", "statusDetail", "createdAt", "updatedAt", "completedAt"],
        `Todo task ${taskIndex + 1}`,
      );
      const id = assertSafeInteger(taskValue.id, `Todo task ${taskIndex + 1} id`, 1);
      if (taskIds.has(id)) throw new Error("Todo task IDs must be unique.");
      taskIds.add(id);
      maximumTaskId = Math.max(maximumTaskId, id);
      const content = normalizeTaskContent(taskValue.content, `Todo task ${taskIndex + 1} content`);
      if (taskValue.content !== content) throw new Error(`Todo task ${taskIndex + 1} content must not have surrounding whitespace.`);
      if (taskContents.has(content)) throw new Error("Todo task content must be unique within its phase.");
      taskContents.add(content);
      if (typeof taskValue.status !== "string" || !TODO_STATUSES.includes(taskValue.status as TodoStatus)) {
        throw new Error(`Todo task ${taskIndex + 1} has an invalid status.`);
      }
      const status = taskValue.status as TodoStatus;
      if (status === "pending") pendingCount += 1;
      if (status === "inProgress") activeCount += 1;
      const taskCreatedAt = assertSafeInteger(taskValue.createdAt, `Todo task ${taskIndex + 1} createdAt`);
      const taskUpdatedAt = assertSafeInteger(taskValue.updatedAt, `Todo task ${taskIndex + 1} updatedAt`);
      if (taskCreatedAt < createdAt || taskUpdatedAt < taskCreatedAt || taskUpdatedAt > updatedAt) {
        throw new Error(`Todo task ${taskIndex + 1} timestamps are outside the state interval.`);
      }
      const statusDetail = taskValue.statusDetail === undefined
        ? undefined
        : normalizeStatusDetail(taskValue.statusDetail, `Todo task ${taskIndex + 1} statusDetail`);
      if (taskValue.statusDetail !== undefined && taskValue.statusDetail !== statusDetail) {
        throw new Error(`Todo task ${taskIndex + 1} statusDetail must not have surrounding whitespace.`);
      }
      if ((status === "blocked" || status === "dropped") && statusDetail === undefined) {
        throw new Error(`${status} Todo tasks require a statusDetail.`);
      }
      const completedAt = taskValue.completedAt === undefined
        ? undefined
        : assertSafeInteger(taskValue.completedAt, `Todo task ${taskIndex + 1} completedAt`);
      if (status === "completed") {
        if (completedAt === undefined || completedAt < taskCreatedAt || completedAt > taskUpdatedAt) {
          throw new Error("Completed Todo tasks require completedAt within the task interval.");
        }
      } else if (completedAt !== undefined) {
        throw new Error("Only completed Todo tasks may contain completedAt.");
      }
      taskCount += 1;
      return {
        id,
        content,
        status,
        ...(statusDetail === undefined ? {} : { statusDetail }),
        createdAt: taskCreatedAt,
        updatedAt: taskUpdatedAt,
        ...(completedAt === undefined ? {} : { completedAt }),
      };
    });
    return { name, tasks };
  });

  if (taskCount > MAX_TODO_TASKS) throw new Error(`Todo state exceeds the ${MAX_TODO_TASKS} task limit.`);
  if (nextTaskId <= maximumTaskId) throw new Error("Todo nextTaskId must be greater than every task ID.");
  if (activeCount > 1) throw new Error("Todo state may contain at most one inProgress task.");
  if (pendingCount > 0 && activeCount !== 1) {
    throw new Error("Todo state with pending tasks must contain exactly one inProgress task.");
  }

  const state: TodoState = Object.freeze({
    version: 1,
    boardId,
    revision,
    nextTaskId,
    phases: Object.freeze(phases.map(freezePhase)),
    createdAt,
    updatedAt,
  });
  if (encodedBytes(state) > MAX_TODO_STATE_BYTES) {
    throw new Error(`Todo state exceeds the ${MAX_TODO_STATE_BYTES} byte limit.`);
  }
  return state;
}

export function decodeTodoState(value: unknown): TodoStateDecode {
  try {
    return { ok: true, value: canonicalizeTodoState(value) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : "Todo state is invalid." };
  }
}

function finalizeState(value: MutableCandidateState): TodoState {
  const decoded = decodeTodoState(value);
  if (!decoded.ok) throw new Error(decoded.reason);
  return decoded.value;
}

export function freezeTodoSnapshot(value: TodoSnapshot): TodoSnapshot {
  const sequence = assertSafeInteger(value.sequence, "Todo sequence");
  let state = value.state;
  if (state !== null && !Object.isFrozen(state)) {
    const decoded = decodeTodoState(state);
    if (!decoded.ok) throw new Error(decoded.reason);
    state = decoded.value;
  }
  return Object.freeze({ sequence, state });
}

export const EMPTY_TODO_SNAPSHOT: TodoSnapshot = freezeTodoSnapshot({ sequence: 0, state: null });

export function incrementSafeInteger(value: number, label: string): number {
  assertSafeInteger(value, label);
  if (value === Number.MAX_SAFE_INTEGER) throw new Error(`${label} cannot be incremented safely.`);
  return value + 1;
}

export function todoCounts(state: TodoState | null): TodoCounts {
  const counts = { total: 0, pending: 0, inProgress: 0, blocked: 0, completed: 0, dropped: 0 };
  if (state) {
    for (const phase of state.phases) {
      for (const task of phase.tasks) {
        counts.total += 1;
        counts[task.status] += 1;
      }
    }
  }
  return Object.freeze(counts);
}

export function todoBoardStatus(state: TodoState | null): TodoBoardStatus {
  if (!state) return "empty";
  const counts = todoCounts(state);
  if (counts.pending > 0 || counts.inProgress > 0) return "active";
  if (counts.blocked > 0) return "blocked";
  return "settled";
}

export function findTodoTask(
  state: TodoState,
  id: number,
): { readonly phase: TodoPhase; readonly task: TodoTask } | undefined {
  for (const phase of state.phases) {
    const task = phase.tasks.find((candidate) => candidate.id === id);
    if (task) return { phase, task };
  }
  return undefined;
}

export function allTodoTasks(state: TodoState): readonly TodoTask[] {
  return state.phases.flatMap((phase) => phase.tasks);
}

export function todoStatesEqual(left: TodoState | null, right: TodoState | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertFrozenState(state: TodoState | null): void {
  if (state === null) return;
  if (!Object.isFrozen(state) || !Object.isFrozen(state.phases)) {
    throw new Error("Todo reducer requires a frozen canonical state.");
  }
}

function normalizeNow(now: unknown, previous?: TodoState): number {
  const current = assertSafeInteger(now, "Todo transition time");
  return previous ? Math.max(current, previous.updatedAt) : current;
}

function normalizeInitList(input: TodoTransitionInput & { readonly op: "init" }): Array<{ phase: string; items: string[] }> {
  if (!Array.isArray(input.list) || input.list.length === 0 || input.list.length > MAX_TODO_PHASES) {
    throw new Error(`Todo init requires 1 to ${MAX_TODO_PHASES} phases.`);
  }
  const phaseNames = new Set<string>();
  let total = 0;
  return input.list.map((entry, phaseIndex) => {
    if (!isRecord(entry)) throw new Error(`Todo init phase ${phaseIndex + 1} must be an object.`);
    assertExactKeys(entry, ["phase", "items"], `Todo init phase ${phaseIndex + 1}`);
    const phase = normalizePhaseName(entry.phase, `Todo init phase ${phaseIndex + 1} name`);
    if (phaseNames.has(phase)) throw new Error("Todo init phase names must be unique.");
    phaseNames.add(phase);
    if (!Array.isArray(entry.items) || entry.items.length === 0 || entry.items.length > MAX_TODO_TASKS) {
      throw new Error(`Todo init phase ${phaseIndex + 1} must contain 1 to ${MAX_TODO_TASKS} tasks.`);
    }
    const contents = new Set<string>();
    const items = entry.items.map((item, taskIndex) => {
      const content = normalizeTaskContent(item, `Todo init task ${taskIndex + 1}`);
      if (contents.has(content)) throw new Error("Todo task content must be unique within its phase.");
      contents.add(content);
      return content;
    });
    total += items.length;
    if (total > MAX_TODO_TASKS) throw new Error(`Todo init exceeds the ${MAX_TODO_TASKS} task limit.`);
    return { phase, items };
  });
}

function clonePhases(state: TodoState): MutableCandidatePhase[] {
  return state.phases.map((phase) => ({
    name: phase.name,
    tasks: phase.tasks.map((task) => ({
      id: task.id,
      content: task.content,
      status: task.status,
      ...(task.statusDetail === undefined ? {} : { statusDetail: task.statusDetail }),
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      ...(task.completedAt === undefined ? {} : { completedAt: task.completedAt }),
    })),
  }));
}

function candidateFrom(state: TodoState, phases: MutableCandidatePhase[], timestamp: number): MutableCandidateState {
  return {
    version: 1,
    boardId: state.boardId,
    revision: incrementSafeInteger(state.revision, "Todo revision"),
    nextTaskId: state.nextTaskId,
    phases,
    createdAt: state.createdAt,
    updatedAt: timestamp,
  };
}

function findMutableTask(phases: MutableCandidatePhase[], id: number): { phase: MutableCandidatePhase; task: MutableCandidateTask } {
  for (const phase of phases) {
    const task = phase.tasks.find((candidate) => candidate.id === id);
    if (task) return { phase, task };
  }
  throw new Error(`Todo task #${id} does not exist on the current board.`);
}

function promoteNextTask(phases: MutableCandidatePhase[], timestamp: number): number | undefined {
  if (phases.some((phase) => phase.tasks.some((task) => task.status === "inProgress"))) return undefined;
  for (const phase of phases) {
    const pending = phase.tasks.find((task) => task.status === "pending");
    if (!pending) continue;
    pending.status = "inProgress";
    pending.updatedAt = timestamp;
    return pending.id;
  }
  return undefined;
}

function freezeTransition(
  state: TodoState | null,
  changedTaskIds: readonly number[],
  effect: TodoTransitionEffect,
): TodoTransition {
  return Object.freeze({
    state,
    changedTaskIds: Object.freeze([...new Set(changedTaskIds)]),
    effect: Object.freeze(effect),
  });
}

export function transitionTodo(
  state: TodoState | null,
  input: TodoTransitionInput,
  now: unknown,
  idFactory: () => string,
): TodoTransition {
  assertFrozenState(state);

  if (input.op === "clear") {
    if (state === null) return freezeTransition(null, [], { kind: "noChange" });
    return freezeTransition(null, [], { kind: "cleared" });
  }

  if (input.op === "init") {
    if (state !== null && todoBoardStatus(state) !== "settled") {
      throw new Error("Todo init cannot replace an active or blocked board; append the new work instead.");
    }
    const timestamp = normalizeNow(now);
    const list = normalizeInitList(input);
    const boardId = normalizeBoardId(idFactory());
    let nextTaskId = 1;
    const phases: MutableCandidatePhase[] = list.map((entry) => ({
      name: entry.phase,
      tasks: entry.items.map((content) => {
        const id = nextTaskId;
        nextTaskId = incrementSafeInteger(nextTaskId, "Todo nextTaskId");
        return {
          id,
          content,
          status: id === 1 ? "inProgress" : "pending",
          createdAt: timestamp,
          updatedAt: timestamp,
        };
      }),
    }));
    const initialized = finalizeState({
      version: 1,
      boardId,
      revision: 1,
      nextTaskId,
      phases,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    return freezeTransition(initialized, allTodoTasks(initialized).map((task) => task.id), { kind: "initialized" });
  }

  if (state === null) throw new Error(`Todo ${input.op} requires an active board.`);
  const timestamp = normalizeNow(now, state);

  if (input.op === "append") {
    const phaseName = normalizePhaseName(input.phase);
    if (!Array.isArray(input.items) || input.items.length === 0 || input.items.length > MAX_ITEMS_PER_APPEND) {
      throw new Error(`Todo append requires 1 to ${MAX_ITEMS_PER_APPEND} tasks.`);
    }
    const items = input.items.map((item, index) => normalizeTaskContent(item, `Todo append task ${index + 1}`));
    if (new Set(items).size !== items.length) throw new Error("Todo append tasks must be unique within the call.");
    const counts = todoCounts(state);
    if (counts.total + items.length > MAX_TODO_TASKS) {
      throw new Error(`Todo append would exceed the ${MAX_TODO_TASKS} task limit.`);
    }
    const phases = clonePhases(state);
    let target = phases.find((phase) => phase.name === phaseName);
    if (!target) {
      if (phases.length >= MAX_TODO_PHASES) throw new Error(`Todo append would exceed the ${MAX_TODO_PHASES} phase limit.`);
      target = { name: phaseName, tasks: [] };
      phases.push(target);
    }
    const existing = new Set(target.tasks.map((task) => task.content));
    if (items.some((item) => existing.has(item))) {
      throw new Error("Todo append would duplicate task content within the target phase.");
    }
    const ids: number[] = [];
    let nextTaskId = state.nextTaskId;
    for (const content of items) {
      const id = nextTaskId;
      nextTaskId = incrementSafeInteger(nextTaskId, "Todo nextTaskId");
      ids.push(id);
      target.tasks.push({ id, content, status: "pending", createdAt: timestamp, updatedAt: timestamp });
    }
    const promoted = promoteNextTask(phases, timestamp);
    const candidate = candidateFrom(state, phases, timestamp);
    candidate.nextTaskId = nextTaskId;
    const appended = finalizeState(candidate);
    return freezeTransition(appended, promoted === undefined ? ids : [...ids, promoted], { kind: "appended", ids: Object.freeze(ids) });
  }

  if (input.op === "drop") {
    // Bulk drops validate every target before cloning so one bad ID rejects
    // the whole call without consuming a revision or task state.
    const ids = normalizeDropIds(input.id);
    const targets = ids.map((dropId) => {
      const found = findTodoTask(state, dropId);
      if (!found) throw new Error(`Todo task #${dropId} does not exist on the current board.`);
      return found.task;
    });
    if (targets.some((target) => target.status === "completed" || target.status === "dropped")) {
      throw new Error("Todo drop only accepts a pending, inProgress, or blocked task.");
    }
    const reason = normalizeStatusDetail(input.reason, "Todo drop reason");
    const phases = clonePhases(state);
    for (const dropId of ids) {
      const { task } = findMutableTask(phases, dropId);
      task.status = "dropped";
      task.statusDetail = reason;
      task.updatedAt = timestamp;
      delete task.completedAt;
    }
    const promoted = promoteNextTask(phases, timestamp);
    const next = finalizeState(candidateFrom(state, phases, timestamp));
    const effect: TodoTransitionEffect = ids.length === 1
      ? { kind: "statusChanged", id: ids[0], from: targets[0]?.status ?? "pending", to: "dropped" }
      : { kind: "bulkDropped", ids: Object.freeze([...ids]) };
    return freezeTransition(next, promoted === undefined ? ids : [...ids, promoted], effect);
  }

  const id = normalizeTaskId(input.id);
  const existing = findTodoTask(state, id);
  if (!existing) throw new Error(`Todo task #${id} does not exist on the current board.`);

  if (input.op === "start" && existing.task.status === "inProgress") {
    return freezeTransition(state, [], { kind: "noChange" });
  }

  const phases = clonePhases(state);
  const { phase, task } = findMutableTask(phases, id);
  const from = task.status;
  const changed: number[] = [];

  if (input.op === "start") {
    if (task.status !== "pending") throw new Error("Todo start only accepts a pending task.");
    for (const candidatePhase of phases) {
      const active = candidatePhase.tasks.find((candidate) => candidate.status === "inProgress");
      if (!active) continue;
      active.status = "pending";
      active.updatedAt = timestamp;
      changed.push(active.id);
      break;
    }
    task.status = "inProgress";
    task.updatedAt = timestamp;
    changed.push(task.id);
  } else if (input.op === "done") {
    if (task.status !== "inProgress") throw new Error("Todo done only accepts the current inProgress task.");
    const note = input.note === undefined ? undefined : normalizeStatusDetail(input.note, "Todo completion note");
    task.status = "completed";
    task.updatedAt = timestamp;
    task.completedAt = timestamp;
    if (note === undefined) delete task.statusDetail;
    else task.statusDetail = note;
    changed.push(task.id);
    const promoted = promoteNextTask(phases, timestamp);
    if (promoted !== undefined) changed.push(promoted);
  } else if (input.op === "block") {
    if (task.status !== "inProgress") throw new Error("Todo block only accepts the current inProgress task.");
    task.status = "blocked";
    task.statusDetail = normalizeStatusDetail(input.reason, "Todo blocker reason");
    task.updatedAt = timestamp;
    changed.push(task.id);
    const promoted = promoteNextTask(phases, timestamp);
    if (promoted !== undefined) changed.push(promoted);
  } else if (input.op === "reopen") {
    if (task.status !== "blocked" && task.status !== "completed" && task.status !== "dropped") {
      throw new Error("Todo reopen only accepts a blocked, completed, or dropped task.");
    }
    task.status = "pending";
    task.statusDetail = normalizeStatusDetail(input.reason, "Todo reopen reason");
    task.updatedAt = timestamp;
    delete task.completedAt;
    changed.push(task.id);
    const promoted = promoteNextTask(phases, timestamp);
    if (promoted !== undefined) changed.push(promoted);
  } else if (input.op === "edit") {
    if (task.status === "completed" || task.status === "dropped") {
      throw new Error("Todo edit only accepts an open task.");
    }
    const content = normalizeTaskContent(input.content, "Todo edited content");
    if (content === task.content) return freezeTransition(state, [], { kind: "noChange" });
    if (phase.tasks.some((candidate) => candidate.id !== id && candidate.content === content)) {
      throw new Error("Todo edit would duplicate task content within its phase.");
    }
    task.content = content;
    task.updatedAt = timestamp;
    changed.push(task.id);
  } else {
    const exhaustive: never = input;
    throw new Error(`Unsupported Todo transition: ${String((exhaustive as { op?: unknown }).op)}`);
  }

  const next = finalizeState(candidateFrom(state, phases, timestamp));
  const effect: TodoTransitionEffect = input.op === "edit"
    ? { kind: "edited", id }
    : { kind: "statusChanged", id, from, to: findTodoTask(next, id)?.task.status ?? from };
  return freezeTransition(next, changed, effect);
}

function uniquePlanPhaseName(state: TodoState, value: unknown): string {
  const requested = normalizePhaseName(value, "Plan Todo phase");
  const existing = new Set(state.phases.map((phase) => phase.name));
  if (!existing.has(requested)) return requested;
  for (let index = 2; index <= MAX_TODO_PHASES + 1; index += 1) {
    const suffix = ` (${index})`;
    const candidate = `${requested.slice(0, MAX_PHASE_NAME_CHARS - suffix.length)}${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  throw new Error("Todo cannot allocate a unique phase for the approved Plan.");
}

export function transitionPlanHandoff(
  state: TodoState | null,
  phase: unknown,
  items: readonly unknown[],
  now: unknown,
  idFactory: () => string,
): TodoTransition {
  assertFrozenState(state);
  if (state === null || todoBoardStatus(state) === "settled") {
    return transitionTodo(state, { op: "init", list: [{ phase, items }] }, now, idFactory);
  }
  const appended = transitionTodo(
    state,
    { op: "append", phase: uniquePlanPhaseName(state, phase), items },
    now,
    idFactory,
  );
  if (appended.effect.kind !== "appended" || !appended.state) {
    throw new Error("Todo Plan handoff did not append the approved tasks.");
  }
  return appended;
}
