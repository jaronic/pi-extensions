import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { digestBytes, snapshotTokenForBytes } from "../src/digest.ts";
import {
  HASHLINE_SNAPSHOT_ENTRY,
  decodeSnapshotEntry,
  encodeSnapshotEntry,
  restoreSnapshotStore,
} from "../src/persistence.ts";
import {
  SnapshotStore,
  type SeenRange,
  type SnapshotRecord,
} from "../src/snapshots.ts";

function makeRecord(
  content: string,
  path: string,
  seen: readonly SeenRange[] = [{ start: 1, end: 1 }],
): SnapshotRecord {
  const bytes = Buffer.from(content);
  const token = snapshotTokenForBytes(bytes);
  return Object.freeze({
    token,
    digest: digestBytes(bytes),
    canonicalPath: resolve(path),
    byteLength: bytes.length,
    lineCount: content.length === 0 ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0),
    seen,
    source: "read",
  });
}

test("same path and digest merge seen provenance", () => {
  const store = new SnapshotStore();
  const base = makeRecord("a\nb\nc\n", "/tmp/hashline-union", [{ start: 1, end: 1 }]);
  store.put(base);
  store.put({ ...base, seen: [{ start: 2, end: 3 }], source: "edit" });
  assert.deepEqual(store.get(base.canonicalPath, base.token)?.seen, [{ start: 1, end: 3 }]);
  assert.equal(store.size, 1);
});

test("per-path, path-count, and global LRU limits evict old projection records", () => {
  const versions = new SnapshotStore();
  const path = resolve("/tmp/hashline-versions");
  const records = Array.from({ length: 9 }, (_, index) => makeRecord(`v${index}`, path));
  records.slice(0, 8).forEach((record) => versions.put(record));
  assert.ok(versions.get(path, records[0].token));
  versions.put(records[8]);
  assert.ok(versions.get(path, records[0].token));
  assert.equal(versions.get(path, records[1].token), undefined);
  assert.ok(versions.get(path, records[8].token));
  assert.equal(versions.size, 8);

  const paths = new SnapshotStore();
  const first = makeRecord("first", "/tmp/hashline-path-0");
  paths.put(first);
  for (let index = 1; index <= 128; index += 1) paths.put(makeRecord(`p${index}`, `/tmp/hashline-path-${index}`));
  assert.equal(paths.pathCount, 128);
  assert.equal(paths.get(first.canonicalPath, first.token), undefined);

  const global = new SnapshotStore();
  for (let pathIndex = 0; pathIndex < 128; pathIndex += 1) {
    for (let version = 0; version < 5; version += 1) {
      global.put(makeRecord(`${pathIndex}:${version}`, `/tmp/hashline-global-${pathIndex}`));
    }
  }
  assert.equal(global.size, 512);
});

test("journal decoder accepts only canonical bounded v1 records", () => {
  const record = makeRecord("a\n", "/tmp/hashline-persistence");
  const entry = encodeSnapshotEntry(record);
  assert.equal(decodeSnapshotEntry(HASHLINE_SNAPSHOT_ENTRY, entry).kind, "valid");
  assert.equal(decodeSnapshotEntry("foreign", entry).kind, "foreign");
  assert.equal(decodeSnapshotEntry(HASHLINE_SNAPSHOT_ENTRY, { ...entry, extra: true }).kind, "malformed");
  let inspectedUnknownField = false;
  const structurallyInvalid: Record<string, unknown> = { ...entry };
  Object.defineProperty(structurallyInvalid, "extra", {
    enumerable: true,
    get() {
      inspectedUnknownField = true;
      throw new Error("decoder serialized unvalidated data");
    },
  });
  const structuralResult = decodeSnapshotEntry(HASHLINE_SNAPSHOT_ENTRY, structurallyInvalid);
  assert.equal(structuralResult.kind, "malformed");
  if (structuralResult.kind === "malformed") assert.match(structuralResult.reason, /unknown field/);
  assert.equal(inspectedUnknownField, false);
  assert.equal(
    decodeSnapshotEntry(HASHLINE_SNAPSHOT_ENTRY, { ...entry, record: { ...record, canonicalPath: "relative.txt" } }).kind,
    "malformed",
  );
  assert.equal(
    decodeSnapshotEntry(HASHLINE_SNAPSHOT_ENTRY, { ...entry, record: { ...record, digest: "x".repeat(43) } }).kind,
    "malformed",
  );
  assert.equal(
    decodeSnapshotEntry(HASHLINE_SNAPSHOT_ENTRY, { ...entry, record: { ...record, seen: [{ start: 2, end: 2 }] } }).kind,
    "malformed",
  );
  assert.equal(
    decodeSnapshotEntry(HASHLINE_SNAPSHOT_ENTRY, { ...entry, record: { ...record, byteLength: 0, lineCount: 1 } }).kind,
    "malformed",
  );
  assert.equal(JSON.stringify(entry).includes("a\n"), false, "journal metadata must not persist source text");
});

test("branch replay ignores malformed entries without losing valid snapshots", () => {
  const record = makeRecord("a\n", "/tmp/hashline-replay");
  const restored = restoreSnapshotStore([
    { type: "custom", customType: HASHLINE_SNAPSHOT_ENTRY, data: encodeSnapshotEntry(record) },
    { type: "custom", customType: HASHLINE_SNAPSHOT_ENTRY, data: { version: 99 } },
    { type: "custom", customType: "other", data: { text: "ignored" } },
  ] as never);
  assert.equal(restored.malformed, 1);
  assert.ok(restored.store.get(record.canonicalPath, record.token));
});
