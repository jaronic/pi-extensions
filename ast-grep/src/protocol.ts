import { cliLanguageName, type SupportedLanguage } from "./languages.ts";
import type {
  ByteRange,
  DecodedMatch,
  DecodedMetaVariable,
  RunnerMode,
  SourcePosition,
  SourceRange,
} from "./types.ts";

const MAX_PROTOCOL_STRING_BYTES = 1024 * 1024;
const MAX_META_NAME_BYTES = 256;
const MAX_META_ENTRIES = 4096;


function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeString(value: unknown, field: string, byteLimit = MAX_PROTOCOL_STRING_BYTES): string {
  if (typeof value !== "string" || !value.isWellFormed() || value.includes("\0")) {
    throw new Error(`incompatible/corrupt ast-grep output: ${field} must be a well-formed NUL-free string.`);
  }
  if (Buffer.byteLength(value) > byteLimit) {
    throw new Error(`incompatible/corrupt ast-grep output: ${field} exceeds its byte limit.`);
  }
  return value;
}

function decodeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`incompatible/corrupt ast-grep output: ${field} must be a non-negative safe integer.`);
  }
  return value as number;
}

function decodeByteRange(value: unknown, field: string): ByteRange {
  if (!isObject(value)) {
    throw new Error(`incompatible/corrupt ast-grep output: ${field} must be an object.`);
  }
  const start = decodeInteger(value.start, `${field}.start`);
  const end = decodeInteger(value.end, `${field}.end`);
  if (start > end) {
    throw new Error(`incompatible/corrupt ast-grep output: ${field} is reversed.`);
  }
  return { start, end };
}

function decodePosition(value: unknown, field: string): SourcePosition {
  if (!isObject(value)) {
    throw new Error(`incompatible/corrupt ast-grep output: ${field} must be an object.`);
  }
  return {
    line: decodeInteger(value.line, `${field}.line`),
    column: decodeInteger(value.column, `${field}.column`),
  };
}

function decodeRange(value: unknown, field: string): SourceRange {
  if (!isObject(value)) {
    throw new Error(`incompatible/corrupt ast-grep output: ${field} must be an object.`);
  }
  return {
    byteOffset: decodeByteRange(value.byteOffset, `${field}.byteOffset`),
    start: decodePosition(value.start, `${field}.start`),
    end: decodePosition(value.end, `${field}.end`),
  };
}

function decodeMetaNode(value: unknown, field: string): { text: string; range: SourceRange } {
  if (!isObject(value)) {
    throw new Error(`incompatible/corrupt ast-grep output: ${field} must be an object.`);
  }
  return {
    text: decodeString(value.text, `${field}.text`),
    range: decodeRange(value.range, `${field}.range`),
  };
}

function decodeMetaVariables(value: unknown): readonly DecodedMetaVariable[] {
  if (value === undefined) {
    return Object.freeze([]);
  }
  if (!isObject(value) || !isObject(value.single) || !isObject(value.multi) || !isObject(value.transformed)) {
    throw new Error("incompatible/corrupt ast-grep output: metaVariables has an invalid shape.");
  }
  const decoded: DecodedMetaVariable[] = [];
  const assertCapacity = () => {
    if (decoded.length >= MAX_META_ENTRIES) {
      throw new Error(`incompatible/corrupt ast-grep output: more than ${MAX_META_ENTRIES} metavariable entries.`);
    }
  };
  for (const name in value.single) {
    if (!Object.hasOwn(value.single, name)) continue;
    assertCapacity();
    const safeName = decodeString(name, "metaVariables.single key", MAX_META_NAME_BYTES);
    const node = decodeMetaNode(value.single[name], `metaVariables.single.${safeName}`);
    decoded.push({ category: "single", name: safeName, text: node.text, range: node.range, ordinal: 0 });
  }
  for (const name in value.multi) {
    if (!Object.hasOwn(value.multi, name)) continue;
    const safeName = decodeString(name, "metaVariables.multi key", MAX_META_NAME_BYTES);
    const nodesValue = value.multi[name];
    if (!Array.isArray(nodesValue)) {
      throw new Error(`incompatible/corrupt ast-grep output: metaVariables.multi.${safeName} must be an array.`);
    }
    for (const [ordinal, nodeValue] of nodesValue.entries()) {
      assertCapacity();
      const node = decodeMetaNode(nodeValue, `metaVariables.multi.${safeName}[${ordinal}]`);
      decoded.push({ category: "multi", name: safeName, text: node.text, range: node.range, ordinal });
    }
  }
  for (const name in value.transformed) {
    if (!Object.hasOwn(value.transformed, name)) continue;
    assertCapacity();
    const safeName = decodeString(name, "metaVariables.transformed key", MAX_META_NAME_BYTES);
    decoded.push({
      category: "transformed",
      name: safeName,
      text: decodeString(value.transformed[name], `metaVariables.transformed.${safeName}`),
      ordinal: 0,
    });
  }
  const categoryOrder: Record<DecodedMetaVariable["category"], number> = {
    single: 0,
    multi: 1,
    transformed: 2,
  };
  decoded.sort((left, right) => categoryOrder[left.category] - categoryOrder[right.category]
    || left.name.localeCompare(right.name, "en")
    || left.ordinal - right.ordinal
    || (left.range?.byteOffset.start ?? 0) - (right.range?.byteOffset.start ?? 0)
    || (left.range?.byteOffset.end ?? 0) - (right.range?.byteOffset.end ?? 0));
  return Object.freeze(decoded.map((entry) => Object.freeze(entry)));
}

export function decodeMatch(value: unknown, mode: RunnerMode, language: SupportedLanguage): DecodedMatch {
  if (!isObject(value)) {
    throw new Error("incompatible/corrupt ast-grep output: each NDJSON line must be an object.");
  }
  if (!isObject(value.charCount)) {
    throw new Error("incompatible/corrupt ast-grep output: charCount must be an object.");
  }
  const decoded: DecodedMatch = {
    text: decodeString(value.text, "text"),
    file: decodeString(value.file, "file", 16 * 1024),
    lines: decodeString(value.lines, "lines"),
    charCount: {
      leading: decodeInteger(value.charCount.leading, "charCount.leading"),
      trailing: decodeInteger(value.charCount.trailing, "charCount.trailing"),
    },
    language: decodeString(value.language, "language", 64),
    range: decodeRange(value.range, "range"),
    metaVariables: decodeMetaVariables(value.metaVariables),
  };
  if (decoded.language !== cliLanguageName(language)) {
    throw new Error(`incompatible/corrupt ast-grep output: expected language ${cliLanguageName(language)}.`);
  }
  if (mode === "rewrite") {
    decoded.replacement = decodeString(value.replacement, "replacement");
    decoded.replacementOffsets = decodeByteRange(value.replacementOffsets, "replacementOffsets");
  } else if (value.replacement !== undefined || value.replacementOffsets !== undefined) {
    throw new Error("incompatible/corrupt ast-grep output: replacement fields appeared in a read-only result.");
  }
  return Object.freeze(decoded);
}
