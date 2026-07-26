import assert from "node:assert/strict";
import test from "node:test";
import { decodeMatch } from "../src/protocol.ts";
import { EditParameters, normalizeEditInput, normalizeSearchInput } from "../src/schema.ts";

function rawMatch(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    text: "foo(x)",
    file: "STDIN",
    lines: "foo(x)",
    charCount: { leading: 0, trailing: 0 },
    language: "TypeScript",
    range: {
      byteOffset: { start: 0, end: 6 },
      start: { line: 0, column: 0 },
      end: { line: 0, column: 6 },
    },
    metaVariables: {
      single: {
        A: {
          text: "x",
          range: {
            byteOffset: { start: 4, end: 5 },
            start: { line: 0, column: 4 },
            end: { line: 0, column: 5 },
          },
        },
      },
      multi: { ARGS: [] },
      transformed: { UPPER: "X" },
    },
    ...overrides,
  };
}

test("schema normalization applies stable defaults and action contracts", () => {
  assert.deepEqual(normalizeSearchInput({ pattern: "foo($A)", language: "typescript" }), {
    pattern: "foo($A)",
    language: "typescript",
    path: ".",
    globs: [],
    strictness: "smart",
    limit: 20,
    offset: 0,
    timeoutMs: 30_000,
  });
  const preview = normalizeEditInput({
    action: "preview",
    path: "sample.ts",
    language: "typescript",
    pattern: "foo($A)",
    rewrite: "",
  });
  assert.equal(preview.maxReplacements, 20);
  assert.equal(preview.timeoutMs, 20_000);
  assert.deepEqual(EditParameters.required, ["action", "path", "language", "pattern", "rewrite"]);
  for (const previewId of [null, ""] as const) {
    const placeholderPreview = normalizeEditInput({
      action: "preview",
      path: "sample.ts",
      language: "typescript",
      pattern: "foo($A)",
      rewrite: "bar($A)",
      previewId,
    });
    assert.equal("previewId" in placeholderPreview, false);
  }
  assert.throws(() => normalizeSearchInput({ pattern: " ", language: "typescript" }), /pattern must not be empty/u);
  assert.throws(() => normalizeSearchInput({ pattern: "x", language: "typescript", path: "~/src" }), /does not expand '~'/u);
  assert.throws(() => normalizeSearchInput({ pattern: "x", language: "typescript", path: "https://example.test/x" }), /filesystem path/u);
  assert.throws(() => normalizeSearchInput({ pattern: "x", language: "typescript", offset: 1001, limit: 50 }), /offset \+ limit \+ 1/u);
  assert.throws(() => normalizeEditInput({
    action: "preview",
    path: "sample.ts",
    language: "typescript",
    pattern: "x",
    rewrite: "y",
    previewId: "a".repeat(64),
  }), /preview must omit previewId/u);
  assert.throws(() => normalizeEditInput({
    action: "apply",
    path: "sample.ts",
    language: "typescript",
    pattern: "x",
    rewrite: "y",
  }), /apply requires previewId/u);
  for (const previewId of [null, ""] as const) {
    assert.throws(() => normalizeEditInput({
      action: "apply",
      path: "sample.ts",
      language: "typescript",
      pattern: "x",
      rewrite: "y",
      previewId,
    }), /apply requires previewId/u);
  }
});

test("protocol decoder accepts bounded search and rewrite records", () => {
  const search = decodeMatch(rawMatch(), "search", "typescript");
  assert.equal(search.text, "foo(x)");
  assert.deepEqual(search.metaVariables.map(({ category, name, text }) => ({ category, name, text })), [
    { category: "single", name: "A", text: "x" },
    { category: "transformed", name: "UPPER", text: "X" },
  ]);
  const rewrite = decodeMatch(rawMatch({
    replacement: "bar(x)",
    replacementOffsets: { start: 0, end: 6 },
  }), "rewrite", "typescript");
  assert.equal(rewrite.replacement, "bar(x)");
  assert.deepEqual(rewrite.replacementOffsets, { start: 0, end: 6 });
});

test("protocol decoder rejects malformed and mode-incompatible output while ignoring extra fields", () => {
  assert.throws(() => decodeMatch(rawMatch({ language: "JavaScript" }), "search", "typescript"), /expected language TypeScript/u);
  assert.throws(() => decodeMatch(rawMatch({ charCount: { leading: -1, trailing: 0 } }), "search", "typescript"), /non-negative safe integer/u);
  assert.throws(() => decodeMatch(rawMatch({ range: { byteOffset: { start: 6, end: 0 }, start: {}, end: {} } }), "search", "typescript"), /reversed/u);
  assert.throws(() => decodeMatch(rawMatch({ replacement: "bar(x)", replacementOffsets: { start: 0, end: 6 } }), "search", "typescript"), /replacement fields appeared/u);
  assert.throws(() => decodeMatch(rawMatch(), "rewrite", "typescript"), /replacement/u);
  const missingText = rawMatch();
  delete missingText.text;
  assert.throws(() => decodeMatch(missingText, "search", "typescript"), /text must be/u);
  const compatible = decodeMatch(rawMatch({
    unexpected: true,
    charCount: { leading: 0, trailing: 0, extra: true },
    range: {
      byteOffset: { start: 0, end: 6, extra: true },
      start: { line: 0, column: 0, extra: true },
      end: { line: 0, column: 6, extra: true },
      extra: true,
    },
  }), "search", "typescript");
  assert.equal(compatible.text, "foo(x)");

  let overLimitValueRead = false;
  const transformed: Record<string, unknown> = {};
  for (let index = 0; index < 4096; index += 1) transformed[`T${index}`] = "x";
  Object.defineProperty(transformed, "OVER_LIMIT", {
    enumerable: true,
    get() {
      overLimitValueRead = true;
      throw new Error("decoder read beyond its metavariable cap");
    },
  });
  assert.throws(() => decodeMatch(rawMatch({
    metaVariables: { single: {}, multi: {}, transformed },
  }), "search", "typescript"), /more than 4096 metavariable entries/u);
  assert.equal(overLimitValueRead, false);
});
