import { diffArrays } from "diff";
import type { SnapshotToken } from "./digest.ts";
import { decodeEditableBytes, type PhysicalLine } from "./lines.ts";
import {
  operationRequiredSeenRange,
  planOperations,
  type ValidatedEditOperation,
} from "./operations.ts";
import {
  EDIT_PREVIEW_CONTEXT,
  MAX_RECOVERY_EDIT_DISTANCE,
  MAX_RECOVERY_ENTRIES,
  MAX_RECOVERY_FILE_BYTES,
  MAX_RECOVERY_TOTAL_BYTES,
  MAX_RECOVERY_VERSIONS_PER_PATH,
  MAX_SEEN_RANGES,
} from "./schemas.ts";
import type { SeenRange, SnapshotRecord } from "./snapshots.ts";

interface RecoveryEntry {
  readonly canonicalPath: string;
  readonly token: SnapshotToken;
  readonly bytes: Buffer;
}

export class RecoveryStore {
  private readonly byPath = new Map<string, Map<SnapshotToken, RecoveryEntry>>();
  private readonly lru = new Map<string, RecoveryEntry>();
  private totalBytes = 0;

  get size(): number {
    return this.lru.size;
  }

  get byteLength(): number {
    return this.totalBytes;
  }

  clear(): void {
    this.byPath.clear();
    this.lru.clear();
    this.totalBytes = 0;
  }

  get(canonicalPath: string, token: SnapshotToken): Buffer | undefined {
    const entry = this.byPath.get(canonicalPath)?.get(token);
    if (!entry) return undefined;
    this.touch(entry);
    return entry.bytes;
  }

  put(record: SnapshotRecord, bytes: Buffer): void {
    if (bytes.length !== record.byteLength || bytes.length > MAX_RECOVERY_FILE_BYTES) return;
    const key = this.key(record.canonicalPath, record.token);
    const existing = this.lru.get(key);
    if (existing) {
      this.touch(existing);
      return;
    }

    const entry = Object.freeze({
      canonicalPath: record.canonicalPath,
      token: record.token,
      bytes,
    });
    let records = this.byPath.get(record.canonicalPath);
    if (!records) {
      records = new Map();
      this.byPath.set(record.canonicalPath, records);
    }
    records.set(record.token, entry);
    this.lru.set(key, entry);
    this.totalBytes += bytes.length;

    while (records.size > MAX_RECOVERY_VERSIONS_PER_PATH) {
      const oldest = records.keys().next().value as SnapshotToken | undefined;
      if (!oldest) break;
      this.remove(record.canonicalPath, oldest);
    }
    while (this.lru.size > MAX_RECOVERY_ENTRIES || this.totalBytes > MAX_RECOVERY_TOTAL_BYTES) {
      const oldest = this.lru.values().next().value as RecoveryEntry | undefined;
      if (!oldest) break;
      this.remove(oldest.canonicalPath, oldest.token);
    }
  }

  private key(canonicalPath: string, token: SnapshotToken): string {
    return `${canonicalPath}\0${token}`;
  }

  private touch(entry: RecoveryEntry): void {
    const records = this.byPath.get(entry.canonicalPath);
    if (records) {
      records.delete(entry.token);
      records.set(entry.token, entry);
    }
    const key = this.key(entry.canonicalPath, entry.token);
    this.lru.delete(key);
    this.lru.set(key, entry);
  }

  private remove(canonicalPath: string, token: SnapshotToken): void {
    const records = this.byPath.get(canonicalPath);
    const entry = records?.get(token);
    if (!records || !entry) return;
    records.delete(token);
    this.lru.delete(this.key(canonicalPath, token));
    this.totalBytes -= entry.bytes.length;
    if (records.size === 0) this.byPath.delete(canonicalPath);
  }
}

interface UnchangedRun {
  readonly oldStart: number;
  readonly currentStart: number;
  readonly count: number;
}

export interface RebasedOperations {
  readonly kind: "rebased";
  readonly operations: readonly ValidatedEditOperation[];
  readonly seen: readonly SeenRange[];
  readonly offset: number;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly targetStart: number;
  readonly targetEnd: number;
}

export interface RebaseRejected {
  readonly kind: "rejected";
  readonly reason: string;
}

export type RebaseAttempt = RebasedOperations | RebaseRejected;

function rejected(reason: string): RebaseRejected {
  return Object.freeze({ kind: "rejected", reason });
}

function samePhysicalLine(left: PhysicalLine, right: PhysicalLine): boolean {
  return left.body === right.body && left.eol === right.eol;
}

function isSeen(ranges: readonly SeenRange[], line: number): boolean {
  return ranges.some((range) => line >= range.start && line <= range.end);
}

function isRangeSeen(ranges: readonly SeenRange[], start: number, end: number): boolean {
  let cursor = start;
  for (const range of ranges) {
    if (range.end < cursor) continue;
    if (range.start > cursor) return false;
    cursor = Math.max(cursor, range.end + 1);
    if (cursor > end) return true;
  }
  return false;
}

function unchangedRuns(
  oldLines: readonly PhysicalLine[],
  currentLines: readonly PhysicalLine[],
): readonly UnchangedRun[] | undefined {
  const changes = diffArrays([...oldLines], [...currentLines], {
    comparator: samePhysicalLine,
    maxEditLength: MAX_RECOVERY_EDIT_DISTANCE,
  });
  if (!changes) return undefined;
  const runs: UnchangedRun[] = [];
  let oldLine = 1;
  let currentLine = 1;
  for (const change of changes) {
    if (change.added) {
      currentLine += change.count;
    } else if (change.removed) {
      oldLine += change.count;
    } else {
      runs.push(Object.freeze({ oldStart: oldLine, currentStart: currentLine, count: change.count }));
      oldLine += change.count;
      currentLine += change.count;
    }
  }
  return Object.freeze(runs);
}

function countSequenceOccurrences(
  haystack: readonly PhysicalLine[],
  pattern: readonly PhysicalLine[],
  patternStart: number,
  patternLength: number,
): { readonly count: number; readonly firstStart: number | undefined } {
  const prefix = new Array<number>(patternLength).fill(0);
  for (let index = 1, matched = 0; index < patternLength;) {
    if (samePhysicalLine(pattern[patternStart + index], pattern[patternStart + matched])) {
      prefix[index] = matched + 1;
      index += 1;
      matched += 1;
    } else if (matched > 0) {
      matched = prefix[matched - 1];
    } else {
      index += 1;
    }
  }

  let count = 0;
  let firstStart: number | undefined;
  for (let index = 0, matched = 0; index < haystack.length;) {
    if (samePhysicalLine(haystack[index], pattern[patternStart + matched])) {
      index += 1;
      matched += 1;
      if (matched === patternLength) {
        const start = index - patternLength;
        firstStart ??= start;
        count += 1;
        if (count > 1) break;
        matched = prefix[matched - 1];
      }
    } else if (matched > 0) {
      matched = prefix[matched - 1];
    } else {
      index += 1;
    }
  }
  return Object.freeze({ count, firstStart });
}

export function tryRebaseOperations(
  record: SnapshotRecord,
  oldBytes: Buffer,
  currentLines: readonly PhysicalLine[],
  operations: readonly ValidatedEditOperation[],
  authoredPath: string,
): RebaseAttempt {
  if (oldBytes.length !== record.byteLength) return rejected("the cached base no longer matches the snapshot metadata");
  let oldLines: readonly PhysicalLine[];
  try {
    const oldEditable = decodeEditableBytes(oldBytes);
    oldLines = oldEditable.lines;
    if (oldLines.length !== record.lineCount) return rejected("the cached base line count no longer matches the snapshot");
    planOperations(operations, oldLines, record.seen, authoredPath);
  } catch {
    return rejected("the submitted operations were not valid and fully seen in the old snapshot");
  }

  let sourceStart = Number.POSITIVE_INFINITY;
  let sourceEnd = 0;
  for (let index = 0; index < operations.length; index += 1) {
    const range = operationRequiredSeenRange(operations[index], oldLines.length, index);
    sourceStart = Math.min(sourceStart, range.start);
    sourceEnd = Math.max(sourceEnd, range.end);
  }
  if (!Number.isFinite(sourceStart) || sourceEnd < sourceStart) return rejected("the edit has no recoverable line anchors");
  if (!isRangeSeen(record.seen, sourceStart, sourceEnd)) {
    return rejected("the complete multi-operation proof envelope was not displayed in the old snapshot; read the full current span from the first through last target before retrying");
  }

  let proofStart = sourceStart;
  let proofEnd = sourceEnd;
  for (let count = 0; count < EDIT_PREVIEW_CONTEXT && proofStart > 1 && isSeen(record.seen, proofStart - 1); count += 1) {
    proofStart -= 1;
  }
  for (let count = 0; count < EDIT_PREVIEW_CONTEXT && proofEnd < oldLines.length && isSeen(record.seen, proofEnd + 1); count += 1) {
    proofEnd += 1;
  }
  if (proofStart === sourceStart && proofEnd === sourceEnd) {
    return rejected("the target has no displayed surrounding context to prove its identity");
  }

  const runs = unchangedRuns(oldLines, currentLines);
  if (!runs) return rejected("the file drift exceeds the bounded recovery diff limit");
  const run = runs.find((candidate) =>
    proofStart >= candidate.oldStart &&
    proofEnd < candidate.oldStart + candidate.count
  );
  if (!run) return rejected("the target or its displayed context changed since the snapshot");

  const proofLength = proofEnd - proofStart + 1;
  const oldOccurrences = countSequenceOccurrences(oldLines, oldLines, proofStart - 1, proofLength);
  const currentOccurrences = countSequenceOccurrences(currentLines, oldLines, proofStart - 1, proofLength);
  const mappedProofStart = run.currentStart + (proofStart - run.oldStart);
  if (
    oldOccurrences.count !== 1 || oldOccurrences.firstStart !== proofStart - 1 ||
    currentOccurrences.count !== 1 || currentOccurrences.firstStart !== mappedProofStart - 1
  ) {
    return rejected("the unchanged target context is duplicated or maps ambiguously");
  }

  const offset = mappedProofStart - proofStart;
  const remapped = operations.map((operation) => Object.freeze({
    ...operation,
    start: operation.start + offset,
    ...(operation.end === undefined ? {} : { end: operation.end + offset }),
  }));
  const remappedSeen = record.seen.flatMap((range) => {
    const start = Math.max(range.start, proofStart);
    const end = Math.min(range.end, proofEnd);
    return start <= end
      ? [Object.freeze({ start: start + offset, end: end + offset })]
      : [];
  });
  return Object.freeze({
    kind: "rebased",
    operations: Object.freeze(remapped),
    seen: Object.freeze(remappedSeen),
    offset,
    sourceStart,
    sourceEnd,
    targetStart: sourceStart + offset,
    targetEnd: sourceEnd + offset,
  });
}

function clampLine(line: number, lineCount: number): number {
  return Math.min(Math.max(1, line), lineCount);
}

export function refreshRangesForOperations(
  operations: readonly ValidatedEditOperation[],
  lineCount: number,
  focus?: SeenRange,
): readonly SeenRange[] {
  if (lineCount < 1) return Object.freeze([]);
  const candidates: Array<{ start: number; end: number }> = [];
  if (focus) {
    candidates.push({
      start: Math.max(1, focus.start - EDIT_PREVIEW_CONTEXT),
      end: Math.min(lineCount, focus.end + EDIT_PREVIEW_CONTEXT),
    });
  } else {
    for (const operation of operations) {
      const anchor = clampLine(operation.start, lineCount);
      let start = anchor;
      let end = anchor;
      if (operation.op === "replace" || operation.op === "delete") {
        end = clampLine(operation.end ?? operation.start, lineCount);
        if (end < start) [start, end] = [end, start];
      } else if (operation.op === "insert_before") {
        start = Math.max(1, anchor - 1);
      } else {
        end = Math.min(lineCount, anchor + 1);
      }
      candidates.push({
        start: Math.max(1, start - EDIT_PREVIEW_CONTEXT),
        end: Math.min(lineCount, end + EDIT_PREVIEW_CONTEXT),
      });
    }
  }

  candidates.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const candidate of candidates) {
    const previous = merged[merged.length - 1];
    if (previous && candidate.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, candidate.end);
    } else if (merged.length < MAX_SEEN_RANGES) {
      merged.push({ ...candidate });
    } else {
      break;
    }
  }
  return Object.freeze(merged.map((range) => Object.freeze(range)));
}
