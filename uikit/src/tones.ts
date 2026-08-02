import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * Named text tones: the single place that maps semantic intent to host theme
 * tokens. Renderers should pick a tone by meaning ("this is auxiliary text")
 * instead of naming tokens directly, so every extension resolves the same
 * intent to the same token.
 */
export type Tone =
  | "title"
  | "accent"
  | "muted"
  | "dim"
  | "text"
  | "output"
  | "success"
  | "warning"
  | "error";

export function tone(theme: Theme, name: Tone, text: string): string {
  switch (name) {
    case "title":
      return theme.fg("toolTitle", theme.bold(text));
    case "accent":
      return theme.fg("accent", text);
    case "muted":
      return theme.fg("muted", text);
    case "dim":
      return theme.fg("dim", text);
    case "text":
      return theme.fg("text", text);
    case "output":
      return theme.fg("toolOutput", text);
    case "success":
      return theme.fg("success", text);
    case "warning":
      return theme.fg("warning", text);
    case "error":
      return theme.fg("error", text);
  }
}
