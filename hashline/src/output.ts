import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  type ReadToolDetails,
} from "@earendil-works/pi-coding-agent";
import type { SnapshotToken } from "./digest.ts";
import type { PhysicalLine } from "./lines.ts";
import type { ChangedSpan, OperationPlan } from "./operations.ts";
import { escapeDisplayPath } from "./paths.ts";
import {
  EDIT_PREVIEW_CONTEXT,
  MAX_EDIT_PREVIEW_LINES,
  MAX_SEEN_RANGES,
} from "./schemas.ts";
import { normalizeSeenRanges, type SeenRange } from "./snapshots.ts";

const OUTPUT_NOTICE_RESERVE_BYTES = 768;
const SNAPSHOT_UNAVAILABLE_NOTICE = "[Hashline snapshot unavailable. Re-read this file before editing; do not guess a token.]";
const FOLLOW_UP_UNAVAILABLE_NOTICE = "[The file was updated, but no follow-up snapshot was saved. Re-read before editing again.]";
const REFRESH_UNAVAILABLE_NOTICE = "[Current context could not be safely journaled. Use read before retrying; do not reuse the submitted snapshot.]";

export interface FormattedReadSnapshot {
  readonly tokenText: string;
  readonly noTokenText: string;
  readonly seen: readonly SeenRange[];
  readonly details: ReadToolDetails | undefined;
}

export interface FormattedEditResults {
  readonly withTokenText?: string;
  readonly withoutTokenText: string;
  readonly seen: readonly SeenRange[];
}

export interface FormattedRefreshResults {
  readonly withTokenText?: string;
  readonly withoutTokenText: string;
  readonly seen: readonly SeenRange[];
}

function snapshotHeader(path: string, token: SnapshotToken): string {
  return `[hashline path=${JSON.stringify(path)} snapshot=${JSON.stringify(token)}]`;
}

function joinSections(sections: readonly string[]): string {
  return sections.filter((section) => section.length > 0).join("\n\n");
}

function assertOutputBounded(text: string): void {
  if (Buffer.byteLength(text, "utf8") > DEFAULT_MAX_BYTES || text.split("\n").length > DEFAULT_MAX_LINES) {
    throw new Error("Hashline output exceeded the Pi tool output boundary.");
  }
}

export function formatReadSnapshot(
  lines: readonly PhysicalLine[],
  startLine: number,
  requestedCount: number,
  displayPath: string,
  token: SnapshotToken,
): FormattedReadSnapshot | undefined {
  const selected = lines.slice(startLine - 1, startLine - 1 + requestedCount);
  if (selected.length === 0) return undefined;
  const header = snapshotHeader(displayPath, token);
  const reservedBytes = Math.max(
    Buffer.byteLength(header, "utf8"),
    Buffer.byteLength(SNAPSHOT_UNAVAILABLE_NOTICE, "utf8"),
  ) + OUTPUT_NOTICE_RESERVE_BYTES;
  const maxBodyBytes = DEFAULT_MAX_BYTES - reservedBytes;
  if (maxBodyBytes <= 0) return undefined;
  const numbered = selected.map((line, index) => `${startLine + index}:${line.body}`).join("\n");
  const truncation = truncateHead(numbered, {
    maxBytes: maxBodyBytes,
    maxLines: DEFAULT_MAX_LINES - 5,
  });
  if (truncation.firstLineExceedsLimit || truncation.outputLines === 0) return undefined;
  const emitted = truncation.outputLines;
  const endLine = startLine + emitted - 1;
  let continuation = "";
  if (emitted < selected.length) {
    continuation = `[Showing lines ${startLine}-${endLine} of ${lines.length} (${DEFAULT_MAX_BYTES / 1024}KB limit). Use offset=${endLine + 1} to continue.]`;
  } else if (startLine - 1 + selected.length < lines.length) {
    const remaining = lines.length - (startLine - 1 + selected.length);
    continuation = `[${remaining} more lines in file. Use offset=${startLine + selected.length} to continue.]`;
  }
  const body = truncation.content;
  const tokenText = joinSections([`${header}\n${body}`, continuation]);
  const noTokenText = joinSections([body, continuation, SNAPSHOT_UNAVAILABLE_NOTICE]);
  assertOutputBounded(tokenText);
  assertOutputBounded(noTokenText);
  return Object.freeze({
    tokenText,
    noTokenText,
    seen: Object.freeze([Object.freeze({ start: startLine, end: endLine })]),
    details: truncation.truncated ? Object.freeze({ truncation }) : undefined,
  });
}

interface PreviewRangeSelection {
  readonly ranges: readonly SeenRange[];
  readonly truncated: boolean;
}

function previewRanges(spans: readonly ChangedSpan[], lineCount: number): PreviewRangeSelection {
  const ranges: Array<{ start: number; end: number }> = [];
  let truncated = false;
  for (const span of spans) {
    const candidate = {
      start: Math.max(1, span.start - EDIT_PREVIEW_CONTEXT),
      end: Math.min(lineCount, span.end + EDIT_PREVIEW_CONTEXT),
    };
    const previous = ranges[ranges.length - 1];
    if (previous && candidate.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, candidate.end);
    } else if (ranges.length < MAX_SEEN_RANGES) {
      ranges.push(candidate);
    } else {
      truncated = true;
      break;
    }
  }
  return Object.freeze({
    ranges: Object.freeze(ranges.map((range) => Object.freeze(range))),
    truncated,
  });
}

function previewBody(
  lines: readonly PhysicalLine[],
  ranges: readonly SeenRange[],
  byteBudget: number,
): { readonly body: string; readonly seen: readonly SeenRange[]; readonly truncated: boolean } {
  const parts: string[] = [];
  const seenLines: number[] = [];
  let sourceRows = 0;
  let bytes = 0;
  let truncated = false;
  let previousEnd = 0;
  outer: for (const range of ranges) {
    if (previousEnd > 0 && range.start > previousEnd + 1) {
      const separator = `[... lines ${previousEnd + 1}-${range.start - 1} omitted ...]`;
      const separatorBytes = Buffer.byteLength(`${parts.length > 0 ? "\n" : ""}${separator}`, "utf8");
      if (bytes + separatorBytes > byteBudget) {
        truncated = true;
        break;
      }
      parts.push(separator);
      bytes += separatorBytes;
    }
    for (let lineNumber = range.start; lineNumber <= range.end; lineNumber += 1) {
      if (sourceRows >= MAX_EDIT_PREVIEW_LINES) {
        truncated = true;
        break outer;
      }
      const row = `${lineNumber}:${lines[lineNumber - 1].body}`;
      const rowBytes = Buffer.byteLength(`${parts.length > 0 ? "\n" : ""}${row}`, "utf8");
      if (bytes + rowBytes > byteBudget) {
        truncated = true;
        break outer;
      }
      parts.push(row);
      bytes += rowBytes;
      sourceRows += 1;
      seenLines.push(lineNumber);
    }
    previousEnd = range.end;
  }
  const seen = normalizeSeenRanges(
    seenLines.map((line) => ({ start: line, end: line })),
    lines.length,
    MAX_EDIT_PREVIEW_LINES,
  );
  return Object.freeze({ body: parts.join("\n"), seen, truncated });
}

export function formatRefreshSnapshot(
  path: string,
  token: SnapshotToken,
  lines: readonly PhysicalLine[],
  ranges: readonly SeenRange[],
  summary: string,
): FormattedRefreshResults {
  const header = snapshotHeader(path, token);
  const reserve = Buffer.byteLength(summary, "utf8") + Math.max(
    Buffer.byteLength(header, "utf8"),
    Buffer.byteLength(REFRESH_UNAVAILABLE_NOTICE, "utf8"),
  ) + OUTPUT_NOTICE_RESERVE_BYTES;
  const preview = previewBody(lines, ranges, Math.max(0, DEFAULT_MAX_BYTES - reserve));
  const truncationNotice = preview.truncated
    ? "[Refresh preview truncated. Read the remaining target range before retrying.]"
    : "";
  const withoutTokenText = joinSections([
    summary,
    REFRESH_UNAVAILABLE_NOTICE,
  ]);
  assertOutputBounded(withoutTokenText);
  let withTokenText: string | undefined;
  if (preview.seen.length > 0) {
    withTokenText = joinSections([
      summary,
      `${header}\n${preview.body}`,
      truncationNotice,
      "[Only the numbered current rows shown above are authorized by this refreshed snapshot.]",
    ]);
    assertOutputBounded(withTokenText);
  }
  return Object.freeze({ withTokenText, withoutTokenText, seen: preview.seen });
}

export function formatEditResults(
  path: string,
  token: SnapshotToken,
  lines: readonly PhysicalLine[],
  spans: readonly ChangedSpan[],
  plan: OperationPlan,
  notice = "",
): FormattedEditResults {
  const summary = `Updated ${escapeDisplayPath(path)} with ${plan.operations.length} hashline edit${plan.operations.length === 1 ? "" : "s"} (+${plan.insertedLines}/-${plan.consumedLines} lines).`;
  const header = snapshotHeader(path, token);
  const reserve = Buffer.byteLength(summary, "utf8") + Buffer.byteLength(notice, "utf8") + Math.max(
    Buffer.byteLength(header, "utf8"),
    Buffer.byteLength(FOLLOW_UP_UNAVAILABLE_NOTICE, "utf8"),
  ) + OUTPUT_NOTICE_RESERVE_BYTES;
  const rangeSelection = previewRanges(spans, lines.length);
  const preview = previewBody(lines, rangeSelection.ranges, Math.max(0, DEFAULT_MAX_BYTES - reserve));
  const truncationNotice = rangeSelection.truncated || preview.truncated
    ? "[Preview truncated. Use read with the follow-up snapshot before another edit.]"
    : "";
  const withoutTokenText = joinSections([summary, notice, preview.body, truncationNotice, FOLLOW_UP_UNAVAILABLE_NOTICE]);
  assertOutputBounded(withoutTokenText);
  let withTokenText: string | undefined;
  if (preview.seen.length > 0) {
    withTokenText = joinSections([summary, notice, `${header}\n${preview.body}`, truncationNotice]);
    assertOutputBounded(withTokenText);
  }
  return Object.freeze({ withTokenText, withoutTokenText, seen: preview.seen });
}
