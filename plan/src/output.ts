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
    case "blocked":
      return "blocked pending user input";
  }
}

export function renderPlan(state: PlanState): string {
  const lines = [
    `Plan: ${state.summary ?? state.blocker?.summary ?? "draft"}`,
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
    lines.push("", "Execution steps:");
    for (const [index, step] of state.steps.entries()) lines.push(`${index + 1}. ${step}`);
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
    blocker: state.blocker,
    steps: state.steps.map((text, index) => ({ number: index + 1, text })),
    updatedAt: state.updatedAt,
    complete,
    truncation,
  };
  return state.planPath ? { ...summary, planPath: state.planPath } : summary;
}

export function renderPlanWidget(state: PlanState): string[] {
  const lines = [state.phase === "blocked" ? "Plan blocked" : "Plan"];
  if (state.phase === "awaitingClarification" && state.clarification) {
    const text = [...state.clarification.question];
    const boundedText = text.length > MAX_WIDGET_STEP_CHARS
      ? `${text.slice(0, MAX_WIDGET_STEP_CHARS - 1).join("")}…`
      : state.clarification.question;
    lines.push(`? ${boundedText}`);
  }
  if (state.blocker) lines.push(`! ${state.blocker.summary}`);
  for (const [index, step] of state.steps.slice(0, MAX_WIDGET_STEPS).entries()) {
    const text = [...step];
    const boundedText = text.length > MAX_WIDGET_STEP_CHARS
      ? `${text.slice(0, MAX_WIDGET_STEP_CHARS - 1).join("")}…`
      : step;
    lines.push(`· ${index + 1}. ${boundedText}`);
  }
  if (state.steps.length > MAX_WIDGET_STEPS) {
    lines.push(`… ${state.steps.length - MAX_WIDGET_STEPS} more step(s)`);
  }
  return lines;
}
