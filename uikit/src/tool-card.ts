import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { tone } from "./tones.ts";

export interface ToolCallTitleParts {
  /** Brand shown bold in toolTitle, e.g. "Hashline". */
  brand: string;
  /** Optional action segment rendered muted as ` · <action> `. */
  action?: string;
  /** Optional target (path, query, …) rendered in accent right after. */
  target?: string;
}

/**
 * The standard one-line tool-call card title shared by tool renderers:
 * `Brand · action target` with brand/action/target in title/muted/accent.
 */
export function toolCallTitle(theme: Theme, parts: ToolCallTitleParts): string {
  const brand = sanitizeTitleSegment(parts.brand);
  const action = parts.action === undefined ? undefined : sanitizeTitleSegment(parts.action);
  const target = parts.target === undefined ? undefined : sanitizeTitleSegment(parts.target);
  let line = tone(theme, "title", brand);
  if (action !== undefined) line += tone(theme, "muted", ` · ${action} `);
  if (target !== undefined) line += tone(theme, "accent", target);
  return line;
}

/**
 * Single-line, control-safe title segment: line breaks and tabs fold to a
 * single space, every other C0/C1 control character (ESC, BEL, CSI/OSC
 * introducers, …) is dropped, so escape sequences from tool arguments cannot
 * reach the TUI. No-op on ordinary input, keeping consumer snapshots
 * byte-identical.
 */
function sanitizeTitleSegment(text: string): string {
  return text
    .replace(/[\t\r\n\u2028\u2029]+/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "");
}

/**
 * Stream-safe Text reuse for renderCall: tool calls re-render while arguments
 * stream in, so mutate the previous component when possible instead of
 * allocating a new one each update.
 */
export function reuseTextComponent(lastComponent: unknown, content: string): Text {
  const text = lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
  text.setText(content);
  return text;
}
