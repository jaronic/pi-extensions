import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { tone } from "pi-uikit-dev";
import {
  decodeLoopJournalEntry,
  failAttempt,
  setLoopStatus,
  settleRound,
  type LoopJournalEntry,
  type LoopState,
  type PauseReason,
} from "./state.ts";
import { loopContextBlock, loopRoundPrompt } from "./prompts.ts";
import { renderLoopWidget } from "./output.ts";
import {
  LOOP_CONTINUATION_TYPE,
  LOOP_STATE_TYPE,
  assistantTailText,
  continuationLoopDetails,
  lastAssistantStop,
} from "./protocol.ts";
import { registerLoopCommand, type LoopCommandRuntime } from "./command.ts";
import { isAnyExclusiveWorkflowActive, registerExclusiveWorkflow } from "./workflow-mode.ts";

const DELIVERY_WATCHDOG_MS = 10_000;
const ROUND_SUMMARY_TAIL_CHARS = 240;
const CONTEXT_BLOCK_TYPE = "loop-context-v1";

export default function loopExtension(pi: ExtensionAPI): void {
  let loop: LoopState | null = null;
  let currentCtx: ExtensionContext | undefined;
  let currentSessionId: string | undefined;

  // Continuation runtime (per-session, rebuilt on restore).
  let continuationPhase: "needed" | "queued" | "delivered" = "needed";
  let queuedRound = 0;
  let inFlight: { generation: number; round: number } | null = null;
  let staleRound: { generation: number; round: number } | null = null;
  let finalStop: { stopReason?: string; errorMessage?: string } | null = null;
  let roundTurns = 0;
  let roundAssistantTail = "";
  let watchdog: ReturnType<typeof setTimeout> | undefined;

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    if (!loop) {
      ctx.ui.setStatus("loop", undefined);
      ctx.ui.setWidget("loop", undefined);
      return;
    }
    const color = loop.status === "running" ? "accent"
      : loop.status === "finished" ? "success"
      : "warning";
    const [heading, ...lines] = renderLoopWidget(loop);
    ctx.ui.setStatus("loop", tone(ctx.ui.theme, color, heading));
    ctx.ui.setWidget("loop", lines.length > 0 ? lines : undefined);
  }

  function persist(action: LoopJournalEntry["action"], ctx: ExtensionContext): void {
    pi.appendEntry<LoopJournalEntry>(LOOP_STATE_TYPE, { version: 1, action, loop });
    updateStatus(ctx);
  }

  function persistSafely(action: LoopJournalEntry["action"], ctx: ExtensionContext): boolean {
    try {
      persist(action, ctx);
      return true;
    } catch (error) {
      if (loop) loop = setLoopStatus(loop, "paused", "send-failed");
      ctx.ui.notify(
        `Failed to persist Loop state (${error instanceof Error ? error.message : String(error)}); loop paused. Use /loop resume after the runtime recovers.`,
        "error",
      );
      return false;
    }
  }

  function clearWatchdog(): void {
    if (!watchdog) return;
    clearTimeout(watchdog);
    watchdog = undefined;
  }

  function failClosedPause(reason: "send-failed", ctx: ExtensionContext): void {
    clearWatchdog();
    continuationPhase = "needed";
    queuedRound = 0;
    if (!loop || loop.status !== "running") return;
    loop = setLoopStatus(loop, "paused", reason);
    persistSafely("status", ctx);
    ctx.ui.notify("Loop continuation was not delivered; loop paused. Use /loop resume to retry.", "warning");
  }

  function armWatchdog(generation: number, round: number, ctx: ExtensionContext): void {
    clearWatchdog();
    watchdog = setTimeout(() => {
      watchdog = undefined;
      if (!loop || loop.status !== "running") return;
      if (loop.generation !== generation) return;
      if (continuationPhase !== "queued" || queuedRound !== round) return;
      failClosedPause("send-failed", ctx);
    }, DELIVERY_WATCHDOG_MS);
    watchdog.unref?.();
  }

  function queueContinuation(round: number, ctx: ExtensionContext): void {
    if (!loop || loop.status !== "running") return;
    if (continuationPhase !== "needed") return;
    if (round < 1 || round > loop.spec.iterations) return;
    continuationPhase = "queued";
    queuedRound = round;
    roundTurns = 0;
    roundAssistantTail = "";
    finalStop = null;
    const message = {
      customType: LOOP_CONTINUATION_TYPE,
      content: loopRoundPrompt(loop, round),
      display: false,
      details: { loopId: loop.id, generation: loop.generation, round },
    };
    try {
      if (ctx.isIdle()) pi.sendMessage(message, { triggerTurn: true });
      else pi.sendMessage(message, { triggerTurn: true, deliverAs: "followUp" });
      armWatchdog(loop.generation, round, ctx);
    } catch {
      failClosedPause("send-failed", ctx);
    }
  }

  function invalidateContinuation(): void {
    if (inFlight) staleRound = inFlight;
    clearWatchdog();
    continuationPhase = "needed";
    queuedRound = 0;
    inFlight = null;
  }

  function restoreFromBranch(ctx: ExtensionContext, reason: "startup" | "reload" | "new" | "resume" | "fork" | "tree"): void {
    clearWatchdog();
    loop = null;
    continuationPhase = "needed";
    queuedRound = 0;
    inFlight = null;
    staleRound = null;
    finalStop = null;
    roundTurns = 0;
    roundAssistantTail = "";
    let restoreWarning: string | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== LOOP_STATE_TYPE) continue;
      const decoded = decodeLoopJournalEntry(entry.data);
      if (!decoded.ok) {
        loop = null;
        restoreWarning = decoded.reason;
        continue;
      }
      if (decoded.value.action === "clear") {
        loop = null;
        restoreWarning = decoded.warning;
        continue;
      }
      loop = decoded.value.loop;
      restoreWarning = decoded.warning;
    }
    if (loop?.status === "running") {
      const pauseReason: PauseReason = reason === "reload" ? "reload" : "restore";
      loop = setLoopStatus(loop, "paused", pauseReason);
      persistSafely("status", ctx);
      ctx.ui.notify(`Loop paused after ${reason}. Use /loop resume to continue.`, "info");
    }
    updateStatus(ctx);
    if (restoreWarning && ctx.hasUI) {
      ctx.ui.notify(`Stored Loop state was not restored safely: ${restoreWarning}`, "warning");
    }
  }

  const loopRuntime: LoopCommandRuntime = {
    getLoop: () => loop,
    isAnyWorkflowActive: (ctx) => isAnyExclusiveWorkflowActive(
      pi.events,
      ctx.sessionManager.getSessionId(),
      "loop",
    ),
    setLoop(next: LoopState | null, action: LoopJournalEntry["action"], ctx: ExtensionContext): LoopState | null {
      const previous = loop;
      const invalidate = !next ||
        next.generation !== previous?.generation ||
        next.status !== "running" ||
        previous.status !== "running";
      if (invalidate) invalidateContinuation();
      loop = next;
      try {
        persist(action, ctx);
      } catch (error) {
        if (next) loop = setLoopStatus(next, "paused", "send-failed");
        ctx.ui.notify(
          `Failed to persist Loop state (${error instanceof Error ? error.message : String(error)}); loop paused in memory.`,
          "error",
        );
        return null;
      }
      if (next?.status === "running" && previous?.status !== "running") staleRound = null;
      return loop;
    },
    queueContinuation,
  };
  registerLoopCommand(pi, loopRuntime);

  const unsubscribeWorkflow = registerExclusiveWorkflow(
    pi.events,
    "loop",
    (sessionId) => loop?.status === "running" && currentSessionId === sessionId,
  );

  pi.on("session_start", (event, ctx) => {
    currentCtx = ctx;
    currentSessionId = ctx.sessionManager.getSessionId();
    restoreFromBranch(ctx, event.reason);
  });

  pi.on("session_tree", (_event, ctx) => {
    currentCtx = ctx;
    currentSessionId = ctx.sessionManager.getSessionId();
    restoreFromBranch(ctx, "tree");
  });

  pi.on("context", (event) => {
    const current = loop;
    if (!current) return { messages: event.messages };
    let latestIndex = -1;
    let latestDetails: { loopId: string; generation: number; round: number } | undefined;
    for (let index = 0; index < event.messages.length; index++) {
      const details = continuationLoopDetails(event.messages[index]);
      if (!details || details.loopId !== current.id) continue;
      if (details.generation < current.generation) continue;
      if (details.generation === current.generation && inFlight !== null && details.round < inFlight.round) continue;
      latestIndex = index;
      latestDetails = details;
    }
    const messages = event.messages.filter((message, index) => {
      const details = continuationLoopDetails(message);
      if (!details) return true;
      return details.loopId === current.id &&
        details.generation === current.generation &&
        index === latestIndex;
    });
    if (latestDetails && current.status === "running") {
      if (
        inFlight === null ||
        inFlight.generation !== latestDetails.generation ||
        inFlight.round !== latestDetails.round
      ) {
        inFlight = { generation: latestDetails.generation, round: latestDetails.round };
        staleRound = null;
        clearWatchdog();
        continuationPhase = "delivered";
      }
    }
    const round = inFlight?.round ?? current.completedIterations + 1;
    const block = {
      role: "custom" as const,
      customType: CONTEXT_BLOCK_TYPE,
      content: loopContextBlock(current, round),
      display: false,
      details: { loopId: current.id, round },
      timestamp: Date.now(),
    };
    return { messages: [...messages, block] };
  });

  pi.on("message_start", (event) => {
    const details = continuationLoopDetails(event.message);
    if (!details) return;
    if (!loop || details.loopId !== loop.id) return;
    if (details.generation !== loop.generation) return;
    if (continuationPhase !== "queued" || queuedRound !== details.round) return;
    clearWatchdog();
    continuationPhase = "delivered";
  });

  pi.on("turn_end", (event) => {
    if (!loop || loop.status !== "running") return;
    if (inFlight === null || inFlight.generation !== loop.generation) return;
    roundTurns += 1;
    const tail = assistantTailText(event.message, ROUND_SUMMARY_TAIL_CHARS);
    if (tail) roundAssistantTail = tail;
  });

  pi.on("agent_end", (event) => {
    finalStop = lastAssistantStop(event.messages) ?? null;
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!loop || loop.status !== "running") return;
    if (inFlight === null || inFlight.generation !== loop.generation) return;
    const settledRound = inFlight.round;
    inFlight = null;
    staleRound = null;
    continuationPhase = "needed";
    queuedRound = 0;
    const stop = finalStop;
    finalStop = null;
    if (stop?.stopReason === "error") {
      const reason = stop.errorMessage ?? "agent error";
      loop = failAttempt(loop, { status: "error", reason });
      if (!persistSafely("status", ctx)) return;
      ctx.ui.notify(`Loop paused after an agent error (round ${settledRound}). Use /loop resume to retry.`, "warning");
      return;
    }
    if (stop?.stopReason === "aborted") {
      loop = failAttempt(loop, { status: "aborted", reason: "aborted" });
      if (!persistSafely("status", ctx)) return;
      ctx.ui.notify("Loop paused after the operation was aborted.", "info");
      return;
    }
    const next = settleRound(
      loop,
      {
        status: stop?.stopReason === "length" ? "length" : "ok",
        turns: roundTurns,
        summary: roundAssistantTail,
      },
      Date.now(),
    );
    loop = next;
    if (!persistSafely("settle", ctx)) return;
    if (next.status === "finished") {
      ctx.ui.notify(`Loop finished (${next.spec.iterations}/${next.spec.iterations} rounds).`, "info");
      return;
    }
    queueContinuation(next.completedIterations + 1, ctx);
  });

  pi.on("tool_call", () => {
    if (!loop) return;
    if (inFlight !== null && inFlight.generation < loop.generation) {
      return { block: true, reason: "This run belongs to an outdated loop generation; no further tool calls are allowed." };
    }
    if (inFlight === null && staleRound !== null) {
      return { block: true, reason: "The loop is no longer running; no further tool calls are allowed for this run." };
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    clearWatchdog();
    unsubscribeWorkflow();
    ctx.ui.setStatus("loop", undefined);
    ctx.ui.setWidget("loop", undefined);
    currentCtx = undefined;
    currentSessionId = undefined;
  });
}
