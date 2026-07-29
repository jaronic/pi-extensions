export type FileStatus = "modified" | "added" | "deleted" | "renamed" | "copied" | "type-changed";

export interface DiffLine {
  type: "context" | "addition" | "deletion";
  content: string;
  oldLine?: number;
  newLine?: number;
}

export interface Hunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileChange {
  oldPath: string;
  newPath: string;
  status: FileStatus;
  hunks: Hunk[];
  additions: number;
  deletions: number;
  isBinary: boolean;
}

export interface DiffSummary {
  files: FileChange[];
  totalFiles: number;
  totalAdditions: number;
  totalDeletions: number;
}

export type EvidenceSource = "uncommitted" | "branch" | "commits";
export type EvidenceView = "overview" | "patch" | "history";

export interface EvidenceScope {
  source: EvidenceSource;
  target?: string;
  base?: string;
}

export interface CommitInfo {
  hash: string;
  subject: string;
  author: string;
  date: string;
  body?: string;
}

export interface BranchInfo {
  name: string;
  current: boolean;
  date?: string;
}

export interface EvidenceFormatOptions {
  maxFiles: number;
  maxHunkLines: number;
  maxCommits: number;
  maxUntrackedFiles: number;
}
