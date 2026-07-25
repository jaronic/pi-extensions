import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export type GrepDisplayLine = Readonly<{
  kind: "file" | "match" | "context" | "tail";
  text: string;
}>;

type ParsedRecord = Readonly<{
  kind: "match" | "context";
  path: string;
  text: string;
}>;

const MATCH_LINE = /^(.+?):(\d+): (.*)$/;
const CONTEXT_LINE = /^(.+?)-(\d+)- (.*)$/;
const COLLAPSED_LINE_LIMIT = 15;

function parseRecord(line: string): ParsedRecord | undefined {
  const match = MATCH_LINE.exec(line);
  if (match) {
    return {
      kind: "match",
      path: match[1],
      text: `  ${match[2]}: ${match[3]}`,
    };
  }

  const context = CONTEXT_LINE.exec(line);
  if (context) {
    return {
      kind: "context",
      path: context[1],
      text: `  ${context[2]}- ${context[3]}`,
    };
  }

  return undefined;
}

export function formatGrepOutputForDisplay(output: string): readonly GrepDisplayLine[] | undefined {
  const groups = new Map<string, GrepDisplayLine[]>();
  const tails: GrepDisplayLine[] = [];
  let readingTail = false;

  for (const line of output.split("\n")) {
    const record = parseRecord(line);
    if (!readingTail && record) {
      const group = groups.get(record.path);
      const displayLine: GrepDisplayLine = { kind: record.kind, text: record.text };
      if (group) group.push(displayLine);
      else groups.set(record.path, [displayLine]);
      continue;
    }

    if (groups.size > 0 && (line === "" || line.startsWith("["))) {
      readingTail = true;
      tails.push({ kind: "tail", text: line });
      continue;
    }

    return undefined;
  }

  if (groups.size === 0) return undefined;

  const display: GrepDisplayLine[] = [];
  for (const [path, records] of groups) {
    display.push({ kind: "file", text: path }, ...records);
  }
  display.push(...tails);
  return display;
}

function styleLine(line: GrepDisplayLine, theme: Theme): string {
  switch (line.kind) {
    case "file":
      return theme.fg("accent", line.text);
    case "context":
      return theme.fg("muted", line.text);
    case "match":
    case "tail":
      return theme.fg("toolOutput", line.text);
  }
}

export function renderGrepOutput(
  output: string,
  options: Readonly<{ expanded: boolean; isError: boolean }>,
  theme: Theme,
): Text {
  if (output.length === 0) return new Text("", 0, 0);
  if (options.isError) return new Text(theme.fg("error", output), 0, 0);

  const display = formatGrepOutputForDisplay(output);
  const lines = display ?? output.split("\n").map((text) => ({ kind: "tail" as const, text }));
  const maxLines = options.expanded ? lines.length : COLLAPSED_LINE_LIMIT;
  const visible = lines.slice(0, maxLines);
  const remaining = lines.length - visible.length;
  let text = visible.map((line) => styleLine(line, theme)).join("\n");

  if (remaining > 0) {
    text += `${text.length > 0 ? "\n" : ""}${theme.fg("muted", `… (${remaining} more lines; expand to show all)`)}`;
  }

  return new Text(text, 0, 0);
}
