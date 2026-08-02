import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult, EditToolDetails, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHashlineEditTool } from "../src/edit-tool.ts";
import { createHashlineReadTool } from "../src/read-tool.ts";
import type { HashlineRuntime } from "../src/runtime.ts";
import { RecoveryStore } from "../src/recovery.ts";
import { SnapshotStore, type SnapshotRecord } from "../src/snapshots.ts";
import type { HashlineSnapshotEntryV1 } from "../src/persistence.ts";

interface TestRuntime {
  readonly runtime: HashlineRuntime;
  readonly store: SnapshotStore;
  readonly entries: HashlineSnapshotEntryV1[];
}

function makeRuntime(): TestRuntime {
  const store = new SnapshotStore();
  const recovery = new RecoveryStore();
  const entries: HashlineSnapshotEntryV1[] = [];
  return {
    store,
    entries,
    runtime: {
      getGeneration: () => 1,
      getStore: () => store,
      getRecoveryBytes: (canonicalPath, token) => recovery.get(canonicalPath, token),
      commitRecord(record: SnapshotRecord, entry: HashlineSnapshotEntryV1, recoveryBytes?: Buffer): void {
        entries.push(entry);
        store.put(record);
        if (recoveryBytes) recovery.put(record, recoveryBytes);
      },
    },
  };
}

function context(cwd: string): ExtensionContext {
  return { cwd, model: { input: ["text"] } } as unknown as ExtensionContext;
}

function textOf(result: AgentToolResult<unknown>): string {
  const content = result.content.find((item) => item.type === "text");
  assert.ok(content && content.type === "text");
  return content.text;
}

function tokenOf(result: AgentToolResult<unknown>): string {
  const text = textOf(result);
  const match = text.match(/snapshot="(h1_[A-Za-z0-9_-]{43})"/);
  assert.ok(match, text);
  return match[1];
}

async function fixture(t: test.TestContext, content: string): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "hashline-cr-only-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "fixture.txt");
  await writeFile(path, content, "utf8");
  return { root, path };
}

test("read applies offset/limit to CR-only files through Hashline physical lines", async (t) => {
  const { root } = await fixture(t, "one\rtwo\rthree\rfour\r");
  const state = makeRuntime();
  const tool = createHashlineReadTool(state.runtime);
  const result = await tool.execute("cr-range", { path: "fixture.txt", offset: 2, limit: 2 }, undefined, undefined, context(root));
  const text = textOf(result);
  assert.match(text, /^\[hashline .*snapshot="h1_/);
  assert.match(text, /\n2:two\n3:three/);
  assert.doesNotMatch(text, /1:one|4:four/);
  const canonical = await realpath(join(root, "fixture.txt"));
  const token = tokenOf(result);
  assert.deepEqual(state.store.get(canonical, token as `h1_${string}`)?.seen, [{ start: 2, end: 3 }]);
});

test("CR-only edit details report the true first changed line and a local hunk", async (t) => {
  const content = `${Array.from({ length: 10 }, (_, index) => `line-${index + 1}`).join("\r")}\r`;
  const { root, path } = await fixture(t, content);
  const state = makeRuntime();
  const readTool = createHashlineReadTool(state.runtime);
  const editTool = createHashlineEditTool(state.runtime);
  const snapshot = tokenOf(await readTool.execute("full", { path: "fixture.txt" }, undefined, undefined, context(root)));
  const result = await editTool.execute(
    "cr-edit",
    { path: "fixture.txt", snapshot, edits: [{ op: "replace", start: 2, lines: ["TWO"] }] },
    undefined,
    undefined,
    context(root),
  );
  assert.equal(await readFile(path, "utf8"), content.replace("line-2", "TWO"));
  const details = result.details as EditToolDetails | undefined;
  assert.ok(details, "successful edits carry built-in details");
  assert.equal(details.firstChangedLine, 2);
  assert.match(details.diff, /^\s+1 line-1$/m);
  assert.match(details.diff, /^-\s+2 line-2$/m);
  assert.match(details.diff, /^\+\s+2 TWO$/m);
  assert.match(details.patch, /^@@ -1,6 \+1,6 @@$/m);
  assert.doesNotMatch(details.diff, /line-7|line-8|line-9|line-10/);
  assert.doesNotMatch(details.patch, /line-7|line-8|line-9|line-10/);
});

test("a ~74KB CR-only file stays editable with bounded details", async (t) => {
  // 2000 lines × (36 chars + CR) = 74,000 bytes: before the LF-normalized
  // details fix this collapsed into a whole-file single-line patch that
  // exceeded the 256KiB details budget and refused the edit with E_TOO_LARGE.
  const content = `${Array.from({ length: 2_000 }, (_, index) => `line-${index + 1}`.padEnd(36, ".")).join("\r")}\r`;
  assert.equal(Buffer.byteLength(content, "utf8"), 74_000);
  const expected = `${Array.from({ length: 2_000 }, (_, index) => (index === 1 ? "TWO" : `line-${index + 1}`.padEnd(36, "."))).join("\r")}\r`;
  const { root, path } = await fixture(t, content);
  const state = makeRuntime();
  const readTool = createHashlineReadTool(state.runtime);
  const editTool = createHashlineEditTool(state.runtime);
  const snapshot = tokenOf(await readTool.execute("full", { path: "fixture.txt" }, undefined, undefined, context(root)));
  const result = await editTool.execute(
    "cr-large-edit",
    { path: "fixture.txt", snapshot, edits: [{ op: "replace", start: 2, lines: ["TWO"] }] },
    undefined,
    undefined,
    context(root),
  );
  assert.equal(await readFile(path, "utf8"), expected);
  const details = result.details as EditToolDetails | undefined;
  assert.ok(details);
  assert.equal(details.firstChangedLine, 2);
  assert.match(details.patch, /^-line-2/m);
  assert.match(details.patch, /^\+TWO/m);
});
