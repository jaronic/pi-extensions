import type { Stats } from "node:fs";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import {
  createEditToolDefinition,
  generateDiffString,
  generateUnifiedPatch,
  withFileMutationQueue,
  type AgentToolResult,
  type EditToolDetails,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { digestBytes, snapshotTokenForBytes, type SnapshotToken } from "./digest.ts";
import { abortIfNeeded, fail, hashlineError } from "./errors.ts";
import { decodeEditableBytes, serializePhysicalLines } from "./lines.ts";
import { applyOperations, decodeHashlineEditInput, planOperations } from "./operations.ts";
import { formatEditResults } from "./output.ts";
import { displayPath, escapeDisplayPath, resolveAuthoredPath } from "./paths.ts";
import { encodeSnapshotEntry } from "./persistence.ts";
import {
  EDIT_DESCRIPTION,
  EDIT_PROMPT_GUIDELINES,
  EDIT_PROMPT_SNIPPET,
} from "./prompts.ts";
import type { HashlineRuntime } from "./runtime.ts";
import {
  MAX_EDITABLE_FILE_BYTES,
  MAX_EDIT_DETAILS_BYTES,
  MAX_PATH_CHARS,
  hashlineEditSchema,
} from "./schemas.ts";
import type { SnapshotRecord } from "./snapshots.ts";

interface StableHandleRead {
  readonly bytes: Buffer;
  readonly stats: Stats;
}

export interface HashlineEditDependencies {
  readonly buildDetails?: (path: string, oldText: string, newText: string) => EditToolDetails;
  readonly commitWrite?: (handle: FileHandle, bytes: Buffer) => Promise<void>;
  readonly closeHandle?: (handle: FileHandle) => Promise<void>;
}

function sameFileState(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.nlink === right.nlink;
}

async function readStableHandle(handle: FileHandle, signal: AbortSignal | undefined): Promise<StableHandleRead> {
  abortIfNeeded(signal);
  const before = await handle.stat();
  abortIfNeeded(signal);
  if (!before.isFile()) fail("E_NOT_EDITABLE", "Hashline only edits existing regular files.");
  if (before.nlink > 1) fail("E_NOT_EDITABLE", "Hardlinked files are not edited because another path would change implicitly.");
  if (before.size > MAX_EDITABLE_FILE_BYTES) {
    fail("E_TOO_LARGE", `File exceeds the ${MAX_EDITABLE_FILE_BYTES} byte editable limit.`);
  }
  const bytes = Buffer.allocUnsafe(before.size);
  let offset = 0;
  while (offset < bytes.length) {
    abortIfNeeded(signal);
    const result = await handle.read(bytes, offset, bytes.length - offset, offset);
    abortIfNeeded(signal);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  const after = await handle.stat();
  abortIfNeeded(signal);
  if (offset !== before.size || !sameFileState(before, after)) {
    fail("E_STALE_SNAPSHOT", "The file changed during validation. No hashline write was attempted; re-read it.");
  }
  return Object.freeze({ bytes, stats: after });
}

function textEditResult(text: string, details: EditToolDetails): AgentToolResult<EditToolDetails> {
  return Object.freeze({ content: [{ type: "text" as const, text }], details });
}

function buildDefaultDetails(path: string, oldText: string, newText: string): EditToolDetails {
  const diffResult = generateDiffString(oldText, newText);
  return Object.freeze({
    diff: diffResult.diff,
    patch: generateUnifiedPatch(path, oldText, newText),
    ...(diffResult.firstChangedLine === undefined ? {} : { firstChangedLine: diffResult.firstChangedLine }),
  });
}

async function commitDefaultWrite(handle: FileHandle, bytes: Buffer): Promise<void> {
  await handle.truncate(0);
  await handle.writeFile(bytes);
}

function isHashlineFailure(error: unknown): boolean {
  return error instanceof Error && /^\[E_[A-Z_]+\]/.test(error.message);
}

async function verifyFinalTarget(
  authoredAbsolutePath: string,
  canonicalPath: string,
  handle: FileHandle,
  expectedBytes: Buffer,
  signal: AbortSignal | undefined,
): Promise<void> {
  abortIfNeeded(signal);
  let currentCanonical: string;
  let pathStats: Stats;
  try {
    [currentCanonical, pathStats] = await Promise.all([realpath(authoredAbsolutePath), stat(authoredAbsolutePath)]);
  } catch {
    fail("E_PATH_MISMATCH", "The edit path disappeared or changed target after read. Re-read the authored path.");
  }
  const handleRead = await readStableHandle(handle, signal);
  if (
    currentCanonical !== canonicalPath ||
    pathStats.dev !== handleRead.stats.dev ||
    pathStats.ino !== handleRead.stats.ino
  ) {
    fail("E_PATH_MISMATCH", "The edit path now resolves to a different file. Re-read the authored path.");
  }
  if (!handleRead.bytes.equals(expectedBytes)) {
    fail("E_STALE_SNAPSHOT", "The file bytes changed after the snapshot. No hashline write was attempted; re-read and rebuild every operation.");
  }
}

export function createHashlineEditTool(
  runtime: HashlineRuntime,
  dependencies: HashlineEditDependencies = {},
): ToolDefinition<typeof hashlineEditSchema, EditToolDetails> {
  const renderer = createEditToolDefinition(process.cwd());
  const buildDetails = dependencies.buildDetails ?? buildDefaultDetails;
  const commitWrite = dependencies.commitWrite ?? commitDefaultWrite;
  const closeHandle = dependencies.closeHandle ?? ((handle: FileHandle) => handle.close());
  return {
    renderShell: renderer.renderShell,
    renderCall: renderer.renderCall as ToolDefinition<typeof hashlineEditSchema, EditToolDetails>["renderCall"],
    renderResult: renderer.renderResult as ToolDefinition<typeof hashlineEditSchema, EditToolDetails>["renderResult"],
    name: "edit",
    label: "edit",
    parameters: hashlineEditSchema,
    description: EDIT_DESCRIPTION,
    promptSnippet: EDIT_PROMPT_SNIPPET,
    promptGuidelines: [...EDIT_PROMPT_GUIDELINES],
    executionMode: "parallel",
    async execute(_toolCallId, rawParams, signal, _onUpdate, ctx) {
      const input = decodeHashlineEditInput(rawParams);
      const generation = runtime.getGeneration();
      const absolutePath = resolveAuthoredPath(input.path, ctx.cwd);
      const displayFilePath = displayPath(absolutePath, ctx.cwd);
      const shownPath = escapeDisplayPath(displayFilePath);
      abortIfNeeded(signal);
      try {
        let canonicalPath: string;
        try {
          canonicalPath = await realpath(absolutePath);
        } catch {
          fail("E_NOT_EDITABLE", `Cannot resolve an existing regular file at ${shownPath}.`);
        }
        if (canonicalPath.length > MAX_PATH_CHARS || canonicalPath.includes("\0")) {
          fail("E_TOO_LARGE", "Canonical file path exceeds the snapshot path limit.");
        }
        abortIfNeeded(signal);
        if (runtime.getGeneration() !== generation) {
          fail("E_BRANCH_CHANGED", "The active session branch changed before queue registration. Re-read on the current branch.");
        }
        return await withFileMutationQueue(canonicalPath, async () => {
          abortIfNeeded(signal);
          if (runtime.getGeneration() !== generation) {
            fail("E_BRANCH_CHANGED", "The active session branch changed while edit was waiting. Re-read on the current branch.");
          }
          let currentCanonicalPath: string;
          try {
            currentCanonicalPath = await realpath(absolutePath);
          } catch {
            fail("E_PATH_MISMATCH", "The edit path disappeared or changed target while edit was waiting. Re-read the authored path.");
          }
          abortIfNeeded(signal);
          if (runtime.getGeneration() !== generation) {
            fail("E_BRANCH_CHANGED", "The active session branch changed before file validation. Re-read on the current branch.");
          }
          if (currentCanonicalPath !== canonicalPath) {
            fail("E_PATH_MISMATCH", "The edit path changed target while edit was waiting. Re-read the authored path.");
          }
          const token = input.snapshot as SnapshotToken;
          const record = runtime.getStore().get(canonicalPath, token);
          if (!record) {
            if (runtime.getStore().hasTokenAtAnotherPath(canonicalPath, token)) {
              fail("E_PATH_MISMATCH", "This snapshot belongs to a different canonical path. Read the intended file.");
            }
            fail("E_SNAPSHOT_UNKNOWN", "This snapshot is not available on the current branch or was evicted. Re-read the file; do not guess a token.");
          }

          let handle: FileHandle;
          try {
            handle = await open(canonicalPath, "r+");
          } catch {
            fail("E_NOT_EDITABLE", `Cannot open ${shownPath} as a readable and writable regular file.`);
          }
          let committed = false;
          let result: AgentToolResult<EditToolDetails> | undefined;
          let primaryError: unknown;
          let followUpRecord: SnapshotRecord | undefined;
          let followUpEntry: ReturnType<typeof encodeSnapshotEntry> | undefined;
          let withTokenResult: AgentToolResult<EditToolDetails> | undefined;
          try {
            abortIfNeeded(signal);
            if (runtime.getGeneration() !== generation) {
              fail("E_BRANCH_CHANGED", "The active session branch changed before validation. Re-read on the current branch.");
            }
            const live = await readStableHandle(handle, signal);
            abortIfNeeded(signal);
            if (runtime.getGeneration() !== generation) {
              fail("E_BRANCH_CHANGED", "The active session branch changed before validation. Re-read on the current branch.");
            }
            const liveDigest = digestBytes(live.bytes);
            if (liveDigest !== record.digest || live.bytes.length !== record.byteLength) {
              fail(
                "E_STALE_SNAPSHOT",
                `Edit rejected for ${shownPath}: file bytes changed after snapshot ${token}. No hashline write was attempted. Re-read and rebuild every operation; stale anchors are never relocated.`,
              );
            }
            const editable = decodeEditableBytes(live.bytes);
            if (editable.lines.length !== record.lineCount) {
              fail("E_STALE_SNAPSHOT", "The live physical line count no longer matches the snapshot. Re-read the file.");
            }
            const plan = planOperations(input.edits, editable.lines, record.seen, shownPath);
            const applied = applyOperations(editable.lines, plan);
            const outputBytes = serializePhysicalLines({ hasBom: editable.hasBom, lines: applied.lines });
            if (live.bytes.length > 0 && outputBytes.length === 0) {
              fail("E_WOULD_EMPTY", "Hashline will not turn a non-empty file into empty bytes. Use write for an explicit full-file clear.");
            }
            if (outputBytes.length > MAX_EDITABLE_FILE_BYTES) {
              fail("E_TOO_LARGE", `Edited file would exceed the ${MAX_EDITABLE_FILE_BYTES} byte limit.`);
            }
            if (outputBytes.equals(live.bytes)) {
              fail("E_NO_CHANGE", "The operation set produces identical file bytes. Confirm whether the requested change already exists, then re-read if needed.");
            }

            const outputToken = snapshotTokenForBytes(outputBytes);
            const oldText = live.bytes.toString("utf8");
            const newText = outputBytes.toString("utf8");
            let details: EditToolDetails;
            try {
              details = Object.freeze({ ...buildDetails(shownPath, oldText, newText) });
            } catch {
              fail("E_TOO_LARGE", "Complete edit details could not be constructed before commit.");
            }
            let detailsJson: string;
            try {
              detailsJson = JSON.stringify(details);
            } catch {
              fail("E_TOO_LARGE", "Edit details could not be serialized before commit.");
            }
            if (Buffer.byteLength(detailsJson, "utf8") > MAX_EDIT_DETAILS_BYTES) {
              fail("E_TOO_LARGE", `Complete edit details exceed the ${MAX_EDIT_DETAILS_BYTES} byte limit.`);
            }
            const formatted = formatEditResults(displayFilePath, outputToken, applied.lines, applied.changedSpans, plan);
            result = textEditResult(formatted.withoutTokenText, details);
            withTokenResult = formatted.withTokenText ? textEditResult(formatted.withTokenText, details) : undefined;
            followUpRecord = withTokenResult
              ? Object.freeze({
                  token: outputToken,
                  digest: outputToken.slice(3),
                  canonicalPath,
                  byteLength: outputBytes.length,
                  lineCount: applied.lines.length,
                  seen: formatted.seen,
                  source: "edit",
                })
              : undefined;
            followUpEntry = followUpRecord ? encodeSnapshotEntry(followUpRecord) : undefined;

            await verifyFinalTarget(absolutePath, canonicalPath, handle, live.bytes, signal);
            abortIfNeeded(signal);
            if (runtime.getGeneration() !== generation) {
              fail("E_BRANCH_CHANGED", "The active session branch changed before commit. No hashline write was attempted; re-read on the current branch.");
            }
            try {
              await commitWrite(handle, outputBytes);
              committed = true;
            } catch {
              throw hashlineError(
                "E_WRITE_FAILED",
                `Writing ${shownPath} failed and the file may be partially changed. Read it before any retry.`,
              );
            }

            // Snapshot metadata is committed only after the writable handle closes successfully.
          } catch (error) {
            primaryError = error;
          }
          try {
            await closeHandle(handle);
          } catch {
            if (committed && primaryError === undefined) {
              primaryError = hashlineError(
                "E_WRITE_FAILED",
                `Closing ${shownPath} failed after file write and the file may be changed. Read it before any retry.`,
              );
            } else if (!committed && primaryError === undefined) {
              primaryError = hashlineError("E_NOT_EDITABLE", `Closing ${shownPath} failed before any hashline write.`);
            }
          }
          if (
            primaryError === undefined &&
            committed &&
            runtime.getGeneration() === generation &&
            followUpRecord &&
            followUpEntry &&
            withTokenResult
          ) {
            try {
              runtime.commitRecord(followUpRecord, followUpEntry);
              result = withTokenResult;
            } catch {
              // The file is committed; the result without a token remains the truthful fallback.
            }
          }
          if (primaryError !== undefined) throw primaryError;
          if (!result) throw hashlineError("E_WRITE_FAILED", `Writing ${shownPath} ended without a verifiable result. Read the file before retrying.`);
          return result;
        });
      } catch (error) {
        if (isHashlineFailure(error)) throw error;
        throw hashlineError("E_NOT_EDITABLE", `Hashline could not access ${shownPath} as an editable file.`);
      }
    },
  };
}
