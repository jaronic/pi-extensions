import type { DiffLine, DiffSummary, FileChange, FileStatus, Hunk } from "./types.ts";

const DIFF_HEADER_RE = /^diff --git a\/(.+?) b\/(.+?)$/;
const OLD_PATH_RE = /^--- (?:a\/(.+)|\/dev\/null)$/;
const NEW_PATH_RE = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const NEW_FILE_RE = /^new file mode/;
const DELETED_FILE_RE = /^deleted file mode/;
const RENAME_FROM_RE = /^rename from (.+)$/;
const RENAME_TO_RE = /^rename to (.+)$/;
const BINARY_RE = /^Binary files/;
const NO_NEWLINE_RE = /^\\ No newline at end of file/;

export function parseDiff(rawDiff: string): DiffSummary {
  if (!rawDiff.trim()) {
    return { files: [], totalFiles: 0, totalAdditions: 0, totalDeletions: 0 };
  }

  const lines = rawDiff.split("\n");
  const files: FileChange[] = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  // Split into file blocks by finding "diff --git" lines
  const blockStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (DIFF_HEADER_RE.test(lines[i])) {
      blockStarts.push(i);
    }
  }

  for (let blockIdx = 0; blockIdx < blockStarts.length; blockIdx++) {
    const start = blockStarts[blockIdx];
    const end = blockIdx + 1 < blockStarts.length ? blockStarts[blockIdx + 1] : lines.length;
    const block = lines.slice(start, end);

    const fileChange = parseFileBlock(block);
    if (fileChange) {
      totalAdditions += fileChange.additions;
      totalDeletions += fileChange.deletions;
      files.push(fileChange);
    }
  }

  return {
    files,
    totalFiles: files.length,
    totalAdditions,
    totalDeletions,
  };
}

function parseFileBlock(block: string[]): FileChange | null {
  if (block.length === 0) return null;

  const headerMatch = DIFF_HEADER_RE.exec(block[0]);
  if (!headerMatch) return null;

  let oldPath = headerMatch[1];
  let newPath = headerMatch[2];
  let status: FileStatus = "modified";
  let isBinary = false;
  const hunks: Hunk[] = [];
  let additions = 0;
  let deletions = 0;

  let i = 1;

  // Parse metadata lines
  while (i < block.length) {
    const line = block[i];

    if (NEW_FILE_RE.test(line)) {
      status = "added";
      i++;
      continue;
    }
    if (DELETED_FILE_RE.test(line)) {
      status = "deleted";
      i++;
      continue;
    }

    const renameFrom = RENAME_FROM_RE.exec(line);
    if (renameFrom) {
      status = "renamed";
      oldPath = renameFrom[1];
      i++;
      continue;
    }
    const renameTo = RENAME_TO_RE.exec(line);
    if (renameTo) {
      newPath = renameTo[1];
      i++;
      continue;
    }

    if (BINARY_RE.test(line)) {
      isBinary = true;
      i++;
      // Skip remaining metadata
      while (i < block.length && !HUNK_RE.test(block[i])) i++;
      break;
    }

    if (OLD_PATH_RE.test(line) || HUNK_RE.test(line)) break;

    i++;
  }

  // Parse --- and +++ lines
  if (i < block.length) {
    const oldMatch = OLD_PATH_RE.exec(block[i]);
    if (oldMatch) {
      if (oldMatch[1] !== undefined) oldPath = oldMatch[1];
      i++;
    }
  }
  if (i < block.length) {
    const newMatch = NEW_PATH_RE.exec(block[i]);
    if (newMatch) {
      if (newMatch[1] !== undefined) newPath = newMatch[1];
      i++;
    }
  }

  if (isBinary) {
    return { oldPath, newPath, status, hunks: [], additions: 0, deletions: 0, isBinary: true };
  }

  // Parse hunks
  while (i < block.length) {
    const hunkMatch = HUNK_RE.exec(block[i]);
    if (!hunkMatch) {
      i++;
      continue;
    }

    const hunkHeader = block[i];
    const oldStart = Number(hunkMatch[1]);
    const oldLines = hunkMatch[2] !== undefined ? Number(hunkMatch[2]) : 1;
    const newStart = Number(hunkMatch[3]);
    const newLines = hunkMatch[4] !== undefined ? Number(hunkMatch[4]) : 1;
    const diffLines: DiffLine[] = [];

    let oldLine = oldStart;
    let newLine = newStart;
    i++;

    while (i < block.length) {
      const line = block[i];

      // Stop if we hit next hunk or next file
      if (HUNK_RE.test(line) || DIFF_HEADER_RE.test(line)) break;

      if (NO_NEWLINE_RE.test(line)) {
        i++;
        continue;
      }

      if (line.startsWith("+")) {
        diffLines.push({ type: "addition", content: line.slice(1), newLine });
        additions++;
        newLine++;
      } else if (line.startsWith("-")) {
        diffLines.push({ type: "deletion", content: line.slice(1), oldLine });
        deletions++;
        oldLine++;
      } else if (line.startsWith(" ") || line === "") {
        // Context line (or empty line treated as context)
        const content = line.startsWith(" ") ? line.slice(1) : line;
        diffLines.push({ type: "context", content, oldLine, newLine });
        oldLine++;
        newLine++;
      } else {
        // Unknown line, skip
        i++;
        continue;
      }

      i++;
    }

    hunks.push({ header: hunkHeader, oldStart, oldLines, newStart, newLines, lines: diffLines });
  }

  return { oldPath, newPath, status, hunks, additions, deletions, isBinary: false };
}
