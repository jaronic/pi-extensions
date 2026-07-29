import assert from "node:assert/strict";
import test from "node:test";
import { link, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWriteToolDefinition, withFileMutationQueue, type AgentToolResult, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHashlineEditTool } from "../src/edit-tool.ts";
import { createHashlineReadTool } from "../src/read-tool.ts";
import { RecoveryStore } from "../src/recovery.ts";
import type { HashlineRuntime } from "../src/runtime.ts";
import { SnapshotStore, type SnapshotRecord } from "../src/snapshots.ts";
import type { HashlineSnapshotEntryV1 } from "../src/persistence.ts";
import { MAX_EDITABLE_FILE_BYTES, type HashlineEditInput } from "../src/schemas.ts";

interface TestRuntime {
  readonly runtime: HashlineRuntime;
  readonly store: SnapshotStore;
  readonly entries: HashlineSnapshotEntryV1[];
  setGeneration(value: number): void;
  failNextCommit(): void;
}

function makeRuntime(): TestRuntime {
  const store = new SnapshotStore();
  const recovery = new RecoveryStore();
  const entries: HashlineSnapshotEntryV1[] = [];
  let generation = 1;
  let nextFailure = false;
  return {
    store,
    entries,
    setGeneration: (value) => {
      generation = value;
    },
    failNextCommit: () => {
      nextFailure = true;
    },
    runtime: {
      getGeneration: () => generation,
      getStore: () => store,
      getRecoveryBytes: (canonicalPath, token) => recovery.get(canonicalPath, token),
      commitRecord(record: SnapshotRecord, entry: HashlineSnapshotEntryV1, recoveryBytes?: Buffer): void {
        if (nextFailure) {
          nextFailure = false;
          throw new Error("injected journal failure");
        }
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

function tokenFromText(text: string): string {
  const match = text.match(/snapshot="(h1_[A-Za-z0-9_-]{43})"/);
  assert.ok(match, text);
  return match[1];
}

function tokenOf(result: AgentToolResult<unknown>): string {
  return tokenFromText(textOf(result));
}

async function rejectionText(promise: Promise<unknown>): Promise<string> {
  let rejected = false;
  let reason: unknown;
  try {
    await promise;
  } catch (error) {
    rejected = true;
    reason = error;
  }
  assert.equal(rejected, true, "expected tool call to reject");
  return String(reason);
}

async function fixture(t: test.TestContext, content = "one\ntwo\nthree\nfour\n"): Promise<{ root: string; path: string }> {
  const root = await mkdtemp(join(tmpdir(), "hashline-tools-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "fixture.txt");
  await writeFile(path, content, "utf8");
  return { root, path };
}

test("read numbers only returned rows and unions repeated seen ranges", async (t) => {
  const { root } = await fixture(t, "one\ntwo\nthree\nfour\nfive\nsix\n");
  const state = makeRuntime();
  const tool = createHashlineReadTool(state.runtime);
  const first = await tool.execute("r1", { path: "fixture.txt", offset: 2, limit: 2 }, undefined, undefined, context(root));
  assert.match(textOf(first), /^\[hashline .*\]\n2:two\n3:three/m);
  assert.doesNotMatch(textOf(first), /1:one/);
  const token = tokenOf(first);
  await tool.execute("r2", { path: "fixture.txt", offset: 4, limit: 2 }, undefined, undefined, context(root));
  const canonical = await realpath(join(root, "fixture.txt"));
  assert.deepEqual(state.store.get(canonical, token as `h1_${string}`)?.seen, [{ start: 2, end: 5 }]);
});

test("read journal failure, invalid text, long or large files, and images never mint unsafe tokens", async (t) => {
  const { root } = await fixture(t);
  const state = makeRuntime();
  const tool = createHashlineReadTool(state.runtime);
  state.failNextCommit();
  const failedJournal = await tool.execute("journal", { path: "fixture.txt" }, undefined, undefined, context(root));
  assert.doesNotMatch(textOf(failedJournal), /snapshot="h1_/);
  assert.match(textOf(failedJournal), /snapshot unavailable/);

  await writeFile(join(root, "invalid.bin"), Buffer.from([0xc3, 0x28]));
  const invalid = await tool.execute("invalid", { path: "invalid.bin" }, undefined, undefined, context(root));
  assert.doesNotMatch(textOf(invalid), /snapshot="h1_/);

  await writeFile(join(root, "long.txt"), `${"x".repeat(65_537)}\n`);
  const long = await tool.execute("long", { path: "long.txt" }, undefined, undefined, context(root));
  assert.doesNotMatch(textOf(long), /snapshot="h1_/);

  const largeBytes = Buffer.alloc(MAX_EDITABLE_FILE_BYTES + 1, 0x61);
  for (let offset = 99; offset < largeBytes.length; offset += 100) largeBytes[offset] = 0x0a;
  await writeFile(join(root, "large.txt"), largeBytes);
  const large = await tool.execute("large", { path: "large.txt", limit: 1 }, undefined, undefined, context(root));
  assert.match(textOf(large), /a/);
  assert.doesNotMatch(textOf(large), /snapshot="h1_/);

  const onePixelBmp = Buffer.alloc(58);
  onePixelBmp.write("BM", 0, "ascii");
  onePixelBmp.writeUInt32LE(58, 2);
  onePixelBmp.writeUInt32LE(54, 10);
  onePixelBmp.writeUInt32LE(40, 14);
  onePixelBmp.writeInt32LE(1, 18);
  onePixelBmp.writeInt32LE(1, 22);
  onePixelBmp.writeUInt16LE(1, 26);
  onePixelBmp.writeUInt16LE(24, 28);
  onePixelBmp.writeUInt32LE(4, 34);
  onePixelBmp.set([0x00, 0x00, 0xff, 0x00], 54);
  await writeFile(join(root, "pixel.bmp"), onePixelBmp);
  const image = await tool.execute("image", { path: "pixel.bmp" }, undefined, undefined, context(root));
  assert.ok(image.content.some((item) => item.type === "image"));
  assert.doesNotMatch(textOf(image), /snapshot="h1_/);

  await writeFile(join(root, "broken.gif"), "GIF89a", "utf8");
  const brokenImage = await tool.execute("broken-image", { path: "broken.gif" }, undefined, undefined, context(root));
  assert.doesNotMatch(textOf(brokenImage), /^\[hashline /);
  assert.doesNotMatch(textOf(brokenImage), /snapshot="h1_/);
  assert.equal(state.entries.length, 0);
  await assert.rejects(
    tool.execute("directory", { path: "." }, undefined, undefined, context(root)),
    /\[E_NOT_EDITABLE\].*regular file/,
  );
});

test("control characters in authored paths stay escaped in read and edit output", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hashline-path-output-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const name = "odd\n\"name.txt";
  const path = join(root, name);
  await writeFile(path, "line\n", "utf8");
  const state = makeRuntime();
  const readTool = createHashlineReadTool(state.runtime);
  const read = await readTool.execute("path-read", { path: name }, undefined, undefined, context(root));
  const readText = textOf(read);
  assert.ok(readText.split("\n", 1)[0].includes(JSON.stringify(name)));
  assert.equal(readText.includes(name), false);

  const edited = await createHashlineEditTool(state.runtime).execute(
    "path-edit",
    { path: name, snapshot: tokenOf(read), edits: [{ op: "replace", start: 1, lines: ["LINE"] }] },
    undefined,
    undefined,
    context(root),
  );
  const expectedPath = JSON.stringify(name).slice(1, -1);
  assert.equal(textOf(edited).split("\n", 1)[0], `Updated ${expectedPath} with 1 hashline edit (+1/-1 lines).`);
  assert.equal(textOf(edited).includes(name), false);
  assert.equal(await readFile(path, "utf8"), "LINE\n");
});

test("unknown, wrong-path, unseen, stale, no-op, and emptying edits are zero-write failures", async (t) => {
  const { root, path } = await fixture(t);
  const secondPath = join(root, "second.txt");
  await writeFile(secondPath, await readFile(path));
  const state = makeRuntime();
  const readTool = createHashlineReadTool(state.runtime);
  const editTool = createHashlineEditTool(state.runtime);
  const partial = await readTool.execute("partial", { path: "fixture.txt", offset: 1, limit: 1 }, undefined, undefined, context(root));
  const token = tokenOf(partial);
  const original = await readFile(path, "utf8");

  await assert.rejects(
    editTool.execute("wrong-path", { path: "second.txt", snapshot: token, edits: [{ op: "replace", start: 1, lines: ["ONE"] }] }, undefined, undefined, context(root)),
    /\[E_PATH_MISMATCH\]/,
  );
  const unseenMessage = await rejectionText(
    editTool.execute("unseen", { path: "fixture.txt", snapshot: token, edits: [{ op: "replace", start: 2, lines: ["TWO"] }] }, undefined, undefined, context(root)),
  );
  assert.match(unseenMessage, /\[E_UNSEEN_LINE\].*snapshot=/s);
  assert.equal(tokenFromText(unseenMessage), token);
  const noChangeMessage = await rejectionText(
    editTool.execute("noop", { path: "fixture.txt", snapshot: token, edits: [{ op: "replace", start: 1, lines: ["one"] }] }, undefined, undefined, context(root)),
  );
  assert.match(noChangeMessage, /\[E_NO_CHANGE\].*snapshot=/s);
  assert.equal(tokenFromText(noChangeMessage), token);
  const full = await readTool.execute("full", { path: "fixture.txt" }, undefined, undefined, context(root));
  await assert.rejects(
    editTool.execute("empty", { path: "fixture.txt", snapshot: tokenOf(full), edits: [{ op: "delete", start: 1, end: 4 }] }, undefined, undefined, context(root)),
    /\[E_WOULD_EMPTY\]/,
  );
  await writeFile(path, original.replace("one", "external"), "utf8");
  await assert.rejects(
    editTool.execute("stale", { path: "fixture.txt", snapshot: tokenOf(full), edits: [{ op: "replace", start: 2, lines: ["TWO"] }] }, undefined, undefined, context(root)),
    /\[E_STALE_SNAPSHOT\]/,
  );
  assert.equal(await readFile(path, "utf8"), original.replace("one", "external"));

  const unknownState = makeRuntime();
  const unknownTool = createHashlineEditTool(unknownState.runtime);
  const unknownMessage = await rejectionText(
    unknownTool.execute("unknown", { path: "fixture.txt", snapshot: tokenOf(full), edits: [{ op: "replace", start: 1, lines: ["x"] }] }, undefined, undefined, context(root)),
  );
  assert.match(unknownMessage, /\[E_SNAPSHOT_UNKNOWN\].*snapshot=/s);
  await unknownTool.execute(
    "unknown-retry",
    { path: "fixture.txt", snapshot: tokenFromText(unknownMessage), edits: [{ op: "replace", start: 1, lines: ["x"] }] },
    undefined,
    undefined,
    context(root),
  );
  assert.equal(await readFile(path, "utf8"), original.replace("one", "x"));
});

test("semantic failures return reusable snapshots and hide current rows if refresh journaling fails", async (t) => {
  const { root, path } = await fixture(t);
  const state = makeRuntime();
  const readTool = createHashlineReadTool(state.runtime);
  const editTool = createHashlineEditTool(state.runtime);
  const token = tokenOf(await readTool.execute("full", { path: "fixture.txt" }, undefined, undefined, context(root)));

  const rangeMessage = await rejectionText(
    editTool.execute("range", { path: "fixture.txt", snapshot: token, edits: [{ op: "replace", start: 99, lines: ["x"] }] }, undefined, undefined, context(root)),
  );
  assert.match(rangeMessage, /\[E_RANGE\].*edits\[0\]\.start.*snapshot=.*2:two.*4:four/s);
  assert.equal(tokenFromText(rangeMessage), token);

  const conflictMessage = await rejectionText(
    editTool.execute(
      "conflict",
      {
        path: "fixture.txt",
        snapshot: token,
        edits: [
          { op: "replace", start: 1, end: 2, lines: ["ONE", "TWO"] },
          { op: "delete", start: 2 },
        ],
      },
      undefined,
      undefined,
      context(root),
    ),
  );
  assert.match(conflictMessage, /\[E_EDIT_CONFLICT\].*edits\[0\].*edits\[1\].*snapshot=/s);
  assert.equal(tokenFromText(conflictMessage), token);

  const emptyMessage = await rejectionText(
    editTool.execute("empty", { path: "fixture.txt", snapshot: token, edits: [{ op: "delete", start: 1, end: 4 }] }, undefined, undefined, context(root)),
  );
  assert.match(emptyMessage, /\[E_WOULD_EMPTY\].*Use write.*snapshot=.*1:one.*4:four/s);
  assert.equal(tokenFromText(emptyMessage), token);
  assert.equal(await readFile(path, "utf8"), "one\ntwo\nthree\nfour\n");

  state.failNextCommit();
  const unjournaledMessage = await rejectionText(
    editTool.execute("unjournaled-range", { path: "fixture.txt", snapshot: token, edits: [{ op: "replace", start: 99, lines: ["x"] }] }, undefined, undefined, context(root)),
  );
  assert.match(unjournaledMessage, /\[E_RANGE\].*could not be safely journaled.*Use read/s);
  assert.doesNotMatch(unjournaledMessage, /snapshot="h1_/);
  assert.doesNotMatch(unjournaledMessage, /\n[1-4]:(?:one|two|three|four)/);

  await editTool.execute(
    "corrected",
    { path: "fixture.txt", snapshot: tokenFromText(rangeMessage), edits: [{ op: "replace", start: 4, lines: ["FOUR"] }] },
    undefined,
    undefined,
    context(root),
  );
  assert.equal(await readFile(path, "utf8"), "one\ntwo\nthree\nFOUR\n");
});

test("successful edit has built-in details shape and journal failure stays a truthful success", async (t) => {
  const { root, path } = await fixture(t);
  const state = makeRuntime();
  const readTool = createHashlineReadTool(state.runtime);
  const editTool = createHashlineEditTool(state.runtime);
  const read = await readTool.execute("read", { path: "fixture.txt" }, undefined, undefined, context(root));
  state.failNextCommit();
  const edited = await editTool.execute(
    "edit",
    { path: "fixture.txt", snapshot: tokenOf(read), edits: [{ op: "replace", start: 2, lines: ["TWO"] }] },
    undefined,
    undefined,
    context(root),
  );
  assert.equal(await readFile(path, "utf8"), "one\nTWO\nthree\nfour\n");
  assert.match(textOf(edited), /file was updated.*no follow-up snapshot/is);
  assert.doesNotMatch(textOf(edited), /snapshot="h1_/);
  assert.deepEqual(Object.keys(edited.details ?? {}).sort(), ["diff", "firstChangedLine", "patch"]);
});
test("post-write close failure reports unknown state and never persists a follow-up snapshot", async (t) => {
  const { root, path } = await fixture(t);
  const state = makeRuntime();
  const readTool = createHashlineReadTool(state.runtime);
  const snapshot = tokenOf(await readTool.execute("read", { path: "fixture.txt" }, undefined, undefined, context(root)));
  const entriesBeforeEdit = state.entries.length;
  const editTool = createHashlineEditTool(state.runtime, {
    closeHandle: async (handle) => {
      await handle.close();
      throw new Error("injected close failure");
    },
  });
  await assert.rejects(
    editTool.execute("close-fail", { path: "fixture.txt", snapshot, edits: [{ op: "replace", start: 1, lines: ["ONE"] }] }, undefined, undefined, context(root)),
    /\[E_WRITE_FAILED\].*Closing.*may be changed/,
  );
  assert.equal(await readFile(path, "utf8"), "ONE\ntwo\nthree\nfour\n");
  assert.equal(state.entries.length, entriesBeforeEdit);
});
test("one hundred disjoint edit regions produce a bounded follow-up preview", async (t) => {
  const content = `${Array.from({ length: 1_000 }, (_, index) => `line-${index + 1}`).join("\n")}\n`;
  const { root, path } = await fixture(t, content);
  const state = makeRuntime();
  const readTool = createHashlineReadTool(state.runtime);
  const snapshot = tokenOf(await readTool.execute("read", { path: "fixture.txt" }, undefined, undefined, context(root)));
  const edits = Array.from({ length: 100 }, (_, index) => ({
    op: "replace" as const,
    start: index * 10 + 1,
    lines: [`changed-${index + 1}`],
  }));
  const result = await createHashlineEditTool(state.runtime).execute(
    "many-regions",
    { path: "fixture.txt", snapshot, edits },
    undefined,
    undefined,
    context(root),
  );
  assert.match(textOf(result), /Preview truncated/);
  assert.match(textOf(result), /snapshot="h1_/);
  const written = (await readFile(path, "utf8")).split("\n");
  assert.equal(written[0], "changed-1");
  assert.equal(written[990], "changed-100");
});

test("two concurrent edits from one token serialize to one success and one stale rejection", async (t) => {
  const { root, path } = await fixture(t);
  const state = makeRuntime();
  const readTool = createHashlineReadTool(state.runtime);
  const editTool = createHashlineEditTool(state.runtime);
  const snapshot = tokenOf(await readTool.execute("read", { path: "fixture.txt" }, undefined, undefined, context(root)));
  const settled = await Promise.allSettled([
    editTool.execute("a", { path: "fixture.txt", snapshot, edits: [{ op: "replace", start: 1, lines: ["A"] }] }, undefined, undefined, context(root)),
    editTool.execute("b", { path: "fixture.txt", snapshot, edits: [{ op: "replace", start: 1, lines: ["B"] }] }, undefined, undefined, context(root)),
  ]);
  assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1);
  const rejected = settled.find((entry) => entry.status === "rejected");
  assert.ok(rejected && rejected.status === "rejected");
  assert.match(String(rejected.reason), /\[E_STALE_SNAPSHOT\]/);
  assert.match(await readFile(path, "utf8"), /^(A|B)\n/);
});

test("verified recovery rebases an unchanged target after an external insertion", async (t) => {
  const content = "L1\nL2\nL3\nL4\nTARGET\nL6\nL7\nL8\n";
  const { root, path } = await fixture(t, content);
  const state = makeRuntime();
  const readTool = createHashlineReadTool(state.runtime);
  const editTool = createHashlineEditTool(state.runtime);
  const snapshot = tokenOf(await readTool.execute("read", { path: "fixture.txt" }, undefined, undefined, context(root)));
  await writeFile(path, `EXTERNAL\n${content}`, "utf8");

  const result = await editTool.execute(
    "rebase",
    { path: "fixture.txt", snapshot, edits: [{ op: "replace", start: 5, lines: ["MODEL"] }] },
    undefined,
    undefined,
    context(root),
  );
  assert.match(textOf(result), /Rebased stale snapshot: line 5 → line 6 \(\+1\)/);
  assert.equal(await readFile(path, "utf8"), "EXTERNAL\nL1\nL2\nL3\nL4\nMODEL\nL6\nL7\nL8\n");
});

test("concurrent disjoint edits from one token both commit through verified recovery", async (t) => {
  const content = Array.from({ length: 10 }, (_, index) => `L${index + 1}`).join("\n") + "\n";
  const { root, path } = await fixture(t, content);
  const state = makeRuntime();
  const readTool = createHashlineReadTool(state.runtime);
  const editTool = createHashlineEditTool(state.runtime);
  const snapshot = tokenOf(await readTool.execute("read", { path: "fixture.txt" }, undefined, undefined, context(root)));
  const results = await Promise.all([
    editTool.execute("early", { path: "fixture.txt", snapshot, edits: [{ op: "replace", start: 2, lines: ["EARLY"] }] }, undefined, undefined, context(root)),
    editTool.execute("late", { path: "fixture.txt", snapshot, edits: [{ op: "replace", start: 9, lines: ["LATE"] }] }, undefined, undefined, context(root)),
  ]);

  assert.equal(results.filter((result) => /Revalidated stale snapshot/.test(textOf(result))).length, 1);
  assert.equal(await readFile(path, "utf8"), "L1\nEARLY\nL3\nL4\nL5\nL6\nL7\nL8\nLATE\nL10\n");
});

test("symlink retargeting while queued cannot move an edit to a different target", async (t) => {
  const { root, path } = await fixture(t);
  const other = join(root, "other.txt");
  const alias = join(root, "alias.txt");
  await writeFile(other, await readFile(path));
  await symlink(path, alias);

  const state = makeRuntime();
  const readTool = createHashlineReadTool(state.runtime);
  const editTool = createHashlineEditTool(state.runtime);
  const snapshot = tokenOf(await readTool.execute("alias-read", { path: "alias.txt" }, undefined, undefined, context(root)));
  await readTool.execute("other-read", { path: "other.txt" }, undefined, undefined, context(root));

  let markEntered: (() => void) | undefined;
  let releaseGate: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => { markEntered = resolve; });
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const blocker = withFileMutationQueue(path, async () => {
    markEntered?.();
    await gate;
  });
  await entered;

  const rejected = assert.rejects(
    editTool.execute("retarget-while-queued", { path: "alias.txt", snapshot, edits: [{ op: "replace", start: 1, lines: ["WRONG"] }] }, undefined, undefined, context(root)),
    /\[E_PATH_MISMATCH\]/,
  );
  await withFileMutationQueue(join(root, "registration-sentinel"), async () => {});
  await unlink(alias);
  await symlink(other, alias);
  releaseGate?.();

  await Promise.all([blocker, rejected]);
  assert.equal(await readFile(other, "utf8"), "one\ntwo\nthree\nfour\n");
});
test("built-in write serialization makes waiting edits stale or cancellable before validation", async (t) => {
  const { root, path } = await fixture(t);
  const state = makeRuntime();
  const readTool = createHashlineReadTool(state.runtime);
  const editTool = createHashlineEditTool(state.runtime);

  function startGatedWrite(content: string) {
    let markEntered: (() => void) | undefined;
    let releaseGate: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const writer = createWriteToolDefinition(root, {
      operations: {
        mkdir: async () => {},
        writeFile: async (target, nextContent) => {
          markEntered?.();
          await gate;
          await writeFile(target, nextContent, "utf8");
        },
      },
    });
    return {
      entered,
      release: () => releaseGate?.(),
      result: writer.execute("write", { path: "fixture.txt", content }, undefined, undefined, context(root)),
    };
  }

  const staleToken = tokenOf(await readTool.execute("stale-read", { path: "fixture.txt" }, undefined, undefined, context(root)));
  const firstWrite = startGatedWrite("external-one\n");
  await firstWrite.entered;
  const staleEdit = assert.rejects(
    editTool.execute("stale-after-write", { path: "fixture.txt", snapshot: staleToken, edits: [{ op: "replace", start: 1, lines: ["HASHLINE"] }] }, undefined, undefined, context(root)),
    /\[E_STALE_SNAPSHOT\]/,
  );
  firstWrite.release();
  await Promise.all([firstWrite.result, staleEdit]);
  assert.equal(await readFile(path, "utf8"), "external-one\n");

  const abortToken = tokenOf(await readTool.execute("abort-read", { path: "fixture.txt" }, undefined, undefined, context(root)));
  const secondWrite = startGatedWrite("external-two\n");
  await secondWrite.entered;
  const controller = new AbortController();
  const abortedEdit = assert.rejects(
    editTool.execute("abort-after-wait", { path: "fixture.txt", snapshot: abortToken, edits: [{ op: "replace", start: 1, lines: ["HASHLINE"] }] }, controller.signal, undefined, context(root)),
    /\[E_ABORTED\]/,
  );
  controller.abort();
  secondWrite.release();
  await Promise.all([secondWrite.result, abortedEdit]);
  assert.equal(await readFile(path, "utf8"), "external-two\n");
});


test("abort and preparation failures are zero-write; commit abort reports success; write failure is unknown-state", async (t) => {
  const { root, path } = await fixture(t);
  const state = makeRuntime();
  const readTool = createHashlineReadTool(state.runtime);
  const snapshot = tokenOf(await readTool.execute("read", { path: "fixture.txt" }, undefined, undefined, context(root)));
  const params: HashlineEditInput = { path: "fixture.txt", snapshot, edits: [{ op: "replace", start: 1, lines: ["ONE"] }] };
  const original = await readFile(path, "utf8");

  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(createHashlineEditTool(state.runtime).execute("abort", params, aborted.signal, undefined, context(root)), /\[E_ABORTED\]/);
  assert.equal(await readFile(path, "utf8"), original);

  const preparationFailure = createHashlineEditTool(state.runtime, { buildDetails: () => { throw new Error("boom"); } });
  await assert.rejects(preparationFailure.execute("prepare", params, undefined, undefined, context(root)), /\[E_TOO_LARGE\]/);
  assert.equal(await readFile(path, "utf8"), original);

  const duringCommit = new AbortController();
  const commitAbort = createHashlineEditTool(state.runtime, {
    async commitWrite(handle, bytes) {
      duringCommit.abort();
      await handle.truncate(0);
      await handle.writeFile(bytes);
    },
  });
  const committed = await commitAbort.execute("commit-abort", params, duringCommit.signal, undefined, context(root));
  assert.match(textOf(committed), /Updated fixture\.txt/);
  assert.equal(await readFile(path, "utf8"), "ONE\ntwo\nthree\nfour\n");

  const fresh = tokenOf(await readTool.execute("fresh", { path: "fixture.txt" }, undefined, undefined, context(root)));
  const failingWrite = createHashlineEditTool(state.runtime, {
    async commitWrite(handle) {
      await handle.truncate(0);
      throw new Error("disk failure");
    },
  });
  await assert.rejects(
    failingWrite.execute("write-fail", { path: "fixture.txt", snapshot: fresh, edits: [{ op: "replace", start: 1, lines: ["again"] }] }, undefined, undefined, context(root)),
    /\[E_WRITE_FAILED\].*may be partially changed/,
  );
  assert.equal((await readFile(path)).length, 0);
});

test("generation changes isolate pre-commit and post-commit branch state", async (t) => {
  const { root, path } = await fixture(t);
  const state = makeRuntime();
  const readTool = createHashlineReadTool(state.runtime);
  const snapshot = tokenOf(await readTool.execute("read", { path: "fixture.txt" }, undefined, undefined, context(root)));
  const params: HashlineEditInput = { path: "fixture.txt", snapshot, edits: [{ op: "replace", start: 1, lines: ["ONE"] }] };
  const preCommit = createHashlineEditTool(state.runtime, {
    buildDetails: () => {
      state.setGeneration(2);
      return { diff: "prepared", patch: "prepared", firstChangedLine: 1 };
    },
  });
  await assert.rejects(preCommit.execute("tree-before", params, undefined, undefined, context(root)), /\[E_BRANCH_CHANGED\]/);
  assert.equal(await readFile(path, "utf8"), "one\ntwo\nthree\nfour\n");

  state.setGeneration(3);
  const beforeEntries = state.entries.length;
  const postCommit = createHashlineEditTool(state.runtime, {
    async commitWrite(handle, bytes) {
      await handle.truncate(0);
      await handle.writeFile(bytes);
      state.setGeneration(4);
    },
  });
  const result = await postCommit.execute("tree-after", params, undefined, undefined, context(root));
  assert.equal(await readFile(path, "utf8"), "ONE\ntwo\nthree\nfour\n");
  assert.match(textOf(result), /no follow-up snapshot/i);
  assert.equal(state.entries.length, beforeEntries);
});

test("symlink target binding works and retargeting fails; hardlinks are refused", async (t) => {
  const { root, path } = await fixture(t);
  const alias = join(root, "alias.txt");
  await symlink(path, alias);
  const state = makeRuntime();
  const readTool = createHashlineReadTool(state.runtime);
  const editTool = createHashlineEditTool(state.runtime);
  const symlinkRead = await readTool.execute("symlink-read", { path: "alias.txt" }, undefined, undefined, context(root));
  await editTool.execute(
    "symlink-edit",
    { path: "alias.txt", snapshot: tokenOf(symlinkRead), edits: [{ op: "replace", start: 1, lines: ["ONE"] }] },
    undefined,
    undefined,
    context(root),
  );
  assert.equal((await readFile(path, "utf8")).startsWith("ONE\n"), true);

  const retargetSnapshot = tokenOf(await readTool.execute("retarget-read", { path: "alias.txt" }, undefined, undefined, context(root)));
  const other = join(root, "other.txt");
  await writeFile(other, await readFile(path));
  await unlink(alias);
  await symlink(other, alias);
  await assert.rejects(
    editTool.execute("retarget", { path: "alias.txt", snapshot: retargetSnapshot, edits: [{ op: "replace", start: 1, lines: ["X"] }] }, undefined, undefined, context(root)),
    /\[E_PATH_MISMATCH\]/,
  );

  const hardlinkSnapshot = tokenOf(await readTool.execute("hardlink-read", { path: "fixture.txt" }, undefined, undefined, context(root)));
  await link(path, join(root, "hardlink.txt"));
  await assert.rejects(
    editTool.execute("hardlink", { path: "fixture.txt", snapshot: hardlinkSnapshot, edits: [{ op: "replace", start: 1, lines: ["X"] }] }, undefined, undefined, context(root)),
    /\[E_NOT_EDITABLE\].*Hardlinked/,
  );
});
