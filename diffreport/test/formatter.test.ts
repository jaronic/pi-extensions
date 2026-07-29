import assert from "node:assert/strict";
import test from "node:test";
import {
  formatEvidenceOverview,
  formatHistoryEvidence,
  formatPatchEvidence,
  scopeDescription,
} from "../src/formatter.ts";
import type { CommitInfo, DiffSummary, FileChange, Hunk } from "../src/types.ts";

function makeHunk(lines: Array<{ type: "addition" | "deletion" | "context"; content: string }>): Hunk {
  return {
    header: "@@ -1,2 +1,2 @@",
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 2,
    lines: lines.map((line, index) => ({ ...line, oldLine: index + 1, newLine: index + 1 })),
  };
}

function makeFile(overrides: Partial<FileChange> = {}): FileChange {
  return {
    oldPath: "src/payment.ts",
    newPath: "src/payment.ts",
    status: "modified",
    hunks: [makeHunk([
      { type: "deletion", content: "return fail();" },
      { type: "addition", content: "return retry();" },
    ])],
    additions: 1,
    deletions: 1,
    isBinary: false,
    ...overrides,
  };
}

function makeSummary(files: FileChange[]): DiffSummary {
  return {
    files,
    totalFiles: files.length,
    totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
    totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

const COMMITS: CommitInfo[] = [{
  hash: "abcdef1234567890",
  subject: "Add retry decision",
  author: "Ada",
  date: "2026-07-29T10:00:00Z",
  body: "Preserve the original payment intent.",
}];

test("formatEvidenceOverview labels output as inventory rather than a final report", () => {
  const report = formatEvidenceOverview(
    makeSummary([makeFile()]),
    { source: "branch", base: "main", target: "feature/payment" },
    COMMITS,
    ["src/new-rule.ts"],
  );
  assert.match(report, /^# Git Evidence: Overview/m);
  assert.match(report, /Inventory only/);
  assert.match(report, /main\.\.\.feature\/payment/);
  assert.match(report, /\| modified \| src\/payment\.ts \| \+1\/-1 \|/);
  assert.match(report, /src\/new-rule\.ts/);
  assert.match(report, /Required next passes/);
  assert.doesNotMatch(report, /Risk Assessment|code review/i);
});

test("formatEvidenceOverview handles an empty tracked and untracked source", () => {
  const report = formatEvidenceOverview(makeSummary([]), { source: "uncommitted" }, [], []);
  assert.match(report, /No tracked changes found/);
  assert.match(report, /Untracked files: 0/);
});

test("formatEvidenceOverview bounds file, commit, and untracked inventories", () => {
  const files = [makeFile({ newPath: "a.ts", oldPath: "a.ts" }), makeFile({ newPath: "b.ts", oldPath: "b.ts" })];
  const report = formatEvidenceOverview(
    makeSummary(files),
    { source: "commits", target: "HEAD~2..HEAD" },
    [...COMMITS, { ...COMMITS[0]!, hash: "def456", subject: "Second" }],
    ["one.ts", "two.ts"],
    { maxFiles: 1, maxCommits: 1, maxUntrackedFiles: 1 },
  );
  assert.match(report, /1 more tracked paths/);
  assert.match(report, /1 more commits omitted/);
  assert.match(report, /1 more untracked paths omitted/);
});

test("formatPatchEvidence renders targeted hunks and points untracked files to direct reads", () => {
  const report = formatPatchEvidence(
    makeSummary([makeFile()]),
    { source: "uncommitted" },
    ["src/untracked.ts"],
  );
  assert.match(report, /^# Git Evidence: Targeted Patch/m);
  assert.match(report, /```diff/);
  assert.match(report, /-return fail\(\);/);
  assert.match(report, /\+return retry\(\);/);
  assert.match(report, /Untracked content is not fabricated/);
  assert.match(report, /not a business report/);
});

test("formatPatchEvidence truncates each large hunk", () => {
  const hunk = makeHunk(Array.from({ length: 4 }, (_, index) => ({
    type: "addition" as const,
    content: `line ${index}`,
  })));
  const report = formatPatchEvidence(
    makeSummary([makeFile({ hunks: [hunk], additions: 4 })]),
    { source: "commits", target: "abc123" },
    [],
    { maxHunkLines: 2 },
  );
  assert.match(report, /2 more lines omitted/);
});

test("formatHistoryEvidence preserves rationale while warning that messages need corroboration", () => {
  const report = formatHistoryEvidence(COMMITS, { source: "branch", base: "main", target: "feature" });
  assert.match(report, /# Git Evidence: Commit History/);
  assert.match(report, /Preserve the original payment intent/);
  assert.match(report, /historical claims/);
});

test("scopeDescription exposes exact before and after boundaries", () => {
  assert.equal(
    scopeDescription({ source: "uncommitted" }),
    "HEAD → index + working tree (tracked changes; untracked files listed separately)",
  );
  assert.equal(scopeDescription({ source: "branch", base: "develop", target: "feature" }), "develop...feature (merge-base comparison)");
  assert.equal(scopeDescription({ source: "commits", target: "HEAD~3..HEAD" }), "HEAD~3..HEAD");
});
