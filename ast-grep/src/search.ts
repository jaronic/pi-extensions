import { createHash, type Hash } from "node:crypto";
import { withFileMutationQueue, type AgentToolResult, type AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { NormalizedSearchInput } from "./schema.ts";
import type { SupportedLanguage } from "./languages.ts";
import type { AstGrepDetailsV1, AstGrepSearchToolDetails, DecodedMatch, SearchCandidate } from "./types.ts";
import type { OperationRecord } from "./operations.ts";
import { throwIfCancelledOrExpired } from "./operations.ts";
import type { AstGrepRunner } from "./runner.ts";
import { BoundedMaxHeap } from "./heap.ts";
import { LosslessDirectoryValidator } from "./filenames.ts";
import { assertTargetStable, readBoundedFile, resolveWorkspaceTarget } from "./paths.ts";
import { formatSearchResult, normalizeMatchSummary, ProgressReporter } from "./output.ts";

const EXACT_SEARCH_BYTES = 8 * 1024 * 1024;

function updateLengthPrefixed(hash: Hash, value: string | Buffer): void {
  const bytes = typeof value === "string" ? Buffer.from(value) : value;
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  hash.update(length);
  hash.update(bytes);
}

function hashLogicalMatch(path: string, match: DecodedMatch): string {
  const hash = createHash("sha256");
  updateLengthPrefixed(hash, path);
  updateLengthPrefixed(hash, match.file);
  updateLengthPrefixed(hash, match.language);
  updateLengthPrefixed(hash, match.text);
  updateLengthPrefixed(hash, match.lines);
  updateLengthPrefixed(hash, String(match.charCount.leading));
  updateLengthPrefixed(hash, String(match.charCount.trailing));
  updateLengthPrefixed(hash, String(match.range.byteOffset.start));
  updateLengthPrefixed(hash, String(match.range.byteOffset.end));
  updateLengthPrefixed(hash, String(match.range.start.line));
  updateLengthPrefixed(hash, String(match.range.start.column));
  updateLengthPrefixed(hash, String(match.range.end.line));
  updateLengthPrefixed(hash, String(match.range.end.column));
  for (const variable of match.metaVariables) {
    updateLengthPrefixed(hash, variable.category);
    updateLengthPrefixed(hash, variable.name);
    updateLengthPrefixed(hash, String(variable.ordinal));
    updateLengthPrefixed(hash, variable.text);
    updateLengthPrefixed(hash, String(variable.range?.byteOffset.start ?? -1));
    updateLengthPrefixed(hash, String(variable.range?.byteOffset.end ?? -1));
  }
  return hash.digest("hex");
}

function compareCandidates(left: SearchCandidate, right: SearchCandidate): number {
  for (let index = 0; index < left.key.length; index += 1) {
    const leftValue = left.key[index]!;
    const rightValue = right.key[index]!;
    if (leftValue < rightValue) {
      return -1;
    }
    if (leftValue > rightValue) {
      return 1;
    }
  }
  return 0;
}

function verifyExactMatch(match: DecodedMatch, source: Buffer, displayPath: string): void {
  if (match.file !== "STDIN") {
    throw new Error("incompatible/corrupt ast-grep output: exact-file result must use the STDIN sentinel.");
  }
  const { start, end } = match.range.byteOffset;
  if (start > source.length || end > source.length) {
    throw new Error("incompatible/corrupt ast-grep output: exact-file match range is outside the source snapshot.");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(source.subarray(start, end));
  } catch {
    throw new Error(`incompatible/corrupt ast-grep output: match range splits UTF-8 bytes in ${displayPath}.`);
  }
  if (text !== match.text) {
    throw new Error(`incompatible/corrupt ast-grep output: match text disagrees with the bounded source snapshot in ${displayPath}.`);
  }
}

export async function executeSearch(
  input: NormalizedSearchInput,
  cwd: string,
  record: OperationRecord,
  runner: AstGrepRunner,
  onUpdate: AgentToolUpdateCallback<AstGrepSearchToolDetails> | undefined,
): Promise<AgentToolResult<AstGrepDetailsV1>> {
  throwIfCancelledOrExpired(record);
  const target = await resolveWorkspaceTarget(input.path, cwd, "file-or-directory");
  throwIfCancelledOrExpired(record);
  if (target.kind === "file" && input.globs.length > 0) {
    throw new Error("globs are only valid for directory searches; remove globs for an exact file.");
  }
  const progress = new ProgressReporter(onUpdate, record, "search", target.displayPath);
  const heap = new BoundedMaxHeap<SearchCandidate>(input.offset + input.limit + 1, compareCandidates);
  let totalMatches = 0;
  let totalOverflow = false;
  let source: Buffer | undefined;
  if (target.kind === "file") {
    progress.update("waiting-file", 0);
    source = await withFileMutationQueue(target.canonicalPath, async () => {
      throwIfCancelledOrExpired(record);
      return readBoundedFile(target, EXACT_SEARCH_BYTES, record);
    });
    throwIfCancelledOrExpired(record);
  }

  const validator = target.kind === "directory" ? new LosslessDirectoryValidator(target, record) : undefined;
  progress.update("waiting-native", 0);
  await runner.withSession(record, async (execution) => {
    if (target.kind === "directory") {
      await assertTargetStable(target);
      throwIfCancelledOrExpired(record);
    }
    await execution.run({
      mode: "search",
      cwd: target.canonicalWorkspace,
      language: input.language,
      pattern: input.pattern,
      strictness: input.strictness,
      ...(input.selector === undefined ? {} : { selector: input.selector }),
      ...(target.kind === "directory" ? { globs: input.globs, directoryScope: target.nativeRelativePath } : { stdin: source! }),
    }, async (match) => {
      throwIfCancelledOrExpired(record);
      let displayPath: string;
      if (source !== undefined) {
        verifyExactMatch(match, source, target.displayPath);
        displayPath = target.displayPath;
      } else {
        const validated = await validator!.validate(match.file);
        displayPath = validated.displayPath;
      }
      if (totalMatches === Number.MAX_SAFE_INTEGER) {
        totalOverflow = true;
      } else {
        totalMatches += 1;
      }
      const payloadSha256 = hashLogicalMatch(displayPath, match);
      const summary = normalizeMatchSummary(displayPath, match);
      heap.push({
        key: [
          displayPath,
          match.range.byteOffset.start,
          match.range.byteOffset.end,
          match.range.start.line,
          match.range.start.column,
          payloadSha256,
        ],
        summary,
      });
      progress.update("query", totalMatches);
    });
    if (target.kind === "directory") {
      await assertTargetStable(target);
    }
  });
  throwIfCancelledOrExpired(record);
  progress.update("formatting", totalMatches);
  const sorted = heap.toSortedArray();
  const page = sorted.slice(input.offset, input.offset + input.limit + 1).map((candidate) => candidate.summary);
  const result = formatSearchResult(input.language as SupportedLanguage, target.displayPath, input, totalMatches, totalOverflow, page);
  throwIfCancelledOrExpired(record);
  return result;
}
