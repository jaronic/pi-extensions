import {
  pauseReasonLabel,
  statusLabel,
  type LoopState,
  type PauseReason,
} from "./state.ts";

export const MAX_WIDGET_ROUNDS = 5;
export const MAX_WIDGET_ROUND_CHARS = 72;
export const MAX_WIDGET_OBJECTIVE_CHARS = 72;

function clampChars(text: string, maxChars: number): string {
  const chars = [...text];
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

export function loopStatusLabel(status: LoopState["status"], pauseReason?: PauseReason): string {
  if (status === "paused" || status === "stopped") {
    const reason = pauseReason === undefined ? "" : ` (${pauseReasonLabel(pauseReason)})`;
    return `${status}${reason}`;
  }
  return statusLabel(status);
}

export function renderLoopWidget(state: LoopState | null): string[] {
  if (!state) return [];
  const lines: string[] = [];
  const rounds = `${state.completedIterations}/${state.spec.iterations}`;
  if (state.status === "running") lines.push(`Loop ${rounds}`);
  else if (state.status === "finished") lines.push(`Loop finished ${rounds}`);
  else if (state.status === "stopped") lines.push(`Loop stopped ${rounds}`);
  else lines.push(`Loop paused ${rounds}`);

  lines.push(`Objective: ${clampChars(state.spec.objective, MAX_WIDGET_OBJECTIVE_CHARS)}`);
  if (state.status === "paused" || state.status === "stopped") {
    if (state.pauseReason !== undefined) {
      lines.push(`! ${pauseReasonLabel(state.pauseReason)}`);
    }
    if (state.lastAttempt) {
      lines.push(`! round ${state.lastAttempt.round} failed: ${clampChars(state.lastAttempt.reason, MAX_WIDGET_ROUND_CHARS)}`);
    }
  }
  for (const entry of state.roundLog.slice(-MAX_WIDGET_ROUNDS)) {
    const glyph = entry.status === "ok" ? "✓" : "○";
    lines.push(`${glyph} ${entry.round}. ${clampChars(entry.summary, MAX_WIDGET_ROUND_CHARS)}`);
  }
  if (state.roundLog.length > MAX_WIDGET_ROUNDS) {
    lines.push(`… ${state.roundLog.length - MAX_WIDGET_ROUNDS} more round(s)`);
  }
  return lines;
}

export function renderLoopStatus(state: LoopState | null): string {
  if (!state) return "Loop: off";
  const lines = [
    `Loop: ${loopStatusLabel(state.status, state.pauseReason)} (${state.completedIterations}/${state.spec.iterations})`,
    `Objective: ${state.spec.objective}`,
  ];
  if (state.lastAttempt) {
    lines.push(
      `Last failed round: ${state.lastAttempt.round} — ${state.lastAttempt.reason} at ${formatTime(state.lastAttempt.at)}`,
    );
  }
  if (state.roundLog.length > 0) {
    lines.push("Rounds:");
    for (const entry of state.roundLog) {
      lines.push(
        `  ${entry.round}. [${entry.status}] ${entry.summary} · ${entry.turns} turn${entry.turns === 1 ? "" : "s"} · ${formatTime(entry.at)}`,
      );
    }
  }
  if (state.finishedAt !== undefined) {
    lines.push(`Finished at: ${formatTime(state.finishedAt)}`);
  }
  return lines.join("\n");
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toISOString();
}
