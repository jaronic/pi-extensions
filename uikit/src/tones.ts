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
  | "error"
  | "strong"
  | "selected"
  | "borderMuted"
  | "borderAccent"
  | "diffAdded"
  | "diffRemoved"
  | "mdHeading"
  | "mdLink"
  | "mdLinkUrl"
  | "mdCode"
  | "mdCodeBlock"
  | "mdCodeBlockBorder"
  | "mdQuote"
  | "mdQuoteBorder"
  | "mdHr"
  | "mdListBullet";

export interface ToneOptions {
  /**
   * Bold handling: `true` wraps the text in `theme.bold` before coloring
   * (inside the fg call); `"outer"` wraps the colored string instead
   * (`theme.bold(theme.fg(token, text))`); `false` only matters for `title`,
   * which is bold by default and renders plain when set to `false`.
   */
  bold?: boolean | "outer";
}

export function tone(theme: Theme, name: Tone, text: string, options?: ToneOptions): string {
  const value = options?.bold === true ? theme.bold(text) : text;
  const colored = colorize(theme, name, value, options);
  return options?.bold === "outer" ? theme.bold(colored) : colored;
}

function colorize(theme: Theme, name: Tone, value: string, options?: ToneOptions): string {
  switch (name) {
    case "title":
      return options?.bold === false ? theme.fg("toolTitle", value) : theme.fg("toolTitle", theme.bold(value));
    case "accent":
      return theme.fg("accent", value);
    case "muted":
      return theme.fg("muted", value);
    case "dim":
      return theme.fg("dim", value);
    case "text":
      return theme.fg("text", value);
    case "output":
      return theme.fg("toolOutput", value);
    case "success":
      return theme.fg("success", value);
    case "warning":
      return theme.fg("warning", value);
    case "error":
      return theme.fg("error", value);
    case "strong":
      return options?.bold === true ? value : theme.bold(value);
    case "selected":
      return theme.bg("selectedBg", theme.fg("text", value));
    case "borderMuted":
      return theme.fg("borderMuted", value);
    case "borderAccent":
      return theme.fg("borderAccent", value);
    case "diffAdded":
      return theme.fg("toolDiffAdded", value);
    case "diffRemoved":
      return theme.fg("toolDiffRemoved", value);
    case "mdHeading":
      return theme.fg("mdHeading", value);
    case "mdLink":
      return theme.fg("mdLink", value);
    case "mdLinkUrl":
      return theme.fg("mdLinkUrl", value);
    case "mdCode":
      return theme.fg("mdCode", value);
    case "mdCodeBlock":
      return theme.fg("mdCodeBlock", value);
    case "mdCodeBlockBorder":
      return theme.fg("mdCodeBlockBorder", value);
    case "mdQuote":
      return theme.fg("mdQuote", value);
    case "mdQuoteBorder":
      return theme.fg("mdQuoteBorder", value);
    case "mdHr":
      return theme.fg("mdHr", value);
    case "mdListBullet":
      return theme.fg("mdListBullet", value);
  }
}
