import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { boundPlanText, phaseLabel, renderPlan } from "./output.ts";
import {
  createPlanningState,
  type PlanJournalEntry,
  type PlanState,
} from "./state.ts";

export interface PlanCommandRuntime {
  getState(): PlanState | null;
  setState(next: PlanState): void;
  persistActive(
    action: PlanJournalEntry["action"],
    ctx: ExtensionContext,
    willTriggerTurn: boolean,
    reason: string,
  ): void;
  syncPlanTools(): void;
  updateStatus(ctx: ExtensionContext): void;
  emitPlanState(ctx: ExtensionContext, willTriggerTurn: boolean, reason: string): void;
  queueControlTurn(ctx: ExtensionContext, kind: "plan" | "refine" | "execute" | "clarification", content: string): void;
  approveAndQueue(ctx: ExtensionContext): Promise<void>;
  refineAndQueue(ctx: ExtensionContext): void;
  resumeBlockedAndQueue(ctx: ExtensionContext): void;
  choosePlanClarification(ctx: ExtensionContext, beforeTransition?: () => Promise<void>): Promise<void>;
  reviewSubmittedPlan(ctx: ExtensionContext, beforeTransition?: () => Promise<void>): Promise<void>;
  renderCurrentPlan(ctx: ExtensionContext): Promise<string>;
  transitionOff(action: "cancel" | "complete", ctx: ExtensionContext, reason: string, signal?: AbortSignal): Promise<void>;
}

async function stopCurrentAgent(ctx: ExtensionCommandContext): Promise<void> {
  if (ctx.isIdle()) return;
  ctx.abort();
  await ctx.waitForIdle();
}

export function registerPlanCommand(pi: ExtensionAPI, runtime: PlanCommandRuntime): void {
  pi.registerCommand("plan", {
    description: "Enter read-only planning, choose a pending decision, inspect or review a submission, resume planning or a blocked result, approve, refine, or cancel",
    getArgumentCompletions: (prefix) => {
      const values = ["status", "choose", "review", "resume", "approve", "refine", "cancel"];
      const filtered = values.filter((value) => value.startsWith(prefix.trim()));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim();
      const current = runtime.getState();
      if (!action && !current) {
        runtime.setState(createPlanningState(pi.getActiveTools()));
        runtime.persistActive("start", ctx, false, "planning-started");
        ctx.ui.notify("Plan mode active: workspace mutation and arbitrary shell execution are disabled. Send the request you want planned.", "info");
        await stopCurrentAgent(ctx);
        return;
      }
      if (!action || action === "status") {
        const statusText = current ? boundPlanText(await runtime.renderCurrentPlan(ctx)).text : "Plan mode is off. Use /plan to start.";
        ctx.ui.notify(statusText, "info");
        return;
      }
      if (action === "review") {
        if (!current || current.phase !== "awaitingApproval") {
          ctx.ui.notify("No submitted plan is awaiting review.", "warning");
          return;
        }
        if (ctx.mode !== "tui") {
          const reviewText = `${renderPlan(current)}\n\nUse /plan approve, /plan refine, or /plan cancel.`;
          ctx.ui.notify(boundPlanText(reviewText).text, "info");
          return;
        }
        await runtime.reviewSubmittedPlan(ctx, () => stopCurrentAgent(ctx));
        return;
      }
      if (action === "choose") {
        if (!current || current.phase !== "awaitingClarification") {
          ctx.ui.notify("No Plan choice is awaiting a decision.", "warning");
          return;
        }
        if (ctx.mode !== "tui") {
          const choiceText = `${renderPlan(current)}\n\nReply with one option number. The agent will record it with answer_plan_choice.`;
          ctx.ui.notify(boundPlanText(choiceText).text, "info");
          return;
        }
        await runtime.choosePlanClarification(ctx, () => stopCurrentAgent(ctx));
        return;
      }
      if (action === "resume") {
        if (!current) {
          ctx.ui.notify("Plan mode is off. Use /plan to start.", "warning");
          return;
        }
        if (current.phase === "blocked") {
          await stopCurrentAgent(ctx);
          const settled = runtime.getState();
          if (!settled || settled.phase !== "blocked") {
            ctx.ui.notify("Plan state changed while the current agent was settling; inspect /plan status.", "warning");
            return;
          }
          runtime.resumeBlockedAndQueue(ctx);
          ctx.ui.notify("New information accepted; Plan returned to read-only planning.", "info");
          return;
        }
        if (current.phase === "awaitingApproval") {
          ctx.ui.notify("The submitted plan needs /plan approve, /plan refine, or /plan cancel.", "warning");
          return;
        }
        if (current.phase === "awaitingClarification") {
          ctx.ui.notify("The pending Plan choice needs /plan choose or an explicit numbered reply.", "warning");
          return;
        }
        await stopCurrentAgent(ctx);
        const settled = runtime.getState();
        if (!settled) {
          ctx.ui.notify("Plan mode became inactive while the current agent was settling.", "warning");
          return;
        }
        if (settled.phase === "awaitingApproval") {
          ctx.ui.notify("The submitted plan needs /plan approve, /plan refine, or /plan cancel.", "warning");
          return;
        }
        if (settled.phase === "awaitingClarification") {
          ctx.ui.notify("The pending Plan choice needs /plan choose or an explicit numbered reply.", "warning");
          return;
        }
        runtime.syncPlanTools();
        runtime.updateStatus(ctx);
        runtime.emitPlanState(ctx, true, "resumed");
        if (settled.phase === "planning") {
          runtime.queueControlTurn(ctx, "plan", "Resume read-only planning from current evidence, then submit the complete plan.");
        } else {
          const rendered = await runtime.renderCurrentPlan(ctx);
          runtime.queueControlTurn(
            ctx,
            "execute",
            `Resume the explicitly approved plan. Update tracked steps as their observable state changes.\n\n${rendered}`,
          );
        }
        ctx.ui.notify(`Plan ${phaseLabel(settled.phase)} resumed.`, "info");
        return;
      }
      if (action === "approve") {
        if (!current || current.phase !== "awaitingApproval") {
          ctx.ui.notify("No submitted plan is awaiting approval.", "warning");
          return;
        }
        await stopCurrentAgent(ctx);
        const settled = runtime.getState();
        if (!settled || settled.phase !== "awaitingApproval") {
          ctx.ui.notify("Plan state changed while the current agent was settling; inspect /plan status.", "warning");
          return;
        }
        await runtime.approveAndQueue(ctx);
        ctx.ui.notify("Plan approved; original tools restored and execution queued.", "info");
        return;
      }
      if (action === "refine") {
        if (!current || current.phase !== "awaitingApproval") {
          ctx.ui.notify("No submitted plan is awaiting refinement.", "warning");
          return;
        }
        await stopCurrentAgent(ctx);
        const settled = runtime.getState();
        if (!settled || settled.phase !== "awaitingApproval") {
          ctx.ui.notify("Plan state changed while the current agent was settling; inspect /plan status.", "warning");
          return;
        }
        runtime.refineAndQueue(ctx);
        ctx.ui.notify("Plan returned to read-only refinement.", "info");
        return;
      }
      if (action === "cancel") {
        if (!current) {
          runtime.emitPlanState(ctx, false, "cancel-already-off");
          ctx.ui.notify("Plan mode is already off.", "info");
          return;
        }
        await stopCurrentAgent(ctx);
        if (!runtime.getState()) {
          ctx.ui.notify("Plan mode became inactive while the current agent was settling.", "info");
          return;
        }
        await runtime.transitionOff("cancel", ctx, "cancelled-tools-restored", ctx.signal);
        ctx.ui.notify("Plan cancelled; original tools restored.", "info");
        return;
      }
      ctx.ui.notify("Usage: /plan [status|choose|review|resume|approve|refine|cancel]", "warning");
    },
  });
}
