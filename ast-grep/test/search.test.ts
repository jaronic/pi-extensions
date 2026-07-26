import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import test from "node:test";
import { executeSearch } from "../src/search.ts";
import type { DecodedMatch } from "../src/types.ts";
import {
  fakeRunner,
  normalizedSearch,
  operationRecord,
  searchMatch,
  sourceRange,
  temporaryWorkspace,
} from "./helpers.ts";

function emittingRunner(records: readonly DecodedMatch[]) {
  return fakeRunner(async (_request, onRecord) => {
    for (const record of records) await onRecord(record);
    return { records: records.length };
  });
}

test("exact-file search validates STDIN ranges and paginates deterministically", async (t) => {
  const root = await temporaryWorkspace(t, "pi-ast-grep-search-file-");
  await writeFile(`${root}/sample.ts`, "foo(x)\nfoo(y)\n", "utf8");
  const records = [
    searchMatch({ text: "foo(y)", lines: "foo(y)", range: sourceRange(7, 13, 1, 0, 6) }),
    searchMatch({ text: "foo(x)", lines: "foo(x)", range: sourceRange(0, 6, 0, 0, 6) }),
  ];
  const result = await executeSearch(
    normalizedSearch({ path: "sample.ts", limit: 1, offset: 1 }),
    root,
    operationRecord(),
    emittingRunner(records),
    undefined,
  );
  assert.equal(result.details.totalMatches, 2);
  assert.equal(result.details.returnedMatches, 1);
  assert.equal(result.details.matches[0]!.text, "foo(y)");
  assert.equal(result.details.matches[0]!.path, "sample.ts");
  assert.equal(result.details.resultLimited, false);
});

test("directory search validates result filenames and sorts out-of-order records", async (t) => {
  const root = await temporaryWorkspace(t, "pi-ast-grep-search-directory-");
  await mkdir(`${root}/src`);
  await writeFile(`${root}/src/a.ts`, "foo(a)\n", "utf8");
  await writeFile(`${root}/src/b.ts`, "foo(b)\nfoo(c)\n", "utf8");
  const records = [
    searchMatch({ file: "src/b.ts", text: "foo(c)", range: sourceRange(7, 13, 1, 0, 6) }),
    searchMatch({ file: "src/a.ts", text: "foo(a)", range: sourceRange(0, 6) }),
    searchMatch({ file: "src/b.ts", text: "foo(b)", range: sourceRange(0, 6) }),
  ];
  let observedScope: string | undefined;
  let observedGlobs: readonly string[] | undefined;
  const runner = fakeRunner(async (request, onRecord) => {
    if (request.mode !== "error-guard") {
      observedScope = request.directoryScope;
      observedGlobs = request.globs;
    }
    for (const record of records) await onRecord(record);
    return { records: records.length };
  });
  const result = await executeSearch(
    normalizedSearch({ path: "src", globs: ["*.ts", "!generated.ts"], limit: 2 }),
    root,
    operationRecord(),
    runner,
    undefined,
  );
  assert.equal(observedScope, "src");
  assert.deepEqual(observedGlobs, ["*.ts", "!generated.ts"]);
  assert.equal(result.details.totalMatches, 3);
  assert.deepEqual(result.details.matches.map((match) => [match.path, match.range.byteOffset.start]), [
    ["src/a.ts", 0],
    ["src/b.ts", 0],
  ]);
  assert.equal(result.details.nextOffset, 2);
});

test("search rejects forged native paths and exact-file protocol drift", async (t) => {
  const root = await temporaryWorkspace(t, "pi-ast-grep-search-forged-");
  await mkdir(`${root}/src`);
  await writeFile(`${root}/src/sample.ts`, "foo(x)\n", "utf8");
  await assert.rejects(executeSearch(
    normalizedSearch({ path: "src" }),
    root,
    operationRecord(),
    emittingRunner([searchMatch({ file: "../outside.ts" })]),
    undefined,
  ), /invalid components|outside the requested directory scope/u);

  await assert.rejects(executeSearch(
    normalizedSearch({ path: "src/sample.ts" }),
    root,
    operationRecord(),
    emittingRunner([searchMatch({ file: "src/sample.ts" })]),
    undefined,
  ), /exact-file result must use the STDIN sentinel/u);

  await assert.rejects(executeSearch(
    normalizedSearch({ path: "src/sample.ts" }),
    root,
    operationRecord(),
    emittingRunner([searchMatch({ text: "foo(y)" })]),
    undefined,
  ), /text disagrees with the bounded source snapshot/u);
});

test("exact-file search refuses directory globs before native execution", async (t) => {
  const root = await temporaryWorkspace(t, "pi-ast-grep-search-globs-");
  await writeFile(`${root}/sample.ts`, "foo(x)\n", "utf8");
  let invoked = false;
  const runner = fakeRunner(async () => {
    invoked = true;
    return { records: 0 };
  });
  await assert.rejects(executeSearch(
    normalizedSearch({ path: "sample.ts", globs: ["*.ts"] }),
    root,
    operationRecord(),
    runner,
    undefined,
  ), /globs are only valid for directory searches/u);
  assert.equal(invoked, false);
});
