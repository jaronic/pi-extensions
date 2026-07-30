import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  DEFAULT_VIEW_LIMIT,
  MAX_VIEW_LIMIT,
  findTodoTask,
  freezeTodoSnapshot,
  incrementSafeInteger,
  normalizePhaseName,
  normalizeTaskId,
  todoCounts,
  transitionTodo,
  type TodoSnapshot,
  type TodoTransitionInput,
} from "./state.ts";
import {
  TODO_PROMPT_GUIDELINES,
} from "./prompts.ts";
import {
  buildTodoGet,
  buildTodoMutationText,
  buildTodoView,
  type TodoOperation,
  type TodoViewQuery,
} from "./output.ts";
import {
  buildTodoToolDetails,
  decodeTodoToolDetails,
  type TodoToolDetails,
} from "./persistence.ts";
import { TODO_OPERATIONS, TodoParams } from "./tool-schema.ts";

export type TodoMutationOperation = Exclude<TodoOperation, "get" | "view">;

export interface TodoToolRuntime {
  getSnapshot(): TodoSnapshot;
  assertAvailable(): void;
  assertMutationAllowed(): void;
  commitTool(snapshot: TodoSnapshot, ctx: ExtensionContext, op: TodoMutationOperation): void;
  now(): number;
  createBoardId(): string;
}

const MUTATION_OPERATIONS: readonly TodoMutationOperation[] = [
  "init",
  "append",
  "start",
  "done",
  "block",
  "drop",
  "reopen",
  "edit",
];

const TODO_PARAM_KEYS = new Set([
  "op",
  "list",
  "phase",
  "items",
  "id",
  "content",
  "reason",
  "note",
  "includeClosed",
  "offset",
  "limit",
]);


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateOperationParams(value: unknown): { op: TodoOperation; record: Record<string, unknown> } {
  if (!isRecord(value) || typeof value.op !== "string" || !TODO_OPERATIONS.includes(value.op as TodoOperation)) {
    throw new Error("Todo op is required and must be a supported operation.");
  }
  if (Object.keys(value).some((key) => !TODO_PARAM_KEYS.has(key))) {
    throw new Error("Todo operation contains an unknown field.");
  }
  const op = value.op as TodoOperation;
  const required: Readonly<Record<TodoOperation, readonly string[]>> = {
    init: ["list"],
    append: ["phase", "items"],
    start: ["id"],
    done: ["id"],
    block: ["id", "reason"],
    drop: ["id", "reason"],
    reopen: ["id", "reason"],
    edit: ["id", "content"],
    get: ["id"],
    view: [],
  };
  if (required[op].some((key) => !(key in value) || value[key] === null)) {
    throw new Error(`Todo ${op} is missing a required field.`);
  }
  return { op, record: value };
}

function transitionInput(op: TodoOperation, record: Record<string, unknown>): TodoTransitionInput {
  switch (op) {
    case "init":
      return { op, list: record.list as TodoTransitionInput & never } as TodoTransitionInput;
    case "append":
      return { op, phase: record.phase, items: record.items as readonly unknown[] };
    case "start":
      return { op, id: record.id };
    case "done":
      return { op, id: record.id, ...(record.note === undefined || record.note === null ? {} : { note: record.note }) };
    case "block":
    case "drop":
    case "reopen":
      return { op, id: record.id, reason: record.reason };
    case "edit":
      return { op, id: record.id, content: record.content };
    case "get":
    case "view":
      throw new Error(`Todo ${op} is read-only and has no transition input.`);
  }
}

function normalizedViewQuery(record: Record<string, unknown>, snapshot: TodoSnapshot): TodoViewQuery {
  const phase = record.phase === undefined || record.phase === null
    ? null
    : normalizePhaseName(record.phase, "Todo view phase");
  if (phase !== null && (!snapshot.state || !snapshot.state.phases.some((candidate) => candidate.name === phase))) {
    throw new Error("Todo view phase does not exist on the current board.");
  }
  if (record.includeClosed !== undefined && record.includeClosed !== null && typeof record.includeClosed !== "boolean") {
    throw new Error("Todo view includeClosed must be boolean or null.");
  }
  const offset = record.offset === undefined || record.offset === null ? 0 : record.offset;
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new Error("Todo view offset must be a non-negative safe integer or null.");
  const limit = record.limit === undefined || record.limit === null ? DEFAULT_VIEW_LIMIT : record.limit;
  if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_VIEW_LIMIT) {
    throw new Error(`Todo view limit must be null or an integer from 1 to ${MAX_VIEW_LIMIT}.`);
  }
  return Object.freeze({
    phase,
    includeClosed: record.includeClosed === true,
    offset: offset as number,
    limit: limit as number,
  });
}

function activeSummary(details: TodoToolDetails): string {
  const counts = details.counts;
  const progress = `${counts.completed}/${counts.total} complete · ${counts.blocked} blocked · ${counts.dropped} dropped`;
  if (!details.state) return `Todo empty · ${progress}`;
  const active = details.state.phases.flatMap((phase) => phase.tasks).find((task) => task.status === "inProgress");
  return active ? `${progress} · active #${active.id} ${active.content}` : progress;
}

function changedPhaseSummary(details: TodoToolDetails): string | undefined {
  if (!details.state || details.changedTaskIds.length === 0) return undefined;
  const changed = new Set(details.changedTaskIds);
  const phases = details.state.phases
    .filter((phase) => phase.tasks.some((task) => changed.has(task.id)))
    .map((phase) => phase.name);
  if (phases.length === 0) return undefined;
  return `${phases.length === 1 ? "Phase" : "Phases"}: ${phases.join(", ")}.`;
}

function firstText(result: { content: readonly { type: string; text?: string }[] }): string {
  const first = result.content[0];
  return first?.type === "text" && typeof first.text === "string" ? first.text.slice(0, 1_000) : "Todo operation failed.";
}

export interface TodoOperationResult {
  readonly content: [{ readonly type: "text"; readonly text: string }];
  readonly details: TodoToolDetails;
}

export function executeTodoOperation(
  runtime: TodoToolRuntime,
  params: unknown,
  signal: AbortSignal | undefined,
  ctx: ExtensionContext,
): TodoOperationResult {
  signal?.throwIfAborted();
  runtime.assertAvailable();
  const { op, record } = validateOperationParams(params);
  const current = runtime.getSnapshot();

  if (op === "get") {
    const id = normalizeTaskId(record.id);
    const text = buildTodoGet(current, id);
    signal?.throwIfAborted();
    return {
      content: [{ type: "text", text }],
      details: buildTodoToolDetails(current, op, []),
    };
  }

  if (op === "view") {
    const query = normalizedViewQuery(record, current);
    const output = buildTodoView(current, query);
    signal?.throwIfAborted();
    return {
      content: [{ type: "text", text: output.text }],
      details: buildTodoToolDetails(current, op, [], output),
    };
  }

  runtime.assertMutationAllowed();
  if (!MUTATION_OPERATIONS.includes(op)) throw new Error(`Todo ${op} is not a mutation.`);
  const transition = transitionTodo(current.state, transitionInput(op, record), runtime.now(), runtime.createBoardId);
  const next = transition.effect.kind === "noChange"
    ? current
    : freezeTodoSnapshot({ sequence: incrementSafeInteger(current.sequence, "Todo sequence"), state: transition.state });
  const details = buildTodoToolDetails(next, op, transition.changedTaskIds);
  const text = buildTodoMutationText(op, next, transition);
  signal?.throwIfAborted();
  runtime.commitTool(next, ctx, op);
  return { content: [{ type: "text", text }], details };
}

export function registerTodoTool(pi: ExtensionAPI, runtime: TodoToolRuntime): void {
  pi.registerTool({
    name: "todo",
    label: "Todo",
    description:
      "Globally available, branch-local Todo execution ledger: it organizes multi-step work into ordered phases and tasks with stable numeric #IDs, keeps at most one task inProgress, and preserves done/blocked/dropped/reopened transitions across turns, compaction, and reloads. Plan approval hands its approved steps onto this same board, and other extensions share it through a versioned service. Judge for yourself when tracking work here adds value — typically multi-step execution or when the user asks to track a checklist.",
    promptSnippet: "Track an execution-ready branch-local checklist with one active task",
    promptGuidelines: [
      "Use the todo tool for branch-local execution tracking whenever you judge a persistent checklist adds value; after Plan approval, continuing through the transferred board is mandatory, not optional.",
      ...TODO_PROMPT_GUIDELINES,
    ],
    parameters: TodoParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return executeTodoOperation(runtime, params, signal, ctx);
    },
    renderCall(args, theme) {
      const op = typeof args.op === "string" && TODO_OPERATIONS.includes(args.op as TodoOperation) ? args.op : "operation";
      let suffix = "";
      if (Number.isSafeInteger(args.id) && (args.id as number) > 0) suffix = ` #${args.id}`;
      else if (op === "drop" && Array.isArray(args.id)) suffix = ` ${args.id.length} tasks`;
      else if (op === "init" && Array.isArray(args.list)) {
        const count = args.list.reduce((total, entry) => total + (Array.isArray(entry?.items) ? entry.items.length : 0), 0);
        suffix = ` ${count} item${count === 1 ? "" : "s"}`;
      } else if (op === "append" && Array.isArray(args.items)) {
        suffix = ` ${args.items.length} item${args.items.length === 1 ? "" : "s"}`;
      }
      return new Text(theme.fg("toolTitle", theme.bold("Todo")) + theme.fg("muted", ` · ${op}${suffix}`), 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      if (context.isError) return new Text(theme.fg("error", firstText(result)), 0, 0);
      const decoded = decodeTodoToolDetails(result.details);
      if (decoded.kind !== "valid") return new Text(theme.fg("error", "Todo result details are unavailable."), 0, 0);
      if (expanded) {
        const phaseSummary = changedPhaseSummary(decoded.value);
        return new Text(phaseSummary === undefined ? firstText(result) : `${firstText(result)}\n${phaseSummary}`, 0, 0);
      }
      const glyph = decoded.value.op === "view" || decoded.value.op === "get" ? "○" : "✓";
      const color = decoded.value.op === "view" || decoded.value.op === "get" ? "muted" : "success";
      return new Text(`${theme.fg(color, glyph)} ${theme.fg("text", activeSummary(decoded.value))}`, 0, 0);
    },
  });
}
