import { randomUUID } from "node:crypto";
import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  answerPlanChoice,
  approvePlan,
  approvePlanWithExternalProgress,
  consumePlanChoice,
  decodePlanJournalEntry,
  refinePlan,
  updatePlanStep,
  validatePlanPath,
  type PlanJournalEntry,
  type PlanPhase,
  type PlanState,
  type PlanStepProgress,
  type PlanStepStatus,
} from "./state.ts";
import {
  phaseLabel,
  renderPlan,
  renderPlanWidget,
} from "./output.ts";
import {
  allProgressStepsComplete,
  closeProgressProvider,
  openProgressProvider,
  readProgressProvider,
  updateProgressProvider,
  type ProgressSnapshot,
} from "./progress.ts";
import { isPlanToolAllowed, selectPlanTools } from "./tool-policy.ts";
import { PlanToolLease } from "./tool-lease.ts";
import { planSystemPrompt } from "./prompts.ts";
import {
  controlPlanUpdatedAt,
  PLAN_CONTROL_TYPE,
  PLAN_COORDINATION_CHANNEL,
  LEGACY_PLAN_STATE_TYPE,
  PLAN_STATE_TYPE,
  PLAN_TOOL_NAMES,
  type PlanCoordinationSignal,
} from "./protocol.ts";
import { registerPlanCommand } from "./command.ts";
import { registerPlanTools } from "./tools.ts";
import { requestPlanReview } from "./review.ts";
import { requestPlanChoiceDialog } from "./clarification.ts";
import { createPlanArtifactStore, type PlanArtifactStore } from "./artifacts.ts";

export { PLAN_COORDINATION_CHANNEL } from "./protocol.ts";



export interface PlanExtensionDependencies {
  copyText(text: string): Promise<void>;
  artifactStore: PlanArtifactStore;
}

export default function planExtension(
  pi: ExtensionAPI,
  dependencies: Partial<PlanExtensionDependencies> = {},
): void {
  const copyText = dependencies.copyText ?? copyToClipboard;
  const artifactStore = dependencies.artifactStore ?? createPlanArtifactStore();
  let state: PlanState | null = null;
  let externalSnapshot: ProgressSnapshot | undefined;
  let controlQueued = false;
  const toolLease = new PlanToolLease(PLAN_TOOL_NAMES);
  let automaticReviewUpdatedAt: number | undefined;
  let reviewOpen = false;
  let automaticClarificationUpdatedAt: number | undefined;
  let clarificationOpen = false;
  let choiceAnswerQueuedAt: number | undefined;
  let submissionPending = false;

  function getPlanState(): PlanState | null {
    return state;
  }

  function planningToolPool(effectiveTools: string[]): string[] {
    const builtinTools = pi.getAllTools()
      .filter((tool) => tool.sourceInfo.source === "builtin" && !toolLease.isExternallyRemoved(tool.name))
      .map((tool) => tool.name);
    return [...builtinTools, ...effectiveTools];
  }

  function syncPlanTools(): void {
    const currentTools = pi.getActiveTools();
    if (!state) {
      const restoredTools = toolLease.active
        ? toolLease.finish(currentTools)
        : currentTools.filter((tool) => !PLAN_TOOL_NAMES.includes(tool as typeof PLAN_TOOL_NAMES[number]));
      pi.setActiveTools(restoredTools);
      return;
    }
    if (!toolLease.active) toolLease.begin(state.enteredWithTools);
    const effectiveTools = toolLease.reconcile(currentTools);
    if (
      effectiveTools.length !== state.enteredWithTools.length ||
      effectiveTools.some((tool, index) => tool !== state?.enteredWithTools[index])
    ) {
      state = { ...state, enteredWithTools: effectiveTools };
    }
    const selectedTools = state.phase === "executing"
      ? [...new Set([...effectiveTools, "update_plan_step"])]
      : selectPlanTools(planningToolPool(effectiveTools), state.phase);
    pi.setActiveTools(selectedTools);
    toolLease.applied(selectedTools);
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const current = state;
    if (!current) {
      ctx.ui.setStatus("plan", undefined);
      ctx.ui.setWidget("plan", undefined);
      return;
    }
    const color = current.phase === "executing" ? "success" : current.phase === "awaitingApproval" || current.phase === "awaitingClarification" ? "warning" : "accent";
    const providerId = current.phase === "executing" && current.progress?.kind === "external"
      ? current.progress.providerId
      : undefined;
    const [heading, ...lines] = renderPlanWidget(current, externalSnapshot?.steps);
    ctx.ui.setStatus("plan", ctx.ui.theme.fg(color, providerId ? `${heading} · ${providerId}` : heading));
    ctx.ui.setWidget("plan", providerId ? undefined : lines.length > 0 ? lines : undefined);
  }

  function emitPlanState(ctx: ExtensionContext, willTriggerTurn: boolean, reason: string): void {
    const phase: PlanPhase = state?.phase ?? "off";
    const signal: PlanCoordinationSignal = {
      version: 1,
      sessionId: ctx.sessionManager.getSessionId(),
      phase,
      readOnly: phase !== "off" && phase !== "executing",
      awaitingApproval: phase === "awaitingApproval",
      willTriggerTurn,
      reason,
    };
    pi.events.emit(PLAN_COORDINATION_CHANNEL, signal);
  }

  function appendActive(action: PlanJournalEntry["action"]): void {
    if (!state) throw new Error("Cannot persist an inactive plan as active.");
    syncPlanTools();
    pi.appendEntry<PlanJournalEntry>(PLAN_STATE_TYPE, { version: 2, action, state });
  }

  function refreshPersistedActive(ctx: ExtensionContext, willTriggerTurn: boolean, reason: string): void {
    updateStatus(ctx);
    emitPlanState(ctx, willTriggerTurn, reason);
  }

  function persistActive(
    action: PlanJournalEntry["action"],
    ctx: ExtensionContext,
    willTriggerTurn: boolean,
    reason: string,
  ): void {
    if (!state) throw new Error("Cannot persist an inactive plan as active.");
    if (action === "submit") automaticReviewUpdatedAt = state.updatedAt;
    else if (state.phase !== "awaitingApproval") automaticReviewUpdatedAt = undefined;
    if (action === "clarify") automaticClarificationUpdatedAt = state.updatedAt;
    else if (state.phase !== "awaitingClarification") automaticClarificationUpdatedAt = undefined;
    appendActive(action);
    refreshPersistedActive(ctx, willTriggerTurn, reason);
  }

  async function discardArtifactAfterFailure(path: string, failure: unknown): Promise<never> {
    try {
      await artifactStore.discard(path);
    } catch (cleanupError) {
      throw new AggregateError([failure, cleanupError], "Failed to discard submitted Plan artifact.", { cause: failure });
    }
    throw failure;
  }

  async function rollbackSubmittedPlan(
    current: PlanState,
    path: string,
    previousAutomaticReviewUpdatedAt: number | undefined,
    failure: unknown,
  ): Promise<never> {
    state = current;
    automaticReviewUpdatedAt = previousAutomaticReviewUpdatedAt;
    const cleanupErrors: unknown[] = [];
    try {
      syncPlanTools();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await artifactStore.discard(path);
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([failure, ...cleanupErrors], "Failed to roll back submitted Plan.", { cause: failure });
    }
    throw failure;
  }

  async function commitSubmittedPlan(
    current: PlanState,
    candidate: PlanState,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<PlanState> {
    if (submissionPending) throw new Error("A Plan submission is already being persisted.");
    submissionPending = true;
    try {
      if (!candidate.plan) throw new Error("Submitted Plan is missing its body.");
      const newPath = await artifactStore.write(candidate.plan, {
        sessionFile: ctx.sessionManager.getSessionFile(),
        sessionId: ctx.sessionManager.getSessionId(),
      }, signal);
      try {
        signal?.throwIfAborted();
        validatePlanPath(newPath);
      } catch (error) {
        return await discardArtifactAfterFailure(newPath, error);
      }
      if (state !== current || state.phase !== "planning") {
        return await discardArtifactAfterFailure(
          newPath,
          new Error("Plan state changed while the submitted Plan was being persisted."),
        );
      }

      const previousAutomaticReviewUpdatedAt = automaticReviewUpdatedAt;
      state = { ...candidate, planPath: newPath };
      try {
        appendActive("submit");
      } catch (error) {
        return await rollbackSubmittedPlan(current, newPath, previousAutomaticReviewUpdatedAt, error);
      }
      const committed = state;
      if (!committed) throw new Error("Submitted Plan was unexpectedly cleared after journal commit.");
      automaticReviewUpdatedAt = committed.updatedAt;
      refreshPersistedActive(ctx, false, "awaiting-approval");
      return committed;
    } finally {
      submissionPending = false;
    }
  }

  async function transitionOff(
    action: "cancel" | "complete",
    ctx: ExtensionContext,
    reason: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const current = state;
    pi.appendEntry<PlanJournalEntry>(PLAN_STATE_TYPE, { version: 2, action, state: null });
    const restoreTools = toolLease.active
      ? toolLease.finish(pi.getActiveTools())
      : current?.enteredWithTools;
    state = null;
    externalSnapshot = undefined;
    automaticReviewUpdatedAt = undefined;
    automaticClarificationUpdatedAt = undefined;
    choiceAnswerQueuedAt = undefined;
    if (restoreTools) pi.setActiveTools(restoreTools);
    else syncPlanTools();
    updateStatus(ctx);
    emitPlanState(ctx, false, reason);
    if (current?.phase !== "executing" || current.progress?.kind !== "external") return;
    try {
      await closeProgressProvider(pi.events, current.progress.providerId, {
        sessionId: ctx.sessionManager.getSessionId(),
        executionId: current.progress.executionId,
        outcome: action === "complete" ? "completed" : "cancelled",
        signal,
      });
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`Progress provider close failed after Plan exited: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }

  function restoreFromBranch(ctx: ExtensionContext): void {
    const previousTools = toolLease.active
      ? toolLease.finish(pi.getActiveTools())
      : state?.enteredWithTools;
    let restored: PlanState | null = null;
    let restoreWarning: string | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || (entry.customType !== PLAN_STATE_TYPE && entry.customType !== LEGACY_PLAN_STATE_TYPE)) continue;
      const decoded = decodePlanJournalEntry(entry.data);
      if (!decoded.ok) {
        restored = null;
        restoreWarning = decoded.reason;
        continue;
      }
      restored = decoded.value.state;
      restoreWarning = undefined;
    }
    state = restored;
    externalSnapshot = undefined;
    controlQueued = false;
    automaticReviewUpdatedAt = undefined;
    automaticClarificationUpdatedAt = undefined;
    choiceAnswerQueuedAt = undefined;
    if (state) toolLease.begin(state.enteredWithTools);
    else if (previousTools) pi.setActiveTools(previousTools);
    syncPlanTools();
    updateStatus(ctx);
    emitPlanState(ctx, true, "session-sync");
    if (restoreWarning && ctx.hasUI) ctx.ui.notify(`Stored Plan state was not restored: ${restoreWarning}`, "warning");
  }

  function queueControlTurn(ctx: ExtensionContext, kind: "plan" | "refine" | "execute" | "clarification", content: string): boolean {
    if (!state || controlQueued || ctx.hasPendingMessages()) return false;
    controlQueued = true;
    const message = {
      customType: PLAN_CONTROL_TYPE,
      content,
      display: false,
      details: { kind, planUpdatedAt: state.updatedAt },
    };
    try {
      if (ctx.isIdle()) pi.sendMessage(message, { triggerTurn: true });
      else pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
      if (kind === "clarification" || (kind === "plan" && state.phase === "planning" && state.clarification?.selection !== undefined)) {
        choiceAnswerQueuedAt = state.updatedAt;
      }
      return true;
    } catch (error) {
      controlQueued = false;
      ctx.ui.notify(`Failed to queue Plan turn: ${error instanceof Error ? error.message : String(error)}`, "error");
      return false;
    }
  }

  function answerChoiceAndQueue(selection: number, ctx: ExtensionContext): PlanState {
    if (!state) throw new Error("No plan is active.");
    state = answerPlanChoice(state, selection);
    persistActive("answer", ctx, true, "clarification-answered");
    const selected = state.clarification?.options[selection];
    if (!selected) throw new Error("Selected Plan choice was unexpectedly unavailable.");
    queueControlTurn(
      ctx,
      "clarification",
      `The user selected option ${selection + 1}: ${selected.label}${selected.description ? ` — ${selected.description}` : ""}. Continue read-only planning with that decision.`,
    );
    return state;
  }

  async function approveAndQueue(ctx: ExtensionContext): Promise<void> {
    const current = state;
    if (!current || current.phase !== "awaitingApproval") throw new Error("No plan is active.");
    const executionId = randomUUID();
    const attempt = await openProgressProvider(pi.events, {
      sessionId: ctx.sessionManager.getSessionId(),
      executionId,
      steps: current.steps,
      signal: ctx.signal,
    });
    if (state !== current || state.phase !== "awaitingApproval") {
      if (attempt.opened) {
        await closeProgressProvider(pi.events, attempt.opened.providerId, {
          sessionId: ctx.sessionManager.getSessionId(),
          executionId,
          outcome: "cancelled",
          signal: ctx.signal,
        });
      }
      throw new Error("Plan state changed while progress ownership was being acquired.");
    }
    const candidate = attempt.opened
      ? approvePlanWithExternalProgress(current, attempt.opened.providerId, executionId)
      : approvePlan(current);
    state = candidate;
    externalSnapshot = attempt.opened?.snapshot;
    try {
      persistActive("approve", ctx, true, "approved-tools-restored");
    } catch (error) {
      state = current;
      externalSnapshot = undefined;
      syncPlanTools();
      if (attempt.opened) {
        try {
          await closeProgressProvider(pi.events, attempt.opened.providerId, {
            sessionId: ctx.sessionManager.getSessionId(),
            executionId,
            outcome: "cancelled",
            signal: ctx.signal,
          });
        } catch (closeError) {
          throw new AggregateError([error, closeError], "Failed to roll back Plan progress ownership.", { cause: error });
        }
      }
      throw error;
    }
    if (!attempt.opened && attempt.failures.length > 0 && ctx.hasUI) {
      ctx.ui.notify(`External progress providers declined; using Plan local progress. ${attempt.failures.join("; ")}`, "warning");
    }
    queueControlTurn(
      ctx,
      "execute",
      `Execute the explicitly approved plan below. Update tracked steps as their observable state changes.\n\n${renderPlan(candidate, attempt.opened?.snapshot.steps)}`,
    );
  }

  async function renderCurrentPlan(ctx: ExtensionContext): Promise<string> {
    const current = state;
    if (!current) return "Plan mode is off. Use /plan to start.";
    if (current.phase !== "executing" || current.progress?.kind !== "external") return renderPlan(current);
    try {
      const snapshot = await readProgressProvider(pi.events, current.progress.providerId, {
        sessionId: ctx.sessionManager.getSessionId(),
        executionId: current.progress.executionId,
        signal: ctx.signal,
      }, current.steps);
      if (state === current) {
        externalSnapshot = snapshot;
        updateStatus(ctx);
      }
      return renderPlan(current, snapshot.steps);
    } catch (error) {
      return `${renderPlan(current, externalSnapshot?.steps)}\n\nProgress provider unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  async function updateStep(
    requestId: string,
    id: string,
    status: PlanStepStatus,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<{ state: PlanState; progress: readonly PlanStepProgress[]; complete: boolean }> {
    const current = state;
    if (!current || current.phase !== "executing" || !current.progress) {
      throw new Error("No approved plan is currently executing.");
    }
    if (current.progress.kind === "local") {
      const next = updatePlanStep(current, id, status);
      const progress = next.progress?.kind === "local" ? next.progress.steps : [];
      const complete = progress.length > 0 && progress.every((step) => step.status === "completed");
      if (complete) {
        await transitionOff("complete", ctx, "completed-tools-restored", signal);
      } else {
        state = next;
        try {
          persistActive("step", ctx, false, "step-updated");
        } catch (error) {
          state = current;
          syncPlanTools();
          updateStatus(ctx);
          throw error;
        }
      }
      return { state: next, progress, complete };
    }
    const snapshot = await updateProgressProvider(pi.events, current.progress.providerId, {
      sessionId: ctx.sessionManager.getSessionId(),
      executionId: current.progress.executionId,
      requestId,
      stepId: id,
      status,
      signal,
    }, current.steps);
    if (state !== current) throw new Error("Plan state changed while its progress provider was updating.");
    externalSnapshot = snapshot;
    updateStatus(ctx);
    const complete = allProgressStepsComplete(snapshot);
    if (complete) await transitionOff("complete", ctx, "completed-tools-restored", signal);
    return { state: current, progress: snapshot.steps, complete };
  }

  function refineAndQueue(ctx: ExtensionContext): void {
    if (!state) throw new Error("No plan is active.");
    state = refinePlan(state);
    persistActive("refine", ctx, true, "refine");
    queueControlTurn(ctx, "refine", "Refine the submitted plan using current evidence, then call submit_plan with the full replacement.");
  }

  async function choosePlanClarification(
    ctx: ExtensionContext,
    beforeTransition?: () => Promise<void>,
  ): Promise<void> {
    const current = state;
    if (!current || current.phase !== "awaitingClarification" || !current.clarification) {
      ctx.ui.notify("No Plan choice is awaiting a decision.", "warning");
      return;
    }
    automaticClarificationUpdatedAt = undefined;
    if (clarificationOpen) return;
    clarificationOpen = true;
    let selection: number | undefined;
    try {
      selection = await requestPlanChoiceDialog(ctx, current.clarification);
    } finally {
      clarificationOpen = false;
    }
    if (selection === undefined) {
      ctx.ui.notify("Plan remains awaiting your decision.", "info");
      return;
    }
    await beforeTransition?.();
    const settled = state;
    if (!settled || settled.phase !== "awaitingClarification" || settled.updatedAt !== current.updatedAt) {
      ctx.ui.notify("Plan state changed while the choice dialog was open; inspect /plan status.", "warning");
      return;
    }
    const selected = settled.clarification?.options[selection];
    if (!selected) {
      ctx.ui.notify("The selected Plan option is no longer available; inspect /plan status.", "warning");
      return;
    }
    answerChoiceAndQueue(selection, ctx);
    ctx.ui.notify(`Plan choice ${selection + 1} recorded: ${selected.label}. Read-only planning resumed.`, "info");
  }

  async function reviewSubmittedPlan(
    ctx: ExtensionContext,
    beforeTransition?: () => Promise<void>,
  ): Promise<void> {
    const current = state;
    if (!current || current.phase !== "awaitingApproval") {
      ctx.ui.notify("No submitted plan is awaiting review.", "warning");
      return;
    }
    automaticReviewUpdatedAt = undefined;
    if (reviewOpen) return;
    reviewOpen = true;
    let choice: Awaited<ReturnType<typeof requestPlanReview>>;
    try {
      choice = await requestPlanReview(ctx, current, copyText);
    } finally {
      reviewOpen = false;
    }
    if (!choice || choice === "Stay in plan mode") {
      ctx.ui.notify("Plan remains awaiting approval.", "info");
      return;
    }
    await beforeTransition?.();
    const settled = state;
    if (!settled || settled.phase !== "awaitingApproval" || settled.updatedAt !== current.updatedAt) {
      ctx.ui.notify("Plan state changed while the review was open; inspect /plan status.", "warning");
      return;
    }
    if (choice === "Execute plan") {
      await approveAndQueue(ctx);
      ctx.ui.notify("Plan approved; original tools restored and execution queued.", "info");
    } else if (choice === "Refine plan") {
      refineAndQueue(ctx);
      ctx.ui.notify("Plan returned to read-only refinement.", "info");
    } else {
      await transitionOff("cancel", ctx, "cancelled-tools-restored", ctx.signal);
      ctx.ui.notify("Plan cancelled; original tools restored.", "info");
    }
  }

  const planRuntime = {
    getState: () => state,
    setState(next: PlanState): void {
      state = next;
    },
    persistActive,
    commitSubmittedPlan,
    syncPlanTools,
    updateStatus,
    emitPlanState,
    queueControlTurn,
    approveAndQueue,
    answerChoiceAndQueue,
    choosePlanClarification,
    refineAndQueue,
    transitionOff,
    renderCurrentPlan,
    updateStep,
    reviewSubmittedPlan,
  };
  registerPlanCommand(pi, planRuntime);
  registerPlanTools(pi, planRuntime);
  pi.on("session_start", (_event, ctx) => {
    restoreFromBranch(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreFromBranch(ctx);
  });

  pi.on("before_agent_start", (event) => {
    if (!state) return;
    syncPlanTools();
    return { systemPrompt: `${event.systemPrompt}\n\n${planSystemPrompt(state)}` };
  });

  pi.on("tool_call", (event) => {
    if (!state || isPlanToolAllowed(event.toolName, state.phase)) return;
    return {
      block: true,
      reason: `Plan mode is ${phaseLabel(state.phase)} and blocks tool ${event.toolName}. Only explicit read-only planning tools are permitted until approval.`,
    };
  });

  pi.on("agent_start", () => {
    controlQueued = false;
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (
      state?.phase === "planning" &&
      state.clarification?.selection !== undefined &&
      choiceAnswerQueuedAt === state.updatedAt &&
      !controlQueued
    ) {
      const answered = state;
      try {
        state = consumePlanChoice(answered);
        persistActive("resume", ctx, false, "clarification-consumed");
        choiceAnswerQueuedAt = undefined;
      } catch (error) {
        state = answered;
        syncPlanTools();
        ctx.ui.notify(`Failed to finalize Plan choice: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    }
    if (ctx.mode !== "tui") {
      automaticReviewUpdatedAt = undefined;
      automaticClarificationUpdatedAt = undefined;
      return;
    }
    if (
      state?.phase === "awaitingClarification" &&
      automaticClarificationUpdatedAt === state.updatedAt &&
      !clarificationOpen
    ) {
      await choosePlanClarification(ctx);
      return;
    }
    if (
      !state ||
      state.phase !== "awaitingApproval" ||
      automaticReviewUpdatedAt !== state.updatedAt ||
      reviewOpen
    ) return;
    await reviewSubmittedPlan(ctx);
  });

  pi.on("context", (event) => {
    let latestControl = -1;
    for (let index = 0; index < event.messages.length; index++) {
      if (controlPlanUpdatedAt(event.messages[index]) === state?.updatedAt) latestControl = index;
    }
    return {
      messages: event.messages.filter((message, index) => {
        const updatedAt = controlPlanUpdatedAt(message);
        return updatedAt === undefined || (state !== null && updatedAt === state.updatedAt && index === latestControl);
      }),
    };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (state && toolLease.active) pi.setActiveTools(toolLease.finish(pi.getActiveTools()));
    else if (state) pi.setActiveTools(state.enteredWithTools);
    ctx.ui.setStatus("plan", undefined);
    ctx.ui.setWidget("plan", undefined);
    await artifactStore.cleanupEphemeral();
  });
}
