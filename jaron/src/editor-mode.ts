import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type EditorInputMode = "shell" | "shellNoContext";

export function detectEditorInputMode(text: string): EditorInputMode | undefined {
	const trimmed = text.trimStart();
	if (trimmed.startsWith("!!")) return "shellNoContext";
	if (trimmed.startsWith("!")) return "shell";
	return undefined;
}

export function editorInputModeLabel(mode: EditorInputMode): string {
	return mode === "shellNoContext"
		? "!! shell mode · no context"
		: "! shell mode";
}

export function renderEditorTopBorder(
	status: string | undefined,
	width: number,
	border: (value: string) => string,
): string {
	const requestedLabel = status ? `${border("─")} ${status} ` : "";
	const label = visibleWidth(requestedLabel) > width
		? truncateToWidth(requestedLabel, width, "")
		: requestedLabel;
	const fill = border("─".repeat(Math.max(0, width - visibleWidth(label))));
	return `${border("╭")}${label}${fill}${border("╮")}`;
}
