import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  renderEditResult,
  renderSearchResult,
} from "../src/renderer.ts";

const theme = {
  fg: (_color: string, text: string) => text,
} as Theme;
const expanded = { expanded: true, isPartial: false } as never;
const context = { isError: false };

function rendered(component: { render(width: number): string[] }): string {
  return component.render(120).join("\n");
}

test("result renderers strictly decode details and sanitize every fallback and progress string", () => {
  const control = "scope\x1b]8;;https://example.invalid\x07\u202E";
  const progress = rendered(renderSearchResult({
    content: [{ type: "text", text: "unused" }],
    details: {
      version: 1,
      kind: "progress",
      operation: "search",
      phase: "query",
      scope: control,
      processedRecords: 2,
    },
  } as never, expanded, theme, context));
  assert.equal(progress.includes("\x1b"), false);
  assert.equal(progress.includes("\u202E"), false);
  assert.match(progress, /\\x1b.*\\x07.*\\u\{202e\}/u);

  const fallback = rendered(renderSearchResult({
    content: [{ type: "text", text: `fallback ${control}` }],
    details: { version: 1, kind: "search", matches: "forged" },
  } as never, expanded, theme, context));
  assert.equal(fallback.includes("\x1b"), false);
  assert.equal(fallback.includes("\u202E"), false);
  assert.match(fallback, /^fallback scope\\x1b/u);

  const editFallback = rendered(renderEditResult({
    content: [{ type: "text", text: `edit ${control}` }],
    details: { version: 1, kind: "edit-preview", replacements: 1, edits: [] },
  } as never, expanded, theme, context));
  assert.equal(editFallback.includes("\x1b"), false);
  assert.equal(editFallback.includes("\u202E"), false);
  assert.match(editFallback, /^edit scope\\x1b/u);
});
