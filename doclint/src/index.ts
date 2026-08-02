/**
 * doclint composition root: registers the doc_lint model tool and the
 * /doclint command. All checking logic lives in checks.ts/scan.ts, all real
 * I/O in fs-adapter.ts; this file only wires them to Pi.
 */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runDocLint, type LintReport } from "./checks.ts";
import { nodeRepoFileSystem, resolveLintRoot } from "./fs-adapter.ts";
import { formatReport } from "./format.ts";
import { renderDocLintCall, renderDocLintResult } from "./renderer.ts";

/** Findings copied into tool details; the full list stays in the text content. */
const MAX_DETAILS_FINDINGS = 50;

const Parameters = Type.Object({
  action: StringEnum(["check"] as const),
  root: Type.Optional(
    Type.String({
      description:
        "Repository root to lint, relative to the current workspace (or an absolute path inside it). Defaults to the workspace root.",
      maxLength: 500,
    }),
  ),
  maxFindings: Type.Optional(
    Type.Integer({
      description: "Maximum number of findings to collect before capping the report",
      minimum: 1,
      maximum: 500,
    }),
  ),
});

function countSeverities(report: LintReport): { errors: number; warnings: number } {
  const errors = report.findings.filter((finding) => finding.severity === "error").length;
  return { errors, warnings: report.findings.length - errors };
}

export default function doclintExtension(pi: ExtensionAPI): void {
  const runCheck = (cwd: string, root: string | undefined, maxFindings: number | undefined): LintReport => {
    const resolved = resolveLintRoot(cwd, root);
    return runDocLint(nodeRepoFileSystem, resolved, maxFindings === undefined ? undefined : { maxFindings });
  };

  pi.registerTool({
    name: "doc_lint",
    label: "Doc Lint",
    description:
      "Check the repository documentation contract without modifying anything: AGENTS.md package-table coverage of extension packages, README tool/command names versus names registered in src, README npm scripts versus package.json scripts, and pi.extensions path existence. Returns findings grouped by file with error/warning severity.",
    promptSnippet: "Lint AGENTS.md/README documentation-contract drift",
    promptGuidelines: [
      "Use doc_lint after adding, renaming, or removing an extension package, tool, command, or npm script to catch documentation drift before commit.",
      "Fix every doc_lint error in the same change as the code drift it reports; review doc_lint warnings individually because README name detection is heuristic.",
    ],
    parameters: Parameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) throw new Error("doc_lint check cancelled");
      const report = runCheck(ctx.cwd, params.root, params.maxFindings);
      const { errors, warnings } = countSeverities(report);
      return {
        content: [{ type: "text", text: formatReport(report) }],
        details: {
          root: report.root,
          packagesScanned: report.packagesScanned,
          errors,
          warnings,
          omitted: report.omitted,
          findings: report.findings.slice(0, MAX_DETAILS_FINDINGS),
        },
      };
    },
    // Model-facing content stays the plain formatReport text above; these
    // hooks only style the TUI card via pi-uikit-dev primitives.
    renderCall(args, theme, context) {
      return renderDocLintCall(args, theme, context);
    },
    renderResult(result, options, theme, context) {
      return renderDocLintResult(result, options, theme, context);
    },
  });

  pi.registerCommand("doclint", {
    description: "Check AGENTS.md/README documentation-contract drift (same checks as the doc_lint tool); optional argument: repository root relative to the workspace",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      let report: LintReport;
      try {
        report = runCheck(ctx.cwd, trimmed === "" ? undefined : trimmed, undefined);
      } catch (error) {
        ctx.ui.notify(`doclint failed: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      const { errors } = countSeverities(report);
      const severity = errors > 0 ? "error" : report.findings.length > 0 ? "warning" : "info";
      ctx.ui.notify(formatReport(report), severity);
    },
  });
}
