import {
  MAX_TODO_ENVELOPE_BYTES,
  MAX_VIEW_LIMIT,
  decodeTodoState,
  findTodoTask,
  freezeTodoSnapshot,
  normalizePhaseName,
  todoCounts,
  todoStatesEqual,
  type TodoCounts,
  type TodoSnapshot,
  type TodoState,
} from "./state.ts";
import {
  buildTodoView,
  type TodoOperation,
  type TodoPage,
  type TodoTruncation,
  type TodoViewQuery,
} from "./output.ts";

export const TODO_TOOL_DETAILS_KIND = "pi-extensions:todo-tool-details";
export const TODO_STATE_TYPE = "todo-state-v2";
const LEGACY_TODO_STATE_TYPE = "todo-state-v1";

export interface TodoToolDetails {
  readonly kind: typeof TODO_TOOL_DETAILS_KIND;
  readonly version: 1;
  readonly sequence: number;
  readonly op: TodoOperation;
  readonly boardId: string | null;
  readonly revision: number | null;
  readonly changedTaskIds: readonly number[];
  readonly counts: TodoCounts;
  readonly state: TodoState | null;
  readonly page?: TodoPage;
  readonly truncation?: TodoTruncation;
}

export type TodoStateEntryOperation = "clear" | Exclude<TodoOperation, "get" | "view">;
export type TodoStateEntrySource = "command" | "service";

export interface TodoStateEntry {
  readonly version: 2;
  readonly sequence: number;
  readonly source: TodoStateEntrySource;
  readonly operation: TodoStateEntryOperation;
  readonly state: TodoState | null;
}

export type TodoStateEntryDecode =
  | { readonly kind: "valid"; readonly value: TodoStateEntry }
  | { readonly kind: "malformed"; readonly reason: string };

export type TodoDetailsDecode =
  | { readonly kind: "valid"; readonly value: TodoToolDetails }
  | { readonly kind: "foreign" }
  | { readonly kind: "malformed"; readonly reason: string }
  | { readonly kind: "unsupported"; readonly version: number };

export interface TodoRestoreResult {
  readonly snapshot: TodoSnapshot;
  readonly warning?: string;
  readonly blockedReason?: string;
}

const TODO_OPERATIONS: readonly TodoOperation[] = [
  "init",
  "append",
  "start",
  "done",
  "block",
  "drop",
  "reopen",
  "edit",
  "get",
  "view",
];

const TODO_MUTATION_OPERATIONS: readonly Exclude<TodoOperation, "get" | "view">[] = [
  "init",
  "append",
  "start",
  "done",
  "block",
  "drop",
  "reopen",
  "edit",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed);
  if (Object.keys(record).some((key) => !keys.has(key))) throw new Error(`${label} contains an unknown field.`);
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return value as number;
}

function encodedBytes(value: unknown): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Todo envelope must be JSON-serializable.");
  }
  if (typeof serialized !== "string") throw new Error("Todo envelope must be JSON-serializable.");
  return Buffer.byteLength(serialized, "utf8");
}

function assertEnvelopeSize(value: unknown): void {
  if (encodedBytes(value) > MAX_TODO_ENVELOPE_BYTES) {
    throw new Error(`Todo envelope exceeds the ${MAX_TODO_ENVELOPE_BYTES} byte limit.`);
  }
}

function decodeCounts(value: unknown): TodoCounts {
  if (!isRecord(value)) throw new Error("Todo counts must be an object.");
  exactKeys(value, ["total", "pending", "inProgress", "blocked", "completed", "dropped"], "Todo counts");
  return Object.freeze({
    total: safeInteger(value.total, "Todo total count"),
    pending: safeInteger(value.pending, "Todo pending count"),
    inProgress: safeInteger(value.inProgress, "Todo inProgress count"),
    blocked: safeInteger(value.blocked, "Todo blocked count"),
    completed: safeInteger(value.completed, "Todo completed count"),
    dropped: safeInteger(value.dropped, "Todo dropped count"),
  });
}

function countsEqual(left: TodoCounts, right: TodoCounts): boolean {
  return left.total === right.total &&
    left.pending === right.pending &&
    left.inProgress === right.inProgress &&
    left.blocked === right.blocked &&
    left.completed === right.completed &&
    left.dropped === right.dropped;
}

function decodePage(value: unknown): TodoPage {
  if (!isRecord(value)) throw new Error("Todo page must be an object.");
  exactKeys(
    value,
    ["phase", "includeClosed", "offset", "requestedLimit", "returned", "matched", "nextOffset"],
    "Todo page",
  );
  const phase = value.phase === null ? null : normalizePhaseName(value.phase, "Todo page phase");
  if (typeof value.includeClosed !== "boolean") throw new Error("Todo page includeClosed must be boolean.");
  const offset = safeInteger(value.offset, "Todo page offset");
  const requestedLimit = safeInteger(value.requestedLimit, "Todo page requestedLimit", 1);
  if (requestedLimit > MAX_VIEW_LIMIT) throw new Error(`Todo page requestedLimit exceeds ${MAX_VIEW_LIMIT}.`);
  const returned = safeInteger(value.returned, "Todo page returned");
  const matched = safeInteger(value.matched, "Todo page matched");
  const nextOffset = value.nextOffset === undefined ? undefined : safeInteger(value.nextOffset, "Todo page nextOffset");
  return Object.freeze({
    phase,
    includeClosed: value.includeClosed,
    offset,
    requestedLimit,
    returned,
    matched,
    ...(nextOffset === undefined ? {} : { nextOffset }),
  });
}

function decodeTruncation(value: unknown): TodoTruncation {
  if (!isRecord(value)) throw new Error("Todo truncation must be an object.");
  exactKeys(value, ["truncatedBy", "totalLines", "totalBytes", "outputLines", "outputBytes"], "Todo truncation");
  if (value.truncatedBy !== "lines" && value.truncatedBy !== "bytes") {
    throw new Error("Todo truncation truncatedBy must be lines or bytes.");
  }
  const truncation = Object.freeze({
    truncatedBy: value.truncatedBy,
    totalLines: safeInteger(value.totalLines, "Todo truncation totalLines"),
    totalBytes: safeInteger(value.totalBytes, "Todo truncation totalBytes"),
    outputLines: safeInteger(value.outputLines, "Todo truncation outputLines"),
    outputBytes: safeInteger(value.outputBytes, "Todo truncation outputBytes"),
  });
  if (truncation.outputLines > truncation.totalLines || truncation.outputBytes > truncation.totalBytes) {
    throw new Error("Todo truncation output metrics must not exceed total metrics.");
  }
  return truncation;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalDetails(record: Record<string, unknown>): TodoToolDetails {
  exactKeys(
    record,
    ["kind", "version", "sequence", "op", "boardId", "revision", "changedTaskIds", "counts", "state", "page", "truncation"],
    "Todo tool details",
  );
  if (record.kind !== TODO_TOOL_DETAILS_KIND || record.version !== 1) {
    throw new Error("Todo tool details discriminant is invalid.");
  }
  const sequence = safeInteger(record.sequence, "Todo sequence");
  if (typeof record.op !== "string" || !TODO_OPERATIONS.includes(record.op as TodoOperation)) {
    throw new Error("Todo tool details op is invalid.");
  }
  const op = record.op as TodoOperation;
  let state: TodoState | null;
  if (record.state === null) state = null;
  else {
    const decodedState = decodeTodoState(record.state);
    if (!decodedState.ok) throw new Error(decodedState.reason);
    state = decodedState.value;
  }
  if (state !== null && sequence < 1) throw new Error("A non-empty Todo state requires sequence at least 1.");
  const boardId = record.boardId === null ? null : record.boardId;
  const revision = record.revision === null ? null : safeInteger(record.revision, "Todo details revision", 1);
  if (state === null) {
    if (boardId !== null || revision !== null) throw new Error("Empty Todo details require null boardId and revision.");
  } else if (boardId !== state.boardId || revision !== state.revision) {
    throw new Error("Todo details boardId/revision must match the embedded state.");
  }
  if (!Array.isArray(record.changedTaskIds)) throw new Error("Todo changedTaskIds must be an array.");
  const changedTaskIds = record.changedTaskIds.map((id) => safeInteger(id, "Todo changed task ID", 1));
  if (new Set(changedTaskIds).size !== changedTaskIds.length) throw new Error("Todo changedTaskIds must be unique.");
  if (state === null && changedTaskIds.length > 0) throw new Error("Empty Todo details cannot reference changed tasks.");
  if (state && changedTaskIds.some((id) => !findTodoTask(state, id))) {
    throw new Error("Todo changedTaskIds must reference tasks in the embedded state.");
  }
  if ((op === "get" || op === "view") && changedTaskIds.length > 0) {
    throw new Error("Read-only Todo details cannot contain changedTaskIds.");
  }
  const counts = decodeCounts(record.counts);
  if (!countsEqual(counts, todoCounts(state))) throw new Error("Todo details counts do not match the embedded state.");
  const page = record.page === undefined ? undefined : decodePage(record.page);
  const truncation = record.truncation === undefined ? undefined : decodeTruncation(record.truncation);
  if (op !== "view" && (page !== undefined || truncation !== undefined)) {
    throw new Error("Only Todo view details may contain page or truncation metadata.");
  }
  if (op === "view") {
    if (page === undefined) throw new Error("Todo view details require page metadata.");
    const query: TodoViewQuery = {
      phase: page.phase,
      includeClosed: page.includeClosed,
      offset: page.offset,
      limit: page.requestedLimit,
    };
    const expected = buildTodoView(freezeTodoSnapshot({ sequence, state }), query);
    if (!sameJson(page, expected.page) || !sameJson(truncation, expected.truncation)) {
      throw new Error("Todo view page/truncation metadata does not match the embedded state.");
    }
  }
  return Object.freeze({
    kind: TODO_TOOL_DETAILS_KIND,
    version: 1,
    sequence,
    op,
    boardId: state?.boardId ?? null,
    revision: state?.revision ?? null,
    changedTaskIds: Object.freeze(changedTaskIds),
    counts,
    state,
    ...(page === undefined ? {} : { page }),
    ...(truncation === undefined ? {} : { truncation }),
  });
}

export function decodeTodoToolDetails(value: unknown): TodoDetailsDecode {
  if (!isRecord(value) || value.kind !== TODO_TOOL_DETAILS_KIND) return { kind: "foreign" };
  const version = value.version;
  if (!Number.isSafeInteger(version) || (version as number) < 1) {
    return { kind: "malformed", reason: "Todo tool details version is invalid." };
  }
  if ((version as number) > 1) return { kind: "unsupported", version: version as number };
  try {
    assertEnvelopeSize(value);
    return { kind: "valid", value: canonicalDetails(value) };
  } catch (error) {
    return { kind: "malformed", reason: error instanceof Error ? error.message : "Todo tool details are invalid." };
  }
}

function decodeEntryState(value: unknown, sequence: number, label: string): TodoState | null {
  let state: TodoState | null;
  if (value === null) state = null;
  else {
    const decoded = decodeTodoState(value);
    if (!decoded.ok) throw new Error(decoded.reason);
    state = decoded.value;
  }
  if (state !== null && sequence < 1) throw new Error(`A non-empty ${label} state requires sequence at least 1.`);
  return state;
}

function decodeLegacyTodoCommandEntry(value: unknown): TodoStateEntryDecode {
  try {
    assertEnvelopeSize(value);
    if (!isRecord(value)) throw new Error("Legacy Todo command entry must be an object.");
    exactKeys(value, ["version", "sequence", "action", "state"], "Legacy Todo command entry");
    if (value.version !== 1) throw new Error("Legacy Todo command entry version must be 1.");
    const sequence = safeInteger(value.sequence, "Legacy Todo command sequence");
    if (value.action !== "clear" && value.action !== "reopen") throw new Error("Legacy Todo command action is invalid.");
    const state = decodeEntryState(value.state, sequence, "Todo command");
    if (value.action === "clear" && state !== null) throw new Error("Todo clear entries require a null state.");
    if (value.action === "reopen" && state === null) throw new Error("Todo reopen entries require a non-empty state.");
    return {
      kind: "valid",
      value: Object.freeze({
        version: 2,
        sequence,
        source: "command",
        operation: value.action,
        state,
      }),
    };
  } catch (error) {
    return { kind: "malformed", reason: error instanceof Error ? error.message : "Legacy Todo command entry is invalid." };
  }
}

export function decodeTodoStateEntry(value: unknown): TodoStateEntryDecode {
  try {
    assertEnvelopeSize(value);
    if (!isRecord(value)) throw new Error("Todo state entry must be an object.");
    exactKeys(value, ["version", "sequence", "source", "operation", "state"], "Todo state entry");
    if (value.version !== 2) throw new Error("Todo state entry version must be 2.");
    const sequence = safeInteger(value.sequence, "Todo state sequence");
    if (value.source !== "command" && value.source !== "service") throw new Error("Todo state source is invalid.");
    if (value.operation !== "clear" && !TODO_MUTATION_OPERATIONS.includes(value.operation as never)) {
      throw new Error("Todo state operation is invalid.");
    }
    const operation = value.operation as TodoStateEntryOperation;
    if (value.source === "command" && operation !== "clear" && operation !== "reopen") {
      throw new Error("Todo command state operation is invalid.");
    }
    if (value.source === "service" && operation === "clear") {
      throw new Error("Todo service state operation is invalid.");
    }
    const state = decodeEntryState(value.state, sequence, "Todo");
    if (operation === "clear" && state !== null) throw new Error("Todo clear entries require a null state.");
    if (operation !== "clear" && state === null) throw new Error("Todo mutation entries require a non-empty state.");
    return {
      kind: "valid",
      value: Object.freeze({ version: 2, sequence, source: value.source, operation, state }),
    };
  } catch (error) {
    return { kind: "malformed", reason: error instanceof Error ? error.message : "Todo state entry is invalid." };
  }
}

export function buildTodoToolDetails(
  snapshot: TodoSnapshot,
  op: TodoOperation,
  changedTaskIds: readonly number[],
  view?: Pick<TodoViewOutputLike, "page" | "truncation">,
): TodoToolDetails {
  const details: TodoToolDetails = Object.freeze({
    kind: TODO_TOOL_DETAILS_KIND,
    version: 1,
    sequence: snapshot.sequence,
    op,
    boardId: snapshot.state?.boardId ?? null,
    revision: snapshot.state?.revision ?? null,
    changedTaskIds: Object.freeze([...changedTaskIds]),
    counts: todoCounts(snapshot.state),
    state: snapshot.state,
    ...(view?.page === undefined ? {} : { page: view.page }),
    ...(view?.truncation === undefined ? {} : { truncation: view.truncation }),
  });
  const decoded = decodeTodoToolDetails(details);
  if (decoded.kind !== "valid") {
    throw new Error(decoded.kind === "malformed" ? decoded.reason : "Todo tool details failed validation.");
  }
  return details;
}

interface TodoViewOutputLike {
  readonly page: TodoPage;
  readonly truncation?: TodoTruncation;
}

export function buildTodoStateEntry(
  source: TodoStateEntrySource,
  operation: TodoStateEntryOperation,
  snapshot: TodoSnapshot,
): TodoStateEntry {
  const entry: TodoStateEntry = Object.freeze({
    version: 2,
    sequence: snapshot.sequence,
    source,
    operation,
    state: snapshot.state,
  });
  const decoded = decodeTodoStateEntry(entry);
  if (decoded.kind !== "valid") throw new Error(decoded.reason);
  return entry;
}

function applySnapshot(
  current: TodoSnapshot,
  candidate: TodoSnapshot,
): { snapshot: TodoSnapshot; conflict: boolean } {
  if (candidate.sequence < current.sequence) return { snapshot: current, conflict: false };
  if (candidate.sequence > current.sequence) return { snapshot: candidate, conflict: false };
  if (todoStatesEqual(candidate.state, current.state)) return { snapshot: current, conflict: false };
  return { snapshot: current, conflict: true };
}

function futureCustomVersion(customType: string): { kind: "foreign" | "malformed" | "future"; version?: number } {
  if (!customType.startsWith("todo-state-v")) return { kind: "foreign" };
  const suffix = customType.slice("todo-state-v".length);
  if (!/^[1-9]\d*$/u.test(suffix)) return { kind: "malformed" };
  const version = Number(suffix);
  if (!Number.isSafeInteger(version)) return { kind: "malformed" };
  return version > 2 ? { kind: "future", version } : { kind: "malformed" };
}

export function restoreTodoSnapshot(entries: readonly unknown[]): TodoRestoreResult {
  let snapshot = freezeTodoSnapshot({ sequence: 0, state: null });
  let warned = false;
  let futureVersion: number | undefined;

  function accept(candidate: TodoSnapshot): void {
    const applied = applySnapshot(snapshot, candidate);
    snapshot = applied.snapshot;
    if (applied.conflict) warned = true;
  }

  for (const entryValue of entries) {
    if (!isRecord(entryValue)) continue;
    if (entryValue.type === "message" && isRecord(entryValue.message)) {
      const message = entryValue.message;
      if (message.role !== "toolResult" || message.toolName !== "todo") continue;
      if (message.isError !== false) {
        if (message.isError !== true) warned = true;
        continue;
      }
      const decoded = decodeTodoToolDetails(message.details);
      if (decoded.kind === "valid") accept(freezeTodoSnapshot({ sequence: decoded.value.sequence, state: decoded.value.state }));
      else if (decoded.kind === "unsupported") futureVersion = Math.max(futureVersion ?? 0, decoded.version);
      else if (decoded.kind === "malformed") warned = true;
      continue;
    }
    if (entryValue.type !== "custom" || typeof entryValue.customType !== "string") continue;
    if (entryValue.customType === LEGACY_TODO_STATE_TYPE || entryValue.customType === TODO_STATE_TYPE) {
      const decoded = entryValue.customType === LEGACY_TODO_STATE_TYPE
        ? decodeLegacyTodoCommandEntry(entryValue.data)
        : decodeTodoStateEntry(entryValue.data);
      if (decoded.kind === "valid") accept(freezeTodoSnapshot({ sequence: decoded.value.sequence, state: decoded.value.state }));
      else warned = true;
      continue;
    }
    const classified = futureCustomVersion(entryValue.customType);
    if (classified.kind === "future") futureVersion = Math.max(futureVersion ?? 0, classified.version ?? 0);
    else if (classified.kind === "malformed") warned = true;
  }

  return Object.freeze({
    snapshot,
    ...(warned ? { warning: "Some Todo records were ignored because they were malformed or conflicted." } : {}),
    ...(futureVersion === undefined ? {} : { blockedReason: `Todo state uses unsupported version v${futureVersion}.` }),
  });
}
