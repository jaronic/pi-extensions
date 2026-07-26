import assert from "node:assert/strict";
import { homedir } from "node:os";
import test from "node:test";
import {
  boundedToolError,
  formatApplyResult,
  formatPathForDisplay,
  formatPreviewResult,
  formatSearchResult,
  normalizeMatchSummary,
  ProgressReporter,
  sanitizeAndCap,
} from "../src/output.ts";
import type { AstGrepSearchToolDetails, EditPlan } from "../src/types.ts";
import { normalizedSearch, operationRecord, searchMatch, sourceRange } from "./helpers.ts";

test("output sanitization neutralizes terminal controls and respects byte/line caps", () => {
  const sanitized = sanitizeAndCap("safe\x1b[31m\u202Etext\x07\nnext", 100, 2);
  assert.equal(sanitized.truncated, false);
  assert.equal(sanitized.text, "safe\\x1b[31m\\u{202e}text\\x07\nnext");
  const capped = sanitizeAndCap("ééé\nsecond\nthird", 8, 2);
  assert.equal(capped.truncated, true);
  assert.ok(Buffer.byteLength(capped.text) <= 8);
  assert.ok(capped.text.endsWith("…"));
  const astralBoundary = sanitizeAndCap(`${"a".repeat(250)}😀éx`, 256, 1);
  assert.equal(astralBoundary.truncated, true);
  assert.equal(astralBoundary.text, `${"a".repeat(250)}…`);
  assert.equal(astralBoundary.text.isWellFormed(), true);
});

test("search formatting paginates without skipping complete results", () => {
  const input = normalizedSearch({ limit: 2, offset: 0 });
  const matches = [0, 1, 2].map((index) => normalizeMatchSummary(`src/${index}.ts`, searchMatch({
    text: `foo(${index})`,
    range: sourceRange(index * 10, index * 10 + 6),
  })));
  const result = formatSearchResult("typescript", ".", input, 3, false, matches);
  assert.equal(result.details.returnedMatches, 2);
  assert.equal(result.details.nextOffset, 2);
  assert.equal(result.details.resultLimited, true);
  assert.deepEqual(result.details.matches.map((match) => match.path), ["src/0.ts", "src/1.ts"]);
  const textContent = result.content[0];
  assert.equal(textContent?.type, "text");
  assert.ok(Buffer.byteLength(textContent?.type === "text" ? textContent.text : "") <= 48 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(result.details)) <= 48 * 1024);

  const finalPage = formatSearchResult("typescript", ".", normalizedSearch({ limit: 2, offset: 2 }), 3, false, [matches[2]!]);
  assert.equal(finalPage.details.returnedMatches, 1);
  assert.equal(finalPage.details.nextOffset, undefined);
  assert.equal(finalPage.details.resultLimited, false);
});

test("machine paths stay raw while model paths are lossless JSON literals", () => {
  const unsafeScope = "src\\folder\n\"x\"\x1b\u202E";
  const scopeDisplay = formatPathForDisplay(unsafeScope, 32 * 1024);
  assert.equal(scopeDisplay.truncated, false);
  assert.equal(scopeDisplay.text, "\"src\\\\folder\\n\\\"x\\\"\\u001b\\u202e\"");
  const noMatches = formatSearchResult("typescript", unsafeScope, normalizedSearch(), 0, false, []);
  assert.equal(noMatches.details.scope, unsafeScope);
  assert.equal(noMatches.content[0]?.type === "text" ? noMatches.content[0].text.includes(scopeDisplay.text) : false, true);
  const unsafeMatchPath = "src/a\\literal\nb.ts";
  const match = normalizeMatchSummary(unsafeMatchPath, searchMatch());
  const withMatch = formatSearchResult("typescript", unsafeScope, normalizedSearch(), 1, false, [match]);
  assert.equal(withMatch.details.scope, unsafeScope);
  assert.equal(withMatch.details.matches[0]?.path, unsafeMatchPath);
  assert.equal(withMatch.content[0]?.type === "text"
    ? withMatch.content[0].text.includes(formatPathForDisplay(unsafeMatchPath, 32 * 1024).text)
    : false, true);
  assert.equal(withMatch.content[0]?.type === "text" ? withMatch.content[0].text.includes("\u202E") : true, false);

  const before = "foo(a);\r\n\x1b[31m";
  const after = "bar(a);\r\n\x1b[0m";
  const plan = {
    path: "src/unsafe\x1b\r.ts",
    canonicalPath: "/workspace/sample.ts",
    source: Buffer.from(before),
    output: Buffer.from(after),
    sourceSha256: "a".repeat(64),
    outputSha256: "b".repeat(64),
    previewId: "c".repeat(64),
    edits: [{
      range: sourceRange(0, 7),
      replacementRange: { start: 0, end: 7 },
      before: Buffer.from(before),
      after: Buffer.from(after),
    }],
    summaries: [{
      range: sourceRange(0, 7),
      replacementRange: { start: 0, end: 7 },
      before,
      after,
    }],
    mode: 0o644,
  } satisfies EditPlan;
  const preview = formatPreviewResult(plan);
  assert.equal(preview.details.edits[0]!.before, "foo(a);\\x0d\n\\x1b[31m");
  assert.equal(preview.details.edits[0]!.after, "bar(a);\\x0d\n\\x1b[0m");
  assert.equal(preview.details.path, "src/unsafe\x1b\r.ts");
  assert.equal(preview.content[0]?.type === "text" ? preview.content[0].text.includes("\x1b") : true, false);
  assert.equal(preview.content[0]?.type === "text" ? preview.content[0].text.includes(formatPathForDisplay(plan.path, 32 * 1024).text) : false, true);
  const applied = formatApplyResult(plan, plan.previewId);
  assert.equal(applied.details.path, "src/unsafe\x1b\r.ts");
  assert.equal(applied.content[0]?.type === "text" ? applied.content[0].text.includes("\x1b") : true, false);
  assert.equal(applied.content[0]?.type === "text" ? applied.content[0].text.includes(formatPathForDisplay(plan.path, 32 * 1024).text) : false, true);
});

test("formatter fails rather than returning zero progress when one match cannot fit", () => {
  const hugePath = "x".repeat(60 * 1024);
  const summary = {
    path: hugePath,
    range: sourceRange(0, 1),
    text: "x",
    metaVariables: [],
  };
  assert.throws(
    () => formatSearchResult("typescript", ".", normalizedSearch({ limit: 1 }), 1, false, [summary]),
    /lossless display budget/u,
  );
});

test("complete edit preview refuses truncation and never signs an omitted change", () => {
  const source = Buffer.from("x");
  const plan = {
    path: "sample.ts",
    canonicalPath: "/workspace/sample.ts",
    source,
    output: Buffer.from("y"),
    sourceSha256: "a".repeat(64),
    outputSha256: "b".repeat(64),
    previewId: "c".repeat(64),
    edits: [{
      range: sourceRange(0, 1),
      replacementRange: { start: 0, end: 1 },
      before: source,
      after: Buffer.from("y"),
    }],
    summaries: [{
      range: sourceRange(0, 1),
      replacementRange: { start: 0, end: 1 },
      before: "x".repeat(33 * 1024),
      after: "y",
    }],
    mode: 0o644,
  } satisfies EditPlan;
  assert.throws(() => formatPreviewResult(plan), /complete ast-grep preview exceeds/u);
});

test("progress updates are typed, deterministic, throttled, and abort-aware", () => {
  let now = 0;
  const record = operationRecord(() => now);
  const updates: Array<{ details: AstGrepSearchToolDetails }> = [];
  const reporter = new ProgressReporter<AstGrepSearchToolDetails>((update) => updates.push(update), record, "search", "src\x1b[31m");
  reporter.update("waiting-file", 0);
  reporter.update("waiting-file", 0);
  now = 100;
  reporter.update("query", 1);
  now = 500;
  reporter.update("query", 2);
  assert.equal(updates.length, 2);
  assert.deepEqual(updates.map((update) => update.details.kind), ["progress", "progress"]);
  assert.match(updates[0]!.details.kind === "progress" ? updates[0]!.details.scope : "", /\\u001b/u);
  record.controller.abort();
  assert.throws(() => reporter.update("formatting", 2), /aborted/u);
});

test("bounded errors redact workspace/home paths and cap diagnostics", () => {
  const workspace = "/private/workspace-token";
  const error = boundedToolError(new Error(`${homedir()} ${workspace} ${"line\n".repeat(1000)}`), [workspace]);
  assert.doesNotMatch(error.message, new RegExp(workspace, "u"));
  assert.doesNotMatch(error.message, new RegExp(homedir().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(error.message, /<home> <workspace>/u);
  assert.ok(Buffer.byteLength(error.message) <= 24 * 1024 + 64);
  assert.ok(error.message.split("\n").length <= 201);
});
