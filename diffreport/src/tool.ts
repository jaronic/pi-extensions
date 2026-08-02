import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { parseDiff } from "./diff-parser.ts";
import type { DiffReportCallLedger } from "./call-ledger.ts";
import {
  getCommitHistory,
  listUntrackedFiles,
  resolveEvidenceScope,
  runGitDiff,
  validateWorkspacePaths,
} from "./git-diff.ts";
import {
  formatEvidenceOverview,
  formatHistoryEvidence,
  formatPatchEvidence,
} from "./formatter.ts";
import type { DiffReportOutputStore } from "./output.ts";
import { renderDiffReportCall, renderDiffReportResult } from "./renderer.ts";
import type { EvidenceSource, EvidenceView } from "./types.ts";

const Parameters = Type.Object({
  source: StringEnum(["uncommitted", "branch", "commits"] as const, {
    description: "Git evidence source. The source anchors comparison but does not limit related-code exploration.",
  }),
  view: Type.Optional(StringEnum(["overview", "patch", "history"] as const, {
    description: "Evidence pass: inventory, targeted patch, or commit history. Defaults to overview.",
  })),
  target: Type.Optional(Type.String({
    description: "Target branch for branch source, or commit/ref/range for commits source.",
    maxLength: 256,
  })),
  base: Type.Optional(Type.String({
    description: "Before-state branch/ref for branch source. A repository default is inferred only when unambiguous.",
    maxLength: 256,
  })),
  paths: Type.Optional(Type.Array(Type.String({ maxLength: 1024 }), {
    description: "Targeted workspace-relative paths chosen after inventory; these are not the analysis boundary.",
    maxItems: 20,
  })),
  query: Type.Optional(Type.String({
    description: "Optional commit-message filter for history view only.",
    maxLength: 500,
  })),
  contextLines: Type.Optional(Type.Integer({ minimum: 0, maximum: 20, default: 3 })),
  limit: Type.Optional(Type.Integer({
    minimum: 1,
    maximum: 50,
    default: 20,
    description: "Maximum files or commits rendered in this evidence pass.",
  })),
}, { additionalProperties: false });

export interface DiffReportToolParams {
  source: EvidenceSource;
  view?: EvidenceView;
  target?: string;
  base?: string;
  paths?: string[];
  query?: string;
  contextLines?: number;
  limit?: number;
}

export interface DiffReportToolDetails {
  source: EvidenceSource;
  view: EvidenceView;
  target?: string;
  base?: string;
  totalFiles: number;
  totalAdditions: number;
  totalDeletions: number;
  commitCount: number;
  untrackedCount: number;
  truncated: boolean;
  fullOutputPath?: string;
}

export function registerDiffReportTool(pi: ExtensionAPI, outputStore: DiffReportOutputStore, callLedger?: DiffReportCallLedger): void {
  pi.registerTool({
    name: "diff_report",
    label: "Diff Report Evidence",
    description: "Collect bounded Git evidence for a multi-pass business-logic report. Use it to verify what actually changed before delivering changes or writing a change report. This tool does not generate the final report: start with view='overview', then use targeted patch/history passes and repository navigation before writing Markdown.",
    promptSnippet: "Collect Git evidence for business-flow and decision-chain analysis",
    promptGuidelines: [
      "Use diff_report view='overview' first for each selected source; its output is inventory, never the final report.",
      "After diff_report overview, run at least one targeted patch or history pass and trace unchanged callers, state, persistence, and external effects with repository tools.",
      "Treat diff_report source and paths as evidence anchors, not hard investigation boundaries.",
      "In diff_report, treat a user-provided description as context to verify, never as a commit-message or file filter.",
      "Use the Request ask tool for material scope or intent ambiguity; do not ask clarifying questions as plain prose.",
      "Ground the final deliverable in diff_report evidence: a detailed Markdown business-logic report with evidence-backed diagrams and tradeoff analysis, not a code review.",
    ],
    parameters: Parameters,
    renderCall(args, theme, context) {
      return renderDiffReportCall(args, theme, context.lastComponent);
    },
    renderResult(result, options, theme, context) {
      return renderDiffReportResult(result, options, theme, context);
    },
    async execute(_toolCallId, params: DiffReportToolParams, signal, onUpdate, ctx) {
      if (signal?.aborted) throw new Error("Diff report evidence collection was cancelled.");
      const view = params.view ?? "overview";
      if (params.query && view !== "history") throw new Error("query is only valid with view='history'.");
      const limit = params.limit ?? 20;
      const contextLines = params.contextLines ?? 3;
      const paths = await validateWorkspacePaths(params.paths, ctx.cwd);
      const scope = await resolveEvidenceScope(pi, ctx.cwd, {
        source: params.source,
        target: params.target,
        base: params.base,
      }, signal);

      onUpdate?.({
        content: [{ type: "text", text: `Collecting ${view} evidence for ${scope.source}...` }],
        details: { source: scope.source, view },
      });

      let text: string;
      let totalFiles = 0;
      let totalAdditions = 0;
      let totalDeletions = 0;
      let commitCount = 0;
      let untrackedCount = 0;

      if (view === "history") {
        const commits = await getCommitHistory(
          pi,
          ctx.cwd,
          scope,
          paths,
          params.query,
          limit,
          false,
          signal,
        );
        commitCount = commits.length;
        text = formatHistoryEvidence(commits, scope, params.query, { maxCommits: limit });
      } else {
        const diffPromise = runGitDiff(pi, ctx.cwd, scope, paths, contextLines, signal);
        const untrackedPromise = scope.source === "uncommitted"
          ? listUntrackedFiles(pi, ctx.cwd, paths, signal)
          : Promise.resolve<string[]>([]);
        const commitsPromise = view === "overview" && scope.source !== "uncommitted"
          ? getCommitHistory(pi, ctx.cwd, scope, paths, undefined, limit, true, signal)
          : Promise.resolve([]);
        const [rawDiff, untrackedFiles, commits] = await Promise.all([
          diffPromise,
          untrackedPromise,
          commitsPromise,
        ]);
        const summary = parseDiff(rawDiff);
        totalFiles = summary.totalFiles;
        totalAdditions = summary.totalAdditions;
        totalDeletions = summary.totalDeletions;
        commitCount = commits.length;
        untrackedCount = untrackedFiles.length;
        text = view === "overview"
          ? formatEvidenceOverview(summary, scope, commits, untrackedFiles, {
              maxFiles: limit,
              maxCommits: limit,
              maxUntrackedFiles: limit,
            })
          : formatPatchEvidence(summary, scope, untrackedFiles, {
              maxFiles: limit,
              maxUntrackedFiles: limit,
            });
      }

      const bounded = await outputStore.bound(text);
      const details: DiffReportToolDetails = {
        source: scope.source,
        view,
        ...(scope.target ? { target: scope.target } : {}),
        ...(scope.base ? { base: scope.base } : {}),
        totalFiles,
        totalAdditions,
        totalDeletions,
        commitCount,
        untrackedCount,
        truncated: bounded.truncation !== undefined,
        ...(bounded.fullOutputPath ? { fullOutputPath: bounded.fullOutputPath } : {}),
      };
      callLedger?.record(scope.source, view);
      return {
        content: [{ type: "text" as const, text: bounded.text }],
        details,
      };
    },
  });
}
