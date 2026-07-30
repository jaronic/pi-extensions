import {
  copyToClipboard,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { installRequest, type RequestService } from "pi-request-ui-dev";
import { installTodo, type TodoService, type TodoServiceResult } from "pi-todo-dev";
import {
  answerPlanChoice,
  consumePlanChoice,
  decodePlanJournalEntry,
  planHandoffPhaseName,
  refinePlan,
  reportPlanBlocked,
  resumeBlockedPlan,
  validatePlanPath,
  type PlanJournalEntry,
  type PlanState,
} from "./state.ts";
import {
  phaseLabel,
  renderPlan,
  renderPlanWidget,
} from "./output.ts";
import { isPlanToolAllowed, selectPlanTools } from "./tool-policy.ts";
import { PlanToolLease } from "./tool-lease.ts";
import { planSystemPrompt } from "./prompts.ts";
import {
  controlPlanUpdatedAt,
  executionPlanUpdatedAt,
  PLAN_CONTROL_TYPE,
  PLAN_EXECUTION_TYPE,
  LEGACY_PLAN_STATE_TYPES,
  PLAN_STATE_TYPE,
  PLAN_TOOL_NAMES,
} from "./protocol.ts";
import { registerPlanCommand } from "./command.ts";
import { registerPlanTools } from "./tools.ts";
import { requestPlanReview, type PlanReviewDecision } from "./review.ts";
import { requestPlanChoice } from "./clarification.ts";
import { isExclusiveWorkflowActive, registerExclusiveWorkflow } from "./workflow-mode.ts";
import { createPlanArtifactStore, type PlanArtifactStore } from "./artifacts.ts";

export interface PlanExtensionDependencies {
  copyText(text: string): Promise<void>;
  artifactStore: PlanArtifactStore;
  requestService: RequestService;
  todoService: TodoService;
}

function escapeXmlText(input: string): string {
  return input.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export default function planExtension(
  pi: ExtensionAPI,
  dependencies: Partial<PlanExtensionDependencies> = {},
): void {
  const copyText = dependencies.copyText ?? copyToClipboard;
  const artifactStore = dependencies.artifactStore ?? createPlanArtifactStore();
  const requestService = dependencies.requestService ?? installRequest(pi);
  const todoService = dependencies.todoService ?? installTodo(pi);
  let state: PlanState | null = null;
  let controlQueued = false;
  const toolLease = new PlanToolLease(PLAN_TOOL_NAMES);
  let automaticReviewUpdatedAt: number | undefined;
  let reviewOpen = false;
  let automaticClarificationUpdatedAt: number | undefined;
  let clarificationOpen = false;
  let choiceAnswerQueuedAt: number | undefined;
  let submissionPending = false;
  let currentSessionId: string | undefined;
  let pendingExecutionUpdatedAt: number | undefined;

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
    const selectedTools = selectPlanTools(planningToolPool(effectiveTools), state.phase);
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
    const color = current.phase === "awaitingApproval" || current.phase === "awaitingClarification" || current.phase === "blocked"
      ? "warning"
      : "accent";
    const [heading, ...lines] = renderPlanWidget(current);
    ctx.ui.setStatus("plan", ctx.ui.theme.fg(color, heading));
    ctx.ui.setWidget("plan", lines.length > 0 ? lines : undefined);
  }

  function syncTodoPlanPhase(ctx: ExtensionContext): void {
    todoService.syncPlanPhase({
      sessionId: ctx.sessionManager.getSessionId(),
      phase: state?.phase ?? "off",
    });
  }

  function appendActive(action: PlanJournalEntry["action"]): void {
    if (!state) throw new Error("Cannot persist an inactive plan as active.");
    syncPlanTools();
    pi.appendEntry<PlanJournalEntry>(PLAN_STATE_TYPE, { version: 4, action, state });
  }

  function refreshActiveProjection(ctx: ExtensionContext): void {
    updateStatus(ctx);
    syncTodoPlanPhase(ctx);
  }

  function persistActive(action: PlanJournalEntry["action"], ctx: ExtensionContext): void {
    if (!state) throw new Error("Cannot persist an inactive plan as active.");
    if (action === "submit") automaticReviewUpdatedAt = state.updatedAt;
    else if (state.phase !== "awaitingApproval") automaticReviewUpdatedAt = undefined;
    if (action === "clarify") automaticClarificationUpdatedAt = state.updatedAt;
    else if (state.phase !== "awaitingClarification") automaticClarificationUpdatedAt = undefined;
    appendActive(action);
    refreshActiveProjection(ctx);
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
      refreshActiveProjection(ctx);
      return committed;
    } finally {
      submissionPending = false;
    }
  }

  function commitPlanBlocker(current: PlanState, candidate: PlanState, ctx: ExtensionContext): PlanState {
    if (state !== current || current.phase !== "planning") {
      throw new Error("Plan state changed while the blocked result was being recorded.");
    }
    state = candidate;
    try {
      persistActive("block", ctx);
      return candidate;
    } catch (error) {
      state = current;
      syncPlanTools();
      updateStatus(ctx);
      throw error;
    }
  }

  function transitionOff(ctx: ExtensionContext): void {
    const current = state;
    pi.appendEntry<PlanJournalEntry>(PLAN_STATE_TYPE, { version: 4, action: "cancel", state: null });
    const restoreTools = toolLease.active
      ? toolLease.finish(pi.getActiveTools())
      : current?.enteredWithTools;
    state = null;
    automaticReviewUpdatedAt = undefined;
    automaticClarificationUpdatedAt = undefined;
    choiceAnswerQueuedAt = undefined;
    pendingExecutionUpdatedAt = undefined;
    if (restoreTools) pi.setActiveTools(restoreTools);
    else syncPlanTools();
    updateStatus(ctx);
    syncTodoPlanPhase(ctx);
  }

  function restoreFromBranch(ctx: ExtensionContext): void {
    currentSessionId = ctx.sessionManager.getSessionId();
    const previousTools = toolLease.active
      ? toolLease.finish(pi.getActiveTools())
      : state?.enteredWithTools;
    let restored: PlanState | null = null;
    let restoreWarning: string | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || (entry.customType !== PLAN_STATE_TYPE && !LEGACY_PLAN_STATE_TYPES.includes(entry.customType as typeof LEGACY_PLAN_STATE_TYPES[number]))) continue;
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
    controlQueued = false;
    pendingExecutionUpdatedAt = undefined;
    automaticReviewUpdatedAt = undefined;
    automaticClarificationUpdatedAt = undefined;
    choiceAnswerQueuedAt = undefined;
    if (state) toolLease.begin(state.enteredWithTools);
    else if (previousTools) pi.setActiveTools(previousTools);
    syncPlanTools();
    updateStatus(ctx);
    syncTodoPlanPhase(ctx);
    if (restoreWarning && ctx.hasUI) ctx.ui.notify(`Stored Plan state was not restored: ${restoreWarning}`, "warning");
  }

  function queueControlTurn(ctx: ExtensionContext, kind: "plan" | "refine" | "clarification", content: string): boolean {
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

  function queueExecutionTurn(
    ctx: ExtensionContext,
    approved: PlanState,
    handoff: TodoServiceResult,
  ): boolean {
    if (controlQueued) return false;
    controlQueued = true;
    pendingExecutionUpdatedAt = approved.updatedAt;
    const message = {
      customType: PLAN_EXECUTION_TYPE,
      content: `Execute the explicitly approved plan below. Plan mode is now off; the ordinary Todo board is the only execution-progress authority.

<untrusted_plan>
${escapeXmlText(approved.plan ?? "")}
</untrusted_plan>

Todo handoff:
${handoff.content}

The approved steps are already initialized on the Todo board with stable numeric #IDs; never call todo init or append to recreate them. Start the first pending #ID, mark the active Todo done only after its observable check passes, and block it only for a genuine external dependency. Todo is the sole progress ledger after approval.`,
      display: false,
      details: { kind: "execute", planUpdatedAt: approved.updatedAt, todoSequence: handoff.details.sequence },
    };
    try {
      if (ctx.isIdle()) pi.sendMessage(message, { triggerTurn: true });
      else pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
      return true;
    } catch (error) {
      controlQueued = false;
      pendingExecutionUpdatedAt = undefined;
      ctx.ui.notify(`Failed to queue approved Plan execution: ${error instanceof Error ? error.message : String(error)}`, "error");
      return false;
    }
  }

  function answerChoiceAndQueue(selection: number, ctx: ExtensionContext): PlanState {
    if (!state) throw new Error("No plan is active.");
    state = answerPlanChoice(state, selection);
    persistActive("answer", ctx);
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
    ctx.signal?.throwIfAborted();
    pi.appendEntry<PlanJournalEntry>(PLAN_STATE_TYPE, { version: 4, action: "approve", state: null });
    let handoff: TodoServiceResult;
    try {
      handoff = todoService.handoffPlan({
        sessionId: ctx.sessionManager.getSessionId(),
        phase: planHandoffPhaseName(current.summary),
        items: current.steps,
        signal: ctx.signal,
      });
    } catch (error) {
      try {
        pi.appendEntry<PlanJournalEntry>(PLAN_STATE_TYPE, { version: 4, action: "submit", state: current });
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "Failed to roll back Plan approval after Todo handoff failed.", { cause: error });
      }
      throw error;
    }
    const restoreTools = toolLease.active
      ? toolLease.finish(pi.getActiveTools())
      : current.enteredWithTools;
    state = null;
    automaticReviewUpdatedAt = undefined;
    automaticClarificationUpdatedAt = undefined;
    choiceAnswerQueuedAt = undefined;
    pi.setActiveTools(restoreTools);
    updateStatus(ctx);
    syncTodoPlanPhase(ctx);
    queueExecutionTurn(ctx, current, handoff);
  }

  async function renderCurrentPlan(_ctx: ExtensionContext): Promise<string> {
    return state ? renderPlan(state) : "Plan mode is off. Use /plan to start.";
  }

  function refineAndQueue(ctx: ExtensionContext, feedback: string): void {
    const current = state;
    if (!current || current.phase !== "awaitingApproval") throw new Error("No submitted plan is awaiting refinement.");
    const normalized = feedback.trim();
    if (!normalized) throw new Error("Plan refinement requires concrete feedback.");
    if ([...normalized].length > 4_000) throw new Error("Plan refinement feedback exceeds 4,000 characters.");
    state = refinePlan(current);
    persistActive("refine", ctx);
    const queued = queueControlTurn(
      ctx,
      "refine",
      `Refine the submitted plan using the user's requested changes below, then call submit_plan with the full replacement.

<untrusted_refinement_feedback>
${escapeXmlText(normalized)}
</untrusted_refinement_feedback>`,
    );
    if (!queued) throw new Error("Plan refinement was recorded, but its planning turn could not be queued.");
  }

  function resumeBlockedAndQueue(ctx: ExtensionContext): void {
    const current = state;
    if (!current) throw new Error("No plan is active.");
    state = resumeBlockedPlan(current);
    try {
      persistActive("resume", ctx);
    } catch (error) {
      state = current;
      syncPlanTools();
      updateStatus(ctx);
      throw error;
    }
    queueControlTurn(
      ctx,
      "plan",
      "New user information is available after a blocked Plan result. Re-check the prior blocker against current evidence, then either submit an approvable replacement plan or report_plan_blocked again.",
    );
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
      selection = await requestPlanChoice(requestService, current.clarification);
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
    let choice: PlanReviewDecision | undefined;
    try {
      choice = await requestPlanReview(ctx, current, copyText);
    } finally {
      reviewOpen = false;
    }
    if (!choice || choice === "Stay in plan mode") {
      ctx.ui.notify("Plan remains awaiting approval. Send your change requests, then use /plan refine <feedback>; approve when no changes remain.", "info");
      return;
    }
    let refinementFeedback: string | undefined;
    if (choice === "Refine plan") {
      const edited = await ctx.ui.editor("Plan refinement feedback", "");
      if (edited === undefined || !edited.trim()) {
        ctx.ui.notify("Plan remains awaiting approval; no refinement feedback was submitted.", "info");
        return;
      }
      refinementFeedback = edited;
    }
    await beforeTransition?.();
    const settled = state;
    if (!settled || settled.phase !== "awaitingApproval" || settled.updatedAt !== current.updatedAt) {
      ctx.ui.notify("Plan state changed while the review was open; inspect /plan status.", "warning");
      return;
    }
    if (choice === "Execute plan") {
      await approveAndQueue(ctx);
      ctx.ui.notify("Plan approved; steps transferred to Todo, Plan exited, and execution queued.", "info");
    } else if (choice === "Refine plan") {
      refineAndQueue(ctx, refinementFeedback ?? "");
      ctx.ui.notify("Plan returned to read-only refinement with your feedback.", "info");
    } else {
      transitionOff(ctx);
      ctx.ui.notify("Plan cancelled; original tools restored.", "info");
    }
  }

  const unsubscribeWorkflow = registerExclusiveWorkflow(
    pi.events,
    "plan",
    (sessionId) => state !== null && currentSessionId === sessionId,
  );

  const planRuntime = {
    getState: () => state,
    isGoalActive: (ctx: ExtensionContext) => isExclusiveWorkflowActive(
      pi.events,
      ctx.sessionManager.getSessionId(),
      "goal",
    ),
    setState(next: PlanState): void {
      state = next;
    },
    persistActive,
    commitSubmittedPlan,
    commitPlanBlocker,
    syncPlanTools,
    updateStatus,
    syncTodoPlanPhase,
    queueControlTurn,
    approveAndQueue,
    answerChoiceAndQueue,
    choosePlanClarification,
    refineAndQueue,
    resumeBlockedAndQueue,
    transitionOff,
    renderCurrentPlan,
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
    pendingExecutionUpdatedAt = undefined;
    if (
      state?.phase === "planning" &&
      state.clarification?.selection !== undefined &&
      choiceAnswerQueuedAt === state.updatedAt &&
      !controlQueued
    ) {
      const answered = state;
      try {
        state = consumePlanChoice(answered);
        persistActive("resume", ctx);
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
    let latestExecution = -1;
    for (let index = 0; index < event.messages.length; index += 1) {
      if (controlPlanUpdatedAt(event.messages[index]) === state?.updatedAt) latestControl = index;
      if (executionPlanUpdatedAt(event.messages[index]) === pendingExecutionUpdatedAt) latestExecution = index;
    }
    return {
      messages: event.messages.filter((message, index) => {
        const controlUpdatedAt = controlPlanUpdatedAt(message);
        if (controlUpdatedAt !== undefined) {
          return state !== null && controlUpdatedAt === state.updatedAt && index === latestControl;
        }
        const executionUpdatedAt = executionPlanUpdatedAt(message);
        if (executionUpdatedAt !== undefined) {
          return pendingExecutionUpdatedAt !== undefined && executionUpdatedAt === pendingExecutionUpdatedAt && index === latestExecution;
        }
        return true;
      }),
    };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (state && toolLease.active) pi.setActiveTools(toolLease.finish(pi.getActiveTools()));
    else if (state) pi.setActiveTools(state.enteredWithTools);
    ctx.ui.setStatus("plan", undefined);
    ctx.ui.setWidget("plan", undefined);
    await artifactStore.cleanupEphemeral();
    currentSessionId = undefined;
    unsubscribeWorkflow();
  });
}
