import type { Theme } from "@earendil-works/pi-coding-agent";
import { tone } from "./tones.ts";

export interface CollapseOptions {
  /** True renders every line; false caps at `collapsedLimit`. */
  expanded: boolean;
  collapsedLimit: number;
}

export interface Collapsed<T> {
  visible: readonly T[];
  hiddenCount: number;
}

/** Split lines into the visible head and a hidden-count, honoring expand state. */
export function collapseLines<T>(lines: readonly T[], options: CollapseOptions): Collapsed<T> {
  const max = options.expanded ? lines.length : options.collapsedLimit;
  const visible = lines.slice(0, max);
  return { visible, hiddenCount: lines.length - visible.length };
}

/** The standard trailing hint for collapsed output. */
export function moreLinesHint(theme: Theme, hiddenCount: number, noun = "lines"): string {
  return tone(theme, "muted", `… (${hiddenCount} more ${noun}; expand to show all)`);
}
