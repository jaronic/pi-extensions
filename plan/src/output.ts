import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import type { PlanPhase, PlanState } from "./state.ts";

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

export function phaseLabel(phase: PlanPhase): string {
  switch (phase) {
    case "off":
      return "off";
    case "planning":
      return "planning";
    case "awaitingClarification":
      return "awaiting your decision";
    case "awaitingApproval":
      return "awaiting approval";
    case "executing":
      return "executing";
  }
}

export function renderPlan(state: PlanState): string {
  const lines = [
    `Plan: ${state.summary ?? "draft"}`,
    `Phase: ${phaseLabel(state.phase)}`,
  ];
  if (state.clarification) {
    lines.push("", "User decision:", state.clarification.question);
    for (const [index, option] of state.clarification.options.entries()) {
      const selected = state.clarification.selection === index ? " (selected)" : "";
      lines.push(`${index + 1}. ${option.label}${selected}`);
      if (option.description) lines.push(`   ${option.description}`);
    }
  }
  if (state.plan) lines.push("", state.plan);
  if (state.steps.length > 0) {
    lines.push("", "Execution steps:");
    for (const step of state.steps) {
      const marker = step.status === "completed" ? "x" : step.status === "blocked" ? "!" : " ";
      lines.push(`- [${marker}] ${step.id}: ${step.text} (${step.status})`);
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
): Record<string, unknown> {
  if (!state) return { phase: "off", complete, truncation };
  const summary = {
    phase: state.phase,
    summary: state.summary,
    steps: state.steps.map(({ id, status }) => ({ id, status })),
    updatedAt: state.updatedAt,
    complete,
    truncation,
  };
  return state.planPath ? { ...summary, planPath: state.planPath } : summary;
}

export function renderPlanWidget(state: PlanState): string[] {
  const lines = ["Plan"];
  if (state.phase === "awaitingClarification" && state.clarification) {
    const text = [...state.clarification.question];
    const boundedText = text.length > MAX_WIDGET_STEP_CHARS
      ? `${text.slice(0, MAX_WIDGET_STEP_CHARS - 1).join("")}…`
      : state.clarification.question;
    lines.push(`? ${boundedText}`);
  }
  for (const step of state.steps.slice(0, MAX_WIDGET_STEPS)) {
    const marker = step.status === "completed"
      ? "✓"
      : step.status === "blocked"
        ? "!"
        : step.status === "inProgress"
          ? "→"
          : "·";
    const text = [...step.text];
    const boundedText = text.length > MAX_WIDGET_STEP_CHARS
      ? `${text.slice(0, MAX_WIDGET_STEP_CHARS - 1).join("")}…`
      : step.text;
    lines.push(`${marker} ${step.id} ${boundedText}`);
  }
  if (state.steps.length > MAX_WIDGET_STEPS) {
    lines.push(`… ${state.steps.length - MAX_WIDGET_STEPS} more step(s)`);
  }
  return lines;
}
