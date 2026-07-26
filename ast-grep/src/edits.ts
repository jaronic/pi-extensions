import { createHash } from "node:crypto";
import type { NormalizedEditInput } from "./schema.ts";
import type { CanonicalEdit, DecodedMatch, EditPlan, EditSummary } from "./types.ts";
import { AST_GREP_VERSION } from "./types.ts";

const MAX_SINGLE_REPLACEMENT_BYTES = 16 * 1024;
const MAX_TOTAL_EDIT_BYTES = 32 * 1024;

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeSourceRange(source: Buffer, start: number, end: number, field: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(source.subarray(start, end));
  } catch {
    throw new Error(`incompatible/corrupt ast-grep output: ${field} splits a UTF-8 code point.`);
  }
}

export function createEditPlan(
  input: NormalizedEditInput,
  canonicalWorkspace: string,
  canonicalPath: string,
  displayPath: string,
  source: Buffer,
  mode: number,
  records: readonly DecodedMatch[],
): EditPlan {
  const provisional: CanonicalEdit[] = [];
  let totalBytes = 0;
  for (const [index, record] of records.entries()) {
    if (record.file !== "STDIN" || record.replacement === undefined || record.replacementOffsets === undefined) {
      throw new Error(`incompatible/corrupt ast-grep output: rewrite record ${index + 1} lacks the STDIN replacement contract.`);
    }
    const matchRange = record.range.byteOffset;
    const replacementRange = record.replacementOffsets;
    if (matchRange.start >= matchRange.end || replacementRange.start >= replacementRange.end) {
      throw new Error("ast-grep v1 refuses zero-width matches or replacements because insertion order would be ambiguous.");
    }
    if (matchRange.end > source.length || replacementRange.end > source.length) {
      throw new Error("incompatible/corrupt ast-grep output: rewrite range is outside the source snapshot.");
    }
    if (matchRange.start !== replacementRange.start || matchRange.end !== replacementRange.end) {
      throw new Error("incompatible/corrupt ast-grep output: replacementOffsets drifted from the fixed 0.45.0 match range contract.");
    }
    const matchedText = decodeSourceRange(source, matchRange.start, matchRange.end, "match range");
    if (matchedText !== record.text) {
      throw new Error("incompatible/corrupt ast-grep output: rewrite text disagrees with the bounded source snapshot.");
    }
    const before = source.subarray(replacementRange.start, replacementRange.end);
    const after = Buffer.from(record.replacement, "utf8");
    if (after.length > MAX_SINGLE_REPLACEMENT_BYTES) {
      throw new Error(`one ast-grep replacement exceeds ${MAX_SINGLE_REPLACEMENT_BYTES} bytes; narrow the rewrite.`);
    }
    totalBytes += before.length + after.length;
    if (totalBytes > MAX_TOTAL_EDIT_BYTES) {
      throw new Error(`ast-grep preview exceeds ${MAX_TOTAL_EDIT_BYTES} total before/after bytes; narrow the pattern.`);
    }
    if (before.equals(after)) {
      continue;
    }
    provisional.push({
      range: record.range,
      replacementRange,
      before: Buffer.from(before),
      after,
    });
  }

  provisional.sort((left, right) => left.replacementRange.start - right.replacementRange.start
    || left.replacementRange.end - right.replacementRange.end
    || Buffer.compare(left.after, right.after));
  const edits: CanonicalEdit[] = [];
  for (const edit of provisional) {
    const previous = edits[edits.length - 1];
    if (previous !== undefined
      && previous.replacementRange.start === edit.replacementRange.start
      && previous.replacementRange.end === edit.replacementRange.end) {
      if (!previous.after.equals(edit.after)) {
        throw new Error("ast-grep produced conflicting replacements for the same byte range.");
      }
      continue;
    }
    if (previous !== undefined && edit.replacementRange.start < previous.replacementRange.end) {
      throw new Error("ast-grep produced nested or overlapping replacement ranges; no changes were written.");
    }
    edits.push(edit);
  }

  const outputParts: Buffer[] = [];
  let sourceOffset = 0;
  for (const edit of edits) {
    outputParts.push(source.subarray(sourceOffset, edit.replacementRange.start), edit.after);
    sourceOffset = edit.replacementRange.end;
  }
  outputParts.push(source.subarray(sourceOffset));
  const output = Buffer.concat(outputParts);
  if (output.equals(source)) {
    edits.length = 0;
  }
  if (edits.length > input.maxReplacements) {
    throw new Error(`ast-grep produced more than maxReplacements=${input.maxReplacements}; narrow the pattern.`);
  }
  const sourceSha256 = sha256(source);
  const outputSha256 = sha256(output);
  const fingerprint = {
    protocol: "pi-extensions:ast-edit-preview:v1",
    cliVersion: AST_GREP_VERSION,
    workspace: canonicalWorkspace,
    path: displayPath,
    language: input.language,
    pattern: input.pattern,
    rewrite: input.rewrite,
    selector: input.selector ?? null,
    strictness: input.strictness,
    maxReplacements: input.maxReplacements,
    sourceSha256,
    edits: edits.map((edit) => ({
      replacementStart: edit.replacementRange.start,
      replacementEnd: edit.replacementRange.end,
      replacementSha256: sha256(edit.after),
    })),
  } as const;
  const previewId = createHash("sha256").update(JSON.stringify(fingerprint), "utf8").digest("hex");
  const summaries: EditSummary[] = edits.map((edit) => ({
    range: edit.range,
    replacementRange: edit.replacementRange,
    before: decodeSourceRange(edit.before, 0, edit.before.length, "replacement before bytes"),
    after: decodeSourceRange(edit.after, 0, edit.after.length, "replacement after bytes"),
  }));
  return {
    path: displayPath,
    canonicalPath,
    source,
    output,
    sourceSha256,
    outputSha256,
    previewId,
    edits,
    summaries,
    mode,
  };
}
