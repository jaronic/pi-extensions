import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  collapseLines,
  kvRow,
  linesToText,
  moreLinesHint,
  reuseTextComponent,
  statusRow,
  toolCallTitle,
  tone,
} from "pi-uikit-dev";

interface LspResultDetails {
  action: string;
  resultCount: number;
  errorCount: number;
  configuredCount?: number;
  activeCount?: number;
  truncated?: boolean;
  fullOutputPath?: string;
}

interface LspCallArgs {
  action?: string;
  file?: string;
  query?: string;
  newName?: string;
}

const COLLAPSED_LINE_LIMIT = 15;

const SERVER_ERROR = /^\[[^\]]+\] ERROR /;
const DIAGNOSTIC_SEVERITY = / (error|warning|info|hint)( \S+)?(\([^)]*\))?: /;

function isDetails(value: unknown): value is LspResultDetails {
  if (typeof value !== "object" || value === null) return false;
  const details = value as LspResultDetails;
  return typeof details.action === "string"
    && Number.isSafeInteger(details.resultCount)
    && Number.isSafeInteger(details.errorCount);
}

export function renderLspCall(args: LspCallArgs, theme: Theme, lastComponent: unknown): Text {
  const target = args.file === undefined
    ? args.query
    : args.newName === undefined ? args.file : `${args.file} → ${args.newName}`;
  return reuseTextComponent(
    lastComponent,
    toolCallTitle(theme, { brand: "LSP", action: args.action, target }),
  );
}

function styleLine(line: string, theme: Theme): string {
  if (line.startsWith("…")) return tone(theme, "muted", line);
  if (SERVER_ERROR.test(line)) return tone(theme, "error", line);
  const severity = DIAGNOSTIC_SEVERITY.exec(line);
  if (severity?.[1] === "error") return tone(theme, "error", line);
  if (severity?.[1] === "warning") return tone(theme, "warning", line);
  return tone(theme, "output", line);
}

export function renderLspResult(
  result: AgentToolResult<unknown>,
  options: Readonly<{ expanded: boolean; isError: boolean }>,
  theme: Theme,
): Text {
  const output = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (options.isError) return new Text(tone(theme, "error", output), 0, 0);

  const details: unknown = result.details;
  const lines: string[] = [];
  if (isDetails(details)) {
    const value = details.action === "status"
      && Number.isSafeInteger(details.activeCount)
      && Number.isSafeInteger(details.configuredCount)
      ? `${details.activeCount} active / ${details.configuredCount} configured`
      : `${details.resultCount} result(s)`;
    lines.push(statusRow(theme, details.errorCount > 0 ? "warning" : "success", details.action, value));
  }

  const bodyLines = output.length === 0 ? [] : output.split("\n");
  const { visible, hiddenCount } = collapseLines(bodyLines, {
    expanded: options.expanded,
    collapsedLimit: COLLAPSED_LINE_LIMIT,
  });
  lines.push(...visible.map((line) => styleLine(line, theme)));
  if (hiddenCount > 0) lines.push(moreLinesHint(theme, hiddenCount));
  if (isDetails(details) && details.truncated === true && typeof details.fullOutputPath === "string") {
    lines.push(kvRow(theme, "full output", details.fullOutputPath));
  }
  return linesToText(lines);
}
