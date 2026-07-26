import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { PlanPhase, PlanState, PlanStepProgress } from "./state.ts";

const NOTICE_RESERVE_BYTES = 1_024;
const NOTICE_RESERVE_LINES = 2;
const MAX_WIDGET_STEPS = 20;
const MAX_WIDGET_STEP_CHARS = 120;

export interface TruncationSummary {
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
}

export interface BoundedPlanText {
  text: string;
  truncation?: TruncationSummary;
}

function displayedProgress(
  state: PlanState,
  external?: readonly PlanStepProgress[],
): readonly PlanStepProgress[] {
  if (state.phase === "executing" && state.progress?.kind === "local") return state.progress.steps;
  if (state.phase === "executing" && state.progress?.kind === "external" && external) return external;
  return state.steps.map((step) => ({ id: step.id, status: "pending" as const }));
}

function renderStepUpdateAction(ordinal: number, text: string, status: PlanStepProgress["status"]): string {
  switch (status) {
    case "pending":
      return `Set #${ordinal} to pending: ${text}.`;
    case "inProgress":
      return `Started #${ordinal}: ${text}.`;
    case "completed":
      return `Completed #${ordinal}: ${text}.`;
    case "blocked":
      return `Blocked #${ordinal}: ${text}.`;
  }
}

export function renderPlanStepUpdate(
  state: PlanState,
  id: string,
  external?: readonly PlanStepProgress[],
): string {
  const index = state.steps.findIndex((step) => step.id === id);
  const definition = state.steps[index];
  if (!definition) throw new Error(`Unknown plan step: ${id}`);
  const progress = displayedProgress(state, external);
  const updated = progress.find((step) => step.id === id);
  if (!updated) throw new Error(`Progress is missing plan step: ${id}`);
  let completed = 0;
  let blocked = 0;
  for (const step of progress) {
    if (step.status === "completed") completed += 1;
    else if (step.status === "blocked") blocked += 1;
  }
  const exited = completed === state.steps.length ? " · Plan mode exited." : ".";
  return [
    renderStepUpdateAction(index + 1, definition.text, updated.status),
    `Progress: ${completed}/${state.steps.length} completed · ${blocked} blocked${exited}`,
  ].join("\n");
}

export function phaseLabel(phase: PlanPhase): string {
  switch (phase) {
    case "off":
      return "off";
    case "planning":
      return "planning";
    case "awaitingApproval":
      return "awaiting approval";
    case "blocked":
      return "blocked pending user input";
    case "executing":
      return "executing";
  }
}

export function renderPlan(state: PlanState, external?: readonly PlanStepProgress[]): string {
  const lines = [
    `Plan: ${state.summary ?? state.blocker?.summary ?? "draft"}`,
    `Phase: ${phaseLabel(state.phase)}`,
  ];
  if (state.phase === "executing" && state.progress?.kind === "external") {
    lines.push(`Progress provider: ${state.progress.providerId}`);
  }
  if (state.blocker) {
    lines.push("", "Planning blocked:", state.blocker.summary, "", "Verified blocking facts:");
    for (const fact of state.blocker.blockingFacts) lines.push(`- ${fact}`);
    lines.push("", "Evidence sources consulted:");
    for (const source of state.blocker.evidenceSources) lines.push(`- ${source}`);
    lines.push("", "User resolution paths:");
    for (const resolution of state.blocker.resolutions) lines.push(`- ${resolution.kind}: ${resolution.label} — ${resolution.description}`);
  }
  if (state.plan) lines.push("", state.plan);
  if (state.steps.length > 0) {
    const statusById = new Map(displayedProgress(state, external).map((step) => [step.id, step.status]));
    lines.push("", "Execution steps:");
    for (const step of state.steps) {
      const status = statusById.get(step.id) ?? "pending";
      const marker = status === "completed" ? "x" : status === "blocked" ? "!" : " ";
      lines.push(`- [${marker}] ${step.id}: ${step.text} (${status})`);
    }
  }
  return lines.join("\n");
}

export function boundPlanText(text: string): BoundedPlanText {
  const result = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES - NOTICE_RESERVE_BYTES,
    maxLines: DEFAULT_MAX_LINES - NOTICE_RESERVE_LINES,
  });
  if (!result.truncated) return { text };
  const summary: TruncationSummary = {
    truncatedBy: result.truncatedBy,
    totalLines: result.totalLines,
    totalBytes: result.totalBytes,
    outputLines: result.outputLines,
    outputBytes: result.outputBytes,
  };
  const notice = `[Plan output truncated: showing ${result.outputLines} of ${result.totalLines} lines ` +
    `(${formatSize(result.outputBytes)} of ${formatSize(result.totalBytes)}). ` +
    "The complete Plan remains in persisted Plan state and Plan-mode context.]";
  return { text: `${result.content}\n\n${notice}`, truncation: summary };
}

export function summarizePlanState(
  state: PlanState | null,
  complete = false,
  truncation?: TruncationSummary,
  external?: readonly PlanStepProgress[],
): Record<string, unknown> {
  if (!state) return { phase: "off", complete, truncation };
  const summary = {
    phase: state.phase,
    summary: state.summary,
    progress: state.phase === "executing" ? state.progress?.kind : undefined,
    providerId: state.phase === "executing" && state.progress?.kind === "external" ? state.progress.providerId : undefined,
    executionId: state.phase === "executing" && state.progress?.kind === "external" ? state.progress.executionId : undefined,
    blocker: state.blocker,
    steps: displayedProgress(state, external).map(({ id, status }) => ({ id, status })),
    updatedAt: state.updatedAt,
    complete,
    truncation,
  };
  return state.planPath ? { ...summary, planPath: state.planPath } : summary;
}

export function renderPlanWidget(state: PlanState, external?: readonly PlanStepProgress[]): string[] {
  const lines = [state.phase === "blocked" ? "Plan blocked" : "Plan"];
  if (state.blocker) lines.push(`! ${state.blocker.summary}`);
  const statusById = new Map(displayedProgress(state, external).map((step) => [step.id, step.status]));
  for (const [index, step] of state.steps.slice(0, MAX_WIDGET_STEPS).entries()) {
    const status = statusById.get(step.id) ?? "pending";
    const marker = status === "completed"
      ? "✓"
      : status === "blocked"
        ? "!"
        : status === "inProgress"
          ? "→"
          : "·";
    const text = [...step.text];
    const boundedText = text.length > MAX_WIDGET_STEP_CHARS
      ? `${text.slice(0, MAX_WIDGET_STEP_CHARS - 1).join("")}…`
      : step.text;
    lines.push(`${marker} #${index + 1} ${boundedText}`);
  }
  if (state.steps.length > MAX_WIDGET_STEPS) {
    lines.push(`… ${state.steps.length - MAX_WIDGET_STEPS} more step(s)`);
  }
  return lines;
}
