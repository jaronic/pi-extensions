import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createLoop,
  parseLoopInput,
  resumeLoop,
  setLoopStatus,
  type LoopJournalEntry,
  type LoopState,
} from "./state.ts";
import { renderLoopStatus } from "./output.ts";

export interface LoopCommandRuntime {
  getLoop(): LoopState | null;
  isAnyWorkflowActive(ctx: ExtensionContext): boolean;
  setLoop(next: LoopState | null, action: LoopJournalEntry["action"], ctx: ExtensionContext): LoopState | null;
  queueContinuation(round: number, ctx: ExtensionContext): void;
}

export function registerLoopCommand(pi: ExtensionAPI, runtime: LoopCommandRuntime): void {
  pi.registerCommand("loop", {
    description: "Run a fixed number of agent iterations toward an objective",
    getArgumentCompletions: (prefix) => {
      const values = ["status", "pause", "resume", "stop", "clear"];
      const filtered = values.filter((value) => value.startsWith(prefix.trim()));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const current = runtime.getLoop();
      if (!trimmed || trimmed === "status") {
        ctx.ui.notify(renderLoopStatus(current), "info");
        return;
      }

      if (trimmed === "clear") {
        if (!current) {
          ctx.ui.notify("No loop is active.", "info");
          return;
        }
        runtime.setLoop(null, "clear", ctx);
        await abortAndWait(ctx);
        ctx.ui.notify("Loop cleared.", "info");
        return;
      }

      if (trimmed === "pause") {
        if (!current) {
          ctx.ui.notify("No loop is active.", "warning");
          return;
        }
        if (runtime.setLoop(setLoopStatus(current, "paused", "user"), "status", ctx) === null) return;
        await abortAndWait(ctx);
        ctx.ui.notify("Loop paused.", "info");
        return;
      }

      if (trimmed === "stop") {
        if (!current) {
          ctx.ui.notify("No loop is active.", "warning");
          return;
        }
        if (runtime.setLoop(setLoopStatus(current, "stopped", "user"), "status", ctx) === null) return;
        await abortAndWait(ctx);
        ctx.ui.notify("Loop stopped.", "info");
        return;
      }

      if (trimmed === "resume") {
        if (!current) {
          ctx.ui.notify("No loop is active.", "warning");
          return;
        }
        if (current.status !== "paused") {
          ctx.ui.notify("Only a paused loop can be resumed.", "warning");
          return;
        }
        if (runtime.isAnyWorkflowActive(ctx)) {
          ctx.ui.notify("Loop cannot resume while another exclusive workflow (Goal or Plan) is active.", "warning");
          return;
        }
        const resumed = runtime.setLoop(resumeLoop(current), "status", ctx);
        if (resumed) {
          ctx.ui.notify("Loop resumed.", "info");
          runtime.queueContinuation(resumed.completedIterations + 1, ctx);
        }
        return;
      }

      let parsed;
      try {
        parsed = parseLoopInput(trimmed);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        return;
      }
      if (runtime.isAnyWorkflowActive(ctx)) {
        ctx.ui.notify("Loop cannot start while another exclusive workflow (Goal or Plan) is active.", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Loop creation requires an idle agent. Let the current run settle first, then retry.", "warning");
        return;
      }
      if (current && (current.status === "running" || current.status === "paused")) {
        if (!ctx.hasUI) {
          ctx.ui.notify("An unfinished loop exists. Stop or clear it before replacing it in non-interactive mode.", "warning");
          return;
        }
        const replace = await ctx.ui.confirm(
          "Replace unfinished loop?",
          `Current: ${current.spec.objective}\n\nNew: ${parsed.objective}`,
        );
        if (!replace) return;
      }
      if (runtime.isAnyWorkflowActive(ctx)) {
        ctx.ui.notify("Loop cannot start while another exclusive workflow (Goal or Plan) is active.", "warning");
        return;
      }
      const created = runtime.setLoop(createLoop(parsed.objective, parsed.iterations), "create", ctx);
      if (created) {
        ctx.ui.notify(`Loop active (${created.spec.iterations} iterations).`, "info");
        runtime.queueContinuation(1, ctx);
      }
    },
  });
}

async function abortAndWait(ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.isIdle()) return;
  ctx.abort();
  await ctx.waitForIdle();
}
