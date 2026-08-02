import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Text } from "@earendil-works/pi-tui";
import {
  collapseLines,
  kvRow,
  linesToText,
  moreLinesHint,
  reuseTextComponent,
  statusRow,
  tone,
  toolCallTitle,
} from "pi-uikit-dev";
import { scopeDescription } from "./formatter.ts";
import type { DiffReportToolDetails, DiffReportToolParams } from "./tool.ts";

interface RenderErrorContext {
  isError: boolean;
}

const COLLAPSED_LINE_LIMIT = 15;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

// Partial onUpdate details carry only { source, view }; the final result adds
// the evidence counters. Only the full shape gets the summary card.
function isEvidenceDetails(value: unknown): value is DiffReportToolDetails {
  return isObject(value)
    && typeof value.source === "string"
    && typeof value.view === "string"
    && isCount(value.totalFiles)
    && isCount(value.totalAdditions)
    && isCount(value.totalDeletions)
    && isCount(value.commitCount)
    && isCount(value.untrackedCount)
    && typeof value.truncated === "boolean"
    && (value.target === undefined || typeof value.target === "string")
    && (value.base === undefined || typeof value.base === "string")
    && (value.fullOutputPath === undefined || typeof value.fullOutputPath === "string");
}

function isProgressDetails(value: unknown): value is Readonly<{ source: string; view: string }> {
  return isObject(value) && typeof value.source === "string" && typeof value.view === "string";
}

function resultText(result: AgentToolResult<unknown>): string {
  return result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function summaryValue(details: DiffReportToolDetails): string {
  if (details.view === "history") return `${details.commitCount} commits`;
  const parts = [`${details.totalFiles} files +${details.totalAdditions}/-${details.totalDeletions}`];
  if (details.commitCount > 0) parts.push(`${details.commitCount} commits`);
  if (details.untrackedCount > 0) parts.push(`${details.untrackedCount} untracked`);
  return parts.join(", ");
}

function evidenceLines(output: string, expanded: boolean, theme: Theme): string[] {
  if (output.length === 0) return [];
  const { visible, hiddenCount } = collapseLines(output.split("\n"), {
    expanded,
    collapsedLimit: COLLAPSED_LINE_LIMIT,
  });
  const lines = visible.map((line) => tone(theme, "output", line));
  if (hiddenCount > 0) lines.push(moreLinesHint(theme, hiddenCount));
  return lines;
}

export function renderDiffReportCall(
  args: DiffReportToolParams,
  theme: Theme,
  lastComponent: unknown,
): Text {
  const target = args.target
    ?? (args.paths && args.paths.length > 0
      ? `${args.paths.length} targeted path${args.paths.length === 1 ? "" : "s"}`
      : undefined);
  return reuseTextComponent(
    lastComponent,
    toolCallTitle(theme, {
      brand: "Diff Report",
      action: `${args.source} ${args.view ?? "overview"}`,
      ...(target !== undefined ? { target } : {}),
    }),
  );
}

export function renderDiffReportResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: RenderErrorContext,
): Text {
  const output = resultText(result);

  if (context.isError) {
    return linesToText([tone(theme, "error", output.length > 0 ? output : "diff_report failed.")]);
  }

  const details: unknown = result.details;
  if (isEvidenceDetails(details)) {
    const lines = [
      statusRow(theme, details.truncated ? "warning" : "success", `${details.view} evidence`, summaryValue(details)),
      kvRow(theme, "scope", scopeDescription({
        source: details.source,
        ...(details.target !== undefined ? { target: details.target } : {}),
        ...(details.base !== undefined ? { base: details.base } : {}),
      })),
    ];
    if (details.fullOutputPath !== undefined) lines.push(kvRow(theme, "full output", details.fullOutputPath));
    lines.push(...evidenceLines(output, options.expanded, theme));
    return linesToText(lines);
  }

  if (isProgressDetails(details)) {
    return linesToText([statusRow(theme, "pending", "collecting", `${details.view} evidence for ${details.source}`)]);
  }

  return linesToText(evidenceLines(output, options.expanded, theme));
}
