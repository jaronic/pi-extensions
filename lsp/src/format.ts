import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DiagnosticSeverity,
  type CodeAction,
  type Command,
  type Diagnostic,
  type DocumentSymbol,
  type Hover,
  type Location,
  type LocationLink,
  type MarkedString,
  type MarkupContent,
  type SymbolInformation,
  type WorkspaceEdit,
  type WorkspaceSymbol,
} from "vscode-languageserver-protocol";
import type { DiagnosticResult } from "./server-manager.ts";
import { isWithin } from "./roots.ts";

export type SeverityFilter = "all" | "error" | "warning" | "info" | "hint";

const SEVERITY_LIMIT: Record<SeverityFilter, number> = {
  all: DiagnosticSeverity.Hint,
  error: DiagnosticSeverity.Error,
  warning: DiagnosticSeverity.Warning,
  info: DiagnosticSeverity.Information,
  hint: DiagnosticSeverity.Hint,
};

const SEVERITY_NAME: Record<number, string> = {
  [DiagnosticSeverity.Error]: "error",
  [DiagnosticSeverity.Warning]: "warning",
  [DiagnosticSeverity.Information]: "info",
  [DiagnosticSeverity.Hint]: "hint",
};

const SYMBOL_KIND = [
  "", "file", "module", "namespace", "package", "class", "method", "property", "field", "constructor",
  "enum", "interface", "function", "variable", "constant", "string", "number", "boolean", "array", "object",
  "key", "null", "enum-member", "struct", "event", "operator", "type-parameter",
];

export function formatDiagnostics(
  file: string,
  results: DiagnosticResult[],
  cwd: string,
  maxResults: number,
  severity: SeverityFilter,
): string {
  const lines: string[] = [];
  let shown = 0;
  let hidden = 0;
  const threshold = SEVERITY_LIMIT[severity];
  for (const result of results) {
    if (result.error) {
      lines.push(`[${result.server}] ERROR ${singleLine(result.error)}`);
      continue;
    }
    for (const diagnostic of result.diagnostics ?? []) {
      if ((diagnostic.severity ?? DiagnosticSeverity.Error) > threshold) continue;
      if (shown >= maxResults) {
        hidden += 1;
        continue;
      }
      const position = `${displayPath(file, cwd)}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}`;
      const level = SEVERITY_NAME[diagnostic.severity ?? DiagnosticSeverity.Error] ?? "error";
      const source = diagnostic.source ? ` ${diagnostic.source}` : "";
      const code = diagnostic.code === undefined ? "" : `(${String(diagnostic.code)})`;
      const message = typeof diagnostic.message === "string" ? diagnostic.message : diagnostic.message.value;
      lines.push(`[${result.server}] ${position} ${level}${source}${code}: ${singleLine(message)}`);
      shown += 1;
    }
  }
  if (hidden > 0) lines.push(`… ${hidden} more diagnostic(s) omitted`);
  if (lines.length === 0) return "No diagnostics.";
  return lines.join("\n");
}

export function formatLocations(value: unknown, cwd: string, maxResults: number): string {
  const locations = normalizeArray(value).filter(isLocationLike);
  if (locations.length === 0) return "No locations.";
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const location of locations) {
    const uri = "targetUri" in location ? location.targetUri : location.uri;
    const range = "targetSelectionRange" in location ? location.targetSelectionRange : location.range;
    const line = `${displayUri(uri, cwd)}:${range.start.line + 1}:${range.start.character + 1}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
    if (lines.length >= maxResults) break;
  }
  if (locations.length > lines.length) lines.push(`… ${locations.length - lines.length} more location(s) omitted`);
  return lines.join("\n");
}

export function formatHover(hover: Hover | null): string {
  if (!hover) return "No hover information.";
  const contents = Array.isArray(hover.contents) ? hover.contents : [hover.contents];
  const text = contents.map(formatMarkedContent).filter(Boolean).join("\n\n");
  return text || "No hover information.";
}

export function formatDocumentSymbols(value: unknown, cwd: string, maxResults: number): string {
  const symbols = normalizeArray(value) as Array<DocumentSymbol | SymbolInformation>;
  if (symbols.length === 0) return "No symbols.";
  const lines: string[] = [];
  for (const symbol of symbols) appendSymbol(symbol, 0, lines, cwd, maxResults);
  if (lines.length >= maxResults) lines.push("… additional symbols omitted");
  return lines.slice(0, maxResults + 1).join("\n");
}

export function formatWorkspaceSymbols(value: unknown, cwd: string, maxResults: number): string {
  const symbols = normalizeArray(value) as Array<WorkspaceSymbol | SymbolInformation>;
  if (symbols.length === 0) return "No workspace symbols.";
  const lines: string[] = [];
  for (const symbol of symbols.slice(0, maxResults)) {
    const location = symbol.location;
    const uri = location.uri;
    const suffix = "range" in location ? `:${location.range.start.line + 1}:${location.range.start.character + 1}` : "";
    lines.push(`${symbol.name} [${kindName(symbol.kind)}] ${displayUri(uri, cwd)}${suffix}`);
  }
  if (symbols.length > maxResults) lines.push(`… ${symbols.length - maxResults} more symbol(s) omitted`);
  return lines.join("\n");
}

export function formatWorkspaceEdit(edit: WorkspaceEdit | null, cwd: string, maxResults: number): string {
  if (!edit) return "No workspace edit.";
  const lines: string[] = [];
  for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
    for (const textEdit of edits) {
      lines.push(formatTextEdit(uri, textEdit.range.start.line, textEdit.range.start.character, textEdit.range.end.line, textEdit.range.end.character, textEdit.newText, cwd));
      if (lines.length >= maxResults) return finishLimited(lines);
    }
  }
  for (const change of edit.documentChanges ?? []) {
    if ("textDocument" in change) {
      for (const textEdit of change.edits) {
        const replacement = "newText" in textEdit ? textEdit.newText : textEdit.snippet.value;
        lines.push(formatTextEdit(change.textDocument.uri, textEdit.range.start.line, textEdit.range.start.character, textEdit.range.end.line, textEdit.range.end.character, replacement, cwd));
        if (lines.length >= maxResults) return finishLimited(lines);
      }
      continue;
    }
    if (change.kind === "create") lines.push(`create ${displayUri(change.uri, cwd)}`);
    else if (change.kind === "rename") lines.push(`rename ${displayUri(change.oldUri, cwd)} -> ${displayUri(change.newUri, cwd)}`);
    else if (change.kind === "delete") lines.push(`delete ${displayUri(change.uri, cwd)}`);
    if (lines.length >= maxResults) return finishLimited(lines);
  }
  return lines.length > 0 ? lines.join("\n") : "No workspace edit.";
}

export function formatCodeActions(value: unknown, cwd: string, maxResults: number): string {
  const actions = normalizeArray(value) as Array<CodeAction | Command>;
  if (actions.length === 0) return "No code actions.";
  const lines: string[] = [];
  for (const [index, action] of actions.slice(0, maxResults).entries()) {
    const details: string[] = [];
    if ("kind" in action && action.kind) details.push(action.kind);
    if ("isPreferred" in action && action.isPreferred) details.push("preferred");
    if ("disabled" in action && action.disabled) details.push(`disabled: ${action.disabled.reason}`);
    lines.push(`${index + 1}. ${action.title}${details.length > 0 ? ` [${details.join(", ")}]` : ""}`);
    if ("edit" in action && action.edit) {
      for (const editLine of formatWorkspaceEdit(action.edit, cwd, 10).split("\n")) lines.push(`   ${editLine}`);
    }
  }
  if (actions.length > maxResults) lines.push(`… ${actions.length - maxResults} more action(s) omitted`);
  return lines.join("\n");
}

function appendSymbol(symbol: DocumentSymbol | SymbolInformation, depth: number, lines: string[], cwd: string, maxResults: number): void {
  if (lines.length >= maxResults) return;
  const indentation = "  ".repeat(depth);
  if ("location" in symbol) {
    lines.push(`${indentation}${symbol.name} [${kindName(symbol.kind)}] ${displayUri(symbol.location.uri, cwd)}:${symbol.location.range.start.line + 1}:${symbol.location.range.start.character + 1}`);
    return;
  }
  lines.push(`${indentation}${symbol.name} [${kindName(symbol.kind)}] ${symbol.selectionRange.start.line + 1}:${symbol.selectionRange.start.character + 1}`);
  for (const child of symbol.children ?? []) appendSymbol(child, depth + 1, lines, cwd, maxResults);
}

function formatMarkedContent(content: MarkedString | MarkupContent): string {
  if (typeof content === "string") return content;
  if ("language" in content) return `\`\`\`${content.language}\n${content.value}\n\`\`\``;
  return content.value;
}

function formatTextEdit(uri: string, startLine: number, startCharacter: number, endLine: number, endCharacter: number, newText: string, cwd: string): string {
  const replacement = singleLine(newText).slice(0, 180);
  return `${displayUri(uri, cwd)}:${startLine + 1}:${startCharacter + 1}-${endLine + 1}:${endCharacter + 1} => ${JSON.stringify(replacement)}`;
}

function finishLimited(lines: string[]): string {
  return `${lines.join("\n")}\n… additional edit(s) omitted`;
}

function kindName(kind: number): string {
  return SYMBOL_KIND[kind] ?? `kind-${kind}`;
}

function displayUri(uri: string, cwd: string): string {
  try {
    return displayPath(fileURLToPath(uri), cwd);
  } catch {
    return uri;
  }
}

function displayPath(path: string, cwd: string): string {
  return isWithin(path, cwd) ? relative(cwd, path) || "." : path;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeArray(value: unknown): unknown[] {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function isLocationLike(value: unknown): value is Location | LocationLink {
  if (!value || typeof value !== "object") return false;
  return ("uri" in value && "range" in value) || ("targetUri" in value && "targetSelectionRange" in value);
}
