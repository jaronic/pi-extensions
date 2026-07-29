import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { DiffReportOutputStore } from "../src/output.ts";

test("DiffReportOutputStore: small text returned as-is, no truncation", async () => {
  const store = new DiffReportOutputStore();
  try {
    const bounded = await store.bound("Hello, world!\nLine two.");
    assert.equal(bounded.text, "Hello, world!\nLine two.");
    assert.equal(bounded.truncation, undefined);
    assert.equal(bounded.fullOutputPath, undefined);
  } finally {
    await store.cleanup();
  }
});

test("DiffReportOutputStore: large text is truncated and full output saved", async () => {
  const store = new DiffReportOutputStore();
  // Generate 3000 lines to exceed DEFAULT_MAX_LINES
  const source = Array.from({ length: 3000 }, (_, i) => `line ${i}: ${"x".repeat(40)}`).join("\n");

  try {
    const bounded = await store.bound(source);

    // Truncation metadata must be present
    assert.ok(bounded.truncation, "truncation should be defined");
    assert.equal(bounded.truncation.totalLines, 3000);
    assert.ok(bounded.truncation.outputLines <= DEFAULT_MAX_LINES);

    // fullOutputPath must be set and file must exist
    assert.ok(bounded.fullOutputPath);
    const savedContent = await readFile(bounded.fullOutputPath, "utf8");
    assert.equal(savedContent, source);

    // File permissions: 0o600
    const fileStat = await stat(bounded.fullOutputPath);
    assert.equal(fileStat.mode & 0o777, 0o600);

    // Returned text must be within limits
    assert.ok(Buffer.byteLength(bounded.text) <= DEFAULT_MAX_BYTES);
    assert.ok(bounded.text.split("\n").length <= DEFAULT_MAX_LINES);

    // Truncation notice contains correct counts
    assert.match(bounded.text, /Output truncated/);
    assert.match(bounded.text, /3000 lines/);
  } finally {
    await store.cleanup();
  }
});

test("DiffReportOutputStore: cleanup removes temp directory and is idempotent", async () => {
  const store = new DiffReportOutputStore();
  const source = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n");
  const bounded = await store.bound(source);
  assert.ok(bounded.fullOutputPath);

  const path = bounded.fullOutputPath;

  // First cleanup: should succeed
  await store.cleanup();

  // File should be gone
  await assert.rejects(stat(path), (error: NodeJS.ErrnoException) => error.code === "ENOENT");

  // Second cleanup: should not throw (idempotent)
  await store.cleanup();
});

test("DiffReportOutputStore: cleanup without any bound call is safe", async () => {
  const store = new DiffReportOutputStore();
  // No bound() called — cleanup should be a no-op
  await store.cleanup();
});
