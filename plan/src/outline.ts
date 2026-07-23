import { randomUUID } from "node:crypto";
import { lexer, type Token, type Tokens } from "marked";

export interface PlanOutlineEntry {
  index: number;
  depth: number;
  text: string;
  marker: string;
  syntheticSeparator: "none" | "before" | "after";
}

export interface PlanOutline {
  decoratedBody: string;
  entries: PlanOutlineEntry[];
  stripDecoratedBody(): string;
}

interface Insertion {
  offset: number;
  text: string;
}

function isHeading(token: Token): token is Tokens.Heading {
  return token.type === "heading";
}

function inlineText(tokens: Token[]): string {
  let result = "";
  for (const token of tokens) {
    if (token.type === "br") {
      result += " ";
      continue;
    }
    if (token.type === "strong" || token.type === "em" || token.type === "del") {
      result += inlineText(token.tokens ?? []);
      continue;
    }
    if (token.type === "link" || token.type === "image") {
      const nested = token.tokens ?? [];
      result += nested.length > 0 ? inlineText(nested) : token.text;
      continue;
    }
    if (token.type === "text" || token.type === "escape" || token.type === "codespan" || token.type === "html") {
      result += token.text;
      continue;
    }
    const nested = "tokens" in token && Array.isArray(token.tokens) ? token.tokens : undefined;
    if (nested) {
      result += inlineText(nested);
      continue;
    }
    if ("text" in token && typeof token.text === "string") result += token.text;
  }
  return result;
}

function inlineStartOffset(token: Tokens.Heading): number {
  const inlineRaw = token.tokens.map((inline) => inline.raw).join("");
  const candidate = inlineRaw || token.text;
  if (candidate) {
    const offset = token.raw.indexOf(candidate);
    if (offset >= 0) return offset;
  }
  const atxPrefix = /^(?: {0,3}#{1,6}[ \t]+)/.exec(token.raw);
  return atxPrefix ? atxPrefix[0].length : 0;
}

function emptyAtxInsertion(token: Tokens.Heading, marker: string): { offset: number; text: string; syntheticSeparator: PlanOutlineEntry["syntheticSeparator"] } {
  const atx = /^( {0,3}#{1,6})([ \t]*)(.*?)(?:\r?\n)?$/.exec(token.raw);
  if (!atx) return { offset: inlineStartOffset(token), text: marker, syntheticSeparator: "none" };
  const [, openingFence, openingWhitespace, remainder] = atx;
  if (openingWhitespace) {
    return {
      offset: openingFence.length + openingWhitespace.length,
      text: marker,
      syntheticSeparator: "none",
    };
  }
  const closingFence = /^(.*?)([ \t]+#+[ \t]*)$/.exec(remainder);
  if (closingFence) {
    return {
      offset: openingFence.length + closingFence[1].length,
      text: `${marker} `,
      syntheticSeparator: "after",
    };
  }
  return {
    offset: openingFence.length,
    text: ` ${marker}`,
    syntheticSeparator: "before",
  };
}

export function clearPlanOutlineMarkers(text: string, entries: readonly PlanOutlineEntry[]): string {
  let cleared = text;
  for (const entry of entries) cleared = cleared.replaceAll(entry.marker, "");
  return cleared;
}

export function stripPlanOutlineMarkers(text: string, entries: readonly PlanOutlineEntry[]): string {
  let stripped = text;
  for (const entry of entries) {
    if (entry.syntheticSeparator === "before") stripped = stripped.replace(` ${entry.marker}`, "");
    else if (entry.syntheticSeparator === "after") stripped = stripped.replace(`${entry.marker} `, "");
    else stripped = stripped.replace(entry.marker, "");
  }
  return stripped;
}

export function createPlanOutline(markdown: string): PlanOutline {
  const entries: PlanOutlineEntry[] = [];
  const insertions: Insertion[] = [];
  const nonce = randomUUID();
  let sourceOffset = 0;

  for (const token of lexer(markdown)) {
    if (isHeading(token)) {
      const index = entries.length;
      const marker = `\u001b_plan-outline:${nonce}:${index}\u0007`;
      const empty = token.tokens.length === 0;
      const insertion = empty
        ? emptyAtxInsertion(token, marker)
        : { offset: inlineStartOffset(token), text: marker, syntheticSeparator: "none" as const };
      entries.push({
        index,
        depth: Math.max(1, Math.min(6, token.depth)),
        text: inlineText(token.tokens).replace(/\s+/g, " ").trim() || "(untitled heading)",
        marker,
        syntheticSeparator: insertion.syntheticSeparator,
      });
      insertions.push({ offset: sourceOffset + insertion.offset, text: insertion.text });
    }
    sourceOffset += token.raw.length;
  }

  let decoratedBody = markdown;
  for (const insertion of insertions.toSorted((left, right) => right.offset - left.offset)) {
    decoratedBody = `${decoratedBody.slice(0, insertion.offset)}${insertion.text}${decoratedBody.slice(insertion.offset)}`;
  }
  return {
    decoratedBody,
    entries,
    stripDecoratedBody: () => stripPlanOutlineMarkers(decoratedBody, entries),
  };
}
