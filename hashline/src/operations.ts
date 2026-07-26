import { parseSnapshotToken } from "./digest.ts";
import { fail } from "./errors.ts";
import {
  assertEditableLineSizes,
  lineByteLength,
  preferredLineEnding,
  type LineEnding,
  type PhysicalLine,
} from "./lines.ts";
import {
  EDIT_OPS,
  MAX_EDIT_CHANGED_BYTES,
  MAX_EDITABLE_LINES,
  MAX_EDIT_OPERATIONS,
  MAX_EDIT_PAYLOAD_BYTES,
  MAX_EDIT_PAYLOAD_LINES,
  MAX_EDIT_LINE_BYTES,
  MAX_PATH_CHARS,
  type HashlineEditOp,
} from "./schemas.ts";
import { normalizeSeenRanges, type SeenRange } from "./snapshots.ts";

export interface ValidatedEditOperation {
  readonly op: HashlineEditOp;
  readonly start: number;
  readonly end?: number;
  readonly lines?: readonly string[];
}

export interface ValidatedHashlineEditInput {
  readonly path: string;
  readonly snapshot: `h1_${string}`;
  readonly edits: readonly ValidatedEditOperation[];
}

export interface OperationPlan {
  readonly operations: readonly ValidatedEditOperation[];
  readonly consumedLines: number;
  readonly insertedLines: number;
  readonly oldChangedBytes: number;
}

export interface ChangedSpan {
  readonly start: number;
  readonly end: number;
}

export interface ApplyResult {
  readonly lines: readonly PhysicalLine[];
  readonly changedSpans: readonly ChangedSpan[];
  readonly changedBytes: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) fail("E_BAD_REQUEST", `${label} contains an unknown field.`);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

function safeLineNumber(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail("E_BAD_REQUEST", `${label} must be a safe 1-based integer.`);
  return value as number;
}

interface PayloadBudget {
  lineCount: number;
  byteCount: number;
}

function decodeLines(value: unknown, label: string, budget: PayloadBudget): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) fail("E_BAD_REQUEST", `${label} must be a non-empty array of logical lines.`);
  if (value.length > MAX_EDIT_PAYLOAD_LINES - budget.lineCount) {
    fail("E_TOO_LARGE", `Edit payload exceeds ${MAX_EDIT_PAYLOAD_LINES} logical lines.`);
  }
  const lines: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const line = value[index];
    if (typeof line !== "string") fail("E_BAD_REQUEST", `${label}[${index}] must be a string.`);
    if (line.includes("\n") || line.includes("\r") || line.includes("\0")) {
      fail("E_BAD_REQUEST", `${label}[${index}] must not contain a line terminator or NUL.`);
    }
    if (hasUnpairedSurrogate(line)) fail("E_BAD_REQUEST", `${label}[${index}] contains an unpaired UTF-16 surrogate.`);
    const bytes = Buffer.byteLength(line, "utf8");
    if (bytes > MAX_EDIT_LINE_BYTES) fail("E_TOO_LARGE", `${label}[${index}] exceeds ${MAX_EDIT_LINE_BYTES} bytes.`);
    if (budget.byteCount + bytes > MAX_EDIT_PAYLOAD_BYTES) {
      fail("E_TOO_LARGE", `Edit payload exceeds ${MAX_EDIT_PAYLOAD_BYTES} bytes.`);
    }
    budget.lineCount += 1;
    budget.byteCount += bytes;
    lines.push(line);
  }
  return Object.freeze(lines);
}

function decodeOperation(value: unknown, index: number, budget: PayloadBudget): ValidatedEditOperation {
  if (!isRecord(value)) fail("E_BAD_REQUEST", `edits[${index}] must be an object.`);
  exactKeys(value, ["op", "start", "end", "lines"], `edits[${index}]`);
  if (typeof value.op !== "string" || !EDIT_OPS.includes(value.op as HashlineEditOp)) {
    fail("E_BAD_REQUEST", `edits[${index}].op is invalid.`);
  }
  const op = value.op as HashlineEditOp;
  const start = safeLineNumber(value.start, `edits[${index}].start`);
  const hasEnd = Object.hasOwn(value, "end");
  const hasLines = Object.hasOwn(value, "lines");
  if ((op === "insert_before" || op === "insert_after") && hasEnd) {
    fail("E_BAD_REQUEST", `edits[${index}].end is not allowed for ${op}.`);
  }
  if (op === "delete" && hasLines) fail("E_BAD_REQUEST", `edits[${index}].lines is not allowed for delete.`);
  if ((op === "replace" || op === "insert_before" || op === "insert_after") && !hasLines) {
    fail("E_BAD_REQUEST", `edits[${index}].lines is required for ${op}.`);
  }
  const end = hasEnd ? safeLineNumber(value.end, `edits[${index}].end`) : undefined;
  const lines = hasLines ? decodeLines(value.lines, `edits[${index}].lines`, budget) : undefined;
  return Object.freeze({ op, start, ...(end === undefined ? {} : { end }), ...(lines === undefined ? {} : { lines }) });
}

export function decodeHashlineEditInput(value: unknown): ValidatedHashlineEditInput {
  if (!isRecord(value)) fail("E_BAD_REQUEST", "edit input must be an object.");
  exactKeys(value, ["path", "snapshot", "edits"], "edit input");
  if (typeof value.path !== "string" || value.path.length === 0) fail("E_BAD_REQUEST", "path must be a non-empty string.");
  if (value.path.length > MAX_PATH_CHARS) fail("E_TOO_LARGE", `path exceeds ${MAX_PATH_CHARS} characters.`);
  if (value.path.includes("\0") || hasUnpairedSurrogate(value.path)) fail("E_BAD_REQUEST", "path contains an invalid character.");
  const parsedToken = parseSnapshotToken(value.snapshot);
  if (!parsedToken) fail("E_SNAPSHOT_REQUIRED", "A valid snapshot from read is required; do not guess or reuse another token.");
  if (!Array.isArray(value.edits) || value.edits.length < 1 || value.edits.length > MAX_EDIT_OPERATIONS) {
    fail("E_BAD_REQUEST", `edits must contain between 1 and ${MAX_EDIT_OPERATIONS} operations.`);
  }
  const decodedEdits: ValidatedEditOperation[] = [];
  const budget: PayloadBudget = { lineCount: 0, byteCount: 0 };
  for (let index = 0; index < value.edits.length; index += 1) {
    decodedEdits.push(decodeOperation(value.edits[index], index, budget));
  }
  return Object.freeze({ path: value.path, snapshot: parsedToken.token, edits: Object.freeze(decodedEdits) });
}

function missingSeenLine(ranges: readonly SeenRange[], start: number, end: number): number | undefined {
  let cursor = start;
  for (const range of ranges) {
    if (range.end < cursor) continue;
    if (range.start > cursor) return cursor;
    cursor = Math.max(cursor, range.end + 1);
    if (cursor > end) return undefined;
  }
  return cursor <= end ? cursor : undefined;
}

export function planOperations(
  operations: readonly ValidatedEditOperation[],
  sourceLines: readonly PhysicalLine[],
  seen: readonly SeenRange[],
  authoredPath: string,
): OperationPlan {
  assertEditableLineSizes(sourceLines);
  const normalizedSeen = normalizeSeenRanges(seen, sourceLines.length);
  const consumes: Array<{ start: number; end: number; index: number }> = [];
  const inserts: Array<{ gap: number; index: number }> = [];
  let consumedLines = 0;
  let insertedLines = 0;
  let oldChangedBytes = 0;

  operations.forEach((operation, index) => {
    if (operation.start > sourceLines.length) {
      fail("E_RANGE", `edits[${index}].start ${operation.start} is beyond the ${sourceLines.length}-line file.`);
    }
    if (operation.op === "replace" || operation.op === "delete") {
      const end = operation.end ?? operation.start;
      if (end < operation.start || end > sourceLines.length) {
        fail("E_RANGE", `edits[${index}] range ${operation.start}..${end} is outside the original file.`);
      }
      const unseen = missingSeenLine(normalizedSeen, operation.start, end);
      if (unseen !== undefined) {
        fail(
          "E_UNSEEN_LINE",
          `Line ${unseen} was not shown by this snapshot. Read ${authoredPath} with offset=${operation.start} limit=${end - operation.start + 1}, then rebuild the edit.`,
        );
      }
      consumes.push({ start: operation.start, end, index });
      consumedLines += end - operation.start + 1;
      for (let line = operation.start; line <= end; line += 1) {
        oldChangedBytes += lineByteLength(sourceLines[line - 1]);
        if (oldChangedBytes > MAX_EDIT_CHANGED_BYTES) {
          fail("E_TOO_LARGE", `Edit changes more than ${MAX_EDIT_CHANGED_BYTES} existing bytes.`);
        }
      }
      if (operation.op === "replace") insertedLines += operation.lines?.length ?? 0;
    } else {
      const gap = operation.op === "insert_before" ? operation.start - 1 : operation.start;
      const requiredStart = operation.op === "insert_before" ? Math.max(1, operation.start - 1) : operation.start;
      const requiredEnd = operation.op === "insert_before"
        ? operation.start
        : Math.min(sourceLines.length, operation.start + 1);
      const unseen = missingSeenLine(normalizedSeen, requiredStart, requiredEnd);
      if (unseen !== undefined) {
        fail(
          "E_UNSEEN_LINE",
          `Insertion gap at line ${operation.start} is not fully shown. Read ${authoredPath} with offset=${requiredStart} limit=${requiredEnd - requiredStart + 1}, then rebuild the edit.`,
        );
      }
      inserts.push({ gap, index });
      insertedLines += operation.lines?.length ?? 0;
    }
  });

  consumes.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < consumes.length; index += 1) {
    if (consumes[index].start <= consumes[index - 1].end) {
      fail("E_EDIT_CONFLICT", `edits[${consumes[index - 1].index}] and edits[${consumes[index].index}] consume overlapping lines.`);
    }
  }
  inserts.sort((left, right) => left.gap - right.gap);
  for (let index = 1; index < inserts.length; index += 1) {
    if (inserts[index].gap === inserts[index - 1].gap) {
      fail("E_EDIT_CONFLICT", `edits[${inserts[index - 1].index}] and edits[${inserts[index].index}] target the same insertion gap.`);
    }
  }
  for (const insertion of inserts) {
    const enclosing = consumes.find((range) => insertion.gap >= range.start && insertion.gap < range.end);
    if (enclosing) {
      fail("E_EDIT_CONFLICT", `edits[${insertion.index}] inserts inside the range consumed by edits[${enclosing.index}].`);
    }
  }
  return Object.freeze({ operations, consumedLines, insertedLines, oldChangedBytes });
}

function spansFromLines(changedLines: ReadonlySet<number>): readonly ChangedSpan[] {
  const sorted = [...changedLines].sort((left, right) => left - right);
  const spans: Array<{ start: number; end: number }> = [];
  for (const line of sorted) {
    const previous = spans[spans.length - 1];
    if (previous && line <= previous.end + 1) previous.end = line;
    else spans.push({ start: line, end: line });
  }
  return Object.freeze(spans.map((span) => Object.freeze(span)));
}

function makePayloadRecords(
  bodies: readonly string[],
  eol: Exclude<LineEnding, "">,
  lastEol: LineEnding,
): readonly PhysicalLine[] {
  return bodies.map((body, index) => Object.freeze({ body, eol: index === bodies.length - 1 ? lastEol : eol }));
}

export function applyOperations(sourceLines: readonly PhysicalLine[], plan: OperationPlan): ApplyResult {
  const consumeByStart = new Map<number, ValidatedEditOperation>();
  const insertByGap = new Map<number, ValidatedEditOperation>();
  for (const operation of plan.operations) {
    if (operation.op === "replace" || operation.op === "delete") consumeByStart.set(operation.start, operation);
    else insertByGap.set(operation.op === "insert_before" ? operation.start - 1 : operation.start, operation);
  }

  const output: PhysicalLine[] = [];
  const changedLines = new Set<number>();
  const deletionMarkers: number[] = [];
  let newChangedBytes = 0;

  const emitInsertion = (gap: number): void => {
    const operation = insertByGap.get(gap);
    if (!operation?.lines) return;
    const localEol = preferredLineEnding(sourceLines, operation.start);
    const atUnterminatedEof = gap === sourceLines.length && sourceLines[sourceLines.length - 1]?.eol === "";
    if (atUnterminatedEof && output.length > 0 && output[output.length - 1].eol === "") {
      output[output.length - 1] = Object.freeze({ ...output[output.length - 1], eol: localEol });
      changedLines.add(output.length);
      newChangedBytes += Buffer.byteLength(localEol, "utf8");
    }
    const records = makePayloadRecords(
      operation.lines,
      localEol,
      atUnterminatedEof ? "" : localEol,
    );
    for (const record of records) {
      output.push(record);
      changedLines.add(output.length);
      newChangedBytes += lineByteLength(record);
    }
  };

  let sourceLine = 1;
  while (sourceLine <= sourceLines.length) {
    emitInsertion(sourceLine - 1);
    const operation = consumeByStart.get(sourceLine);
    if (!operation) {
      output.push(sourceLines[sourceLine - 1]);
      sourceLine += 1;
      continue;
    }
    const end = operation.end ?? operation.start;
    deletionMarkers.push(output.length);
    if (operation.op === "replace" && operation.lines) {
      const localEol = preferredLineEnding(sourceLines, operation.start);
      const records = makePayloadRecords(operation.lines, localEol, sourceLines[end - 1].eol);
      for (const record of records) {
        output.push(record);
        changedLines.add(output.length);
        newChangedBytes += lineByteLength(record);
      }
    }
    sourceLine = end + 1;
  }
  emitInsertion(sourceLines.length);

  for (const marker of deletionMarkers) {
    if (output.length > 0) changedLines.add(Math.min(marker + 1, output.length));
  }
  if (output.length > MAX_EDITABLE_LINES) {
    fail("E_TOO_LARGE", `Edited file would exceed the ${MAX_EDITABLE_LINES} physical-line limit.`);
  }
  const changedBytes = plan.oldChangedBytes + newChangedBytes;
  if (changedBytes > MAX_EDIT_CHANGED_BYTES) {
    fail("E_TOO_LARGE", `Edit changes ${changedBytes} bytes, exceeding the ${MAX_EDIT_CHANGED_BYTES} byte limit.`);
  }
  return Object.freeze({
    lines: Object.freeze(output),
    changedSpans: spansFromLines(changedLines),
    changedBytes,
  });
}
