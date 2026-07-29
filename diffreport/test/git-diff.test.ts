import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildGitDiffArgs,
  parseCommitLog,
  validateWorkspacePath,
  validateWorkspacePaths,
} from "../src/git-diff.ts";

test("buildGitDiffArgs creates a tracked uncommitted comparison with options after the subcommand", () => {
  assert.deepEqual(buildGitDiffArgs({ source: "uncommitted" }), [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--unified=3",
    "HEAD",
  ]);
});

test("buildGitDiffArgs uses merge-base semantics for a branch", () => {
  assert.deepEqual(buildGitDiffArgs({ source: "branch", target: "feature-x", base: "develop" }), [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--unified=3",
    "develop...feature-x",
  ]);
});

test("buildGitDiffArgs uses show for one commit and diff for a revision range", () => {
  assert.deepEqual(buildGitDiffArgs({ source: "commits", target: "abc123" }, [], 5), [
    "show",
    "--format=",
    "--no-color",
    "--no-ext-diff",
    "--unified=5",
    "abc123",
  ]);
  assert.deepEqual(buildGitDiffArgs({ source: "commits", target: "main..feature" }), [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--unified=3",
    "main..feature",
  ]);
});

test("buildGitDiffArgs appends targeted paths after the pathspec separator", () => {
  const args = buildGitDiffArgs({ source: "uncommitted" }, ["src/a.ts", "src/b.ts"], 0);
  assert.deepEqual(args.slice(-3), ["--", "src/a.ts", "src/b.ts"]);
  assert.ok(args.includes("--unified=0"));
});

test("buildGitDiffArgs rejects unsafe revisions and invalid context", () => {
  assert.throws(() => buildGitDiffArgs({ source: "branch", target: "-feature", base: "main" }), /Branch target/);
  assert.throws(() => buildGitDiffArgs({ source: "commits", target: "abc 123" }), /Commit selection/);
  assert.throws(() => buildGitDiffArgs({ source: "uncommitted" }, [], 21), /contextLines/);
});

test("validateWorkspacePath returns normalized repository-relative paths", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "diffreport-path-"));
  try {
    await mkdir(join(workspace, "src"));
    await writeFile(join(workspace, "src", "file.ts"), "content");
    assert.equal(await validateWorkspacePath("src/../src/file.ts", workspace), "src/file.ts");
    assert.equal(await validateWorkspacePath("reports/new.md", workspace), "reports/new.md");
    assert.equal(await validateWorkspacePath(".", workspace), ".");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("validateWorkspacePath rejects lexical and symlink escapes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "diffreport-workspace-"));
  const outside = await mkdtemp(join(tmpdir(), "diffreport-outside-"));
  try {
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(workspace, "link"), "dir");
    await assert.rejects(validateWorkspacePath("../outside.md", workspace), /escapes the working directory/);
    await assert.rejects(validateWorkspacePath("link/secret.txt", workspace), /via symlink/);
    await assert.rejects(validateWorkspacePath("link/new.txt", workspace), /via symlink/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("validateWorkspacePaths deduplicates normalized paths", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "diffreport-paths-"));
  try {
    await mkdir(join(workspace, "src"));
    assert.deepEqual(
      await validateWorkspacePaths(["src", "./src", "src/../src"], workspace),
      ["src"],
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("parseCommitLog preserves body text and separators in ordinary prose", () => {
  const raw = [
    "abc123\u001fAdd payment retry\u001fAda\u001f2026-07-29T10:00:00Z\u001fExplain | fallback\nSecond line\u001e",
    "def456\u001fRefine state flow\u001fLin\u001f2026-07-29T11:00:00Z\u001f\u001e",
  ].join("\n");
  assert.deepEqual(parseCommitLog(raw), [
    {
      hash: "abc123",
      subject: "Add payment retry",
      author: "Ada",
      date: "2026-07-29T10:00:00Z",
      body: "Explain | fallback\nSecond line",
    },
    {
      hash: "def456",
      subject: "Refine state flow",
      author: "Lin",
      date: "2026-07-29T11:00:00Z",
    },
  ]);
});
