/**
 * TUI rendering for the doc_lint tool: call-card title and result body styled
 * through pi-uikit-dev primitives. The model-facing content text is produced
 * by format.ts and never passes through this module.
 */
import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
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
import type { Finding } from "./checks.ts";

/** Structured summary execute() copies into tool details. */
export interface DocLintToolDetails {
  root: string;
  packagesScanned: string[];
  errors: number;
  warnings: number;
  omitted: number;
  findings: Finding[];
}

interface RenderErrorContext {
  lastComponent?: unknown;
  isError: boolean;
}

const COLLAPSED_BODY_LIMIT = 15;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isFinding(value: unknown): value is Finding {
  return isObject(value)
    && typeof value.file === "string"
    && typeof value.check === "string"
    && (value.severity === "error" || value.severity === "warning")
    && typeof value.message === "string";
}

function isDocLintDetails(value: unknown): value is DocLintToolDetails {
  return isObject(value)
    && typeof value.root === "string"
    && Array.isArray(value.packagesScanned)
    && value.packagesScanned.every((entry) => typeof entry === "string")
    && isCount(value.errors)
    && isCount(value.warnings)
    && isCount(value.omitted)
    && Array.isArray(value.findings)
    && value.findings.every(isFinding);
}

function severityRank(finding: Finding): number {
  return finding.severity === "error" ? 0 : 1;
}

export function renderDocLintCall(
  args: Readonly<{ action: string; root?: string; maxFindings?: number }>,
  theme: Theme,
  context: RenderErrorContext,
): Text {
  return reuseTextComponent(
    context.lastComponent,
    toolCallTitle(theme, { brand: "Doclint", action: args.action, target: args.root }),
  );
}

function fallbackResult(result: AgentToolResult<unknown>, isError: boolean, theme: Theme): Text {
  const text = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return linesToText([tone(theme, isError ? "error" : "output", text)]);
}

export function renderDocLintResult(
  result: AgentToolResult<unknown>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: RenderErrorContext,
): Text {
  const details: unknown = result.details;
  if (context.isError || !isDocLintDetails(details)) {
    return fallbackResult(result, context.isError, theme);
  }

  const total = details.errors + details.warnings;
  const status = details.errors > 0 ? "error" : total > 0 ? "warning" : "success";
  const summary = total === 0
    ? "no findings; the documentation contract holds"
    : `${details.errors} error(s), ${details.warnings} warning(s)`;
  const header = [
    statusRow(theme, status, "doc lint", summary),
    kvRow(theme, "root", details.root),
    kvRow(
      theme,
      "packages scanned",
      details.packagesScanned.length > 0
        ? `${details.packagesScanned.length} (${details.packagesScanned.join(", ")})`
        : "(none)",
    ),
  ];
  if (details.omitted > 0) {
    header.push(tone(theme, "warning", `omitted findings: ${details.omitted} (raise maxFindings to see them)`));
  }

  const byFile = new Map<string, Finding[]>();
  for (const finding of details.findings) {
    const group = byFile.get(finding.file);
    if (group) group.push(finding);
    else byFile.set(finding.file, [finding]);
  }
  const body: string[] = [];
  for (const [file, group] of byFile) {
    body.push("");
    body.push(tone(theme, "accent", `${file}:`));
    const ordered = [...group].sort((a, b) => severityRank(a) - severityRank(b));
    for (const finding of ordered) {
      body.push(tone(theme, finding.severity, `  [${finding.severity}] ${finding.check}: ${finding.message}`));
    }
  }

  const { visible, hiddenCount } = collapseLines(body, { expanded: options.expanded, collapsedLimit: COLLAPSED_BODY_LIMIT });
  const lines = [...header, ...visible];
  if (hiddenCount > 0) lines.push(moreLinesHint(theme, hiddenCount));
  // details.findings is capped by execute(); the full list stays in the text content.
  const beyondDetails = total - details.findings.length;
  if (beyondDetails > 0) {
    lines.push(tone(theme, "muted", `… (${beyondDetails} more findings in the tool text output)`));
  }
  return linesToText(lines);
}
