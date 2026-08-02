import type { Theme } from "@earendil-works/pi-coding-agent";
import type { MarkdownTheme } from "@earendil-works/pi-tui";
import { tone } from "./tones.ts";

/**
 * The shared MarkdownTheme for pi-tui Markdown components: every markdown
 * construct styles through the same tones, so embedded markdown renders
 * identically in every extension.
 */
export function markdownThemeStyles(theme: Theme): MarkdownTheme {
  return {
    heading: (text) => tone(theme, "mdHeading", text),
    link: (text) => tone(theme, "mdLink", text),
    linkUrl: (text) => tone(theme, "mdLinkUrl", text),
    code: (text) => tone(theme, "mdCode", text),
    codeBlock: (text) => tone(theme, "mdCodeBlock", text),
    codeBlockBorder: (text) => tone(theme, "mdCodeBlockBorder", text),
    quote: (text) => tone(theme, "mdQuote", text),
    quoteBorder: (text) => tone(theme, "mdQuoteBorder", text),
    hr: (text) => tone(theme, "mdHr", text),
    listBullet: (text) => tone(theme, "mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    strikethrough: (text) => theme.strikethrough(text),
    underline: (text) => theme.underline(text),
  };
}
