import assert from "node:assert/strict";
import test from "node:test";
import { parseDiff } from "../src/diff-parser.ts";

// ── helpers ────────────────────────────────────────────────────────────────────

const SINGLE_MODIFICATION = `diff --git a/src/foo.ts b/src/foo.ts
index abc1234..def5678 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,4 +10,5 @@ export function foo() {
   const a = 1;
-  const b = 2;
+  const b = 20;
+  const c = 30;
   return a + b;
 }
`;

const NEW_FILE = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+export const x = 1;
+export const y = 2;
+export const z = 3;`;

const DELETED_FILE = `diff --git a/src/old.ts b/src/old.ts
deleted file mode 100644
index abc1234..0000000
--- a/src/old.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-export const x = 1;
-export const y = 2;
-export const z = 3;
`;

const RENAMED_FILE = `diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 95%
rename from src/old-name.ts
rename to src/new-name.ts
index abc1234..def5678 100644
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1,3 +1,3 @@
 export const x = 1;
-export const y = 2;
+export const y = 20;
 export const z = 3;
`;

const BINARY_FILE = `diff --git a/assets/logo.png b/assets/logo.png
index abc1234..def5678 100644
Binary files a/assets/logo.png and b/assets/logo.png differ
`;

const MULTI_FILE = `diff --git a/src/a.ts b/src/a.ts
index abc1234..def5678 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const added = true;
 const b = 2;
 const c = 3;
diff --git a/src/b.ts b/src/b.ts
index abc1234..def5678 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -5,4 +5,3 @@
 line5
 line6
-line7
 line8
`;

const NO_NEWLINE_EOF = `diff --git a/src/noeol.ts b/src/noeol.ts
index abc1234..def5678 100644
--- a/src/noeol.ts
+++ b/src/noeol.ts
@@ -1,2 +1,2 @@
 const a = 1;
-const b = 2;
\\ No newline at end of file
+const b = 20;
\\ No newline at end of file
`;

const MERGE_CONFLICT = `diff --git a/src/conflict.ts b/src/conflict.ts
index abc1234..def5678 100644
--- a/src/conflict.ts
+++ b/src/conflict.ts
@@ -1,5 +1,5 @@
 const a = 1;
-const b = 2;
+const b = 20;
<<<<<<< HEAD
 const c = 3;
=======
 const c = 30;
>>>>>>> feature-branch
 const d = 4;
`;

// ── tests ──────────────────────────────────────────────────────────────────────

test("parseDiff: empty diff returns empty summary", () => {
  const result = parseDiff("");
  assert.equal(result.totalFiles, 0);
  assert.deepEqual(result.files, []);
  assert.equal(result.totalAdditions, 0);
  assert.equal(result.totalDeletions, 0);
});

test("parseDiff: whitespace-only diff returns empty summary", () => {
  const result = parseDiff("   \n\n  \t  \n");
  assert.equal(result.totalFiles, 0);
});

test("parseDiff: single file modification", () => {
  const result = parseDiff(SINGLE_MODIFICATION);
  assert.equal(result.totalFiles, 1);
  assert.equal(result.totalAdditions, 2);
  assert.equal(result.totalDeletions, 1);

  const file = result.files[0];
  assert.equal(file.status, "modified");
  assert.equal(file.oldPath, "src/foo.ts");
  assert.equal(file.newPath, "src/foo.ts");
  assert.equal(file.isBinary, false);
  assert.equal(file.hunks.length, 1);

  const hunk = file.hunks[0];
  assert.equal(hunk.oldStart, 10);
  assert.equal(hunk.oldLines, 4);
  assert.equal(hunk.newStart, 10);
  assert.equal(hunk.newLines, 5);

  const adds = hunk.lines.filter(l => l.type === "addition");
  const dels = hunk.lines.filter(l => l.type === "deletion");
  assert.equal(adds.length, 2);
  assert.equal(dels.length, 1);
  assert.equal(adds[0].content, "  const b = 20;");
  assert.equal(adds[1].content, "  const c = 30;");
  assert.equal(dels[0].content, "  const b = 2;");
});

test("parseDiff: new file addition", () => {
  const result = parseDiff(NEW_FILE);
  assert.equal(result.totalFiles, 1);
  assert.equal(result.totalAdditions, 3);
  assert.equal(result.totalDeletions, 0);

  const file = result.files[0];
  assert.equal(file.status, "added");
  assert.equal(file.newPath, "src/new.ts");
  assert.equal(file.hunks.length, 1);
  assert.equal(file.hunks[0].lines.length, 3);
});

test("parseDiff: deleted file", () => {
  const result = parseDiff(DELETED_FILE);
  assert.equal(result.totalFiles, 1);
  assert.equal(result.totalAdditions, 0);
  assert.equal(result.totalDeletions, 3);

  const file = result.files[0];
  assert.equal(file.status, "deleted");
  assert.equal(file.oldPath, "src/old.ts");
});

test("parseDiff: renamed file with content change", () => {
  const result = parseDiff(RENAMED_FILE);
  assert.equal(result.totalFiles, 1);

  const file = result.files[0];
  assert.equal(file.status, "renamed");
  assert.equal(file.oldPath, "src/old-name.ts");
  assert.equal(file.newPath, "src/new-name.ts");
  assert.equal(file.additions, 1);
  assert.equal(file.deletions, 1);
});

test("parseDiff: binary file has isBinary true and no hunks", () => {
  const result = parseDiff(BINARY_FILE);
  assert.equal(result.totalFiles, 1);

  const file = result.files[0];
  assert.equal(file.isBinary, true);
  assert.equal(file.hunks.length, 0);
  assert.equal(file.additions, 0);
  assert.equal(file.deletions, 0);
});

test("parseDiff: multiple files in one diff", () => {
  const result = parseDiff(MULTI_FILE);
  assert.equal(result.totalFiles, 2);
  assert.equal(result.totalAdditions, 1 + 0);
  assert.equal(result.totalDeletions, 0 + 1);

  assert.equal(result.files[0].newPath, "src/a.ts");
  assert.equal(result.files[0].additions, 1);
  assert.equal(result.files[0].deletions, 0);

  assert.equal(result.files[1].newPath, "src/b.ts");
  assert.equal(result.files[1].additions, 0);
  assert.equal(result.files[1].deletions, 1);
});

test("parseDiff: handles No newline at end of file gracefully", () => {
  const result = parseDiff(NO_NEWLINE_EOF);
  assert.equal(result.totalFiles, 1);

  const file = result.files[0];
  assert.equal(file.additions, 1);
  assert.equal(file.deletions, 1);
  // No-newline marker lines should not appear as diff lines
  const hunkLines = file.hunks[0].lines;
  const noNewlineLines = hunkLines.filter(l => l.content.includes("No newline"));
  assert.equal(noNewlineLines.length, 0);
});

test("parseDiff: merge conflict markers treated as context lines, no crash", () => {
  const result = parseDiff(MERGE_CONFLICT);
  assert.equal(result.totalFiles, 1);

  const file = result.files[0];
  assert.equal(file.status, "modified");
  // Should not crash; conflict markers that start with non +/-/space are skipped
  // or treated as context. Just verify we got some lines.
  assert.ok(file.hunks[0].lines.length > 0);
});

test("parseDiff: large hunk with 1000+ lines parses correctly", () => {
  const addedLines = Array.from({ length: 1200 }, (_, i) => `+added line ${i}`).join("\n");
  const largeDiff = `diff --git a/src/large.ts b/src/large.ts
index abc1234..def5678 100644
--- a/src/large.ts
+++ b/src/large.ts
@@ -1,0 +1,1200 @@
${addedLines}`;
  const start = performance.now();
  const result = parseDiff(largeDiff);
  const elapsed = performance.now() - start;

  assert.equal(result.totalFiles, 1);
  assert.equal(result.totalAdditions, 1200);
  // The trailing empty line from template may add an extra context line
  assert.ok(result.files[0].hunks[0].lines.length >= 1200);
  // Performance: should complete well under 5 seconds
  assert.ok(elapsed < 5000, `Parsing took too long: ${elapsed}ms`);
});

test("parseDiff: totalAdditions and totalDeletions aggregate across files", () => {
  const result = parseDiff(MULTI_FILE);
  const sumAdditions = result.files.reduce((s, f) => s + f.additions, 0);
  const sumDeletions = result.files.reduce((s, f) => s + f.deletions, 0);
  assert.equal(result.totalAdditions, sumAdditions);
  assert.equal(result.totalDeletions, sumDeletions);
});

test("parseDiff: tolerates an unclosed hunk from a truncated diff", () => {
  // Simulates a collection cap that cut the diff mid-hunk: the hunk header
  // promises more lines than the captured content provides, and the last
  // line has no trailing newline. Parsing must not crash and must keep the
  // lines captured before the cut.
  const truncatedDiff = `diff --git a/src/a.ts b/src/a.ts
index abc1234..def5678 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,10 +1,12 @@
 const a = 1;
+const added = true;
 const b = 2;
-const removed = 3;
+const replaced = 30;
 const c = 4;
+const d = 5;`;
  const result = parseDiff(truncatedDiff);
  assert.equal(result.totalFiles, 1);
  const file = result.files[0];
  assert.equal(file.hunks.length, 1);
  assert.equal(file.additions, 3);
  assert.equal(file.deletions, 1);
});
