import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	detectEditorInputMode,
	editorInputModeLabel,
	renderEditorTopBorder,
} from "../src/editor-mode.ts";
import { stripAnsi } from "../src/banner.ts";

const color = (value: string) => `\x1b[35m${value}\x1b[0m`;

test("detectEditorInputMode follows Pi shell prefixes", () => {
	assert.equal(detectEditorInputMode("hello"), undefined);
	assert.equal(detectEditorInputMode("  !pwd"), "shell");
	assert.equal(detectEditorInputMode("!!pwd"), "shellNoContext");
	assert.equal(detectEditorInputMode(" \n !! git status"), "shellNoContext");
});

test("editorInputModeLabel distinguishes shell context behavior", () => {
	assert.equal(editorInputModeLabel("shell"), "! shell mode");
	assert.equal(
		editorInputModeLabel("shellNoContext"),
		"!! shell mode · no context",
	);
});

test("renderEditorTopBorder embeds and bounds the mode label", () => {
	assert.equal(stripAnsi(renderEditorTopBorder(undefined, 10, color)), "╭──────────╮");
	assert.equal(
		stripAnsi(renderEditorTopBorder(color("! shell mode"), 20, color)),
		"╭─ ! shell mode ─────╮",
	);

	for (const width of [1, 4, 8, 20, 80]) {
		const line = renderEditorTopBorder(
			color("!! shell mode · no context · Goal active (12m)"),
			width,
			color,
		);
		assert.equal(visibleWidth(line), width + 2, `unexpected width at ${width}`);
	}
});
