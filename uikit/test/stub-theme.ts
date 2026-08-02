import type { Theme } from "@earendil-works/pi-coding-agent";

/**
 * Theme stub that marks every color application so tests can assert which
 * token a primitive resolved, without any ANSI or host state.
 */
export const stubTheme = {
  fg: (token: string, text: string) => `<${token}>${text}</>`,
  bg: (token: string, text: string) => `<bg:${token}>${text}</>`,
  bold: (text: string) => `**${text}**`,
} as unknown as Theme;
