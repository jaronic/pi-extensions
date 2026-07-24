import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { DocumentSymbol, Location, WorkspaceEdit } from "vscode-languageserver-protocol";
import {
  formatDocumentSymbols,
  formatLocations,
  formatWorkspaceEdit,
  workspaceEditCount,
} from "../src/format.ts";
import { LspOutputStore } from "../src/output.ts";

const range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 1 },
};

test("formatters report only genuinely omitted unique results", () => {
  const cwd = "/workspace";
  const location: Location = {
    uri: pathToFileURL(join(cwd, "sample.ts")).href,
    range,
  };
  assert.equal(formatLocations([location, location], cwd, 100), "sample.ts:1:1");

  const symbol: DocumentSymbol = {
    name: "root",
    kind: 13,
    range,
    selectionRange: range,
  };
  assert.equal(formatDocumentSymbols([symbol], cwd, 1).includes("omitted"), false);
  assert.match(formatDocumentSymbols([{ ...symbol, children: [{ ...symbol, name: "child" }] }], cwd, 1), /… 1 more symbol\(s\) omitted/);

  const exactEdit: WorkspaceEdit = { changes: { [location.uri]: [{ range, newText: "x" }] } };
  assert.equal(formatWorkspaceEdit(exactEdit, cwd, 1).includes("omitted"), false);
  const twoEdits: WorkspaceEdit = { changes: { [location.uri]: [{ range, newText: "x" }, { range, newText: "y" }] } };
  assert.match(formatWorkspaceEdit(twoEdits, cwd, 1), /… 1 more edit\(s\) omitted/);
});

test("workspace edit formatting and artifacts preserve every original replacement", async () => {
  const cwd = "/workspace";
  const uri = pathToFileURL(join(cwd, "sample.ts")).href;
  const edits = Array.from({ length: 300 }, (_, index) => ({
    range: {
      start: { line: index, character: 0 },
      end: { line: index, character: 1 },
    },
    newText: `${"x".repeat(220)}__TAIL_MARKER_${index}`,
  }));
  const edit: WorkspaceEdit = {
    documentChanges: [{ textDocument: { uri, version: 1 }, edits }],
  };
  const formatted = formatWorkspaceEdit(edit, cwd, 500);
  assert.equal(workspaceEditCount(edit), 300);
  assert.match(formatted, /__TAIL_MARKER_299/);

  const store = new LspOutputStore();
  try {
    const bounded = await store.bound(formatted);
    assert.ok(bounded.fullOutputPath);
    assert.match(await readFile(bounded.fullOutputPath, "utf8"), /__TAIL_MARKER_299/);
  } finally {
    await store.cleanup();
  }
});
