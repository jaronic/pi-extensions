import { randomUUID } from "node:crypto";
import type {
  EventBus,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { registerTodoCommand } from "./command.ts";
import {
  TODO_STATE_TYPE,
  buildTodoStateEntry,
  buildTodoToolDetails,
  decodeTodoToolDetails,
  restoreTodoSnapshot,
  type TodoStateEntry,
} from "./persistence.ts";
import { todoSystemPrompt } from "./prompts.ts";
import {
  decodeTodoPlanPhaseSync,
  planBlocksTodoMutation,
  type TodoPlanPhase,
  type TodoPlanPhaseSync,
} from "./protocol.ts";
import {
  registerTodoService,
  requestTodoService,
  TODO_SERVICE_CHANNEL,
  type TodoPlanHandoffRequest,
  type TodoService,
  type TodoServiceRequest,
  type TodoServiceResult,
} from "./service.ts";
import {
  EMPTY_TODO_SNAPSHOT,
  freezeTodoSnapshot,
  incrementSafeInteger,
  todoBoardStatus,
  todoStatesEqual,
  transitionPlanHandoff,
  type TodoSnapshot,
  type TodoTransition,
} from "./state.ts";
import { buildTodoMutationText, todoWidget } from "./output.ts";
import {
  executeTodoOperation,
  registerTodoTool,
  type TodoMutationOperation,
  type TodoToolRuntime,
} from "./tools.ts";

export { TODO_STATE_TYPE, TODO_TOOL_DETAILS_KIND } from "./persistence.ts";
export type { TodoStateEntry, TodoStateEntryOperation, TodoStateEntrySource, TodoToolDetails } from "./persistence.ts";
export { requestTodoService, TODO_SERVICE_CHANNEL } from "./service.ts";
export type {
  TodoPlanHandoffRequest,
  TodoService,
  TodoServiceOperation,
  TodoServiceRequest,
  TodoServiceResult,
} from "./service.ts";
export type { TodoPlanPhase, TodoPlanPhaseSync } from "./protocol.ts";
export { MAX_PHASE_NAME_CHARS } from "./state.ts";
export type {
  TodoCounts,
  TodoPhase,
  TodoSnapshot,
  TodoState,
  TodoStatus,
  TodoTask,
} from "./state.ts";

export interface TodoExtensionDependencies {
  now(): number;
  createBoardId(): string;
}

interface TodoInstallation {
  service: TodoService;
  dispose(ctx?: ExtensionContext): void;
}

const TODO_INSTALLATIONS = Symbol.for("pi-extensions:todo:installations:v1");

function todoInstallations(): WeakMap<EventBus, TodoInstallation> {
  const host = globalThis as { [key: symbol]: unknown };
  const existing = host[TODO_INSTALLATIONS];
  if (existing === undefined) {
    const installations = new WeakMap<EventBus, TodoInstallation>();
    host[TODO_INSTALLATIONS] = installations;
    return installations;
  }
  if (!(existing instanceof WeakMap)) throw new Error("Todo installation registry is invalid.");
  return existing as WeakMap<EventBus, TodoInstallation>;
}

export function installTodo(
  pi: ExtensionAPI,
  dependencies: Partial<TodoExtensionDependencies> = {},
): TodoService {
  const installations = todoInstallations();
  const installed = installations.get(pi.events);
  if (installed) return installed.service;

  const now = dependencies.now ?? Date.now;
  const createBoardId = dependencies.createBoardId ?? randomUUID;
  const lifetimeController = new AbortController();
  let snapshot: TodoSnapshot = EMPTY_TODO_SNAPSHOT;
  let restoreBlockedReason: string | undefined;
  let planPhase: TodoPlanPhase = "off";
  const latestPlanPhases = new Map<string, TodoPlanPhase>();
  let sessionId: string | undefined;
  let currentContext: ExtensionContext | undefined;
  let widgetVisible = true;
  let disposed = false;
  let unsubscribeService: () => void = () => undefined;
  let installation: TodoInstallation;

  function assertInstallationActive(): void {
    if (disposed || lifetimeController.signal.aborted) throw new Error("Todo installation has shut down.");
  }

  function isPlanActive(): boolean {
    return planBlocksTodoMutation(planPhase);
  }

  function safeClearUi(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.setStatus("todo", undefined);
      ctx.ui.setWidget("todo", undefined);
    } catch {
      // UI projection failure must never alter branch state.
    }
  }

  function refreshUi(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    try {
      ctx.ui.setStatus("todo", undefined);
      if (restoreBlockedReason) {
        ctx.ui.setWidget("todo", undefined);
        return;
      }
      if (isPlanActive()) {
        ctx.ui.setWidget("todo", undefined);
        return;
      }
      const state = snapshot.state;
      if (!state) {
        ctx.ui.setWidget("todo", undefined);
        return;
      }
      const boardStatus = todoBoardStatus(state);
      const shouldShowWidget = widgetVisible && boardStatus !== "settled";
      ctx.ui.setWidget("todo", shouldShowWidget
        ? (_tui, theme) => ({
            render: (width) => todoWidget(state, theme, width),
            invalidate: () => undefined,
          })
        : undefined);
    } catch {
      // Rendering is a projection. Committed snapshots remain authoritative.
    }
  }

  function assertAvailable(): void {
    if (restoreBlockedReason) {
      throw new Error(`${restoreBlockedReason} Load a compatible Todo extension or switch to a branch without that entry.`);
    }
  }

  function assertMutationAllowed(): void {
    if (isPlanActive()) {
      throw new Error(`Todo mutations are frozen while Plan is ${planPhase}; approve or cancel Plan first.`);
    }
  }

  function applyCommittedSnapshot(next: TodoSnapshot, ctx: ExtensionContext): void {
    snapshot = next;
    refreshUi(ctx);
  }

  function commitTool(next: TodoSnapshot, ctx: ExtensionContext): void {
    assertAvailable();
    applyCommittedSnapshot(next, ctx);
  }

  function commitService(next: TodoSnapshot, ctx: ExtensionContext, op: TodoMutationOperation): void {
    assertAvailable();
    assertMutationAllowed();
    if (next.sequence === snapshot.sequence) {
      if (!todoStatesEqual(next.state, snapshot.state)) throw new Error("Todo service returned a conflicting no-change snapshot.");
      return;
    }
    const expectedSequence = incrementSafeInteger(snapshot.sequence, "Todo sequence");
    if (next.sequence !== expectedSequence) throw new Error("Todo service snapshot sequence is not the next branch sequence.");
    const entry = buildTodoStateEntry("service", op, next);
    pi.appendEntry<TodoStateEntry>(TODO_STATE_TYPE, entry);
    applyCommittedSnapshot(next, ctx);
  }

  function commitCommand(
    action: "clear" | "reopen",
    transition: TodoTransition,
    ctx: ExtensionCommandContext,
  ): TodoSnapshot {
    assertAvailable();
    assertMutationAllowed();
    if (transition.effect.kind === "noChange") return snapshot;
    const next = freezeTodoSnapshot({
      sequence: incrementSafeInteger(snapshot.sequence, "Todo sequence"),
      state: transition.state,
    });
    const entry = buildTodoStateEntry("command", action, next);
    pi.appendEntry<TodoStateEntry>(TODO_STATE_TYPE, entry);
    applyCommittedSnapshot(next, ctx);
    return next;
  }

  function applyPlanPhase(input: TodoPlanPhaseSync): void {
    latestPlanPhases.set(input.sessionId, input.phase);
    if (sessionId === undefined || input.sessionId !== sessionId) return;
    planPhase = input.phase;
    if (currentContext) refreshUi(currentContext);
  }


  function restoreFromBranch(ctx: ExtensionContext): void {
    if (disposed) return;
    safeClearUi(ctx);
    currentContext = ctx;
    sessionId = ctx.sessionManager.getSessionId();
    snapshot = EMPTY_TODO_SNAPSHOT;
    restoreBlockedReason = undefined;
    planPhase = "off";
    const restored = restoreTodoSnapshot(ctx.sessionManager.getBranch());
    snapshot = restored.snapshot;
    restoreBlockedReason = restored.blockedReason;
    const latestPlanPhase = latestPlanPhases.get(sessionId);
    if (latestPlanPhase) planPhase = latestPlanPhase;
    refreshUi(ctx);
    if (restored.warning && ctx.hasUI) ctx.ui.notify(restored.warning, "warning");
  }

  const runtime = {
    getSnapshot: () => snapshot,
    assertAvailable,
    assertMutationAllowed,
    commitTool,
    commitCommand,
    isPlanActive,
    getWidgetVisible: () => widgetVisible,
    setWidgetVisible(visible: boolean, ctx: ExtensionCommandContext): void {
      widgetVisible = visible;
      refreshUi(ctx);
    },
    refreshUi,
    now,
    createBoardId,
  };
  const serviceRuntime: TodoToolRuntime = {
    ...runtime,
    commitTool: commitService,
  };

  function execute(request: TodoServiceRequest): TodoServiceResult {
    assertInstallationActive();
    const ctx = currentContext;
    const activeSessionId = sessionId;
    if (!ctx || activeSessionId === undefined) throw new Error("The Todo service is not ready for an active session.");
    if (request.sessionId !== activeSessionId) throw new Error("The Todo service request targets a different session.");
    request.signal?.throwIfAborted();
    const result = executeTodoOperation(serviceRuntime, request.operation, request.signal, ctx);
    return Object.freeze({ content: result.content[0].text, details: result.details });
  }

  function handoffPlan(request: TodoPlanHandoffRequest): TodoServiceResult {
    assertInstallationActive();
    const ctx = currentContext;
    const activeSessionId = sessionId;
    if (!ctx || activeSessionId === undefined) throw new Error("The Todo service is not ready for an active session.");
    if (request.sessionId !== activeSessionId) throw new Error("The Todo Plan handoff targets a different session.");
    if (planPhase !== "awaitingApproval") {
      throw new Error("Todo accepts a Plan handoff only while that Plan is awaiting approval.");
    }
    request.signal?.throwIfAborted();
    const transition = transitionPlanHandoff(snapshot.state, request.phase, request.items, now(), createBoardId);
    const operation: TodoMutationOperation = transition.effect.kind === "initialized" ? "init" : "append";
    const next = freezeTodoSnapshot({
      sequence: incrementSafeInteger(snapshot.sequence, "Todo sequence"),
      state: transition.state,
    });
    const details = buildTodoToolDetails(next, operation, transition.changedTaskIds);
    const content = buildTodoMutationText(operation, next, transition);
    request.signal?.throwIfAborted();
    assertAvailable();
    const entry = buildTodoStateEntry("service", operation, next);
    pi.appendEntry<TodoStateEntry>(TODO_STATE_TYPE, entry);
    applyCommittedSnapshot(next, ctx);
    return Object.freeze({ content, details });
  }

  function syncPlanPhase(input: TodoPlanPhaseSync): void {
    assertInstallationActive();
    applyPlanPhase(decodeTodoPlanPhaseSync(input));
  }

  const service = Object.freeze({
    lifetime: lifetimeController.signal,
    execute,
    handoffPlan,
    syncPlanPhase,
  });

  function dispose(ctx: ExtensionContext | undefined): void {
    if (disposed) return;
    disposed = true;
    lifetimeController.abort();
    const uiContext = ctx ?? currentContext;
    if (uiContext) safeClearUi(uiContext);
    currentContext = undefined;
    sessionId = undefined;
    latestPlanPhases.clear();
    unsubscribeService();
    if (installations.get(pi.events) === installation) installations.delete(pi.events);
  }

  installation = { service, dispose };
  installations.set(pi.events, installation);

  registerTodoTool(pi, runtime);
  registerTodoCommand(pi, runtime);
  unsubscribeService = registerTodoService(pi.events, service.execute);

  pi.on("session_start", (_event, ctx) => restoreFromBranch(ctx));
  pi.on("session_tree", (_event, ctx) => restoreFromBranch(ctx));
  pi.on("session_compact", (_event, ctx) => refreshUi(ctx));

  pi.on("before_agent_start", (event) => {
    if (restoreBlockedReason || isPlanActive()) return;
    const projection = todoSystemPrompt(snapshot.state);
    if (!projection) return;
    return { systemPrompt: `${event.systemPrompt}\n\n${projection}` };
  });

  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "todo" || event.isError) return;
    const decoded = decodeTodoToolDetails(event.details);
    if (decoded.kind === "unsupported") {
      restoreBlockedReason = `Todo state uses unsupported version v${decoded.version}.`;
      refreshUi(ctx);
      return;
    }
    if (decoded.kind !== "valid" || restoreBlockedReason) return;
    const candidate = freezeTodoSnapshot({ sequence: decoded.value.sequence, state: decoded.value.state });
    if (candidate.sequence < snapshot.sequence) return;
    if (candidate.sequence === snapshot.sequence && !todoStatesEqual(candidate.state, snapshot.state)) return;
    if (candidate.sequence > snapshot.sequence) snapshot = candidate;
    refreshUi(ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => dispose(ctx));
  return service;
}

export default function todoExtension(pi: ExtensionAPI): void {
  installTodo(pi);
}
