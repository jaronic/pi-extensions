import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import type { EditPlan } from "./types.ts";
import type { OperationRecord } from "./operations.ts";
import { markCommitted, throwIfCancelledOrExpired } from "./operations.ts";
import { fileIdentity, sameIdentity, type FileIdentity, type WorkspaceTarget } from "./paths.ts";


function openReadOnly(path: string): number {
  return openSync(path, process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW);
}

function sameFilesystemObject(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertTempBytes(fd: number, tempPath: string, expected: FileIdentity, plan: EditPlan): void {
  const pathStats = lstatSync(tempPath, { bigint: true });
  const before = fstatSync(fd, { bigint: true });
  if (pathStats.isSymbolicLink() || !pathStats.isFile() || !before.isFile()
    || pathStats.nlink !== 1n || before.nlink !== 1n
    || !sameIdentity(fileIdentity(pathStats), expected)
    || !sameIdentity(fileIdentity(before), expected)
    || before.size !== BigInt(plan.output.length)) {
    throw new Error("the ast-grep temporary file changed before atomic rename.");
  }
  const bytes = Buffer.allocUnsafe(plan.output.length);
  let offset = 0;
  while (offset < bytes.length) {
    const bytesRead = readSync(fd, bytes, offset, bytes.length - offset, offset);
    if (bytesRead === 0) {
      throw new Error("the ast-grep temporary file became shorter before atomic rename.");
    }
    offset += bytesRead;
  }
  const probe = Buffer.allocUnsafe(1);
  if (readSync(fd, probe, 0, 1, bytes.length) !== 0) {
    throw new Error("the ast-grep temporary file grew before atomic rename.");
  }
  const after = fstatSync(fd, { bigint: true });
  if (!sameIdentity(fileIdentity(after), expected)
    || !bytes.equals(plan.output)
    || createHash("sha256").update(bytes).digest("hex") !== plan.outputSha256) {
    throw new Error("the ast-grep temporary file bytes changed before atomic rename.");
  }
}

function readCurrentBytes(target: WorkspaceTarget, expected: FileIdentity, expectedSize: number): Buffer {
  const fd = openReadOnly(target.canonicalPath);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || !sameIdentity(fileIdentity(before), expected) || before.nlink !== 1n || before.size !== BigInt(expectedSize)) {
      throw new Error(`${target.displayPath} changed before atomic commit.`);
    }
    const size = expectedSize;
    const buffer = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const bytesRead = readSync(fd, buffer, offset, size - offset, offset);
      if (bytesRead === 0) {
        throw new Error(`${target.displayPath} became shorter during atomic commit validation.`);
      }
      offset += bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    if (readSync(fd, probe, 0, 1, size) !== 0) {
      throw new Error(`${target.displayPath} grew during atomic commit validation.`);
    }
    const after = fstatSync(fd, { bigint: true });
    if (!sameIdentity(fileIdentity(after), expected)) {
      throw new Error(`${target.displayPath} changed during atomic commit validation.`);
    }
    return buffer;
  } finally {
    closeSync(fd);
  }
}

function assertNamespace(target: WorkspaceTarget, expectedParent: FileIdentity): void {
  if (realpathSync(target.canonicalWorkspace) !== target.canonicalWorkspace
    || realpathSync(target.canonicalParent) !== target.canonicalParent
    || realpathSync(target.canonicalPath) !== target.canonicalPath) {
    throw new Error(`${target.displayPath} namespace changed before atomic commit.`);
  }
  const workspaceStats = lstatSync(target.canonicalWorkspace, { bigint: true });
  const targetStats = lstatSync(target.canonicalPath, { bigint: true });
  const parentStats = lstatSync(target.canonicalParent, { bigint: true });
  const workspaceIdentity = fileIdentity(workspaceStats);
  if (workspaceStats.isSymbolicLink() || !workspaceStats.isDirectory()
    || !sameFilesystemObject(workspaceIdentity, target.workspaceIdentity)
    || targetStats.isSymbolicLink() || parentStats.isSymbolicLink() || !targetStats.isFile() || !parentStats.isDirectory()
    || targetStats.nlink !== 1n
    || !sameIdentity(fileIdentity(targetStats), target.identity)
    || !sameIdentity(fileIdentity(parentStats), expectedParent)) {
    throw new Error(`${target.displayPath} identity changed before atomic commit.`);
  }
}

interface RenameFailureObservation {
  committed: boolean;
  description: string;
}

function observeTargetAfterRenameFailure(
  target: WorkspaceTarget,
  plan: EditPlan,
  tempIdentity: FileIdentity,
): RenameFailureObservation {
  try {
    const stats = lstatSync(target.canonicalPath, { bigint: true });
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1n) {
      return { committed: false, description: "state is uncertain" };
    }
    const size = Number(stats.size);
    if (!Number.isSafeInteger(size) || (size !== plan.source.length && size !== plan.output.length)) {
      return { committed: false, description: "state is uncertain" };
    }
    const installedIdentity = fileIdentity(stats);
    const bytes = readCurrentBytes(target, installedIdentity, size);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash === plan.outputSha256 && sameFilesystemObject(installedIdentity, tempIdentity)) {
      return { committed: true, description: "contains the intended output on the prepared temporary inode" };
    }
    if (hash === plan.sourceSha256) {
      return { committed: false, description: "still contains the previewed source bytes" };
    }
    if (hash === plan.outputSha256) {
      return { committed: false, description: "contains the intended output on a different inode" };
    }
    return { committed: false, description: `contains different bytes (sha256 ${hash})` };
  } catch {
    return { committed: false, description: "state is uncertain" };
  }
}

export type CommitGuardPhase =
  | "entry"
  | "after-source-read"
  | "after-temp-fsync"
  | "after-parent-check"
  | "after-final-source-read"
  | "before-rename";

export interface CommitEditHooks {
  beforeGuard?: (phase: CommitGuardPhase) => void;
}

export function commitEditSync(
  plan: EditPlan,
  target: WorkspaceTarget,
  record: OperationRecord,
  rename: (from: string, to: string) => void = renameSync,
  hooks: CommitEditHooks = {},
): void {
  hooks.beforeGuard?.("entry");
  throwIfCancelledOrExpired(record);
  assertNamespace(target, target.parentIdentity);
  const initialBytes = readCurrentBytes(target, target.identity, plan.source.length);
  if (!initialBytes.equals(plan.source)
    || createHash("sha256").update(initialBytes).digest("hex") !== plan.sourceSha256) {
    throw new Error(`${target.displayPath} no longer matches the previewed source; run preview again.`);
  }
  hooks.beforeGuard?.("after-source-read");
  throwIfCancelledOrExpired(record);

  const tempPath = join(target.canonicalParent, `.${basename(target.canonicalPath)}.pi-ast-grep-${randomUUID()}.tmp`);
  let tempFd: number | undefined;
  let tempExists = false;
  let failure: Error | undefined;
  let cleanupError: Error | undefined;
  try {
    tempFd = openSync(tempPath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR, 0o600);
    tempExists = true;
    writeFileSync(tempFd, plan.output);
    fchmodSync(tempFd, Number(BigInt(plan.mode) & 0o777n));
    fsyncSync(tempFd);
    const tempIdentity = fileIdentity(fstatSync(tempFd, { bigint: true }));
    assertTempBytes(tempFd, tempPath, tempIdentity, plan);

    hooks.beforeGuard?.("after-temp-fsync");
    throwIfCancelledOrExpired(record);
    const parentAfterTempStats = lstatSync(target.canonicalParent, { bigint: true });
    const parentAfterTemp = fileIdentity(parentAfterTempStats);
    if (parentAfterTempStats.isSymbolicLink() || !parentAfterTempStats.isDirectory()
      || !sameFilesystemObject(parentAfterTemp, target.parentIdentity)) {
      throw new Error(`${target.displayPath} parent identity changed while creating the atomic temporary file.`);
    }
    hooks.beforeGuard?.("after-parent-check");
    throwIfCancelledOrExpired(record);

    assertNamespace(target, parentAfterTemp);
    const finalBytes = readCurrentBytes(target, target.identity, plan.source.length);
    if (!finalBytes.equals(plan.source)
      || createHash("sha256").update(finalBytes).digest("hex") !== plan.sourceSha256) {
      throw new Error(`${target.displayPath} changed after preview; run preview again.`);
    }
    assertTempBytes(tempFd, tempPath, tempIdentity, plan);
    hooks.beforeGuard?.("after-final-source-read");
    throwIfCancelledOrExpired(record);
    hooks.beforeGuard?.("before-rename");
    throwIfCancelledOrExpired(record);
    try {
      rename(tempPath, target.canonicalPath);
    } catch (error) {
      const observation = observeTargetAfterRenameFailure(target, plan, tempIdentity);
      if (!observation.committed) {
        throw new Error(
          `atomic rename failed for ${target.displayPath}; target ${observation.description}. Inspect the file before retrying.`,
          { cause: error },
        );
      }
    }
    tempExists = false;
    markCommitted(record);

    const installedStats = lstatSync(target.canonicalPath, { bigint: true });
    const installedIdentity = fileIdentity(installedStats);
    if (installedStats.isSymbolicLink() || !installedStats.isFile()
      || installedStats.nlink !== 1n || !sameFilesystemObject(installedIdentity, tempIdentity)) {
      throw new Error(`atomic rename completed for ${target.displayPath}, but the installed inode could not be verified.`);
    }
    const installedBytes = readCurrentBytes(target, installedIdentity, plan.output.length);
    if (!installedBytes.equals(plan.output)
      || createHash("sha256").update(installedBytes).digest("hex") !== plan.outputSha256) {
      throw new Error(`atomic rename completed for ${target.displayPath}, but the installed bytes do not match the preview.`);
    }

    let directoryFd: number | undefined;
    try {
      directoryFd = openSync(target.canonicalParent, constants.O_RDONLY);
      fsyncSync(directoryFd);
    } catch {
      // The target is already committed. Directory fsync is unsupported on some platforms.
    } finally {
      if (directoryFd !== undefined) {
        try {
          closeSync(directoryFd);
        } catch {
          // Best effort after a verified commit.
        }
      }
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    if (tempFd !== undefined) {
      try {
        closeSync(tempFd);
      } catch (error) {
        cleanupError = error instanceof Error ? error : new Error(String(error));
      }
    }
    if (tempExists) {
      try {
        unlinkSync(tempPath);
      } catch (error) {
        const unlinkError = error instanceof Error ? error : new Error(String(error));
        cleanupError = cleanupError === undefined
          ? unlinkError
          : new AggregateError([cleanupError, unlinkError], "failed to close and remove the ast-grep temporary file");
      }
    }
  }
  if (failure !== undefined) {
    if (cleanupError !== undefined && !record.committed) {
      throw new AggregateError(
        [failure, cleanupError],
        `${failure.message} Additionally, temporary-file cleanup failed: ${cleanupError.message}`,
      );
    }
    throw failure;
  }
  if (cleanupError !== undefined && !record.committed) {
    throw new Error(`failed to clean up an ast-grep temporary file: ${cleanupError.message}`);
  }
}
