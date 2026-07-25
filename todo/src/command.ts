import type {
  ExtensionAPI,
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, type Component, type Keybinding, type KeyId, type TUI } from "@earendil-works/pi-tui";
import {
  MAX_VIEW_LIMIT,
  allTodoTasks,
  normalizeTaskId,
  todoCounts,
  transitionTodo,
  type TodoSnapshot,
  type TodoState,
  type TodoTransition,
} from "./state.ts";
import { buildTodoView, todoDialogTaskLine } from "./output.ts";

export interface TodoCommandRuntime {
  getSnapshot(): TodoSnapshot;
  assertAvailable(): void;
  assertMutationAllowed(): void;
  commitCommand(action: "clear" | "reopen", transition: TodoTransition, ctx: ExtensionCommandContext): TodoSnapshot;
  isPlanActive(): boolean;
  getWidgetVisible(): boolean;
  setWidgetVisible(visible: boolean, ctx: ExtensionCommandContext): void;
  refreshUi(ctx: ExtensionCommandContext): void;
  now(): number;
  createBoardId(): string;
}

class TodoBoardComponent implements Component {
  private offset = 0;
  private cachedWidth: number | undefined;
  private cachedLines: string[] | undefined;

  constructor(
    private readonly state: TodoState | null,
    private readonly frozenByPlan: boolean,
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly close: () => void,
  ) {}

  private matches(data: string, id: Keybinding, fallback: KeyId): boolean {
    return this.keybindings.matches(data, id) || matchesKey(data, fallback);
  }

  private bodyRows(): number {
    return Math.max(3, Math.min(20, this.tui.terminal.rows - 8));
  }

  private requestRefresh(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.close();
      return;
    }
    const total = this.state ? allTodoTasks(this.state).length : 0;
    const page = this.bodyRows();
    if (this.matches(data, "tui.select.up", "up")) this.offset = Math.max(0, this.offset - 1);
    else if (this.matches(data, "tui.select.down", "down")) this.offset = Math.min(Math.max(0, total - page), this.offset + 1);
    else if (this.matches(data, "tui.select.pageUp", "pageUp")) this.offset = Math.max(0, this.offset - page);
    else if (this.matches(data, "tui.select.pageDown", "pageDown")) {
      this.offset = Math.min(Math.max(0, total - page), this.offset + page);
    } else return;
    this.requestRefresh();
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const safeWidth = Math.max(1, width);
    const lines = [
      "",
      truncateToWidth(
        this.theme.fg("borderMuted", "───") +
          this.theme.fg("accent", this.theme.bold(" Todos ")) +
          this.theme.fg("borderMuted", "─".repeat(Math.max(0, safeWidth - 10))),
        safeWidth,
        "",
      ),
    ];
    if (this.frozenByPlan) lines.push(truncateToWidth(this.theme.fg("warning", "  Frozen while Plan is active"), safeWidth, ""));
    if (!this.state) {
      lines.push("", truncateToWidth(this.theme.fg("dim", "  No Todo board on this branch."), safeWidth, ""));
    } else {
      const counts = todoCounts(this.state);
      lines.push(
        "",
        truncateToWidth(
          this.theme.fg("muted", `  ${counts.completed}/${counts.total} completed · ${counts.blocked} blocked · ${counts.dropped} dropped`),
          safeWidth,
          "",
        ),
        "",
      );
      const located = this.state.phases.flatMap((phase) => phase.tasks.map((task) => ({ phase: phase.name, task })));
      const page = located.slice(this.offset, this.offset + this.bodyRows());
      let priorPhase: string | undefined;
      for (const item of page) {
        if (item.phase !== priorPhase) {
          lines.push(truncateToWidth(this.theme.fg("muted", `  ${item.phase}`), safeWidth, ""));
          priorPhase = item.phase;
        }
        lines.push(`  ${todoDialogTaskLine(item.task, this.theme, Math.max(1, safeWidth - 2))}`);
      }
      if (located.length > page.length) {
        lines.push(truncateToWidth(this.theme.fg("dim", `  ${this.offset + 1}-${this.offset + page.length} of ${located.length}`), safeWidth, ""));
      }
    }
    lines.push("", truncateToWidth(this.theme.fg("dim", "  ↑/↓ scroll · Escape close"), safeWidth, ""), "");
    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

async function stopCurrentAgent(ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.isIdle()) return;
  ctx.abort();
  await ctx.waitForIdle();
}

function requireUiMode(ctx: ExtensionCommandContext, operation: string): void {
  if ((ctx.mode !== "tui" && ctx.mode !== "rpc") || !ctx.hasUI) {
    throw new Error(`/todos ${operation} requires TUI or dialog-capable RPC mode.`);
  }
}

function parseReopen(args: string): { id: number; reason: string } {
  const match = /^reopen\s+([1-9]\d*)\s+(.+)$/u.exec(args);
  if (!match) throw new Error("Usage: /todos reopen <id> <reason>");
  const idText = match[1];
  const reason = match[2];
  if (idText === undefined || reason === undefined) throw new Error("Usage: /todos reopen <id> <reason>");
  const id = Number(idText);
  normalizeTaskId(id);
  return { id, reason };
}

async function showStatus(ctx: ExtensionCommandContext, runtime: TodoCommandRuntime): Promise<void> {
  const snapshot = runtime.getSnapshot();
  if (ctx.mode === "tui") {
    await ctx.ui.custom<void>((tui, theme, keybindings, done) => new TodoBoardComponent(
      snapshot.state,
      runtime.isPlanActive(),
      tui,
      theme,
      keybindings,
      () => done(),
    ));
    return;
  }
  if (ctx.mode === "rpc" && ctx.hasUI) {
    const output = buildTodoView(snapshot, { phase: null, includeClosed: true, offset: 0, limit: MAX_VIEW_LIMIT });
    ctx.ui.notify(`${runtime.isPlanActive() ? "Frozen while Plan is active.\n" : ""}${output.text}`, "info");
    return;
  }
  throw new Error("/todos status is unavailable in print/JSON mode; use the todo view tool result instead.");
}

export function registerTodoCommand(pi: ExtensionAPI, runtime: TodoCommandRuntime): void {
  pi.registerCommand("todos", {
    description: "Inspect, show, hide, clear, or reopen the current branch Todo board",
    getArgumentCompletions: (prefix) => {
      const values = ["status", "show", "hide", "toggle", "clear", "reopen"];
      const normalized = prefix.trim();
      const matches = values.filter((value) => value.startsWith(normalized));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const normalized = args.trim();
      runtime.assertAvailable();
      if (!normalized || normalized === "status") {
        await showStatus(ctx, runtime);
        return;
      }
      if (normalized === "show" || normalized === "hide" || normalized === "toggle") {
        requireUiMode(ctx, normalized);
        const visible = normalized === "show" ? true : normalized === "hide" ? false : !runtime.getWidgetVisible();
        runtime.setWidgetVisible(visible, ctx);
        ctx.ui.notify(`Todo widget ${visible ? "shown" : "hidden"}.`, "info");
        return;
      }
      if (normalized === "clear") {
        runtime.assertMutationAllowed();
        if (!runtime.getSnapshot().state) {
          if (ctx.hasUI) ctx.ui.notify("No Todo board is set.", "info");
          return;
        }
        requireUiMode(ctx, "clear");
        await stopCurrentAgent(ctx);
        runtime.assertAvailable();
        runtime.assertMutationAllowed();
        const current = runtime.getSnapshot();
        if (!current.state) return;
        const counts = todoCounts(current.state);
        const confirmed = await ctx.ui.confirm(
          "Clear Todo board?",
          `This removes the current projection of ${counts.total} persisted task${counts.total === 1 ? "" : "s"}. Session history remains available.`,
        );
        if (!confirmed) {
          ctx.ui.notify("Todo board unchanged.", "info");
          return;
        }
        const transition = transitionTodo(current.state, { op: "clear" }, runtime.now(), runtime.createBoardId);
        runtime.commitCommand("clear", transition, ctx);
        ctx.ui.notify("Todo board cleared.", "info");
        return;
      }
      if (normalized.startsWith("reopen")) {
        const parsed = parseReopen(normalized);
        runtime.assertMutationAllowed();
        await stopCurrentAgent(ctx);
        runtime.assertAvailable();
        runtime.assertMutationAllowed();
        const current = runtime.getSnapshot();
        const transition = transitionTodo(
          current.state,
          { op: "reopen", id: parsed.id, reason: parsed.reason },
          runtime.now(),
          runtime.createBoardId,
        );
        runtime.commitCommand("reopen", transition, ctx);
        if (ctx.hasUI) ctx.ui.notify(`Todo #${parsed.id} reopened.`, "info");
        return;
      }
      throw new Error("Usage: /todos [status|show|hide|toggle|clear|reopen <id> <reason>]");
    },
  });
}
