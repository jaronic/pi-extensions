import type { Position } from "vscode-languageserver-protocol";
import type { LspClient, SyncedDocument } from "./lsp-client.ts";

export interface PositionInput {
  line?: number;
  column?: number;
  symbol?: string;
}

export function resolvePosition(client: LspClient, document: SyncedDocument, input: PositionInput): Position {
  if (input.line !== undefined) return client.toPosition(document, input.line, input.column ?? 1);
  const symbol = input.symbol?.trim();
  if (!symbol) throw new Error("Provide line (and optional column) or an exact symbol");

  const matches = findOccurrences(document.text, symbol, 8);
  if (matches.length === 0) throw new Error(`Symbol not found in file: ${symbol}`);
  if (matches.length > 1) {
    const candidates = matches.map((index) => lineColumnAt(document.text, index)).map(({ line, column }) => `${line}:${column}`);
    throw new Error(`Symbol ${symbol} is ambiguous; provide line/column. Matches: ${candidates.join(", ")}`);
  }
  const location = lineColumnAt(document.text, matches[0]);
  return client.toPosition(document, location.line, location.column);
}

function findOccurrences(text: string, symbol: string, limit: number): number[] {
  const matches: number[] = [];
  let from = 0;
  while (matches.length < limit) {
    const index = text.indexOf(symbol, from);
    if (index < 0) break;
    const before = index > 0 ? text[index - 1] : "";
    const after = text[index + symbol.length] ?? "";
    const firstIsIdentifier = isIdentifierCharacter(symbol[0] ?? "");
    const lastIsIdentifier = isIdentifierCharacter(symbol[symbol.length - 1] ?? "");
    if ((!firstIsIdentifier || !isIdentifierCharacter(before)) && (!lastIsIdentifier || !isIdentifierCharacter(after))) {
      matches.push(index);
    }
    from = index + Math.max(symbol.length, 1);
  }
  return matches;
}

function lineColumnAt(text: string, index: number): { line: number; column: number } {
  const before = text.slice(0, index);
  const lines = before.split(/\r?\n/);
  return {
    line: lines.length,
    column: Array.from(lines[lines.length - 1] ?? "").length + 1,
  };
}

function isIdentifierCharacter(value: string): boolean {
  return value !== "" && /[\p{L}\p{N}_$]/u.test(value);
}
