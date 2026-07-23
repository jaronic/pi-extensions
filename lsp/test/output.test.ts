import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { LspOutputStore } from "../src/output.ts";

test("LspOutputStore bounds output and preserves a private full artifact", async () => {
  const store = new LspOutputStore();
  const source = "x".repeat(DEFAULT_MAX_BYTES + 10_000);
  try {
    const bounded = await store.bound(source);
    assert.ok(bounded.truncation);
    assert.ok(bounded.fullOutputPath);
    assert.ok(Buffer.byteLength(bounded.text) <= DEFAULT_MAX_BYTES);
    assert.ok(bounded.text.split("\n").length <= DEFAULT_MAX_LINES);
    assert.equal(await readFile(bounded.fullOutputPath, "utf8"), source);
    assert.equal((await stat(bounded.fullOutputPath)).mode & 0o777, 0o600);
    assert.equal("content" in bounded.truncation, false);
  } finally {
    await store.cleanup();
  }
});

test("LspOutputStore enforces the line limit and removes artifacts on cleanup", async () => {
  const store = new LspOutputStore();
  const source = Array.from({ length: DEFAULT_MAX_LINES + 100 }, (_, index) => `line ${index}`).join("\n");
  const bounded = await store.bound(source);
  assert.ok(bounded.fullOutputPath);
  assert.ok(bounded.text.split("\n").length <= DEFAULT_MAX_LINES);
  const path = bounded.fullOutputPath;
  await store.cleanup();
  await assert.rejects(stat(path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
});
