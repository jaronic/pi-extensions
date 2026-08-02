import { Text } from "@earendil-works/pi-tui";
import { tone } from "pi-uikit-dev";
import type {
  AgentToolResult,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { EditInput, SearchInput } from "./schema.ts";
import type {
  AstEditApplyDetailsV1,
  AstEditPreviewDetailsV1,
  AstGrepDetailsV1,
  AstGrepEditToolDetails,
  AstGrepProgressDetailsV1,
  AstGrepSearchToolDetails,
  SourceRange,
} from "./types.ts";
import { formatPathForDisplay, sanitizeAndCap } from "./output.ts";

interface RenderErrorContext {
  isError: boolean;
}

const PROGRESS_OPERATIONS = new Set(["search", "edit-preview", "edit-apply"]);
const PROGRESS_PHASES = new Set(["waiting-file", "waiting-native", "guard", "query", "formatting"]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isPosition(value: unknown): boolean {
  return isObject(value) && isCount(value.line) && isCount(value.column);
}

function isRange(value: unknown): value is SourceRange {
  return isObject(value)
    && isObject(value.byteOffset)
    && isCount(value.byteOffset.start)
    && isCount(value.byteOffset.end)
    && value.byteOffset.start <= value.byteOffset.end
    && isPosition(value.start)
    && isPosition(value.end);
}

function isProgress(value: unknown): value is AstGrepProgressDetailsV1 {
  return isObject(value)
    && value.version === 1
    && value.kind === "progress"
    && typeof value.operation === "string"
    && PROGRESS_OPERATIONS.has(value.operation)
    && typeof value.phase === "string"
    && PROGRESS_PHASES.has(value.phase)
    && typeof value.scope === "string"
    && isCount(value.processedRecords);
}

function isSearchDetails(value: unknown): value is AstGrepDetailsV1 {
  return isObject(value)
    && value.version === 1
    && value.kind === "search"
    && isCount(value.totalMatches)
    && typeof value.totalOverflow === "boolean"
    && isCount(value.returnedMatches)
    && typeof value.resultLimited === "boolean"
    && Array.isArray(value.matches)
    && value.matches.length <= 50
    && value.returnedMatches === value.matches.length
    && value.matches.every((match) => isObject(match)
      && typeof match.path === "string"
      && typeof match.text === "string"
      && isRange(match.range));
}

function isApplyDetails(value: unknown): value is AstEditApplyDetailsV1 {
  return isObject(value)
    && value.version === 1
    && value.kind === "edit-apply"
    && typeof value.path === "string"
    && isCount(value.replacements)
    && value.replacements > 0;
}

function isPreviewDetails(value: unknown): value is AstEditPreviewDetailsV1 {
  return isObject(value)
    && value.version === 1
    && value.kind === "edit-preview"
    && typeof value.path === "string"
    && isCount(value.replacements)
    && Array.isArray(value.edits)
    && value.edits.length <= 50
    && value.replacements === value.edits.length
    && value.edits.every((edit) => isObject(edit)
      && isRange(edit.range)
      && typeof edit.before === "string"
      && typeof edit.after === "string");
}

function fallbackText(result: AgentToolResult<unknown>, isError: boolean, theme: Theme): Text {
  const first = result.content.find((item) => item.type === "text");
  const text = first?.type === "text" ? sanitizeAndCap(first.text, 4096, 40).text : "ast-grep returned no displayable text.";
  return new Text(tone(theme, isError ? "error" : "output", text), 0, 0);
}

export function renderSearchCall(args: SearchInput, theme: Theme): Text {
  const scope = formatPathForDisplay(args.path ?? ".", 256).text;
  const pattern = sanitizeAndCap(args.pattern ?? "", 256, 1).text;
  return new Text(
    `${tone(theme, "title", "ast_grep_search", { bold: false })} ${tone(theme, "accent", args.language ?? "?")} ${tone(theme, "muted", scope)}\n${tone(theme, "output", pattern)}`,
    0,
    0,
  );
}

export function renderEditCall(args: EditInput, theme: Theme): Text {
  const path = formatPathForDisplay(args.path ?? "", 256).text;
  const action = args.action === "apply" ? tone(theme, "warning", "apply") : tone(theme, "accent", "preview");
  return new Text(`${tone(theme, "title", "ast_grep_edit", { bold: false })} ${action} ${tone(theme, "muted", path)}`, 0, 0);
}

export function renderSearchResult(
  result: AgentToolResult<AstGrepSearchToolDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: RenderErrorContext,
): Text {
  const details: unknown = result.details;
  if (isProgress(details)) {
    const scope = sanitizeAndCap(details.scope, 512, 1).text;
    return new Text(tone(theme, "muted", `${details.phase}: ${details.processedRecords} records in ${scope}`), 0, 0);
  }
  if (!isSearchDetails(details)) {
    return fallbackText(result, context.isError, theme);
  }
  const title = `${details.totalOverflow ? "≥" : ""}${details.totalMatches} matches; ${details.returnedMatches} shown`;
  if (!options.expanded || details.matches.length === 0) {
    return new Text(tone(theme, details.resultLimited ? "warning" : "success", title), 0, 0);
  }
  const rows = details.matches.map((match) => {
    const location = `${match.range.start.line + 1}:${match.range.start.column + 1}`;
    const path = formatPathForDisplay(match.path, 512).text;
    const text = sanitizeAndCap(match.text, 4096, 40).text;
    return `${tone(theme, "accent", path)} ${tone(theme, "muted", location)}\n${tone(theme, "output", text)}`;
  });
  return new Text(`${tone(theme, "success", title)}\n${rows.join("\n")}`, 0, 0);
}

export function renderEditResult(
  result: AgentToolResult<AstGrepEditToolDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: RenderErrorContext,
): Text {
  const details: unknown = result.details;
  if (isProgress(details)) {
    const scope = sanitizeAndCap(details.scope, 512, 1).text;
    return new Text(tone(theme, "muted", `${details.phase}: ${details.processedRecords} records in ${scope}`), 0, 0);
  }
  if (isApplyDetails(details)) {
    const path = formatPathForDisplay(details.path, 512).text;
    return new Text(tone(theme, "success", `Applied ${details.replacements} replacements to ${path}`), 0, 0);
  }
  if (!isPreviewDetails(details)) {
    return fallbackText(result, context.isError, theme);
  }
  const path = formatPathForDisplay(details.path, 512).text;
  const title = details.replacements === 0
    ? `No changes in ${path}`
    : `Preview: ${details.replacements} replacements in ${path}`;
  if (!options.expanded || details.edits.length === 0) {
    return new Text(tone(theme, details.replacements === 0 ? "muted" : "warning", title), 0, 0);
  }
  const edits = details.edits.map((edit) => {
    const location = `${edit.range.start.line + 1}:${edit.range.start.column + 1}`;
    const before = sanitizeAndCap(edit.before, 4096, 40).text;
    const after = sanitizeAndCap(edit.after, 4096, 40).text;
    return `${tone(theme, "muted", location)}\n${tone(theme, "diffRemoved", `- ${before}`)}\n${tone(theme, "diffAdded", `+ ${after}`)}`;
  });
  return new Text(`${tone(theme, "warning", title)}\n${edits.join("\n")}`, 0, 0);
}
