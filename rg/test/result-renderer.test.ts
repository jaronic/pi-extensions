import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { formatGrepOutputForDisplay, renderGrepOutput } from "../src/result-renderer.ts";

const theme = {
  fg(_color: string, text: string): string {
    return text;
  },
} as unknown as Theme;

function render(output: string, options: Readonly<{ expanded: boolean; isError: boolean }>): string[] {
  return renderGrepOutput(output, options, theme).render(200).map((line) => line.trimEnd());
}

test("groups grep records by file while preserving group and record order", () => {
  const output = [
    "src/a.ts:2: alpha",
    "src/b.ts-3- before beta",
    "src/a.ts:4: omega",
    "",
    "[3 results limit reached]",
  ].join("\n");

  assert.deepEqual(formatGrepOutputForDisplay(output), [
    { kind: "file", text: "src/a.ts" },
    { kind: "match", text: "  2: alpha" },
    { kind: "match", text: "  4: omega" },
    { kind: "file", text: "src/b.ts" },
    { kind: "context", text: "  3- before beta" },
    { kind: "tail", text: "" },
    { kind: "tail", text: "[3 results limit reached]" },
  ]);

  assert.deepEqual(render(output, { expanded: true, isError: false }), [
    "src/a.ts",
    "  2: alpha",
    "  4: omega",
    "src/b.ts",
    "  3- before beta",
    "",
    "[3 results limit reached]",
  ]);
});

test("falls back to raw display for unsupported grep output", () => {
  const noMatches = "No matches found";
  assert.equal(formatGrepOutputForDisplay(noMatches), undefined);
  assert.deepEqual(render(noMatches, { expanded: false, isError: false }), [noMatches]);

  const mixed = ["src/a.ts:2: alpha", "unexpected host output", "src/a.ts:4: omega"].join("\n");
  assert.equal(formatGrepOutputForDisplay(mixed), undefined);
  assert.deepEqual(render(mixed, { expanded: false, isError: false }), mixed.split("\n"));
});

test("renders error output verbatim without parsing records", () => {
  const error = "src/a.ts:2: failed search";
  assert.deepEqual(render(error, { expanded: false, isError: true }), [error]);
});

test("collapses by final display line count and expands every line", () => {
  const output = Array.from({ length: 15 }, (_, index) => `src/a.ts:${index + 1}: line ${index + 1}`).join("\n");
  const collapsed = render(output, { expanded: false, isError: false });
  const expanded = render(output, { expanded: true, isError: false });

  assert.deepEqual(collapsed, [
    "src/a.ts",
    ...Array.from({ length: 14 }, (_, index) => `  ${index + 1}: line ${index + 1}`),
    "… (1 more lines; expand to show all)",
  ]);
  assert.deepEqual(expanded, [
    "src/a.ts",
    ...Array.from({ length: 15 }, (_, index) => `  ${index + 1}: line ${index + 1}`),
  ]);
});
