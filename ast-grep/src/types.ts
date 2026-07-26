import type { SupportedLanguage } from "./languages.ts";

export const AST_GREP_VERSION = "0.45.0" as const;

export const STRICTNESSES = [
  "cst",
  "smart",
  "ast",
  "relaxed",
  "signature",
  "template",
] as const;

export type Strictness = (typeof STRICTNESSES)[number];

export interface ByteRange {
  start: number;
  end: number;
}

export interface SourcePosition {
  line: number;
  column: number;
}

export interface SourceRange {
  byteOffset: ByteRange;
  start: SourcePosition;
  end: SourcePosition;
}

export interface DecodedMetaNode {
  text: string;
  range: SourceRange;
}

export interface DecodedMetaVariable {
  category: "single" | "multi" | "transformed";
  name: string;
  text: string;
  range?: SourceRange;
  ordinal: number;
}

export interface DecodedMatch {
  text: string;
  file: string;
  lines: string;
  charCount: {
    leading: number;
    trailing: number;
  };
  language: string;
  range: SourceRange;
  metaVariables: readonly DecodedMetaVariable[];
  replacement?: string;
  replacementOffsets?: ByteRange;
}

export type RunnerMode = "search" | "error-guard" | "rewrite";

export interface AstMatchSummary {
  path: string;
  range: SourceRange;
  text: string;
  metaVariables: Array<{
    category: DecodedMetaVariable["category"];
    name: string;
    text: string;
    range?: SourceRange;
  }>;
}

export interface SearchCandidate {
  key: readonly [string, number, number, number, number, string];
  summary: AstMatchSummary;
}

export interface EditSummary {
  range: SourceRange;
  replacementRange: ByteRange;
  before: string;
  after: string;
}

export interface CanonicalEdit {
  range: SourceRange;
  replacementRange: ByteRange;
  before: Buffer;
  after: Buffer;
}

export interface EditPlan {
  path: string;
  canonicalPath: string;
  source: Buffer;
  output: Buffer;
  sourceSha256: string;
  outputSha256: string;
  previewId: string;
  edits: CanonicalEdit[];
  summaries: EditSummary[];
  mode: number;
}

export interface AstGrepDetailsV1 {
  version: 1;
  kind: "search";
  language: SupportedLanguage;
  scope: string;
  totalMatches: number;
  totalOverflow: boolean;
  offset: number;
  returnedMatches: number;
  nextOffset?: number;
  resultLimited: boolean;
  cliVersion: typeof AST_GREP_VERSION;
  matches: AstMatchSummary[];
}

export interface AstEditPreviewDetailsV1 {
  version: 1;
  kind: "edit-preview";
  path: string;
  replacements: number;
  previewId?: string;
  sourceSha256: string;
  cliVersion: typeof AST_GREP_VERSION;
  edits: EditSummary[];
}

export interface AstEditApplyDetailsV1 {
  version: 1;
  kind: "edit-apply";
  path: string;
  replacements: number;
  previewId: string;
  beforeSha256: string;
  afterSha256: string;
  cliVersion: typeof AST_GREP_VERSION;
}

export interface AstGrepProgressDetailsV1 {
  version: 1;
  kind: "progress";
  operation: "search" | "edit-preview" | "edit-apply";
  phase: "waiting-file" | "waiting-native" | "guard" | "query" | "formatting";
  scope: string;
  processedRecords: number;
}

export type AstGrepSearchToolDetails = AstGrepDetailsV1 | AstGrepProgressDetailsV1;
export type AstGrepEditToolDetails =
  | AstEditPreviewDetailsV1
  | AstEditApplyDetailsV1
  | AstGrepProgressDetailsV1;
