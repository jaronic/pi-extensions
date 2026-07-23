import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  createGoal,
  editGoal,
  parseGoalInput,
  setGoalStatus,
  statusLabel,
  type GoalJournalEntry,
  type GoalState,
} from "./state.ts";
import { goalSummary } from "./prompts.ts";

export interface GoalCommandRuntime {
  getGoal(): GoalState | null;
  setGoal(next: GoalState | null, action: GoalJournalEntry["action"], ctx: ExtensionContext): GoalState | null;
  queueContinuation(ctx: ExtensionContext, forceThroughPlan?: boolean): void;
}

async function stopCurrentAgent(ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.isIdle()) return;
  ctx.abort();
  await ctx.waitForIdle();
}

export function registerGoalCommand(pi: ExtensionAPI, runtime: GoalCommandRuntime): void {
  pi.registerCommand("goal", {
    description: "Set, inspect, edit, pause, resume, or clear a long-running goal",
    getArgumentCompletions: (prefix) => {
      const values = ["status", "edit", "pause", "resume", "clear"];
      const filtered = values.filter((value) => value.startsWith(prefix.trim()));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const current = runtime.getGoal();
      if (!trimmed || trimmed === "status") {
        ctx.ui.notify(current ? goalSummary(current) : "Usage: /goal [--tokens 50k] <objective>", "info");
        return;
      }

      if (trimmed === "clear") {
        if (!current) {
          ctx.ui.notify("No goal is set.", "info");
          return;
        }
        await stopCurrentAgent(ctx);
        runtime.setGoal(null, "clear", ctx);
        ctx.ui.notify("Goal cleared.", "info");
        return;
      }

      if (trimmed === "pause") {
        if (!current) {
          ctx.ui.notify("No goal is set.", "warning");
          return;
        }
        await stopCurrentAgent(ctx);
        const settled = runtime.getGoal();
        if (!settled) return;
        runtime.setGoal(setGoalStatus(settled, "paused"), "status", ctx);
        ctx.ui.notify("Goal paused.", "info");
        return;
      }

      if (trimmed === "resume") {
        if (!current) {
          ctx.ui.notify("No goal is set.", "warning");
          return;
        }
        await stopCurrentAgent(ctx);
        const settled = runtime.getGoal();
        if (!settled) return;
        if (settled.status === "budgetLimited") {
          ctx.ui.notify("The goal token budget is exhausted. Set a replacement goal with a new budget.", "warning");
          return;
        }
        runtime.setGoal(setGoalStatus(settled, "active"), "status", ctx);
        ctx.ui.notify("Goal resumed.", "info");
        runtime.queueContinuation(ctx, true);
        return;
      }

      if (trimmed === "edit") {
        if (!current) {
          ctx.ui.notify("No goal is set.", "warning");
          return;
        }
        if (!ctx.hasUI) {
          ctx.ui.notify("/goal edit requires dialog-capable UI. Use /goal <objective> instead.", "warning");
          return;
        }
        const resumeAfterEdit = current.status === "active";
        await stopCurrentAgent(ctx);
        const settled = runtime.getGoal();
        if (!settled) return;
        const edited = await ctx.ui.editor("Edit goal objective", settled.objective);
        if (edited === undefined) return;
        try {
          let next = editGoal(settled, edited);
          if (resumeAfterEdit && next.status === "paused") next = setGoalStatus(next, "active");
          runtime.setGoal(next, "edit", ctx);
          ctx.ui.notify(`Goal ${statusLabel(next.status)}.`, "info");
          if (next.status === "active") runtime.queueContinuation(ctx, true);
        } catch (error) {
          ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        }
        return;
      }

      let parsed;
      try {
        parsed = parseGoalInput(trimmed);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
        return;
      }
      if (current && current.status !== "complete") {
        if (!ctx.hasUI) {
          ctx.ui.notify("An unfinished goal exists. Clear it before replacing it in non-interactive mode.", "warning");
          return;
        }
        const replace = await ctx.ui.confirm("Replace active goal?", `Current: ${current.objective}\n\nNew: ${parsed.objective}`);
        if (!replace) return;
      }
      await stopCurrentAgent(ctx);
      runtime.setGoal(createGoal(parsed.objective, parsed.tokenBudget), "set", ctx);
      ctx.ui.notify("Goal active.", "info");
      runtime.queueContinuation(ctx, true);
    },
  });
}
