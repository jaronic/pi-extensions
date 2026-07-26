import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import hashlineExtension from "../src/index.ts";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { HASHLINE_SNAPSHOT_ENTRY } from "../src/persistence.ts";
import { HashlineHarness, type HarnessJournalEntry } from "./harness.ts";

function resultText(result: AgentToolResult<unknown>): string {
  const text = result.content.find((item) => item.type === "text");
  assert.ok(text && text.type === "text");
  return text.text;
}

function snapshot(text: string): string {
  const match = text.match(/snapshot="(h1_[A-Za-z0-9_-]{43})"/);
  assert.ok(match, text);
  return match[1];
}

test("user workflow survives reload and keeps snapshots isolated by active branch", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hashline-e2e-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "story.txt");
  await writeFile(file, "title\nold body\nfooter\n", "utf8");

  const first = new HashlineHarness(root);
  hashlineExtension(first.api);
  await first.emit("session_start", { type: "session_start", reason: "startup" });
  assert.equal(first.toolDefinition("read")?.name, "read");
  assert.equal(first.toolDefinition("edit")?.name, "edit");

  const initialRead = await first.tool("read", { path: "story.txt" });
  const initialText = resultText(initialRead);
  assert.match(initialText, /1:title\n2:old body\n3:footer/);
  const initialToken = snapshot(initialText);
  const firstEdit = await first.tool("edit", {
    path: "story.txt",
    snapshot: initialToken,
    edits: [
      { op: "replace", start: 2, lines: ["new body"] },
      { op: "insert_after", start: 3, lines: ["epilogue"] },
    ],
  });
  assert.equal(await readFile(file, "utf8"), "title\nnew body\nfooter\nepilogue\n");
  assert.deepEqual(Object.keys(firstEdit.details as object).sort(), ["diff", "firstChangedLine", "patch"]);
  const followUpToken = snapshot(resultText(firstEdit));
  const persisted = [...first.entries()];
  assert.ok(persisted.every((entry) => entry.customType === HASHLINE_SNAPSHOT_ENTRY));
  assert.equal(JSON.stringify(persisted).includes("old body"), false);
  assert.equal(JSON.stringify(persisted).includes("new body"), false);

  const reloaded = new HashlineHarness(root);
  reloaded.setBranch(persisted);
  hashlineExtension(reloaded.api);
  await reloaded.emit("session_start", { type: "session_start", reason: "reload" });
  const reloadEdit = await reloaded.tool("edit", {
    path: "story.txt",
    snapshot: followUpToken,
    edits: [{ op: "replace", start: 1, lines: ["TITLE"] }],
  });
  assert.equal(await readFile(file, "utf8"), "TITLE\nnew body\nfooter\nepilogue\n");
  const reloadToken = snapshot(resultText(reloadEdit));
  const activeBranch = [...reloaded.entries()];

  reloaded.setBranch([]);
  await reloaded.emit("session_tree", { type: "session_tree" });
  await assert.rejects(
    reloaded.tool("edit", {
      path: "story.txt",
      snapshot: reloadToken,
      edits: [{ op: "replace", start: 2, lines: ["sibling must not write"] }],
    }),
    /\[E_SNAPSHOT_UNKNOWN\]/,
  );
  assert.equal(await readFile(file, "utf8"), "TITLE\nnew body\nfooter\nepilogue\n");

  reloaded.setBranch(activeBranch as HarnessJournalEntry[]);
  await reloaded.emit("session_tree", { type: "session_tree" });
  await reloaded.tool("edit", {
    path: "story.txt",
    snapshot: reloadToken,
    edits: [{ op: "replace", start: 2, lines: ["restored branch"] }],
  });
  assert.equal(await readFile(file, "utf8"), "TITLE\nrestored branch\nfooter\nepilogue\n");
});

test("user-facing unseen and stale failures prescribe a safe next action", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hashline-guidance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "guide.txt");
  await writeFile(file, "one\ntwo\nthree\n", "utf8");
  const harness = new HashlineHarness(root);
  hashlineExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });

  const partialToken = snapshot(resultText(await harness.tool("read", { path: "guide.txt", offset: 1, limit: 1 })));
  await assert.rejects(
    harness.tool("edit", {
      path: "guide.txt",
      snapshot: partialToken,
      edits: [{ op: "insert_after", start: 1, lines: ["blind"] }],
    }),
    /\[E_UNSEEN_LINE\].*offset=1 limit=2.*rebuild/s,
  );
  const fullToken = snapshot(resultText(await harness.tool("read", { path: "guide.txt" })));
  await writeFile(file, "external\ntwo\nthree\n", "utf8");
  await assert.rejects(
    harness.tool("edit", {
      path: "guide.txt",
      snapshot: fullToken,
      edits: [{ op: "replace", start: 2, lines: ["TWO"] }],
    }),
    /\[E_STALE_SNAPSHOT\].*No hashline write was attempted.*Re-read.*never relocated/s,
  );
  assert.equal(await readFile(file, "utf8"), "external\ntwo\nthree\n");
});

test("malformed branch metadata is summarized once without blocking healthy reads", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hashline-malformed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "ok.txt"), "ok\n", "utf8");
  const harness = new HashlineHarness(root, true);
  harness.setBranch([
    { type: "custom", customType: HASHLINE_SNAPSHOT_ENTRY, data: { version: 99 } },
    { type: "custom", customType: HASHLINE_SNAPSHOT_ENTRY, data: { version: 1, kind: "bad" } },
  ]);
  hashlineExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  assert.equal(harness.notifications.length, 1);
  assert.match(harness.notifications[0].message, /ignored 2 malformed snapshot entries/);
  assert.match(resultText(await harness.tool("read", { path: "ok.txt" })), /snapshot="h1_/);
});
