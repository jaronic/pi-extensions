import assert from "node:assert/strict";
import test from "node:test";
import { snapshotTokenForBytes } from "../src/digest.ts";
import { decodeEditableBytes } from "../src/lines.ts";
import { decodeHashlineEditInput } from "../src/operations.ts";
import { RecoveryStore, tryRebaseOperations } from "../src/recovery.ts";
import { MAX_RECOVERY_ENTRIES, MAX_RECOVERY_FILE_BYTES, MAX_RECOVERY_TOTAL_BYTES } from "../src/schemas.ts";
import type { SeenRange, SnapshotRecord } from "../src/snapshots.ts";

const PATH = "/tmp/hashline-recovery.txt";

function recordFor(text: string, seen?: readonly SeenRange[]): { readonly bytes: Buffer; readonly record: SnapshotRecord } {
  const bytes = Buffer.from(text, "utf8");
  const editable = decodeEditableBytes(bytes);
  const token = snapshotTokenForBytes(bytes);
  return Object.freeze({
    bytes,
    record: Object.freeze({
      token,
      digest: token.slice(3),
      canonicalPath: PATH,
      byteLength: bytes.length,
      lineCount: editable.lines.length,
      seen: seen ?? [Object.freeze({ start: 1, end: editable.lines.length })],
      source: "read",
    }),
  });
}

function attempt(
  oldText: string,
  currentText: string,
  edits: readonly Record<string, unknown>[],
  seen?: readonly SeenRange[],
) {
  const base = recordFor(oldText, seen);
  const input = decodeHashlineEditInput({ path: PATH, snapshot: base.record.token, edits });
  return tryRebaseOperations(
    base.record,
    base.bytes,
    decodeEditableBytes(Buffer.from(currentText, "utf8")).lines,
    input.edits,
    PATH,
  );
}

test("verified recovery remaps unchanged targets through one positive or negative offset", () => {
  const oldText = "L1\nL2\nL3\nL4\nTARGET\nL6\nL7\nL8\n";
  const inserted = attempt(
    oldText,
    `NEW\n${oldText}`,
    [{ op: "replace", start: 5, lines: ["MODEL"] }],
  );
  assert.equal(inserted.kind, "rebased");
  if (inserted.kind === "rebased") {
    assert.equal(inserted.offset, 1);
    assert.deepEqual(inserted.operations, [{ op: "replace", start: 6, lines: ["MODEL"] }]);
  }

  const deleted = attempt(
    oldText,
    "L2\nL3\nL4\nTARGET\nL6\nL7\nL8\n",
    [{ op: "replace", start: 5, lines: ["MODEL"] }],
  );
  assert.equal(deleted.kind, "rebased");
  if (deleted.kind === "rebased") {
    assert.equal(deleted.offset, -1);
    assert.deepEqual(deleted.operations, [{ op: "replace", start: 4, lines: ["MODEL"] }]);
  }
});

test("recovery rejects changed targets, changed EOL, split drift, and unseen multi-operation envelopes", () => {
  const oldText = "L1\nL2\nTARGET\nL4\nL5\nL6\nL7\nL8\n";
  const changed = attempt(
    oldText,
    "L1\nL2\nEXTERNAL\nL4\nL5\nL6\nL7\nL8\n",
    [{ op: "replace", start: 3, lines: ["MODEL"] }],
  );
  assert.deepEqual(changed, {
    kind: "rejected",
    reason: "the target or its displayed context changed since the snapshot",
  });

  const eolChanged = attempt(
    "L1\r\nL2\r\nTARGET\r\nL4\r\nL5\r\n",
    "NEW\r\nL1\r\nL2\r\nTARGET\nL4\r\nL5\r\n",
    [{ op: "replace", start: 3, lines: ["MODEL"] }],
  );
  assert.equal(eolChanged.kind, "rejected");

  const split = attempt(
    "L1\nL2\nA\nL4\nL5\nL6\nB\nL8\nL9\n",
    "NEW\nL1\nL2\nA\nL4\nCHANGED\nL6\nB\nL8\nL9\n",
    [
      { op: "replace", start: 3, lines: ["AA"] },
      { op: "replace", start: 7, lines: ["BB"] },
    ],
  );
  assert.equal(split.kind, "rejected");

  const oldWithHiddenGap = "L1\nA\nL3\nL4\nHIDDEN\nL6\nB\nL8\n";
  const hiddenGap = attempt(
    oldWithHiddenGap,
    `NEW\n${oldWithHiddenGap}`,
    [
      { op: "replace", start: 2, lines: ["AA"] },
      { op: "replace", start: 7, lines: ["BB"] },
    ],
    [{ start: 1, end: 4 }, { start: 6, end: 8 }],
  );
  assert.deepEqual(hiddenGap, {
    kind: "rejected",
    reason: "the complete multi-operation proof envelope was not displayed in the old snapshot; read the full current span from the first through last target before retrying",
  });
});

test("recovery rejects duplicated proof windows and targets without displayed context", () => {
  const repeated = "pre\na\nb\nTARGET\nc\nd\nmid\na\nb\nTARGET\nc\nd\npost\n";
  const ambiguous = attempt(
    repeated,
    `NEW\n${repeated}`,
    [{ op: "replace", start: 4, lines: ["MODEL"] }],
  );
  assert.deepEqual(ambiguous, {
    kind: "rejected",
    reason: "the unchanged target context is duplicated or maps ambiguously",
  });

  const noContext = attempt(
    "head\nTARGET\ntail\n",
    "NEW\nhead\nTARGET\ntail\n",
    [{ op: "replace", start: 2, lines: ["MODEL"] }],
    [{ start: 2, end: 2 }],
  );
  assert.deepEqual(noContext, {
    kind: "rejected",
    reason: "the target has no displayed surrounding context to prove its identity",
  });
});

test("recovery cache is bounded per path and never stores oversized versions", () => {
  const store = new RecoveryStore();
  const versions = Array.from({ length: 5 }, (_, index) => recordFor(`version-${index}\n`));
  for (const version of versions) store.put(version.record, version.bytes);
  assert.equal(store.size, 4);
  assert.equal(store.get(PATH, versions[0].record.token), undefined);
  assert.ok(store.get(PATH, versions[4].record.token));

  const oversizedBytes = Buffer.alloc(4 * 1024 * 1024 + 1, 0x61);
  const oversizedToken = snapshotTokenForBytes(oversizedBytes);
  const oversized: SnapshotRecord = Object.freeze({
    token: oversizedToken,
    digest: oversizedToken.slice(3),
    canonicalPath: "/tmp/hashline-oversized.txt",
    byteLength: oversizedBytes.length,
    lineCount: 1,
    seen: [{ start: 1, end: 1 }],
    source: "read",
  });
  store.put(oversized, oversizedBytes);
  assert.equal(store.get(oversized.canonicalPath, oversized.token), undefined);

  const entries = Array.from({ length: MAX_RECOVERY_ENTRIES + 1 }, (_, index) => recordFor(`entry-${index}\n`));
  for (let index = 0; index < entries.length; index += 1) {
    store.put(Object.freeze({ ...entries[index].record, canonicalPath: `/tmp/hashline-entry-${index}.txt` }), entries[index].bytes);
  }
  assert.equal(store.size, MAX_RECOVERY_ENTRIES);
  assert.equal(store.get("/tmp/hashline-entry-0.txt", entries[0].record.token), undefined);
  assert.ok(store.get(`/tmp/hashline-entry-${MAX_RECOVERY_ENTRIES}.txt`, entries[MAX_RECOVERY_ENTRIES].record.token));
  store.clear();
  assert.equal(store.size, 0);
  assert.equal(store.byteLength, 0);
});

test("recovery cache enforces its total byte budget", () => {
  const store = new RecoveryStore();
  const versionCount = Math.floor(MAX_RECOVERY_TOTAL_BYTES / MAX_RECOVERY_FILE_BYTES) + 1;
  let oldestToken: `h1_${string}` | undefined;
  let newestToken: `h1_${string}` | undefined;
  let newestPath = "";
  for (let index = 0; index < versionCount; index += 1) {
    const bytes = Buffer.alloc(MAX_RECOVERY_FILE_BYTES, 0x61);
    bytes[0] = 0x41 + index;
    for (let offset = 65_535; offset < bytes.length; offset += 65_536) bytes[offset] = 0x0a;
    const token = snapshotTokenForBytes(bytes);
    const canonicalPath = `/tmp/hashline-byte-budget-${index}.txt`;
    store.put(Object.freeze({
      token,
      digest: token.slice(3),
      canonicalPath,
      byteLength: bytes.length,
      lineCount: 64,
      seen: [Object.freeze({ start: 1, end: 64 })],
      source: "read",
    }), bytes);
    oldestToken ??= token;
    newestToken = token;
    newestPath = canonicalPath;
  }

  assert.equal(store.byteLength, MAX_RECOVERY_TOTAL_BYTES);
  assert.equal(store.size, MAX_RECOVERY_TOTAL_BYTES / MAX_RECOVERY_FILE_BYTES);
  assert.equal(store.get("/tmp/hashline-byte-budget-0.txt", oldestToken!), undefined);
  assert.ok(store.get(newestPath, newestToken!));
  store.clear();
  assert.equal(store.byteLength, 0);
});
