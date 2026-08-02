import type { Theme } from "@earendil-works/pi-coding-agent";
import { tone, type Tone } from "./tones.ts";

export type StatusKind = "success" | "warning" | "error" | "pending";

const STATUS_GLYPHS: Record<StatusKind, string> = {
  success: "✓",
  warning: "!",
  error: "✕",
  pending: "○",
};

function statusTone(status: StatusKind): Tone {
  return status === "pending" ? "warning" : status;
}

/**
 * One result row: a colored status glyph, an accent label, and an optional
 * plain-text value — the shared shape for answer/result listings.
 */
export function statusRow(theme: Theme, status: StatusKind, label: string, value?: string): string {
  let row = `${tone(theme, statusTone(status), STATUS_GLYPHS[status])} ${tone(theme, "accent", label)}`;
  if (value !== undefined) row += `: ${tone(theme, "text", value)}`;
  return row;
}

/** One key/value row: muted key, plain-text value. */
export function kvRow(theme: Theme, key: string, value: string): string {
  return `${tone(theme, "muted", key)}: ${tone(theme, "text", value)}`;
}

/** A short bracketed marker, e.g. `[beta]`, in the given tone. */
export function badge(theme: Theme, text: string, name: Tone): string {
  return tone(theme, name, `[${text}]`);
}
