import { Text } from "@earendil-works/pi-tui";

/** Join styled lines into a plain Text component for tool renderers. */
export function linesToText(lines: readonly string[]): Text {
  return new Text(lines.join("\n"), 0, 0);
}
