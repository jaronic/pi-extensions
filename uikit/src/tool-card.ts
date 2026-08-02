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
  let line = tone(theme, "title", parts.brand);
  if (parts.action !== undefined) line += tone(theme, "muted", ` · ${parts.action} `);
  if (parts.target !== undefined) line += tone(theme, "accent", parts.target);
  return line;
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
