import { homedir } from "node:os";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { NormalizedSearchInput } from "./schema.ts";
import type {
  AstEditApplyDetailsV1,
  AstEditPreviewDetailsV1,
  AstGrepDetailsV1,
  AstGrepEditToolDetails,
  AstGrepProgressDetailsV1,
  AstGrepSearchToolDetails,
  AstMatchSummary,
  DecodedMatch,
  EditPlan,
  EditSummary,
} from "./types.ts";
import { AST_GREP_VERSION } from "./types.ts";
import type { SupportedLanguage } from "./languages.ts";
import type { OperationRecord } from "./operations.ts";
import { throwIfCancelledOrExpired } from "./operations.ts";

const CONTENT_BYTES = 48 * 1024;
const CONTENT_LINES = 1000;
const DETAILS_BYTES = 48 * 1024;
const SNIPPET_BYTES = 4 * 1024;
const SNIPPET_LINES = 40;
const META_ENTRIES = 32;
const META_BYTES = 4 * 1024;
const PROGRESS_BYTES = 1024;
const PROGRESS_LINES = 20;
const PATH_DISPLAY_BYTES = 32 * 1024;

interface CappedText {
  text: string;
  truncated: boolean;
}

function escapedCodePoint(character: string, preserveLayout: boolean): string {
  const code = character.codePointAt(0)!;
  if (code >= 0xd800 && code <= 0xdfff) {
    return `\\u{${code.toString(16)}}`;
  }
  if ((preserveLayout && (character === "\n" || character === "\t")) || (code >= 0x20 && code <= 0x7e)) {
    return character;
  }
  if (code >= 0xa0
    && code !== 0x200e
    && code !== 0x200f
    && code !== 0x061c
    && code !== 0x2028
    && code !== 0x2029
    && !(code >= 0x202a && code <= 0x202e)
    && !(code >= 0x2066 && code <= 0x2069)) {
    return character;
  }
  return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u{${code.toString(16)}}`;
}

function withoutLastCodePoint(value: string): string {
  const last = value.charCodeAt(value.length - 1);
  const previous = value.charCodeAt(value.length - 2);
  const units = last >= 0xdc00 && last <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff ? 2 : 1;
  return value.slice(0, -units);
}

function sanitizeWith(
  value: string,
  maxBytes: number,
  maxLines: number,
  escape: (character: string) => string,
): CappedText {
  let text = "";
  let bytes = 0;
  let lines = 1;
  let truncated = false;
  for (const character of value) {
    const escaped = escape(character);
    const nextLines = lines + (escaped === "\n" ? 1 : 0);
    const nextBytes = bytes + Buffer.byteLength(escaped);
    if (nextLines > maxLines || nextBytes > maxBytes) {
      truncated = true;
      break;
    }
    text += escaped;
    bytes = nextBytes;
    lines = nextLines;
  }
  if (truncated) {
    const marker = "…";
    if (Buffer.byteLength(marker) > maxBytes) {
      return { text: "", truncated: true };
    }
    while (text.length > 0 && Buffer.byteLength(text) + Buffer.byteLength(marker) > maxBytes) {
      text = withoutLastCodePoint(text);
    }
    text += marker;
  }
  return { text, truncated };
}

export function sanitizeAndCap(value: string, maxBytes: number, maxLines: number): CappedText {
  return sanitizeWith(value, maxBytes, maxLines, (character) => escapedCodePoint(character, true));
}

export function formatPathForDisplay(value: string, maxBytes: number): CappedText {
  const literal = JSON.stringify(value).replace(
    /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
    (character) => `\\u${character.codePointAt(0)!.toString(16).padStart(4, "0")}`,
  );
  return sanitizeWith(literal, maxBytes, 1, (character) => escapedCodePoint(character, false));
}

function exactPathForOutput(value: string): string {
  const display = formatPathForDisplay(value, PATH_DISPLAY_BYTES);
  if (display.truncated) {
    throw new Error("an ast-grep result path exceeds the lossless display budget; narrow the directory scope.");
  }
  return display.text;
}

function lineCount(value: string): number {
  let count = 1;
  for (const character of value) {
    if (character === "\n") {
      count += 1;
    }
  }
  return count;
}

function contentFits(value: string, bytes = CONTENT_BYTES, lines = CONTENT_LINES): boolean {
  return Buffer.byteLength(value) <= bytes && lineCount(value) <= lines;
}

function detailsFit(value: unknown): boolean {
  return Buffer.byteLength(JSON.stringify(value)) <= DETAILS_BYTES;
}

export function normalizeMatchSummary(path: string, match: DecodedMatch): AstMatchSummary {
  const text = sanitizeAndCap(match.text, SNIPPET_BYTES, SNIPPET_LINES).text;
  const metaVariables: AstMatchSummary["metaVariables"] = [];
  let metaBytes = 0;
  for (const variable of match.metaVariables) {
    if (metaVariables.length >= META_ENTRIES) {
      break;
    }
    const safeName = sanitizeAndCap(variable.name, 256, 1).text;
    const safeText = sanitizeAndCap(variable.text, 1024, 10).text;
    const projected = {
      category: variable.category,
      name: safeName,
      text: safeText,
      ...(variable.range === undefined ? {} : { range: variable.range }),
    };
    const nextBytes = metaBytes + Buffer.byteLength(JSON.stringify(projected));
    if (nextBytes > META_BYTES) {
      break;
    }
    metaVariables.push(projected);
    metaBytes = nextBytes;
  }
  return {
    path,
    range: match.range,
    text,
    metaVariables,
  };
}

function renderSearchItem(match: AstMatchSummary): string {
  const path = exactPathForOutput(match.path);
  const startLine = match.range.start.line + 1;
  const startColumn = match.range.start.column + 1;
  const endLine = match.range.end.line + 1;
  const endColumn = match.range.end.column + 1;
  const text = match.text.replace(/\n/gu, "\n  ");
  const meta = match.metaVariables
    .map((variable) => `  ${variable.category}:${variable.name}=${variable.text.replace(/\n/gu, "\\n")}`)
    .join("\n");
  return `${path}\n${startLine}:${startColumn}-${endLine}:${endColumn}  ${text}${meta ? `\n${meta}` : ""}`;
}

export function formatSearchResult(
  language: SupportedLanguage,
  scope: string,
  input: NormalizedSearchInput,
  totalMatches: number,
  totalOverflow: boolean,
  pageMatches: readonly AstMatchSummary[],
): AgentToolResult<AstGrepDetailsV1> {
  const safeScope = exactPathForOutput(scope);
  if (totalMatches === 0 && !totalOverflow) {
    const details: AstGrepDetailsV1 = {
      version: 1,
      kind: "search",
      language,
      scope,
      totalMatches: 0,
      totalOverflow: false,
      offset: input.offset,
      returnedMatches: 0,
      resultLimited: false,
      cliVersion: AST_GREP_VERSION,
      matches: [],
    };
    return {
      content: [{ type: "text", text: `No structural matches in ${safeScope} (${language}). Pattern execution succeeded; this does not prove every source file is parse-valid.` }],
      details,
    };
  }

  let shown: AstMatchSummary[] = [];
  let finalContent = "";
  let finalDetails: AstGrepDetailsV1 | undefined;
  const candidates = pageMatches.slice(0, input.limit);
  for (let count = 0; count <= candidates.length; count += 1) {
    const proposed = candidates.slice(0, count);
    const resultLimited = totalOverflow || totalMatches > input.offset + proposed.length;
    const nextOffset = resultLimited && proposed.length > 0 ? input.offset + proposed.length : undefined;
    const totalLabel = totalOverflow ? `at least ${totalMatches}` : String(totalMatches);
    const rangeLabel = proposed.length === 0
      ? `no results shown at offset ${input.offset}`
      : `showing ${input.offset + 1}-${input.offset + proposed.length}`;
    const header = `${totalLabel} matches; ${rangeLabel} in ${safeScope} (${language})`;
    const footer = nextOffset === undefined
      ? ""
      : `\n\nMore results: call ast_grep_search with offset ${nextOffset}. Pagination is not snapshot-isolated.`;
    const content = `${header}${proposed.length === 0 ? "" : `\n\n${proposed.map(renderSearchItem).join("\n\n")}`}${footer}`;
    const details: AstGrepDetailsV1 = {
      version: 1,
      kind: "search",
      language,
      scope,
      totalMatches,
      totalOverflow,
      offset: input.offset,
      returnedMatches: proposed.length,
      ...(nextOffset === undefined ? {} : { nextOffset }),
      resultLimited,
      cliVersion: AST_GREP_VERSION,
      matches: proposed,
    };
    if (!contentFits(content) || !detailsFit(details)) {
      break;
    }
    shown = proposed;
    finalContent = content;
    finalDetails = details;
  }
  if (finalDetails === undefined || (pageMatches.length > 0 && shown.length === 0)) {
    throw new Error("ast-grep output contract cannot fit even one complete match; narrow the path or pattern.");
  }
  return { content: [{ type: "text", text: finalContent }], details: finalDetails };
}

export function formatPreviewResult(plan: EditPlan): AgentToolResult<AstEditPreviewDetailsV1> {
  const sanitizedEdits = plan.summaries.map((edit) => {
    const before = sanitizeAndCap(edit.before, 32 * 1024, CONTENT_LINES);
    const after = sanitizeAndCap(edit.after, 32 * 1024, CONTENT_LINES);
    return {
      summary: {
        range: edit.range,
        replacementRange: edit.replacementRange,
        before: before.text,
        after: after.text,
      },
      truncated: before.truncated || after.truncated,
    };
  });
  const safeEdits: EditSummary[] = sanitizedEdits.map((edit) => edit.summary);
  const safePath = exactPathForOutput(plan.path);
  const details: AstEditPreviewDetailsV1 = {
    version: 1,
    kind: "edit-preview",
    path: plan.path,
    replacements: safeEdits.length,
    ...(safeEdits.length === 0 ? {} : { previewId: plan.previewId }),
    sourceSha256: plan.sourceSha256,
    cliVersion: AST_GREP_VERSION,
    edits: safeEdits,
  };
  const content = safeEdits.length === 0
    ? `No structural changes for ${safePath}; no previewId was issued.`
    : [
        `Preview ready: ${safeEdits.length} replacement${safeEdits.length === 1 ? "" : "s"} in ${safePath}`,
        `previewId: ${plan.previewId}`,
        ...safeEdits.map((edit) => {
          const location = `${edit.range.start.line + 1}:${edit.range.start.column + 1}-${edit.range.end.line + 1}:${edit.range.end.column + 1}`;
          const before = edit.before.split("\n").map((line) => `- ${line}`).join("\n");
          const after = edit.after.split("\n").map((line) => `+ ${line}`).join("\n");
          return `${location}\n${before}\n${after}`;
        }),
        `Apply with action="apply", the same semantic arguments, and this previewId; timeout may differ.`,
      ].join("\n\n");
  if (!contentFits(content) || !detailsFit(details)
    || sanitizedEdits.some((edit) => edit.truncated)) {
    throw new Error("complete ast-grep preview exceeds the output budget; narrow the pattern before retrying.");
  }
  return { content: [{ type: "text", text: content }], details };
}

export function formatApplyResult(plan: EditPlan, previewId: string): AgentToolResult<AstEditApplyDetailsV1> {
  const safePath = exactPathForOutput(plan.path);
  const details: AstEditApplyDetailsV1 = {
    version: 1,
    kind: "edit-apply",
    path: plan.path,
    replacements: plan.edits.length,
    previewId,
    beforeSha256: plan.sourceSha256,
    afterSha256: plan.outputSha256,
    cliVersion: AST_GREP_VERSION,
  };
  const content = `Applied ${plan.edits.length} structural replacement${plan.edits.length === 1 ? "" : "s"} to ${safePath}.\nbefore sha256: ${plan.sourceSha256}\nafter sha256: ${plan.outputSha256}`;
  if (!contentFits(content) || !detailsFit(details)) {
    throw new Error("ast-grep apply result exceeded its bounded output contract after commit.");
  }
  return { content: [{ type: "text", text: content }], details };
}

export class ProgressReporter<T extends AstGrepSearchToolDetails | AstGrepEditToolDetails> {
  readonly #callback: AgentToolUpdateCallback<T> | undefined;
  readonly #record: OperationRecord;
  readonly #operation: AstGrepProgressDetailsV1["operation"];
  readonly #scope: string;
  #lastAt = Number.NEGATIVE_INFINITY;
  #lastPhase?: AstGrepProgressDetailsV1["phase"];
  #lastCount = -1;

  constructor(
    callback: AgentToolUpdateCallback<T> | undefined,
    record: OperationRecord,
    operation: AstGrepProgressDetailsV1["operation"],
    scope: string,
  ) {
    this.#callback = callback;
    this.#record = record;
    this.#operation = operation;
    this.#scope = formatPathForDisplay(scope, 512).text;
  }

  update(phase: AstGrepProgressDetailsV1["phase"], processedRecords: number): void {
    if (this.#callback === undefined || (phase === this.#lastPhase && processedRecords === this.#lastCount)) {
      return;
    }
    throwIfCancelledOrExpired(this.#record);
    const now = this.#record.now();
    if (now - this.#lastAt < 500) {
      return;
    }
    const details: AstGrepProgressDetailsV1 = {
      version: 1,
      kind: "progress",
      operation: this.#operation,
      phase,
      scope: this.#scope,
      processedRecords: Number.isSafeInteger(processedRecords) ? processedRecords : Number.MAX_SAFE_INTEGER,
    };
    const text = `${this.#operation}: ${phase} (${details.processedRecords} records) in ${this.#scope}`;
    if (!contentFits(text, PROGRESS_BYTES, PROGRESS_LINES) || Buffer.byteLength(JSON.stringify(details)) > PROGRESS_BYTES) {
      throw new Error("internal ast-grep progress projection exceeded its fixed budget.");
    }
    this.#callback({ content: [{ type: "text", text }], details: details as T });
    this.#lastAt = now;
    this.#lastPhase = phase;
    this.#lastCount = processedRecords;
  }
}

export function boundedToolError(error: unknown, secrets: readonly string[] = []): Error {
  let message = error instanceof Error ? error.message : String(error);
  const replacements = [...secrets, homedir()].filter((value) => value.length > 0);
  for (const secret of replacements) {
    message = message.split(secret).join(secret === homedir() ? "<home>" : "<workspace>");
  }
  const safe = sanitizeAndCap(message, 24 * 1024, 200);
  return new Error(safe.truncated ? `${safe.text}\n[diagnostic truncated]` : safe.text);
}
