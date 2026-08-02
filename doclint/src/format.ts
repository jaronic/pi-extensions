/**
 * Render a LintReport as bounded plain text for tool content and
 * command notifications. Grouped by file, errors before warnings,
 * truncated to the Pi output budget (50KB / 2000 lines).
 */
import { formatSize, truncateHead, type TruncationOptions } from "@earendil-works/pi-coding-agent";
import type { Finding, LintReport } from "./checks.ts";

function severityRank(finding: Finding): number {
  return finding.severity === "error" ? 0 : 1;
}

export function formatReport(report: LintReport, truncation?: TruncationOptions): string {
  const errors = report.findings.filter((finding) => finding.severity === "error").length;
  const warnings = report.findings.length - errors;
  const lines: string[] = [];
  lines.push(
    report.findings.length === 0
      ? "doc lint: no findings; the documentation contract holds"
      : `doc lint: ${errors} error(s), ${warnings} warning(s)`,
  );
  lines.push(`root: ${report.root}`);
  lines.push(
    `packages scanned (${report.packagesScanned.length}): ${
      report.packagesScanned.length > 0 ? report.packagesScanned.join(", ") : "(none)"
    }`,
  );
  if (report.omitted > 0) {
    lines.push(`omitted findings: ${report.omitted} (raise maxFindings to see them)`);
  }

  const byFile = new Map<string, Finding[]>();
  for (const finding of report.findings) {
    const group = byFile.get(finding.file);
    if (group) group.push(finding);
    else byFile.set(finding.file, [finding]);
  }
  for (const [file, group] of byFile) {
    lines.push("");
    lines.push(`${file}:`);
    const ordered = [...group].sort((a, b) => severityRank(a) - severityRank(b));
    for (const finding of ordered) {
      lines.push(`  [${finding.severity}] ${finding.check}: ${finding.message}`);
    }
  }

  const truncated = truncateHead(lines.join("\n"), truncation);
  if (!truncated.truncated) return truncated.content;
  return `${truncated.content}\n... truncated: showing ${truncated.outputLines} of ${truncated.totalLines} lines (${formatSize(truncated.totalBytes)} total)`;
}
