import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { BranchInfo, CommitInfo, EvidenceScope } from "./types.ts";

const SAFE_REVISION_PATTERN = /^[^\s\-\u0000-\u001f\u007f][^\s\u0000-\u001f\u007f]{0,255}$/u;
const FIELD_SEPARATOR = "\u001f";
const RECORD_SEPARATOR = "\u001e";
const LOG_FORMAT = "%H%x1f%s%x1f%an%x1f%aI%x1f%b%x1e";
const MAX_ERROR_STDERR_CHARS = 2_000;

export const MAX_DIFF_BYTES = 4 * 1024 * 1024;
export const MAX_OVERVIEW_DIFF_BYTES = 512 * 1024;
export const MAX_UNTRACKED_FILES = 10_000;

function assertSafeRevision(revision: string, label: string): void {
  if (!SAFE_REVISION_PATTERN.test(revision)) {
    throw new Error(`${label} must be 1-256 characters with no leading dash, whitespace, or control characters.`);
  }
}

export interface GitExecOptions {
  cwd: string;
  signal?: AbortSignal;
  timeout?: number;
}

export interface GitExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Run a git subcommand through the host and treat every failure as an error.
 * The host resolves non-zero exit codes instead of rejecting, so a diff that
 * fails (not a repository, invalid ref) must not look like an empty success.
 * `-c core.quotePath=false` is prepended so diff headers keep raw UTF-8 paths
 * that the diff parser can match, even for non-ASCII file names.
 * `--literal-pathspecs` is prepended so pathspec magic (e.g. `:(top)`) cannot
 * resolve a targeted path outside the calling workspace.
 */
export async function execGitChecked(
  pi: ExtensionAPI,
  args: readonly string[],
  options: GitExecOptions,
): Promise<GitExecResult> {
  const result = await pi.exec("git", ["-c", "core.quotePath=false", "--literal-pathspecs", ...args], {
    cwd: options.cwd,
    signal: options.signal,
    timeout: options.timeout,
  });
  if (result.killed || result.code !== 0) {
    const stderr = (result.stderr ?? "").trim().slice(0, MAX_ERROR_STDERR_CHARS);
    throw new Error(
      `git ${args[0] ?? "command"} ${result.killed ? "was killed (timeout or abort)" : `exited with code ${result.code}`}` +
      (stderr ? `: ${stderr}` : ""),
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function nearestExistingCanonicalPath(path: string): Promise<string> {
  let candidate = path;
  while (true) {
    try {
      return await realpath(candidate);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

export async function validateWorkspacePath(path: string, cwd: string): Promise<string> {
  if (!path || path.includes("\0")) throw new Error("Workspace path must not be empty or contain NUL bytes.");
  const workspace = resolve(cwd);
  const candidate = resolve(workspace, path);
  if (!isWithin(workspace, candidate)) throw new Error(`Path '${path}' escapes the working directory.`);

  const canonicalWorkspace = await realpath(workspace);
  const canonicalAncestor = await nearestExistingCanonicalPath(candidate);
  if (!isWithin(canonicalWorkspace, canonicalAncestor)) {
    throw new Error(`Path '${path}' resolves outside the working directory via symlink.`);
  }

  const relativePath = relative(workspace, candidate);
  return relativePath === "" ? "." : relativePath.split(sep).join("/");
}

export async function validateWorkspacePaths(paths: readonly string[] | undefined, cwd: string): Promise<string[]> {
  if (!paths || paths.length === 0) return [];
  const validated = await Promise.all(paths.map((path) => validateWorkspacePath(path, cwd)));
  return [...new Set(validated)];
}

export function buildGitDiffArgs(
  scope: EvidenceScope,
  paths: readonly string[] = [],
  contextLines = 3,
): string[] {
  if (!Number.isInteger(contextLines) || contextLines < 0 || contextLines > 20) {
    throw new Error("contextLines must be an integer from 0 to 20.");
  }

  // --no-ext-diff and --no-textconv keep repository-configured diff drivers
  // and textconv conversions from running arbitrary processes during
  // collection; --no-color keeps the output parseable.
  const diffOptions = ["--no-color", "--no-ext-diff", "--no-textconv", `--unified=${contextLines}`];
  let args: string[];
  switch (scope.source) {
    case "uncommitted":
      args = ["diff", ...diffOptions, "HEAD"];
      break;
    case "branch": {
      const target = scope.target ?? "";
      const base = scope.base ?? "";
      assertSafeRevision(target, "Branch target");
      assertSafeRevision(base, "Branch base");
      args = ["diff", ...diffOptions, `${base}...${target}`];
      break;
    }
    case "commits": {
      const target = scope.target ?? "";
      assertSafeRevision(target, "Commit selection");
      args = target.includes("..")
        ? ["diff", ...diffOptions, target]
        // A single commit diffs against its first parent (`-m --first-parent`):
        // a clean merge otherwise shows an empty combined diff and a root
        // commit keeps its full diff.
        : ["show", "-m", "--first-parent", "--format=", ...diffOptions, target];
      break;
    }
  }

  if (paths.length > 0) args.push("--", ...paths);
  return args;
}

export async function ensureGitRepository(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    await execGitChecked(pi, ["rev-parse", "--is-inside-work-tree"], { cwd, signal, timeout: 10_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Not a git repository (or git is unavailable): ${message}`);
  }
}

async function verifyCommitish(
  pi: ExtensionAPI,
  cwd: string,
  revision: string,
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  assertSafeRevision(revision, label);
  try {
    await execGitChecked(pi, ["rev-parse", "--verify", "--quiet", `${revision}^{commit}`], {
      cwd,
      signal,
      timeout: 5_000,
    });
  } catch {
    throw new Error(`${label} '${revision}' does not resolve to a commit.`);
  }
}

async function verifyRevisionSelection(
  pi: ExtensionAPI,
  cwd: string,
  revision: string,
  signal?: AbortSignal,
): Promise<void> {
  assertSafeRevision(revision, "Commit selection");
  try {
    await execGitChecked(pi, ["rev-list", "--max-count=1", revision], { cwd, signal, timeout: 5_000 });
  } catch {
    throw new Error(`Commit selection '${revision}' is not a valid commit, ref, or revision range.`);
  }
}

export async function isValidGitRevision(
  pi: ExtensionAPI,
  cwd: string,
  revision: string,
  allowRange: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    if (allowRange) await verifyRevisionSelection(pi, cwd, revision, signal);
    else await verifyCommitish(pi, cwd, revision, "Git revision", signal);
    return true;
  } catch {
    return false;
  }
}

export async function resolveEvidenceScope(
  pi: ExtensionAPI,
  cwd: string,
  requested: EvidenceScope,
  signal?: AbortSignal,
): Promise<EvidenceScope> {
  await ensureGitRepository(pi, cwd, signal);
  if (requested.source === "uncommitted") return { source: "uncommitted" };

  if (requested.source === "branch") {
    const target = requested.target ?? "";
    const base = requested.base ?? await discoverDefaultBase(pi, cwd, target, signal);
    if (!target) throw new Error("Branch evidence requires a target branch.");
    if (!base) throw new Error("Branch evidence requires a base branch; no safe default was found.");
    if (target === base) throw new Error("Branch target and base must be different revisions.");
    await Promise.all([
      verifyCommitish(pi, cwd, target, "Branch target", signal),
      verifyCommitish(pi, cwd, base, "Branch base", signal),
    ]);
    return { source: "branch", target, base };
  }

  const target = requested.target ?? "";
  if (!target) throw new Error("Commit evidence requires a commit, ref, or revision range.");
  await verifyRevisionSelection(pi, cwd, target, signal);
  return { source: "commits", target };
}

export interface GitDiffResult {
  content: string;
  truncated: boolean;
}

function truncateDiffHead(content: string, maxBytes: number): string | null {
  if (Buffer.byteLength(content, "utf8") <= maxBytes) return null;
  // Keep whole lines only, so a cut never splits a diff line in half.
  let byteCount = 0;
  let lineStart = 0;
  while (lineStart < content.length) {
    const newline = content.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? content.length : newline + 1;
    byteCount += Buffer.byteLength(content.slice(lineStart, lineEnd), "utf8");
    if (byteCount > maxBytes) break;
    lineStart = lineEnd;
  }
  return content.slice(0, lineStart);
}

export async function runGitDiff(
  pi: ExtensionAPI,
  cwd: string,
  scope: EvidenceScope,
  paths: readonly string[],
  contextLines: number,
  signal?: AbortSignal,
  maxBytes = MAX_DIFF_BYTES,
): Promise<GitDiffResult> {
  const result = await execGitChecked(pi, buildGitDiffArgs(scope, paths, contextLines), {
    cwd,
    signal,
    timeout: 30_000,
  });
  const truncatedContent = truncateDiffHead(result.stdout, maxBytes);
  return truncatedContent === null
    ? { content: result.stdout, truncated: false }
    : { content: truncatedContent, truncated: true };
}

export interface UntrackedListResult {
  files: string[];
  truncated: boolean;
}

export async function listUntrackedFiles(
  pi: ExtensionAPI,
  cwd: string,
  paths: readonly string[],
  signal?: AbortSignal,
  maxFiles = MAX_UNTRACKED_FILES,
): Promise<UntrackedListResult> {
  const args = ["ls-files", "--others", "--exclude-standard", "-z"];
  if (paths.length > 0) args.push("--", ...paths);
  const result = await execGitChecked(pi, args, { cwd, signal, timeout: 10_000 });
  const files = result.stdout.split("\0").filter(Boolean);
  return files.length > maxFiles
    ? { files: files.slice(0, maxFiles), truncated: true }
    : { files, truncated: false };
}

function cleanGitText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001d\u007f-\u009f]/gu, "�").trim();
}

export function parseCommitLog(raw: string): CommitInfo[] {
  const commits: CommitInfo[] = [];
  for (const rawRecord of raw.split(RECORD_SEPARATOR)) {
    const record = rawRecord.replace(/^\n+|\n+$/g, "");
    if (!record) continue;
    const [hash = "", subject = "", author = "", date = "", ...bodyParts] = record.split(FIELD_SEPARATOR);
    if (!hash) continue;
    const body = cleanGitText(bodyParts.join(FIELD_SEPARATOR));
    commits.push({
      hash: cleanGitText(hash),
      subject: cleanGitText(subject),
      author: cleanGitText(author),
      date: cleanGitText(date),
      ...(body ? { body } : {}),
    });
  }
  return commits;
}

export async function getCommitHistory(
  pi: ExtensionAPI,
  cwd: string,
  scope: EvidenceScope,
  paths: readonly string[],
  query: string | undefined,
  limit: number,
  exactSelection: boolean,
  signal?: AbortSignal,
): Promise<CommitInfo[]> {
  // A precisely selected single commit must surface as itself: the default
  // --no-merges filter would silently report its first parent instead.
  const exactCommit = exactSelection && scope.source === "commits" && !(scope.target ?? "").includes("..");
  const args = ["log"];
  if (!exactCommit) args.push("--no-merges");
  args.push(`--max-count=${limit}`, `--format=${LOG_FORMAT}`);
  if (query) args.push(`--grep=${query}`, "--regexp-ignore-case");

  switch (scope.source) {
    case "uncommitted":
      args.push("HEAD");
      break;
    case "branch":
      args.push("--reverse", `${scope.base ?? ""}..${scope.target ?? ""}`);
      break;
    case "commits": {
      const target = scope.target ?? "";
      if (exactCommit) args.push("-1");
      args.push(target);
      break;
    }
  }

  if (paths.length > 0) args.push("--", ...paths);
  const result = await execGitChecked(pi, args, { cwd, signal, timeout: 15_000 });
  return parseCommitLog(result.stdout);
}

export async function getCurrentBranch(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const result = await execGitChecked(pi, ["branch", "--show-current"], { cwd, signal, timeout: 5_000 });
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function listBranches(
  pi: ExtensionAPI,
  cwd: string,
  signal?: AbortSignal,
): Promise<BranchInfo[]> {
  const result = await execGitChecked(pi, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)%09%(HEAD)%09%(committerdate:iso8601-strict)",
    "refs/heads",
    "refs/remotes",
  ], { cwd, signal, timeout: 10_000 });
  const seen = new Set<string>();
  const branches: BranchInfo[] = [];
  for (const rawLine of result.stdout.split("\n")) {
    const [name = "", head = "", date = ""] = rawLine.replace(/\r$/, "").split("\t");
    if (!name || name.endsWith("/HEAD") || seen.has(name)) continue;
    seen.add(name);
    branches.push({ name, current: head.trim() === "*", ...(date ? { date } : {}) });
  }
  return branches;
}

export async function discoverDefaultBase(
  pi: ExtensionAPI,
  cwd: string,
  target: string,
  signal?: AbortSignal,
  knownBranches?: readonly BranchInfo[],
): Promise<string | undefined> {
  const branches = knownBranches ?? await listBranches(pi, cwd, signal);
  const names = new Set(branches.map((branch) => branch.name));
  let remoteDefault: string | undefined;
  try {
    const result = await execGitChecked(pi, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
      cwd,
      signal,
      timeout: 5_000,
    });
    remoteDefault = result.stdout.trim() || undefined;
  } catch {
    remoteDefault = undefined;
  }

  const localDefault = remoteDefault?.replace(/^origin\//, "");
  const remoteFirst = target.includes("/");
  const candidates = [
    ...(remoteFirst ? [remoteDefault, localDefault] : [localDefault, remoteDefault]),
    "main",
    "master",
    "develop",
    "trunk",
    "origin/main",
    "origin/master",
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (candidate !== target && names.has(candidate)) return candidate;
  }
  // No arbitrary fallback: an unrelated branch is never an unambiguous default.
  return undefined;
}

export async function listRecentCommits(
  pi: ExtensionAPI,
  cwd: string,
  ref = "HEAD",
  limit = 8,
  signal?: AbortSignal,
): Promise<CommitInfo[]> {
  assertSafeRevision(ref, "History ref");
  return getCommitHistory(
    pi,
    cwd,
    { source: "commits", target: ref },
    [],
    undefined,
    limit,
    false,
    signal,
  );
}
