import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [installRoot, workspace] = process.argv.slice(2);
assert.ok(installRoot && workspace, "usage: packed-host-smoke.mjs <clean-install-root> <workspace>");

const piEntry = join(installRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
const { discoverAndLoadExtensions } = await import(pathToFileURL(piEntry).href);
const extensionRoot = join(installRoot, "node_modules", "pi-ast-grep-dev");
const agentDir = join(installRoot, "empty-agent-dir");
await mkdir(agentDir, { recursive: true });
const loaded = await discoverAndLoadExtensions([extensionRoot], workspace, agentDir);
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);
const extension = loaded.extensions[0];
const search = extension.tools.get("ast_grep_search")?.definition;
const edit = extension.tools.get("ast_grep_edit")?.definition;
assert.ok(search && edit, "the packed extension must register both public tools through Pi's loader");

const source = "const value = oldName(first);\n";
const changed = "// concurrent change\nconst value = oldName(first);\n";
const path = join(workspace, "sample.ts");
await writeFile(path, source, "utf8");
const context = { cwd: workspace };
const invoke = (tool, id, params) => tool.execute(
  id,
  params,
  new AbortController().signal,
  () => undefined,
  context,
);

try {
  const found = await invoke(search, "packed-search", {
    path: "sample.ts",
    language: "typescript",
    pattern: "oldName($A)",
  });
  assert.equal(found.details.kind, "search");
  assert.equal(found.details.totalMatches, 1);

  const preview = await invoke(edit, "packed-preview", {
    action: "preview",
    path: "sample.ts",
    language: "typescript",
    pattern: "oldName($A)",
    rewrite: "newName($A)",
  });
  assert.equal(preview.details.kind, "edit-preview");
  assert.ok(preview.details.previewId);
  assert.equal(await readFile(path, "utf8"), source);

  await writeFile(path, changed, "utf8");
  await assert.rejects(invoke(edit, "packed-stale", {
    action: "apply",
    path: "sample.ts",
    language: "typescript",
    pattern: "oldName($A)",
    rewrite: "newName($A)",
    previewId: preview.details.previewId,
  }), /previewId is stale/u);
  assert.equal(await readFile(path, "utf8"), changed);

  await writeFile(path, source, "utf8");
  const applied = await invoke(edit, "packed-apply", {
    action: "apply",
    path: "sample.ts",
    language: "typescript",
    pattern: "oldName($A)",
    rewrite: "newName($A)",
    previewId: preview.details.previewId,
  });
  assert.equal(applied.details.kind, "edit-apply");
  assert.equal(await readFile(path, "utf8"), "const value = newName(first);\n");
} finally {
  for (const handler of extension.handlers.get("session_shutdown") ?? []) {
    await handler({ type: "session_shutdown" }, context);
  }
}

process.stdout.write("PACKED_PI_SMOKE_OK\n");
