import { formatSize, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { tone } from "pi-uikit-dev";
import {
  DEFAULT_VIEW_LIMIT,
  MAX_MODEL_OUTPUT_BYTES,
  MAX_MODEL_OUTPUT_LINES,
  MAX_WIDGET_ROWS,
  allTodoTasks,
  findTodoTask,
  todoBoardStatus,
  todoCounts,
  type TodoCounts,
  type TodoPhase,
  type TodoSnapshot,
  type TodoState,
  type TodoStatus,
  type TodoTask,
  type TodoTransition,
} from "./state.ts";

export type TodoOperation =
  | "init"
  | "append"
  | "start"
  | "done"
  | "block"
  | "drop"
  | "reopen"
  | "edit"
  | "get"
  | "view";

export interface TodoViewQuery {
  readonly phase: string | null;
  readonly includeClosed: boolean;
  readonly offset: number;
  readonly limit: number;
}

export interface TodoPage {
  readonly phase: string | null;
  readonly includeClosed: boolean;
  readonly offset: number;
  readonly requestedLimit: number;
  readonly returned: number;
  readonly matched: number;
  readonly nextOffset?: number;
}

export interface TodoTruncation {
  readonly truncatedBy: "lines" | "bytes";
  readonly totalLines: number;
  readonly totalBytes: number;
  readonly outputLines: number;
  readonly outputBytes: number;
}

export interface TodoViewOutput {
  readonly text: string;
  readonly page: TodoPage;
  readonly truncation?: TodoTruncation;
}

export interface TodoFooter {
  readonly text: string;
  readonly color: "accent" | "warning" | "success" | "muted";
}

interface LocatedTask {
  readonly phase: TodoPhase;
  readonly task: TodoTask;
}

const TASK_SYMBOL: Readonly<Record<TodoStatus, string>> = {
  pending: "○",
  inProgress: "→",
  blocked: "!",
  completed: "✓",
  dropped: "×",
};

export const MAX_SETTLED_RECAP_TASKS = 20;
export const MAX_SETTLED_RECAP_BYTES = 4 * 1024;

function textMetrics(lines: readonly string[]): { lines: number; bytes: number } {
  return {
    lines: lines.length,
    bytes: Buffer.byteLength(lines.join("\n"), "utf8"),
  };
}

function shortBoardId(boardId: string): string {
  return boardId.length <= 8 ? boardId : `${boardId.slice(0, 8)}…`;
}

function progressText(counts: TodoCounts): string {
  return `${counts.completed}/${counts.total} completed · ${counts.blocked} blocked · ${counts.dropped} dropped`;
}

function taskDetail(task: TodoTask): string {
  return task.statusDetail === undefined ? "" : `: ${task.statusDetail}`;
}

function plainTaskLine(task: TodoTask): string {
  return `${TASK_SYMBOL[task.status]} #${task.id} ${task.content} [${task.status}${taskDetail(task)}]`;
}

function matchingTasks(state: TodoState | null, query: TodoViewQuery): LocatedTask[] {
  if (!state) return [];
  const matches: LocatedTask[] = [];
  for (const phase of state.phases) {
    if (query.phase !== null && phase.name !== query.phase) continue;
    for (const task of phase.tasks) {
      if (!query.includeClosed && (task.status === "completed" || task.status === "dropped")) continue;
      matches.push({ phase, task });
    }
  }
  return matches;
}

function viewLines(
  snapshot: TodoSnapshot,
  query: TodoViewQuery,
  matches: readonly LocatedTask[],
  displayed: readonly LocatedTask[],
  truncationNotice?: string,
): string[] {
  const state = snapshot.state;
  if (!state) {
    return ["Todo board is empty.", "Page: 0 shown of 0 matched · end"];
  }
  const counts = todoCounts(state);
  const lines = [
    `Todo board ${shortBoardId(state.boardId)} · revision ${state.revision}`,
    `Progress: ${progressText(counts)}`,
    "",
  ];
  let previousPhase: string | undefined;
  for (const located of displayed) {
    if (located.phase.name !== previousPhase) {
      if (previousPhase !== undefined) lines.push("");
      lines.push(located.phase.name);
      previousPhase = located.phase.name;
    }
    lines.push(plainTaskLine(located.task));
  }
  if (displayed.length === 0) lines.push("No matching Todo tasks.");
  const returned = displayed.length;
  const nextOffset = query.offset + returned < matches.length ? query.offset + returned : undefined;
  lines.push("");
  lines.push(`Page: ${returned} shown of ${matches.length} matched · ${nextOffset === undefined ? "end" : `next offset ${nextOffset}`}`);
  if (!query.includeClosed && counts.completed + counts.dropped > 0) {
    lines.push(`Closed items hidden: ${counts.completed + counts.dropped}. Use includeClosed:true or todo get by id.`);
  }
  if (nextOffset !== undefined) {
    const phaseArgument = query.phase === null ? "" : ` phase:${JSON.stringify(query.phase)}`;
    lines.push(
      `Continue with todo view${phaseArgument} includeClosed:${query.includeClosed} offset:${nextOffset} limit:${query.limit}; restart at offset 0 if board/revision changed.`,
    );
  }
  if (truncationNotice !== undefined) lines.push(truncationNotice);
  return lines;
}

export function buildTodoView(snapshot: TodoSnapshot, query: TodoViewQuery): TodoViewOutput {
  const matches = matchingTasks(snapshot.state, query);
  if (query.offset > matches.length) throw new Error("Todo view offset must not exceed the matched task count.");
  const requested = matches.slice(query.offset, query.offset + query.limit);
  const fullLines = viewLines(snapshot, query, matches, requested);
  const fullMetrics = textMetrics(fullLines);
  const exceedsLimit = fullLines.length > MAX_MODEL_OUTPUT_LINES || fullMetrics.bytes > MAX_MODEL_OUTPUT_BYTES;
  const truncatedBy: TodoTruncation["truncatedBy"] = fullLines.length > MAX_MODEL_OUTPUT_LINES ? "lines" : "bytes";
  const truncationNotice = exceedsLimit
    ? `[Todo output truncated by ${truncatedBy}: requested page is ${fullMetrics.lines} lines / ${formatSize(fullMetrics.bytes)}; limit is ${MAX_MODEL_OUTPUT_LINES} lines / ${formatSize(MAX_MODEL_OUTPUT_BYTES)}.]`
    : undefined;
  let displayedCount = requested.length;
  let outputLines = exceedsLimit
    ? viewLines(snapshot, query, matches, requested, truncationNotice)
    : fullLines;
  while (
    displayedCount > 0 &&
    (outputLines.length > MAX_MODEL_OUTPUT_LINES || textMetrics(outputLines).bytes > MAX_MODEL_OUTPUT_BYTES)
  ) {
    displayedCount -= 1;
    outputLines = viewLines(snapshot, query, matches, requested.slice(0, displayedCount), truncationNotice);
  }
  const outputMetrics = textMetrics(outputLines);
  if (outputLines.length > MAX_MODEL_OUTPUT_LINES || outputMetrics.bytes > MAX_MODEL_OUTPUT_BYTES) {
    throw new Error("Todo view metadata exceeds the model output limit.");
  }
  const page: TodoPage = Object.freeze({
    phase: query.phase,
    includeClosed: query.includeClosed,
    offset: query.offset,
    requestedLimit: query.limit,
    returned: displayedCount,
    matched: matches.length,
    ...(query.offset + displayedCount < matches.length ? { nextOffset: query.offset + displayedCount } : {}),
  });
  const wasTruncated = displayedCount < requested.length;
  const truncation = wasTruncated
    ? Object.freeze({
        truncatedBy,
        totalLines: fullMetrics.lines,
        totalBytes: fullMetrics.bytes,
        outputLines: outputMetrics.lines,
        outputBytes: outputMetrics.bytes,
      })
    : undefined;
  return Object.freeze({
    text: outputLines.join("\n"),
    page,
    ...(truncation === undefined ? {} : { truncation }),
  });
}

export function defaultTodoViewQuery(): TodoViewQuery {
  return Object.freeze({ phase: null, includeClosed: false, offset: 0, limit: DEFAULT_VIEW_LIMIT });
}

export function buildTodoGet(snapshot: TodoSnapshot, id: number): string {
  const state = snapshot.state;
  if (!state) throw new Error("Todo get requires an active board.");
  const located = findTodoTask(state, id);
  if (!located) throw new Error(`Todo task #${id} does not exist on the current board.`);
  const task = located.task;
  const lines = [
    `Todo #${task.id} · ${located.phase.name}`,
    plainTaskLine(task),
    `Created: ${task.createdAt} · Updated: ${task.updatedAt}`,
  ];
  if (task.completedAt !== undefined) lines.push(`Completed: ${task.completedAt}`);
  return lines.join("\n");
}

function activeTask(state: TodoState | null): TodoTask | undefined {
  return state ? allTodoTasks(state).find((task) => task.status === "inProgress") : undefined;
}

function settledRecapLines(state: TodoState): string[] {
  const closed = allTodoTasks(state);
  const lines = ["Settled recap:"];
  let bytes = 0;
  let shown = 0;
  for (const task of closed) {
    if (shown >= MAX_SETTLED_RECAP_TASKS) break;
    const line = plainTaskLine(task);
    const lineBytes = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + lineBytes > MAX_SETTLED_RECAP_BYTES) break;
    lines.push(line);
    bytes += lineBytes;
    shown += 1;
  }
  if (closed.length > shown) {
    lines.push(`… ${closed.length - shown} more closed tasks; use todo view includeClosed:true.`);
  }
  return lines;
}

export function buildTodoMutationText(
  op: Exclude<TodoOperation, "get" | "view">,
  snapshot: TodoSnapshot,
  transition: TodoTransition,
): string {
  const state = snapshot.state;
  const counts = todoCounts(state);
  const primaryId = transition.effect.kind === "statusChanged" || transition.effect.kind === "edited"
    ? transition.effect.id
    : transition.effect.kind === "appended" || transition.effect.kind === "bulkDropped"
      ? transition.effect.ids[0]
      : undefined;
  const primary = state && primaryId !== undefined ? findTodoTask(state, primaryId)?.task : undefined;
  let first: string;
  switch (transition.effect.kind) {
    case "initialized":
      first = `Initialized Todo board with ${counts.total} tasks.`;
      break;
    case "appended":
      first = `Appended ${transition.effect.ids.length} Todo task${transition.effect.ids.length === 1 ? "" : "s"}.`;
      break;
    case "statusChanged":
      first = `${op === "done" ? "Completed" : op === "block" ? "Blocked" : op === "drop" ? "Dropped" : op === "reopen" ? "Reopened" : "Started"} #${transition.effect.id}${primary ? `: ${primary.content}` : ""}.`;
      break;
    case "bulkDropped":
      first = `Dropped ${transition.effect.ids.length} Todo tasks: ${transition.effect.ids.map((droppedId) => `#${droppedId}`).join(", ")}.`;
      break;
    case "edited":
      first = `Edited Todo #${transition.effect.id}${primary ? `: ${primary.content}` : ""}.`;
      break;
    case "noChange":
      first = "No Todo state change.";
      break;
    case "cleared":
      first = "Cleared Todo board.";
      break;
  }
  const lines = [first, `Progress: ${progressText(counts)}.`];
  const active = activeTask(state);
  if (active) lines.push(`Active: #${active.id} ${active.content}.`);
  else if (state && todoBoardStatus(state) === "blocked") lines.push(`No runnable task; ${counts.blocked} blocked.`);
  else if (state && todoBoardStatus(state) === "settled") {
    lines.push("Todo board settled.");
    if (transition.effect.kind === "statusChanged" || transition.effect.kind === "bulkDropped") lines.push(...settledRecapLines(state));
  }
  return lines.join("\n");
}

export function todoFooter(state: TodoState | null): TodoFooter | undefined {
  if (!state) return undefined;
  const counts = todoCounts(state);
  const boardStatus = todoBoardStatus(state);
  if (boardStatus === "active") {
    const active = activeTask(state);
    return {
      text: `Todo ${counts.completed}/${counts.total}${active ? ` · #${active.id} ${active.content}` : ""}`,
      color: "accent",
    };
  }
  if (boardStatus === "blocked") {
    return { text: `Todo ${counts.completed}/${counts.total} · ${counts.blocked} blocked`, color: "warning" };
  }
  return {
    text: `Todo ${counts.completed}/${counts.total} · settled${counts.dropped > 0 ? ` · ${counts.dropped} dropped` : ""}`,
    color: counts.dropped === 0 ? "success" : "muted",
  };
}

function coloredTaskLine(task: TodoTask, theme: Theme): string {
  const symbolColor = task.status === "inProgress"
    ? "accent"
    : task.status === "blocked"
      ? "warning"
      : task.status === "completed"
        ? "success"
        : task.status === "dropped"
          ? "muted"
          : "dim";
  const textColor = task.status === "inProgress" ? "text" : task.status === "blocked" ? "warning" : "muted";
  const detail = task.status === "blocked" && task.statusDetail ? ` — ${task.statusDetail}` : "";
  return `${tone(theme, symbolColor, TASK_SYMBOL[task.status])} ${tone(theme, "accent", `#${task.id}`)} ${tone(theme, textColor, `${task.content}${detail}`)}`;
}

export function todoWidget(state: TodoState, theme: Theme, width = 120): string[] {
  const counts = todoCounts(state);
  const tasks = allTodoTasks(state);
  const active = tasks.find((task) => task.status === "inProgress");
  const ordered: TodoTask[] = [];
  if (active) ordered.push(active);
  for (const task of tasks) {
    if (task.status === "pending") ordered.push(task);
  }
  for (const task of tasks) {
    if (task.status === "blocked") ordered.push(task);
  }
  const headingTask = active ?? ordered[0] ?? tasks.at(-1);
  const phaseName = headingTask === undefined ? undefined : findTodoTask(state, headingTask.id)?.phase.name;
  const heading = tone(
    theme,
    todoBoardStatus(state) === "blocked" ? "warning" : todoBoardStatus(state) === "settled" ? "success" : "accent",
    `Todo${phaseName === undefined ? "" : ` · ${phaseName}`} · ${progressText(counts)}`,
  );
  const lines = [truncateToWidth(heading, width, "")];
  const availableTaskRows = Math.max(0, MAX_WIDGET_ROWS - 1);
  const needsSummary = ordered.length > availableTaskRows;
  const visibleCount = needsSummary ? Math.max(0, availableTaskRows - 1) : availableTaskRows;
  for (const task of ordered.slice(0, visibleCount)) {
    lines.push(truncateToWidth(coloredTaskLine(task, theme), width, ""));
  }
  if (needsSummary) lines.push(tone(theme, "dim", `… ${ordered.length - visibleCount} more`));
  return lines.slice(0, MAX_WIDGET_ROWS);
}

export function todoDialogTaskLine(task: TodoTask, theme: Theme, width: number): string {
  return truncateToWidth(coloredTaskLine(task, theme), width, "");
}
