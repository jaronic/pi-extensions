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
import { Text } from "@earendil-works/pi-tui";
import { digestBytes, snapshotTokenForBytes, type SnapshotToken } from "./digest.ts";
import { abortIfNeeded, fail, hashlineError } from "./errors.ts";
import type { Logger } from "./logger.ts";
import { decodeEditableBytes, serializePhysicalLines, type PhysicalLine } from "./lines.ts";
import {
  applyOperations,
  decodeHashlineEditInput,
  firstUnseenRequirement,
  planOperations,
  type ValidatedEditOperation,
} from "./operations.ts";
import { formatEditResults, formatRefreshSnapshot } from "./output.ts";
import { displayPath, escapeDisplayPath, resolveAuthoredPath } from "./paths.ts";
import { encodeSnapshotEntry, type HashlineSnapshotEntryV1 } from "./persistence.ts";
import {
  EDIT_DESCRIPTION,
  EDIT_PROMPT_GUIDELINES,
  EDIT_PROMPT_SNIPPET,
} from "./prompts.ts";
import { refreshRangesForOperations, tryRebaseOperations, type RebasedOperations } from "./recovery.ts";
import type { HashlineRuntime } from "./runtime.ts";
import {
  MAX_EDITABLE_FILE_BYTES,
  MAX_EDIT_DETAILS_BYTES,
  MAX_PATH_CHARS,
  hashlineEditSchema,
} from "./schemas.ts";
import type { SeenRange, SnapshotRecord } from "./snapshots.ts";

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
    fail("E_STALE_SNAPSHOT", "The file changed during validation. Nothing was written; re-read it.");
  }
  return Object.freeze({ bytes, stats: after });
}

function textEditResult(text: string, details: EditToolDetails): AgentToolResult<EditToolDetails> {
  return Object.freeze({ content: [{ type: "text" as const, text }], details });
}

// Refreshable refusals (stale/unknown/unseen/range/conflict/no-change/would-empty)
// are normal control flow, not failures: they return a plain result carrying the
// journaled refreshed snapshot so the TUI stays calm and the model can retry
// immediately. Genuine defects (write/open/path/branch/abort/too-large) still throw.
function refusalEditResult(text: string): AgentToolResult<EditToolDetails> {
  return Object.freeze({
    content: [{ type: "text" as const, text }],
    details: Object.freeze({ diff: "", patch: "" }),
  });
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

const NOOP_LOGGER: Logger = { error() {}, warn() {}, info() {}, debug() {} };

// A refusal that is normal control flow (compare-and-set rejected, branch moved,
// nothing to change) is not a defect, so it is logged at debug. A write failure
// or a non-hashline error is a real problem worth surfacing at error level.
function hashlineErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  return /^\[(E_[A-Z_]+)\]/.exec(error.message)?.[1];
}

async function verifyFinalTarget(
  authoredAbsolutePath: string,
  canonicalPath: string,
  handle: FileHandle,
  expectedBytes: Buffer,
  signal: AbortSignal | undefined,
): Promise<Buffer | undefined> {
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
  return handleRead.bytes.equals(expectedBytes) ? undefined : handleRead.bytes;
}

type RefreshErrorCode =
  | "E_SNAPSHOT_UNKNOWN"
  | "E_STALE_SNAPSHOT"
  | "E_UNSEEN_LINE"
  | "E_RANGE"
  | "E_EDIT_CONFLICT"
  | "E_NO_CHANGE"
  | "E_WOULD_EMPTY";

interface PendingRefresh {
  readonly code: RefreshErrorCode;
  readonly bytes: Buffer;
  readonly withTokenText?: string;
  readonly withoutTokenText: string;
  readonly record?: SnapshotRecord;
  readonly entry?: HashlineSnapshotEntryV1;
}

interface RefreshContext {
  readonly bytes: Buffer;
  readonly lines: readonly PhysicalLine[];
  readonly operations: readonly ValidatedEditOperation[];
}

function refreshableSemanticError(error: unknown): { readonly code: "E_RANGE" | "E_EDIT_CONFLICT" | "E_WOULD_EMPTY"; readonly summary: string } | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = /^\[(E_RANGE|E_EDIT_CONFLICT|E_WOULD_EMPTY)\]\s+([\s\S]+)$/.exec(error.message);
  if (!match) return undefined;
  return Object.freeze({
    code: match[1] as "E_RANGE" | "E_EDIT_CONFLICT" | "E_WOULD_EMPTY",
    summary: match[2],
  });
}

function pendingRefresh(
  code: RefreshErrorCode,
  summary: string,
  canonicalPath: string,
  displayFilePath: string,
  bytes: Buffer,
  lines: readonly PhysicalLine[],
  operations: readonly ValidatedEditOperation[],
  focus?: SeenRange,
): PendingRefresh {
  const token = snapshotTokenForBytes(bytes);
  const formatted = formatRefreshSnapshot(
    displayFilePath,
    token,
    lines,
    refreshRangesForOperations(operations, lines.length, focus),
    summary,
  );
  if (!formatted.withTokenText || formatted.seen.length === 0) {
    return Object.freeze({ code, bytes, withoutTokenText: formatted.withoutTokenText });
  }
  const record: SnapshotRecord = Object.freeze({
    token,
    digest: token.slice(3),
    canonicalPath,
    byteLength: bytes.length,
    lineCount: lines.length,
    seen: formatted.seen,
    source: "read",
  });
  return Object.freeze({
    code,
    bytes,
    withTokenText: formatted.withTokenText,
    withoutTokenText: formatted.withoutTokenText,
    record,
    entry: encodeSnapshotEntry(record),
  });
}

function displayedRange(start: number, end: number): string {
  return start === end ? `line ${start}` : `lines ${start}-${end}`;
}

function rebaseNotice(rebased: RebasedOperations): string {
  if (rebased.offset === 0) {
    return `Revalidated stale snapshot at ${displayedRange(rebased.targetStart, rebased.targetEnd)}; every targeted physical line and displayed context line remained byte-identical.`;
  }
  const offset = rebased.offset > 0 ? `+${rebased.offset}` : String(rebased.offset);
  return `Rebased stale snapshot: ${displayedRange(rebased.sourceStart, rebased.sourceEnd)} → ${displayedRange(rebased.targetStart, rebased.targetEnd)} (${offset}). Every targeted physical line and displayed context line remained byte-identical; external changes were preserved.`;
}

export function createHashlineEditTool(
  runtime: HashlineRuntime,
  dependencies: HashlineEditDependencies = {},
  logger: Logger = NOOP_LOGGER,
): ToolDefinition<typeof hashlineEditSchema, EditToolDetails> {
  const renderer = createEditToolDefinition(process.cwd());
  const renderCall: NonNullable<ToolDefinition<typeof hashlineEditSchema, EditToolDetails>["renderCall"]> = (args, theme, context) => {
    const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
    text.setText(
      `${theme.fg("toolTitle", theme.bold("Hashline"))}${theme.fg("muted", " · edit ")}${theme.fg("accent", args.path)}`,
    );
    return text;
  };
  const buildDetails = dependencies.buildDetails ?? buildDefaultDetails;
  const commitWrite = dependencies.commitWrite ?? commitDefaultWrite;
  const closeHandle = dependencies.closeHandle ?? ((handle: FileHandle) => handle.close());
  return {
    renderShell: renderer.renderShell,
    renderCall,
    renderResult: renderer.renderResult as ToolDefinition<typeof hashlineEditSchema, EditToolDetails>["renderResult"],
    name: "edit",
    label: "Hashline edit",
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
          if (!record && runtime.getStore().hasTokenAtAnotherPath(canonicalPath, token)) {
            fail("E_PATH_MISMATCH", "This snapshot belongs to a different canonical path. Read the intended file.");
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
          let refresh: PendingRefresh | undefined;
          let refusal: { readonly code: RefreshErrorCode; readonly text: string } | undefined;
          let followUpRecord: SnapshotRecord | undefined;
          let followUpEntry: HashlineSnapshotEntryV1 | undefined;
          let withTokenResult: AgentToolResult<EditToolDetails> | undefined;
          let followUpBytes: Buffer | undefined;
          let refreshContext: RefreshContext | undefined;
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
            const editable = decodeEditableBytes(live.bytes);
            refreshContext = Object.freeze({ bytes: live.bytes, lines: editable.lines, operations: input.edits });

            if (!record) {
              refresh = pendingRefresh(
                "E_SNAPSHOT_UNKNOWN",
                `Snapshot ${token} is not available on this branch. Nothing was written.`,
                canonicalPath,
                displayFilePath,
                live.bytes,
                editable.lines,
                input.edits,
              );
            } else {
              let activeOperations = input.edits;
              let activeSeen: readonly SeenRange[] = record.seen;
              let notice = "";
              const snapshotCurrent = live.bytes.length === record.byteLength && digestBytes(live.bytes) === record.digest;
              if (snapshotCurrent && editable.lines.length !== record.lineCount) {
                refresh = pendingRefresh(
                  "E_STALE_SNAPSHOT",
                  `Snapshot ${token} no longer matches the file's current lines. Nothing was written.`,
                  canonicalPath,
                  displayFilePath,
                  live.bytes,
                  editable.lines,
                  input.edits,
                );
              } else if (!snapshotCurrent) {
                const oldBytes = runtime.getRecoveryBytes(canonicalPath, token);
                const attempt = oldBytes
                  ? tryRebaseOperations(record, oldBytes, editable.lines, input.edits, shownPath)
                  : { kind: "rejected" as const, reason: "the exact prior bytes are no longer in the branch-local recovery cache" };
                if (attempt.kind === "rebased") {
                  activeOperations = attempt.operations;
                  activeSeen = attempt.seen;
                  notice = rebaseNotice(attempt);
                } else {
                  // The detailed proof failure stays in the debug log; the
                  // model-facing message only states the safe outcome.
                  logger.debug("rebase_rejected", { path: displayFilePath, snapshot: token, reason: attempt.reason });
                  refresh = pendingRefresh(
                    "E_STALE_SNAPSHOT",
                    `${shownPath} changed on disk after snapshot ${token}, overlapping this edit. Nothing was written.`,
                    canonicalPath,
                    displayFilePath,
                    live.bytes,
                    editable.lines,
                    input.edits,
                  );
                }
              }

              refreshContext = Object.freeze({ bytes: live.bytes, lines: editable.lines, operations: activeOperations });
              if (!refresh) {
                const unseen = firstUnseenRequirement(activeOperations, editable.lines.length, activeSeen);
                if (unseen) {
                  refresh = pendingRefresh(
                    "E_UNSEEN_LINE",
                    `This edit touches line ${unseen.missingLine}, which snapshot ${token} never showed (need ${unseen.start}-${unseen.end}). Nothing was written.`,
                    canonicalPath,
                    displayFilePath,
                    live.bytes,
                    editable.lines,
                    activeOperations,
                    { start: unseen.missingLine, end: unseen.end },
                  );
                }
              }

              if (!refresh) {
                const plan = planOperations(activeOperations, editable.lines, activeSeen, shownPath);
                const applied = applyOperations(editable.lines, plan);
                const outputBytes = serializePhysicalLines({ hasBom: editable.hasBom, lines: applied.lines });
                if (live.bytes.length > 0 && outputBytes.length === 0) {
                  fail("E_WOULD_EMPTY", "Hashline will not turn a non-empty file into empty bytes. Use write for an explicit full-file clear.");
                }
                if (outputBytes.length > MAX_EDITABLE_FILE_BYTES) {
                  fail("E_TOO_LARGE", `Edited file would exceed the ${MAX_EDITABLE_FILE_BYTES} byte limit.`);
                }
                if (outputBytes.equals(live.bytes)) {
                  refresh = pendingRefresh(
                    "E_NO_CHANGE",
                    `This edit would not change the file. Nothing was written; do not retry the same payload.`,
                    canonicalPath,
                    displayFilePath,
                    live.bytes,
                    editable.lines,
                    activeOperations,
                  );
                } else {
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
                  const formatted = formatEditResults(
                    displayFilePath,
                    outputToken,
                    applied.lines,
                    applied.changedSpans,
                    plan,
                    notice,
                  );
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
                  followUpBytes = followUpRecord ? outputBytes : undefined;

                  const changedAgain = await verifyFinalTarget(absolutePath, canonicalPath, handle, live.bytes, signal);
                  abortIfNeeded(signal);
                  if (runtime.getGeneration() !== generation) {
                    fail("E_BRANCH_CHANGED", "The active session branch changed before commit. Nothing was written; re-read on the current branch.");
                  }
                  if (changedAgain) {
                    const changedEditable = decodeEditableBytes(changedAgain);
                    refresh = pendingRefresh(
                      "E_STALE_SNAPSHOT",
                      `${shownPath} changed again while this edit was being checked. Nothing was written.`,
                      canonicalPath,
                      displayFilePath,
                      changedAgain,
                      changedEditable.lines,
                      activeOperations,
                    );
                  } else {
                    try {
                      await commitWrite(handle, outputBytes);
                      committed = true;
                      logger.info("edit_committed", {
                        path: displayFilePath,
                        snapshot: input.snapshot,
                        token: outputToken,
                        edits: input.edits.length,
                        rebased: notice.length > 0,
                        bytesBefore: live.bytes.length,
                        bytesAfter: outputBytes.length,
                        generation,
                      });
                    } catch {
                      throw hashlineError(
                        "E_WRITE_FAILED",
                        `Writing ${shownPath} failed and the file may be partially changed. Read it before any retry.`,
                      );
                    }
                  }
                }
              }
            }
          } catch (error) {
            const issue = refreshableSemanticError(error);
            if (!committed && !refresh && refreshContext && issue) {
              try {
                refresh = pendingRefresh(
                  issue.code,
                  `${issue.summary} Nothing was written.`,
                  canonicalPath,
                  displayFilePath,
                  refreshContext.bytes,
                  refreshContext.lines,
                  refreshContext.operations,
                );
              } catch (refreshError) {
                primaryError = refreshError;
              }
            } else {
              primaryError = error;
            }
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
          if (primaryError === undefined && !committed && refresh) {
            if (runtime.getGeneration() !== generation) {
              primaryError = hashlineError("E_BRANCH_CHANGED", "The active session branch changed before snapshot refresh. Re-read on the current branch.");
            } else {
              let text = refresh.withoutTokenText;
              if (refresh.record && refresh.entry && refresh.withTokenText) {
                try {
                  runtime.commitRecord(refresh.record, refresh.entry, refresh.bytes);
                  text = refresh.withTokenText;
                } catch {
                  // The refresh performed no write; a missing token truthfully falls back to explicit read.
                }
              }
              refusal = { code: refresh.code, text: `[${refresh.code}] ${text}` };
              logger.debug("edit_refused", {
                path: displayFilePath,
                code: refresh.code,
                snapshot: input.snapshot,
                edits: input.edits.length,
                generation,
              });
            }
          }
          if (
            primaryError === undefined &&
            committed &&
            runtime.getGeneration() === generation &&
            followUpRecord &&
            followUpEntry &&
            withTokenResult &&
            followUpBytes
          ) {
            try {
              runtime.commitRecord(followUpRecord, followUpEntry, followUpBytes);
              result = withTokenResult;
            } catch {
              // The file is committed; the result without a token remains the truthful fallback.
            }
          }
          if (primaryError !== undefined) throw primaryError;
          if (refusal !== undefined) return refusalEditResult(refusal.text);
          if (!result) throw hashlineError("E_WRITE_FAILED", `Writing ${shownPath} ended without a verifiable result. Read the file before retrying.`);
          return result;
        });
      } catch (error) {
        const code = hashlineErrorCode(error);
        const unexpected = !isHashlineFailure(error) || code === "E_WRITE_FAILED";
        logger[unexpected ? "error" : "debug"]("edit_failed", {
          path: displayFilePath,
          code: code ?? "unknown",
          snapshot: input.snapshot,
          edits: input.edits.length,
          generation,
          error,
        });
        if (isHashlineFailure(error)) throw error;
        throw hashlineError("E_NOT_EDITABLE", `Hashline could not access ${shownPath} as an editable file.`);
      }
    },
  };
}
