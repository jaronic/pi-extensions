import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { tone } from "pi-uikit-dev";
import {
  accountGoalTurn,
  formatElapsed,
  formatTokens,
  decodeGoalJournalEntry,
  setGoalStatus,
  statusLabel,
  tokenDeltaFromMessage,
  type GoalJournalEntry,
  type GoalState,
} from "./state.ts";
import { activeGoalPrompt, continuationPrompt } from "./prompts.ts";
import {
  continuationGoalId,
  GOAL_CONTINUATION_TYPE,
  GOAL_STATE_TYPE,
  lastAssistantStop,
} from "./protocol.ts";
import { registerGoalCommand } from "./command.ts";
import { registerGoalTools } from "./tools.ts";
import { isAnyExclusiveWorkflowActive, registerExclusiveWorkflow } from "./workflow-mode.ts";

export default function goalExtension(pi: ExtensionAPI): void {
  let goal: GoalState | null = null;
  let currentCtx: ExtensionContext | undefined;
  let currentSessionId: string | undefined;
  let restoredExclusivityTimer: ReturnType<typeof setTimeout> | undefined;
  let continuationQueued = false;
  let continuationSuppressed = false;
  let continuationAgentActive = false;
  let continuationAgentToolCalls = 0;
  let activeTurnStartedAt: number | null = null;
  let activeGoalTurnId: string | null = null;
  let pendingAgentError: { goalId: string; status: "paused" | "usageLimited" } | null = null;
  let statusTimer: ReturnType<typeof setInterval> | undefined;

  function activeElapsedSeconds(now = Date.now()): number {
    const currentTurnSeconds = activeTurnStartedAt === null
      ? 0
      : Math.max(0, Math.floor((now - activeTurnStartedAt) / 1_000));
    return (goal?.timeUsedSeconds ?? 0) + currentTurnSeconds;
  }

  function stopStatusTimer(): void {
    if (!statusTimer) return;
    clearInterval(statusTimer);
    statusTimer = undefined;
  }

  function startStatusTimer(ctx: ExtensionContext): void {
    stopStatusTimer();
    statusTimer = setInterval(() => {
      if (!goal || goal.status !== "active" || activeTurnStartedAt === null) {
        stopStatusTimer();
        return;
      }
      updateStatus(ctx);
    }, 1_000);
    statusTimer.unref?.();
  }


  function syncGoalTools(): void {
    const activeTools = new Set(pi.getActiveTools());
    activeTools.add("create_goal");
    if (goal?.status === "active") activeTools.add("get_goal");
    else activeTools.delete("get_goal");
    if (goal?.status === "active") activeTools.add("update_goal");
    else activeTools.delete("update_goal");
    pi.setActiveTools([...activeTools]);
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setWidget("goal", undefined);
    if (!goal) {
      ctx.ui.setStatus("goal", undefined);
      return;
    }
    if (goal.status === "active") {
      const elapsed = formatElapsed(activeElapsedSeconds());
      const usage = goal.tokenBudget === undefined
        ? elapsed
        : `${elapsed} · ${formatTokens(goal.tokensUsed)} / ${formatTokens(goal.tokenBudget)}`;
      ctx.ui.setStatus("goal", tone(ctx.ui.theme, "accent", `Goal active (${usage})`));
      return;
    }
    const color: "success" | "warning" = goal.status === "complete" ? "success" : "warning";
    const duration = goal.status === "complete" ? ` (${formatElapsed(goal.timeUsedSeconds)})` : "";
    ctx.ui.setStatus("goal", tone(ctx.ui.theme, color, `Goal ${statusLabel(goal.status)}${duration}`));
  }

  function persist(action: GoalJournalEntry["action"], ctx: ExtensionContext): void {
    pi.appendEntry<GoalJournalEntry>(GOAL_STATE_TYPE, { version: 1, action, goal });
    updateStatus(ctx);
    syncGoalTools();
  }

  function restoreFromBranch(ctx: ExtensionContext): void {
    stopStatusTimer();
    clearTimeout(restoredExclusivityTimer);
    restoredExclusivityTimer = undefined;
    goal = null;
    let restoreWarning: string | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== GOAL_STATE_TYPE) continue;
      const decoded = decodeGoalJournalEntry(entry.data);
      if (!decoded.ok) {
        goal = null;
        restoreWarning = decoded.reason;
        continue;
      }
      goal = decoded.value.goal;
      restoreWarning = decoded.warning;
    }
    continuationQueued = false;
    activeTurnStartedAt = null;
    activeGoalTurnId = null;
    continuationSuppressed = false;
    continuationAgentActive = false;
    continuationAgentToolCalls = 0;
    syncGoalTools();
    updateStatus(ctx);
    if (restoreWarning && ctx.hasUI) ctx.ui.notify(`Stored Goal state was not restored safely: ${restoreWarning}`, "warning");
  }

  function queueContinuation(ctx: ExtensionContext): void {
    if (!goal || goal.status !== "active") return;
    if (continuationSuppressed) return;
    if (continuationQueued || ctx.hasPendingMessages()) return;
    continuationQueued = true;
    const message = {
      customType: GOAL_CONTINUATION_TYPE,
      content: continuationPrompt(goal),
      display: false,
      details: { goalId: goal.id },
    };
    try {
      if (ctx.isIdle()) pi.sendMessage(message, { triggerTurn: true });
      else pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
    } catch (error) {
      continuationQueued = false;
      ctx.ui.notify(`Failed to queue goal continuation: ${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }


  const unsubscribeWorkflow = registerExclusiveWorkflow(
    pi.events,
    "goal",
    (sessionId) => goal?.status === "active" && currentSessionId === sessionId,
  );

  function planIsActive(ctx: ExtensionContext): boolean {
    return isAnyExclusiveWorkflowActive(pi.events, ctx.sessionManager.getSessionId(), "goal");
  }

  function settleRestoredExclusivity(ctx: ExtensionContext): void {
    const restoredGoalId = goal?.status === "active" ? goal.id : undefined;
    if (!restoredGoalId) return;
    clearTimeout(restoredExclusivityTimer);
    restoredExclusivityTimer = setTimeout(() => {
      restoredExclusivityTimer = undefined;
      if (currentCtx !== ctx || goal?.id !== restoredGoalId || goal.status !== "active" || !planIsActive(ctx)) return;
      goal = setGoalStatus(goal, "paused");
      persist("status", ctx);
      ctx.ui.notify("Restored Goal was paused because Plan mode is active. Finish or cancel Plan before resuming Goal.", "warning");
    }, 0);
  }

  const goalRuntime = {
    getGoal: () => goal,
    isPlanActive: planIsActive,
    setGoal(next: GoalState | null, action: GoalJournalEntry["action"], ctx: ExtensionContext): GoalState | null {
      const previousGoal = goal;
      const completed = previousGoal?.status === "active" && next?.id === previousGoal.id && next.status === "complete";
      if (completed && goal && next && activeGoalTurnId === goal.id && activeTurnStartedAt !== null) {
        const elapsedSeconds = Math.max(0, Math.floor((Date.now() - activeTurnStartedAt) / 1_000));
        next = accountGoalTurn(next, 0, elapsedSeconds);
        activeTurnStartedAt = null;
      }
      if (next?.status !== "active") stopStatusTimer();
      if (next?.status === "active") continuationSuppressed = false;
      if (!next || next.status !== "active" || next.id !== previousGoal?.id) {
        continuationAgentActive = false;
        continuationAgentToolCalls = 0;
      }
      goal = next;
      persist(action, ctx);
      if (completed && goal) {
        ctx.ui.notify(`Goal completed in ${formatElapsed(goal.timeUsedSeconds)}.`, "info");
      }
      return goal;
    },
    queueContinuation,
  };
  registerGoalCommand(pi, goalRuntime);
  registerGoalTools(pi, goalRuntime);

  pi.on("session_start", (event, ctx) => {
    currentCtx = ctx;
    currentSessionId = ctx.sessionManager.getSessionId();
    restoreFromBranch(ctx);
    if (goal?.status === "active" && event.reason === "reload") {
      goal = setGoalStatus(goal, "paused");
      persist("status", ctx);
      ctx.ui.notify("Active goal paused after reload. Use /goal resume to continue.", "info");
    }
    settleRestoredExclusivity(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    currentCtx = ctx;
    currentSessionId = ctx.sessionManager.getSessionId();
    restoreFromBranch(ctx);
    settleRestoredExclusivity(ctx);
  });

  pi.on("before_agent_start", (event) => {
    if (!goal || goal.status !== "active") return;
    return { systemPrompt: `${event.systemPrompt}\n\n${activeGoalPrompt(goal)}` };
  });

  pi.on("agent_start", () => {
    continuationAgentActive = continuationQueued && goal?.status === "active";
    continuationAgentToolCalls = 0;
    continuationQueued = false;
    if (!continuationAgentActive) continuationSuppressed = false;
  });

  pi.on("tool_call", () => {
    if (continuationAgentActive && goal?.status === "active") continuationAgentToolCalls += 1;
  });

  pi.on("turn_start", (_event, ctx) => {
    activeGoalTurnId = goal?.status === "active" ? goal.id : null;
    activeTurnStartedAt = activeGoalTurnId ? Date.now() : null;
    if (activeGoalTurnId) startStatusTimer(ctx);
    else stopStatusTimer();
    updateStatus(ctx);
  });

  pi.on("turn_end", (event, ctx) => {
    stopStatusTimer();
    if (!goal || activeGoalTurnId !== goal.id) {
      activeTurnStartedAt = null;
      activeGoalTurnId = null;
      return;
    }
    const elapsedSeconds = activeTurnStartedAt === null
      ? 0
      : Math.max(0, Math.floor((Date.now() - activeTurnStartedAt) / 1_000));
    activeTurnStartedAt = null;
    activeGoalTurnId = null;
    const previousStatus = goal.status;
    goal = accountGoalTurn(goal, tokenDeltaFromMessage(event.message), elapsedSeconds);
    persist("account", ctx);
    if (previousStatus === "active" && goal.status === "budgetLimited") {
      ctx.ui.notify("Goal token budget reached; automatic continuation stopped.", "warning");
    }
  });

  pi.on("agent_end", (event, ctx) => {
    const wasContinuationAgent = continuationAgentActive;
    const continuationToolCalls = continuationAgentToolCalls;
    continuationAgentActive = false;
    continuationAgentToolCalls = 0;
    if (!goal || goal.status !== "active") {
      pendingAgentError = null;
      return;
    }
    const stop = lastAssistantStop(event.messages);
    if (stop?.stopReason === "error") {
      pendingAgentError = {
        goalId: goal.id,
        status: /\b(usage|rate|quota|limit)\b/i.test(stop.errorMessage ?? "") ? "usageLimited" : "paused",
      };
      return;
    }
    pendingAgentError = null;
    if (stop?.stopReason === "aborted") {
      goal = setGoalStatus(goal, "paused");
      persist("status", ctx);
      ctx.ui.notify("Goal paused after the operation was aborted.", "info");
      return;
    }
    if (wasContinuationAgent && continuationToolCalls === 0) {
      continuationSuppressed = true;
      ctx.ui.notify(
        "Goal remains active, but automatic continuation stopped because the last continuation made no tool calls. Send new input or use /goal resume to continue.",
        "info",
      );
      return;
    }
    continuationSuppressed = false;
    queueContinuation(ctx);
  });

  pi.on("agent_settled", (_event, ctx) => {
    const pending = pendingAgentError;
    pendingAgentError = null;
    if (!pending || !goal || goal.id !== pending.goalId || goal.status !== "active") return;
    goal = setGoalStatus(goal, pending.status);
    persist("status", ctx);
    ctx.ui.notify(`Goal ${statusLabel(pending.status)} after an agent error; automatic continuation stopped.`, "warning");
  });

  pi.on("context", (event) => {
    let latestContinuation = -1;
    for (let index = 0; index < event.messages.length; index++) {
      if (continuationGoalId(event.messages[index]) === goal?.id) latestContinuation = index;
    }
    return {
      messages: event.messages.filter((message, index) => {
        const goalId = continuationGoalId(message);
        return goalId === undefined || (goal?.status === "active" && goalId === goal.id && index === latestContinuation);
      }),
    };
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopStatusTimer();
    clearTimeout(restoredExclusivityTimer);
    restoredExclusivityTimer = undefined;
    ctx.ui.setStatus("goal", undefined);
    ctx.ui.setWidget("goal", undefined);
    currentCtx = undefined;
    currentSessionId = undefined;
    unsubscribeWorkflow();
  });
}
