import type {
  CommitInfo,
  DiffSummary,
  EvidenceFormatOptions,
  EvidenceScope,
  FileChange,
  Hunk,
} from "./types.ts";

const DEFAULT_OPTIONS: EvidenceFormatOptions = {
  maxFiles: 50,
  maxHunkLines: 200,
  maxCommits: 20,
  maxUntrackedFiles: 50,
};

function inlineCode(value: string): string {
  return `\`${value.replaceAll("`", "\\`")}\``;
}


export function scopeDescription(scope: EvidenceScope): string {
  switch (scope.source) {
    case "uncommitted":
      return "HEAD → index + working tree (tracked changes; untracked files listed separately)";
    case "branch":
      return `${scope.base ?? "?"}...${scope.target ?? "?"} (merge-base comparison)`;
    case "commits":
      return scope.target ?? "unknown commit selection";
  }
}

function displayPath(file: FileChange): string {
  return file.status === "renamed" ? `${file.oldPath} → ${file.newPath}` : file.newPath;
}

function renderFileInventory(summary: DiffSummary, maxFiles: number): string[] {
  const lines = ["| Status | Path | Delta |", "| --- | --- | ---: |"];
  for (const file of summary.files.slice(0, maxFiles)) {
    const binary = file.isBinary ? "binary" : `+${file.additions}/-${file.deletions}`;
    lines.push(`| ${file.status} | ${displayPath(file).replaceAll("|", "\\|").replace(/\r?\n/g, " ")} | ${binary} |`);
  }
  if (summary.files.length > maxFiles) {
    lines.push(`| … | ${summary.files.length - maxFiles} more tracked paths | — |`);
  }
  return lines;
}

function renderCommits(commits: readonly CommitInfo[], maxCommits: number): string[] {
  const visible = commits.slice(0, maxCommits);
  const lines = visible.map((commit, index) =>
    `${index + 1}. ${inlineCode(commit.hash.slice(0, 12))} ${commit.subject} — ${commit.author}, ${commit.date}`
  );
  if (commits.length > visible.length) lines.push(`… ${commits.length - visible.length} more commits omitted`);
  return lines;
}

function renderUntracked(files: readonly string[], maximum: number): string[] {
  const visible = files.slice(0, maximum);
  const lines = visible.map((path) => `- ${inlineCode(path)}`);
  if (files.length > visible.length) lines.push(`- … ${files.length - visible.length} more untracked paths omitted`);
  return lines;
}

export function formatEvidenceOverview(
  summary: DiffSummary,
  scope: EvidenceScope,
  commits: readonly CommitInfo[],
  untrackedFiles: readonly string[],
  options?: Partial<EvidenceFormatOptions>,
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const lines = [
    "# Git Evidence: Overview",
    "",
    "> Inventory only. This is a starting point for business-flow exploration, not the final report.",
    "",
    "## Source",
    `- ${scopeDescription(scope)}`,
    `- Tracked files: ${summary.totalFiles}`,
    `- Tracked delta: +${summary.totalAdditions}/-${summary.totalDeletions}`,
    `- Untracked files: ${untrackedFiles.length}`,
    "",
  ];

  if (commits.length > 0) {
    lines.push("## Commits in the selected boundary", "", ...renderCommits(commits, opts.maxCommits), "");
  }

  lines.push("## Changed paths", "");
  if (summary.totalFiles === 0) lines.push("No tracked changes found.");
  else lines.push(...renderFileInventory(summary, opts.maxFiles));
  lines.push("");

  if (untrackedFiles.length > 0) {
    lines.push("## Untracked paths", "", ...renderUntracked(untrackedFiles, opts.maxUntrackedFiles), "");
  }

  lines.push(
    "## Required next passes",
    "",
    "- Use `view=\"patch\"` for targeted paths; do not infer business behavior from filenames or statistics.",
    "- Use `view=\"history\"` for decision context, then trace callers, state, persistence, and external effects in source.",
    "- Treat the selected Git source as an evidence anchor, not a hard investigation boundary.",
  );
  return lines.join("\n");
}

function formatHunk(hunk: Hunk, maxHunkLines: number): string {
  const lines = ["```diff", hunk.header];
  const visible = hunk.lines.slice(0, maxHunkLines);
  for (const line of visible) {
    const prefix = line.type === "addition" ? "+" : line.type === "deletion" ? "-" : " ";
    lines.push(`${prefix}${line.content}`);
  }
  if (hunk.lines.length > visible.length) lines.push(`... (${hunk.lines.length - visible.length} more lines omitted)`);
  lines.push("```");
  return lines.join("\n");
}

function formatFilePatch(file: FileChange, maxHunkLines: number): string {
  const marker = file.isBinary ? " [binary]" : ` +${file.additions}/-${file.deletions}`;
  const lines = [`### ${displayPath(file)} (${file.status})${marker}`];
  if (!file.isBinary) {
    for (const hunk of file.hunks) lines.push("", formatHunk(hunk, maxHunkLines));
  }
  return lines.join("\n");
}

export function formatPatchEvidence(
  summary: DiffSummary,
  scope: EvidenceScope,
  untrackedFiles: readonly string[],
  options?: Partial<EvidenceFormatOptions>,
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const visible = summary.files.slice(0, opts.maxFiles);
  const lines = [
    "# Git Evidence: Targeted Patch",
    "",
    `- Source: ${scopeDescription(scope)}`,
    `- Showing ${visible.length} of ${summary.totalFiles} tracked files`,
    "",
  ];
  if (visible.length === 0) lines.push("No tracked patch content found.");
  else lines.push(...visible.flatMap((file) => [formatFilePatch(file, opts.maxHunkLines), ""]));
  if (summary.files.length > visible.length) {
    lines.push(`… ${summary.files.length - visible.length} more tracked files omitted; narrow with \`paths\`.`, "");
  }
  if (untrackedFiles.length > 0) {
    lines.push(
      "## Untracked paths",
      "",
      "Untracked content is not fabricated as a Git patch. Read these files directly:",
      "",
      ...renderUntracked(untrackedFiles, opts.maxUntrackedFiles),
      "",
    );
  }
  lines.push("> Patch evidence is not a business report. Continue through unchanged callers and state transitions.");
  return lines.join("\n");
}

export function formatHistoryEvidence(
  commits: readonly CommitInfo[],
  scope: EvidenceScope,
  query?: string,
  options?: Partial<EvidenceFormatOptions>,
): string {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const visible = commits.slice(0, opts.maxCommits);
  const lines = [
    "# Git Evidence: Commit History",
    "",
    `- Source: ${scopeDescription(scope)}`,
    ...(query ? [`- Message filter: ${query}`] : []),
    `- Showing ${visible.length} commits`,
    "",
  ];
  if (visible.length === 0) lines.push("No commits matched the selected history boundary.");
  for (const commit of visible) {
    lines.push(`## ${inlineCode(commit.hash.slice(0, 12))} ${commit.subject}`, "");
    lines.push(`- Author: ${commit.author}`, `- Date: ${commit.date}`);
    if (commit.body) {
      lines.push("", ...commit.body.split("\n").map((line) => `> ${line}`));
    }
    lines.push("");
  }
  if (commits.length > visible.length) lines.push(`… ${commits.length - visible.length} more commits omitted.`, "");
  lines.push("> Commit messages are historical claims. Corroborate them against code and behavior before reconstructing decisions.");
  return lines.join("\n");
}
