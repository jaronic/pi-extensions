import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, stat, type FileHandle } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import type { OperationRecord } from "./operations.ts";
import { throwIfCancelledOrExpired } from "./operations.ts";

export interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mode: bigint;
  nlink: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export interface WorkspaceTarget {
  canonicalWorkspace: string;
  workspaceIdentity: FileIdentity;
  canonicalPath: string;
  canonicalParent: string;
  parentIdentity: FileIdentity;
  identity: FileIdentity;
  displayPath: string;
  nativeRelativePath: string;
  kind: "file" | "directory";
}

export type ExpectedTargetKind = "file" | "directory" | "file-or-directory";

export function fileIdentity(stats: BigIntStats): FileIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mode: stats.mode,
    nlink: stats.nlink,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

export function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

export function isPathContained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function posixDisplay(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/");
}

function validateRawPath(raw: string, field: string): void {
  if (raw.length === 0 || !raw.isWellFormed() || raw.includes("\0")) {
    throw new Error(`${field} must be a non-empty, well-formed, NUL-free filesystem path.`);
  }
  if (/^~(?:[\\/]|$)/u.test(raw) || /^[A-Za-z][A-Za-z\d+.-]*:\/\//u.test(raw)) {
    throw new Error(`${field} must be a literal workspace filesystem path without URL or '~' expansion.`);
  }
  if (process.platform === "win32" && /^(?:\\\\[.?]\\|\\\?\?\\)/u.test(raw)) {
    throw new Error(`${field} must not use a Windows device namespace.`);
  }
}

async function stableStats(path: string): Promise<{ stats: BigIntStats; identity: FileIdentity }> {
  const stats = await lstat(path, { bigint: true });
  if (stats.isSymbolicLink()) {
    throw new Error("workspace path resolved to a symbolic link at a protected boundary.");
  }
  return { stats, identity: fileIdentity(stats) };
}

export async function resolveWorkspaceTarget(
  raw: string,
  cwd: string,
  expected: ExpectedTargetKind,
): Promise<WorkspaceTarget> {
  validateRawPath(raw, "path");
  validateRawPath(cwd, "working directory");
  const lexicalWorkspace = resolve(cwd);
  const lexicalCandidate = isAbsolute(raw) ? resolve(raw) : resolve(lexicalWorkspace, raw);
  if (!isPathContained(lexicalWorkspace, lexicalCandidate)) {
    throw new Error("path is outside the current workspace.");
  }

  const canonicalWorkspace = await realpath(lexicalWorkspace);
  const workspace = await stableStats(canonicalWorkspace);
  if (!workspace.stats.isDirectory()) {
    throw new Error("current workspace is not a directory.");
  }
  const canonicalPath = await realpath(lexicalCandidate);
  if (!isPathContained(canonicalWorkspace, canonicalPath)) {
    throw new Error("path resolves outside the current workspace.");
  }
  const target = await stableStats(canonicalPath);
  const kind = target.stats.isFile() ? "file" : target.stats.isDirectory() ? "directory" : undefined;
  if (kind === undefined || (expected !== "file-or-directory" && kind !== expected)) {
    throw new Error(`path must resolve to an existing ${expected === "file-or-directory" ? "regular file or directory" : expected}.`);
  }
  if (kind === "file" && expected === "file" && target.stats.nlink !== 1n) {
    throw new Error("ast-grep edit refuses hard-linked files; copy the file to a unique inode first.");
  }
  if (canonicalPath === canonicalWorkspace && kind !== "directory") {
    throw new Error("the workspace root is only valid as a directory search scope.");
  }

  const canonicalParent = kind === "directory" && canonicalPath === canonicalWorkspace
    ? dirname(canonicalWorkspace)
    : await realpath(dirname(canonicalPath));
  const parent = await stableStats(canonicalParent);
  if (!parent.stats.isDirectory()) {
    throw new Error("target parent is not a directory.");
  }
  const nativeRelativePath = relative(canonicalWorkspace, canonicalPath) || ".";
  return {
    canonicalWorkspace,
    workspaceIdentity: workspace.identity,
    canonicalPath,
    canonicalParent,
    parentIdentity: parent.identity,
    identity: target.identity,
    displayPath: posixDisplay(nativeRelativePath),
    nativeRelativePath,
    kind,
  };
}

export async function assertTargetStable(target: WorkspaceTarget): Promise<void> {
  const [workspacePath, targetPath, parentPath] = await Promise.all([
    realpath(target.canonicalWorkspace),
    realpath(target.canonicalPath),
    realpath(target.canonicalParent),
  ]);
  if (workspacePath !== target.canonicalWorkspace || targetPath !== target.canonicalPath || parentPath !== target.canonicalParent) {
    throw new Error(`workspace identity changed while accessing ${target.displayPath}.`);
  }
  const [workspaceStats, targetStats, parentStats] = await Promise.all([
    lstat(workspacePath, { bigint: true }),
    lstat(targetPath, { bigint: true }),
    lstat(parentPath, { bigint: true }),
  ]);
  if (workspaceStats.isSymbolicLink() || targetStats.isSymbolicLink() || parentStats.isSymbolicLink()
    || !sameIdentity(fileIdentity(workspaceStats), target.workspaceIdentity)
    || !sameIdentity(fileIdentity(targetStats), target.identity)
    || !sameIdentity(fileIdentity(parentStats), target.parentIdentity)) {
    throw new Error(`workspace identity changed while accessing ${target.displayPath}.`);
  }
}

async function openProtected(path: string): Promise<FileHandle> {
  if (process.platform === "win32" || typeof constants.O_NOFOLLOW !== "number") {
    return open(path, constants.O_RDONLY);
  }
  return open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
}

export interface ReadBoundedFileHooks {
  afterInitialStat?: () => void | Promise<void>;
}

export async function readBoundedFile(
  target: WorkspaceTarget,
  byteLimit: number,
  record: OperationRecord,
  hooks: ReadBoundedFileHooks = {},
): Promise<Buffer> {
  throwIfCancelledOrExpired(record);
  await assertTargetStable(target);
  throwIfCancelledOrExpired(record);
  const handle = await openProtected(target.canonicalPath);
  try {
    const before = await handle.stat({ bigint: true });
    throwIfCancelledOrExpired(record);
    const observed = fileIdentity(before);
    if (!before.isFile() || !sameIdentity(observed, target.identity)) {
      throw new Error(`${target.displayPath} changed before its bounded read.`);
    }
    if (before.size > BigInt(byteLimit)) {
      throw new Error(`${target.displayPath} exceeds the ${byteLimit}-byte file limit.`);
    }
    const size = Number(before.size);
    await hooks.afterInitialStat?.();
    throwIfCancelledOrExpired(record);
    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
      throwIfCancelledOrExpired(record);
      if (bytesRead === 0) {
        throw new Error(`${target.displayPath} became shorter during its bounded read.`);
      }
      offset += bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await handle.read(probe, 0, 1, size);
    throwIfCancelledOrExpired(record);
    if (extraBytes !== 0) {
      throw new Error(`${target.displayPath} grew during its bounded read.`);
    }
    const after = await handle.stat({ bigint: true });
    if (!sameIdentity(fileIdentity(after), observed)) {
      throw new Error(`${target.displayPath} changed during its bounded read.`);
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      throw new Error(`${target.displayPath} is not valid UTF-8 and cannot be searched safely.`);
    }
    return buffer;
  } finally {
    await handle.close();
  }
}

export async function refreshFileIdentity(target: WorkspaceTarget): Promise<WorkspaceTarget> {
  const targetStats = await stat(target.canonicalPath, { bigint: true });
  const parentStats = await stat(target.canonicalParent, { bigint: true });
  return {
    ...target,
    identity: fileIdentity(targetStats),
    parentIdentity: fileIdentity(parentStats),
  };
}
