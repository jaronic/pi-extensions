import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { SUPPORTED_LANGUAGES } from "./languages.ts";
import { STRICTNESSES, type Strictness } from "./types.ts";

export const MAX_PATTERN_BYTES = 4 * 1024;
export const MAX_REWRITE_BYTES = 8 * 1024;
export const MAX_SELECTOR_BYTES = 256;
export const MAX_PATH_CHARS = 4096;
export const MAX_GLOBS = 16;
export const MAX_GLOB_CHARS = 256;
export const MAX_TIMEOUT_MS = 120_000;
export const MAX_SEARCH_LIMIT = 50;
export const MAX_SEARCH_OFFSET = 1000;
export const MAX_REPLACEMENTS = 50;
export const MAX_RETAINED_MATCHES = 1051;

export const SearchParameters = Type.Object(
  {
    pattern: Type.String({ description: "ast-grep structural pattern" }),
    language: StringEnum(SUPPORTED_LANGUAGES),
    path: Type.Optional(Type.String({ description: "Existing file or directory; defaults to ." })),
    globs: Type.Optional(Type.Array(Type.String(), { maxItems: MAX_GLOBS })),
    selector: Type.Optional(Type.String()),
    strictness: Type.Optional(StringEnum(STRICTNESSES)),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_LIMIT })),
    offset: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_SEARCH_OFFSET })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: MAX_TIMEOUT_MS })),
  },
  { additionalProperties: false },
);

export const EditParameters = Type.Object(
  {
    action: StringEnum(["preview", "apply"] as const),
    path: Type.String({ description: "Existing regular file inside the workspace" }),
    language: StringEnum(SUPPORTED_LANGUAGES),
    pattern: Type.String(),
    rewrite: Type.String({ description: "Replacement pattern; empty string deletes matches" }),
    selector: Type.Optional(Type.String()),
    strictness: Type.Optional(StringEnum(STRICTNESSES)),
    maxReplacements: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_REPLACEMENTS })),
    timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, maximum: MAX_TIMEOUT_MS })),
    previewId: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

export type SearchInput = Static<typeof SearchParameters>;
export type EditInput = Static<typeof EditParameters>;

export interface NormalizedSearchInput extends Omit<SearchInput, "path" | "globs" | "selector" | "strictness" | "limit" | "offset" | "timeoutMs"> {
  path: string;
  globs: readonly string[];
  selector?: string;
  strictness: Strictness;
  limit: number;
  offset: number;
  timeoutMs: number;
}

export interface NormalizedEditInput extends Omit<EditInput, "selector" | "strictness" | "maxReplacements" | "timeoutMs" | "previewId"> {
  selector?: string;
  strictness: Strictness;
  maxReplacements: number;
  timeoutMs: number;
  previewId?: string;
}

function validateText(value: string, field: string, byteLimit: number, allowEmpty: boolean): void {
  if (!value.isWellFormed()) {
    throw new Error(`${field} must be well-formed Unicode.`);
  }
  if (value.includes("\0")) {
    throw new Error(`${field} must not contain NUL.`);
  }
  if (!allowEmpty && value.trim().length === 0) {
    throw new Error(`${field} must not be empty.`);
  }
  if (Buffer.byteLength(value, "utf8") > byteLimit) {
    throw new Error(`${field} exceeds the ${byteLimit}-byte limit.`);
  }
}

function validatePathInput(value: string, field: string): void {
  validateText(value, field, MAX_PATH_CHARS * 4, false);
  if (value.length > MAX_PATH_CHARS) {
    throw new Error(`${field} exceeds the ${MAX_PATH_CHARS}-character limit.`);
  }
  if (/^~(?:[\\/]|$)/u.test(value)) {
    throw new Error(`${field} does not expand '~'; provide a workspace path.`);
  }
  if (/^[A-Za-z][A-Za-z\d+.-]*:\/\//u.test(value)) {
    throw new Error(`${field} must be a filesystem path, not a URL.`);
  }
}

export function normalizeSearchInput(input: SearchInput): NormalizedSearchInput {
  validateText(input.pattern, "pattern", MAX_PATTERN_BYTES, false);
  const path = input.path ?? ".";
  validatePathInput(path, "path");
  if (input.selector !== undefined) {
    validateText(input.selector, "selector", MAX_SELECTOR_BYTES, false);
  }
  const globs = input.globs ?? [];
  if (globs.length > MAX_GLOBS) {
    throw new Error(`globs contains more than ${MAX_GLOBS} entries.`);
  }
  for (const [index, glob] of globs.entries()) {
    validateText(glob, `globs[${index}]`, MAX_GLOB_CHARS * 4, false);
    if (glob.length > MAX_GLOB_CHARS) {
      throw new Error(`globs[${index}] exceeds the ${MAX_GLOB_CHARS}-character limit.`);
    }
  }
  const limit = input.limit ?? 20;
  const offset = input.offset ?? 0;
  if (offset + limit + 1 > MAX_RETAINED_MATCHES) {
    throw new Error(`offset + limit + 1 must not exceed ${MAX_RETAINED_MATCHES}.`);
  }
  return {
    ...input,
    path,
    globs: [...globs],
    strictness: input.strictness ?? "smart",
    limit,
    offset,
    timeoutMs: input.timeoutMs ?? 30_000,
  };
}

export function normalizeEditInput(input: EditInput): NormalizedEditInput {
  validatePathInput(input.path, "path");
  validateText(input.pattern, "pattern", MAX_PATTERN_BYTES, false);
  validateText(input.rewrite, "rewrite", MAX_REWRITE_BYTES, true);
  if (input.selector !== undefined) {
    validateText(input.selector, "selector", MAX_SELECTOR_BYTES, false);
  }
  if (input.action === "preview" && input.previewId !== undefined) {
    throw new Error("preview must not include previewId; preview returns a new ID when changes exist.");
  }
  if (input.action === "apply" && !/^[a-f0-9]{64}$/u.test(input.previewId ?? "")) {
    throw new Error("apply requires previewId as exactly 64 lower-case hexadecimal characters.");
  }
  return {
    ...input,
    strictness: input.strictness ?? "smart",
    maxReplacements: input.maxReplacements ?? 20,
    timeoutMs: input.timeoutMs ?? 20_000,
  };
}
