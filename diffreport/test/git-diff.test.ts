import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseDiff } from "../src/diff-parser.ts";
import {
  buildGitDiffArgs,
  discoverDefaultBase,
  ensureGitRepository,
  execGitChecked,
  isValidGitRevision,
  listUntrackedFiles,
  MAX_UNTRACKED_FILES,
  parseCommitLog,
  runGitDiff,
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

test("discoverDefaultBase returns undefined when no unambiguous default exists", async () => {
  const pi = {
    async exec(_command: string, args: string[]) {
      if (args[2] === "symbolic-ref") throw new Error("no origin/HEAD");
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    },
  } as unknown as ExtensionAPI;
  const branches = [
    { name: "feature/payment", current: true },
    { name: "hotfix/unrelated", current: false },
  ];

  // Previously this silently picked hotfix/unrelated as the comparison base.
  assert.equal(
    await discoverDefaultBase(pi, "/tmp", "feature/payment", undefined, branches),
    undefined,
  );
});

test("discoverDefaultBase still prefers a conventional default branch", async () => {
  const pi = {
    async exec(_command: string, args: string[]) {
      if (args[2] === "symbolic-ref") throw new Error("no origin/HEAD");
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    },
  } as unknown as ExtensionAPI;
  const branches = [
    { name: "feature/payment", current: true },
    { name: "hotfix/unrelated", current: false },
    { name: "main", current: false },
  ];

  assert.equal(
    await discoverDefaultBase(pi, "/tmp", "feature/payment", undefined, branches),
    "main",
  );
});

// ── exit-code handling ────────────────────────────────────────────────────────

test("execGitChecked prepends the quotePath config and returns stdout on success", async () => {
  const pi = {
    async exec(command: string, args: string[], options: { cwd: string; timeout?: number }) {
      assert.equal(command, "git");
      assert.equal(args[0], "-c");
      assert.equal(args[1], "core.quotePath=false");
      assert.equal(args[2], "diff");
      assert.equal(options.cwd, "/tmp");
      return { stdout: "out\n", stderr: "", code: 0, killed: false };
    },
  } as unknown as ExtensionAPI;
  const result = await execGitChecked(pi, ["diff", "HEAD"], { cwd: "/tmp", timeout: 10_000 });
  assert.equal(result.stdout, "out\n");
});

test("execGitChecked rejects non-zero exit codes and embeds bounded stderr", async () => {
  const pi = {
    async exec() {
      return {
        stdout: "",
        stderr: "fatal: not a git repository (or any of the parent directories): .git\n",
        code: 128,
        killed: false,
      };
    },
  } as unknown as ExtensionAPI;
  await assert.rejects(
    execGitChecked(pi, ["rev-parse", "--is-inside-work-tree"], { cwd: "/tmp" }),
    /exited with code 128: fatal: not a git repository/,
  );
});

test("execGitChecked rejects killed results", async () => {
  const pi = {
    async exec() {
      return { stdout: "", stderr: "", code: 0, killed: true };
    },
  } as unknown as ExtensionAPI;
  await assert.rejects(execGitChecked(pi, ["diff"], { cwd: "/tmp" }), /was killed \(timeout or abort\)/);
});

test("ensureGitRepository throws when git exits non-zero instead of treating it as a repo", async () => {
  const pi = {
    async exec() {
      return { stdout: "", stderr: "fatal: not a git repository", code: 128, killed: false };
    },
  } as unknown as ExtensionAPI;
  await assert.rejects(ensureGitRepository(pi, "/tmp"), /Not a git repository/);
});

test("isValidGitRevision returns false on non-zero exit instead of a phantom success", async () => {
  const pi = {
    async exec() {
      return { stdout: "", stderr: "", code: 128, killed: false };
    },
  } as unknown as ExtensionAPI;
  assert.equal(await isValidGitRevision(pi, "/tmp", "main", true), false);
  assert.equal(await isValidGitRevision(pi, "/tmp", "main", false), false);
});

// ── collection caps ───────────────────────────────────────────────────────────

test("runGitDiff truncates oversized diffs at a line boundary and marks truncated", async () => {
  const lines = Array.from({ length: 5_000 }, (_, index) => `+padded content line ${index} of the diff`).join("\n");
  const bigDiff = `diff --git a/src/big.ts b/src/big.ts
index abc1234..def5678 100644
--- a/src/big.ts
+++ b/src/big.ts
@@ -1,5000 +1,5000 @@
${lines}\n`;
  const pi = {
    async exec() {
      return { stdout: bigDiff, stderr: "", code: 0, killed: false };
    },
  } as unknown as ExtensionAPI;

  const capped = await runGitDiff(pi, "/tmp", { source: "uncommitted" }, [], 0, undefined, 8 * 1024);
  assert.equal(capped.truncated, true);
  assert.ok(Buffer.byteLength(capped.content, "utf8") <= 8 * 1024);
  assert.ok(capped.content.endsWith("\n"), "truncated content must end at a line boundary");
  // The cut can land inside the hunk; parseDiff must tolerate the unclosed hunk.
  assert.equal(parseDiff(capped.content).totalFiles, 1);

  const full = await runGitDiff(pi, "/tmp", { source: "uncommitted" }, [], 0, undefined);
  assert.equal(full.truncated, false);
  assert.equal(full.content, bigDiff);
});

test("listUntrackedFiles caps the listing at maxFiles and marks truncated", async () => {
  const entries = Array.from({ length: 12_000 }, (_, index) => `untracked-${index}.ts`).join("\0") + "\0";
  const pi = {
    async exec() {
      return { stdout: entries, stderr: "", code: 0, killed: false };
    },
  } as unknown as ExtensionAPI;

  const defaulted = await listUntrackedFiles(pi, "/tmp", []);
  assert.equal(defaulted.truncated, true);
  assert.equal(defaulted.files.length, MAX_UNTRACKED_FILES);

  const capped = await listUntrackedFiles(pi, "/tmp", [], undefined, 3);
  assert.equal(capped.truncated, true);
  assert.deepEqual(capped.files, ["untracked-0.ts", "untracked-1.ts", "untracked-2.ts"]);
});
