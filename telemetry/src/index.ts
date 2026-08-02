import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  decodeTelemetrySnapshot,
  emptyTelemetryState,
  recordCallEnd,
  recordCallStart,
  resetTelemetry,
  TELEMETRY_STATE_TYPE,
  telemetryDimensions,
  type TelemetryDimensions,
  type TelemetrySnapshot,
  type TelemetryState,
} from "./state.ts";
import { registerTelemetryCommand } from "./command.ts";

const MAX_PENDING_CALLS = 128;

interface PendingCall {
  dims: TelemetryDimensions;
  startedAt: number;
}

export default function telemetryExtension(pi: ExtensionAPI): void {
  let state: TelemetryState = emptyTelemetryState();
  let dirty = false;
  const pending = new Map<string, PendingCall>();

  function dimensionsFor(toolName: string, ctx: ExtensionContext): TelemetryDimensions {
    return telemetryDimensions(toolName, ctx.model?.provider, ctx.model?.id);
  }

  function trackPending(toolCallId: string, call: PendingCall): void {
    if (pending.has(toolCallId)) pending.delete(toolCallId);
    while (pending.size >= MAX_PENDING_CALLS) {
      const oldest = pending.keys().next();
      if (oldest.done) break;
      pending.delete(oldest.value);
    }
    pending.set(toolCallId, call);
  }

  function persistSnapshot(): void {
    const snapshot: TelemetrySnapshot = {
      version: 1,
      aggregates: state.aggregates.map((aggregate) => ({ ...aggregate })),
    };
    try {
      pi.appendEntry<TelemetrySnapshot>(TELEMETRY_STATE_TYPE, snapshot);
      dirty = false;
    } catch {
      // Keep the dirty flag; persistence is retried on the next turn_end.
    }
  }

  function restoreFromBranch(ctx: ExtensionContext): void {
    pending.clear();
    state = emptyTelemetryState();
    dirty = false;
    let restoreWarning: string | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== TELEMETRY_STATE_TYPE) continue;
      const decoded = decodeTelemetrySnapshot(entry.data);
      if (!decoded.ok) {
        state = emptyTelemetryState();
        restoreWarning = decoded.reason;
        continue;
      }
      state = { version: 1, aggregates: decoded.value.aggregates };
      restoreWarning = decoded.warning;
    }
    if (restoreWarning && ctx.hasUI) {
      ctx.ui.notify(`Stored Telemetry state was not fully restored: ${restoreWarning}`, "warning");
    }
  }

  registerTelemetryCommand(pi, {
    getState: () => state,
    resetTelemetry: () => {
      state = resetTelemetry();
      pending.clear();
      dirty = true;
      // A reset must append an empty snapshot so branch restore replays to empty.
      persistSnapshot();
    },
  });

  pi.on("session_start", (_event, ctx) => {
    restoreFromBranch(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    restoreFromBranch(ctx);
  });

  // The host emits tool_execution_start/end for every attempted tool call,
  // including immediate-failure paths (unknown tool, schema validation error,
  // gate block, truncation) that never reach the tool_call/tool_result hooks.
  pi.on("tool_execution_start", (event, ctx) => {
    const dims = dimensionsFor(event.toolName, ctx);
    state = recordCallStart(state, dims, Date.now());
    dirty = true;
    trackPending(event.toolCallId, { dims, startedAt: Date.now() });
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const now = Date.now();
    const started = pending.get(event.toolCallId);
    if (started) pending.delete(event.toolCallId);
    const dims = started?.dims ?? dimensionsFor(event.toolName, ctx);
    state = recordCallEnd(
      state,
      dims,
      {
        isError: event.isError,
        durationMs: started ? now - started.startedAt : undefined,
        // An end without its start (restore cleared pending, or the start was
        // evicted by the pending cap) still implies one call; recordCallEnd
        // adds the call even when an aggregate already exists.
        impliesCall: started === undefined,
      },
      now,
    );
    dirty = true;
  });

  pi.on("turn_end", () => {
    if (!dirty) return;
    persistSnapshot();
  });

  pi.on("session_shutdown", () => {
    pending.clear();
  });
}
