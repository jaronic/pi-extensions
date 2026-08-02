import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderDiffReportCall, renderDiffReportResult } from "../src/renderer.ts";

const theme = {
  fg(_color: string, text: string): string {
    return text;
  },
  bold(text: string): string {
    return text;
  },
} as unknown as Theme;

const expanded = { expanded: true, isPartial: false };
const collapsed = { expanded: false, isPartial: false };
const ok = { isError: false };

function rendered(component: { render(width: number): string[] }): string[] {
  return component.render(120).map((line) => line.trimEnd());
}

function overviewDetails(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "branch",
    view: "overview",
    target: "feature/payment",
    base: "main",
    totalFiles: 2,
    totalAdditions: 10,
    totalDeletions: 3,
    commitCount: 4,
    untrackedCount: 1,
    truncated: false,
    ...overrides,
  };
}

test("renderCall composes the uikit title and reuses the previous Text component", () => {
  const fresh = renderDiffReportCall(
    { source: "branch", view: "patch", target: "feature/payment" },
    theme,
    undefined,
  );
  assert.deepEqual(rendered(fresh), ["Diff Report · branch patch feature/payment"]);

  const previous = renderDiffReportCall({ source: "commits", target: "HEAD~3..HEAD" }, theme, undefined);
  const reused = renderDiffReportCall({ source: "uncommitted" }, theme, previous);
  assert.equal(reused, previous);
  assert.deepEqual(rendered(reused), ["Diff Report · uncommitted overview"]);

  const targeted = renderDiffReportCall(
    { source: "uncommitted", view: "patch", paths: ["a.ts", "b.ts"] },
    theme,
    undefined,
  );
  assert.deepEqual(rendered(targeted), ["Diff Report · uncommitted patch 2 targeted paths"]);
});

test("renderResult shows the summary card and evidence text from the tool result", () => {
  const output = ["# Git Evidence: Overview", "", "- src/a.ts", "- src/b.ts"].join("\n");
  const lines = rendered(renderDiffReportResult(
    { content: [{ type: "text", text: output }], details: overviewDetails() },
    collapsed,
    theme,
    ok,
  ));
  assert.deepEqual(lines, [
    "✓ overview evidence: 2 files +10/-3, 4 commits, 1 untracked",
    "scope: main...feature/payment (merge-base comparison)",
    "# Git Evidence: Overview",
    "",
    "- src/a.ts",
    "- src/b.ts",
  ]);
});

test("renderResult flags truncation and the full-output path", () => {
  const lines = rendered(renderDiffReportResult(
    {
      content: [{ type: "text", text: "bounded evidence" }],
      details: overviewDetails({ truncated: true, fullOutputPath: "/tmp/diffreport/full.md" }),
    },
    collapsed,
    theme,
    ok,
  ));
  assert.deepEqual(lines, [
    "! overview evidence: 2 files +10/-3, 4 commits, 1 untracked",
    "scope: main...feature/payment (merge-base comparison)",
    "full output: /tmp/diffreport/full.md",
    "bounded evidence",
  ]);
});

test("renderResult summarizes history passes by commit count", () => {
  const lines = rendered(renderDiffReportResult(
    {
      content: [{ type: "text", text: "# Git Evidence: Commit History" }],
      details: overviewDetails({
        source: "commits",
        view: "history",
        target: "HEAD~5..HEAD",
        base: undefined,
        totalFiles: 0,
        totalAdditions: 0,
        totalDeletions: 0,
        commitCount: 5,
        untrackedCount: 0,
      }),
    },
    collapsed,
    theme,
    ok,
  ));
  assert.deepEqual(lines, [
    "✓ history evidence: 5 commits",
    "scope: HEAD~5..HEAD",
    "# Git Evidence: Commit History",
  ]);
});

test("renderResult collapses long evidence and expands every line", () => {
  const output = Array.from({ length: 20 }, (_, index) => `evidence line ${index + 1}`).join("\n");
  const result = {
    content: [{ type: "text" as const, text: output }],
    details: overviewDetails({ commitCount: 0, untrackedCount: 0 }),
  };

  const collapsedLines = rendered(renderDiffReportResult(result, collapsed, theme, ok));
  assert.deepEqual(collapsedLines, [
    "✓ overview evidence: 2 files +10/-3",
    "scope: main...feature/payment (merge-base comparison)",
    ...Array.from({ length: 15 }, (_, index) => `evidence line ${index + 1}`),
    "… (5 more lines; expand to show all)",
  ]);

  const expandedLines = rendered(renderDiffReportResult(result, expanded, theme, ok));
  assert.equal(expandedLines.length, 2 + 20);
  assert.equal(expandedLines.at(-1), "evidence line 20");
});

test("renderResult renders streaming progress and errors without a summary card", () => {
  const progress = rendered(renderDiffReportResult(
    {
      content: [{ type: "text", text: "Collecting overview evidence for branch..." }],
      details: { source: "branch", view: "overview" },
    },
    { expanded: false, isPartial: true },
    theme,
    ok,
  ));
  assert.deepEqual(progress, ["○ collecting: overview evidence for branch"]);

  const failure = rendered(renderDiffReportResult(
    { content: [{ type: "text", text: "not a git repository" }], details: undefined },
    collapsed,
    theme,
    { isError: true },
  ));
  assert.deepEqual(failure, ["not a git repository"]);
});

test("renderResult falls back to plain evidence lines for malformed details", () => {
  const lines = rendered(renderDiffReportResult(
    { content: [{ type: "text", text: "raw evidence" }], details: { forged: true } },
    collapsed,
    theme,
    ok,
  ));
  assert.deepEqual(lines, ["raw evidence"]);
});
