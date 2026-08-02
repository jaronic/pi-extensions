import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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
  getCommitHistory,
  isValidGitRevision,
  listUntrackedFiles,
  MAX_UNTRACKED_FILES,
  parseCommitLog,
  runGitDiff,
  validateWorkspacePath,
  validateWorkspacePaths,
} from "../src/git-diff.ts";

function run(command: string, args: string[], cwd: string, signal?: AbortSignal, timeout?: number): Promise<{ stdout: string; stderr: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ stdout: string; stderr: string }>();
  execFile(command, args, {
    cwd,
    signal,
    timeout,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }, (error, stdout, stderr) => {
    if (error) reject(error);
    else resolve({ stdout, stderr });
  });
  return promise;
}

function realGitPi(): ExtensionAPI {
  return {
    async exec(command: string, args: string[], options: { cwd: string; signal?: AbortSignal; timeout?: number }) {
      const result = await run(command, args, options.cwd, options.signal, options.timeout);
      return { ...result, code: 0, killed: false };
    },
  } as unknown as ExtensionAPI;
}

async function initRepository(workspace: string): Promise<void> {
  await run("git", ["init", "-b", "main"], workspace);
  await run("git", ["config", "user.email", "diffreport@example.com"], workspace);
  await run("git", ["config", "user.name", "Diffreport Test"], workspace);
}

test("buildGitDiffArgs creates a tracked uncommitted comparison with options after the subcommand", () => {
  assert.deepEqual(buildGitDiffArgs({ source: "uncommitted" }), [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--unified=3",
    "HEAD",
  ]);
});

test("buildGitDiffArgs uses merge-base semantics for a branch", () => {
  assert.deepEqual(buildGitDiffArgs({ source: "branch", target: "feature-x", base: "develop" }), [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--unified=3",
    "develop...feature-x",
  ]);
});

test("buildGitDiffArgs uses first-parent show for one commit and diff for a revision range", () => {
  assert.deepEqual(buildGitDiffArgs({ source: "commits", target: "abc123" }, [], 5), [
    "show",
    "-m",
    "--first-parent",
    "--format=",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--unified=5",
    "abc123",
  ]);
  assert.deepEqual(buildGitDiffArgs({ source: "commits", target: "main..feature" }), [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
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
      if (args[3] === "symbolic-ref") throw new Error("no origin/HEAD");
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
      if (args[3] === "symbolic-ref") throw new Error("no origin/HEAD");
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

test("execGitChecked prepends the quotePath config and literal pathspecs and returns stdout on success", async () => {
  const pi = {
    async exec(command: string, args: string[], options: { cwd: string; timeout?: number }) {
      assert.equal(command, "git");
      assert.equal(args[0], "-c");
      assert.equal(args[1], "core.quotePath=false");
      assert.equal(args[2], "--literal-pathspecs");
      assert.equal(args[3], "diff");
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

// ── real-repository evidence safety ───────────────────────────────────────────

test("runGitDiff never executes a repository-configured textconv driver", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "diffreport-textconv-"));
  try {
    const markerLog = join(workspace, "textconv-executed.log");
    const driverScript = join(workspace, "textconv-driver.sh");
    await writeFile(driverScript, `#!/bin/sh\necho executed >> "${markerLog}"\nprintf 'converted\\n'\n`);
    await run("chmod", ["+x", driverScript], workspace);
    await initRepository(workspace);
    await run("git", ["config", "diff.testdriver.textconv", driverScript], workspace);
    await writeFile(join(workspace, ".gitattributes"), "*.txt diff=testdriver\n");
    await writeFile(join(workspace, "a.txt"), "plain content\n");
    await run("git", ["add", "."], workspace);
    await run("git", ["commit", "-m", "init"], workspace);
    await writeFile(join(workspace, "a.txt"), "changed content\n");

    const result = await runGitDiff(realGitPi(), workspace, { source: "uncommitted" }, [], 3);
    assert.equal(existsSync(markerLog), false, "textconv driver must not be executed during collection");
    // The raw diff is visible instead of being replaced by the conversion output.
    assert.match(result.content, /-plain content/);
    assert.match(result.content, /\+changed content/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runGitDiff rejects pathspec magic that would escape the nested workspace", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "diffreport-pathspec-"));
  try {
    await mkdir(join(workspace, "secret"));
    await mkdir(join(workspace, "work"));
    await writeFile(join(workspace, "secret", "leaked.txt"), "secret v1\n");
    await writeFile(join(workspace, "work", "inside.txt"), "inside v1\n");
    await initRepository(workspace);
    await run("git", ["add", "."], workspace);
    await run("git", ["commit", "-m", "init"], workspace);
    await writeFile(join(workspace, "secret", "leaked.txt"), "secret v2\n");
    await writeFile(join(workspace, "work", "inside.txt"), "inside v2\n");

    const nestedCwd = join(workspace, "work");
    const magic = await runGitDiff(realGitPi(), nestedCwd, { source: "uncommitted" }, [":(top)secret/leaked.txt"], 3);
    // Without --literal-pathspecs the magic pathspec resolves relative to the
    // repository top and leaks a file outside the nested workspace.
    assert.doesNotMatch(magic.content, /leaked\.txt/);

    const plain = await runGitDiff(realGitPi(), nestedCwd, { source: "uncommitted" }, ["inside.txt"], 3);
    assert.match(plain.content, /inside\.txt/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("runGitDiff shows the first-parent diff of a single merge commit", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "diffreport-merge-"));
  try {
    await initRepository(workspace);
    await writeFile(join(workspace, "base.txt"), "base v1\n");
    await writeFile(join(workspace, "feat.txt"), "feat v1\n");
    await run("git", ["add", "."], workspace);
    await run("git", ["commit", "-m", "root"], workspace);
    await run("git", ["checkout", "-b", "feature"], workspace);
    await writeFile(join(workspace, "feat.txt"), "feat v2\n");
    await run("git", ["add", "."], workspace);
    await run("git", ["commit", "-m", "feature change"], workspace);
    await run("git", ["checkout", "main"], workspace);
    await writeFile(join(workspace, "base.txt"), "base v2\n");
    await run("git", ["add", "."], workspace);
    await run("git", ["commit", "-m", "main change"], workspace);
    await run("git", ["merge", "--no-ff", "feature", "-m", "merge feature"], workspace);
    const mergeSha = (await run("git", ["rev-parse", "HEAD"], workspace)).stdout.trim();

    // A clean merge shows an empty combined diff with plain `git show`; the
    // first-parent view must surface what the merge brought in.
    const result = await runGitDiff(realGitPi(), workspace, { source: "commits", target: mergeSha }, [], 3);
    assert.ok(result.content.length > 0, "a clean merge must still produce a first-parent diff");
    assert.match(result.content, /feat\.txt/);
    assert.doesNotMatch(result.content, /base\.txt/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("getCommitHistory returns the merge commit itself when exactly selected", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "diffreport-merge-history-"));
  try {
    await initRepository(workspace);
    await writeFile(join(workspace, "base.txt"), "base v1\n");
    await writeFile(join(workspace, "feat.txt"), "feat v1\n");
    await run("git", ["add", "."], workspace);
    await run("git", ["commit", "-m", "root"], workspace);
    await run("git", ["checkout", "-b", "feature"], workspace);
    await writeFile(join(workspace, "feat.txt"), "feat v2\n");
    await run("git", ["add", "."], workspace);
    await run("git", ["commit", "-m", "feature change"], workspace);
    await run("git", ["checkout", "main"], workspace);
    await writeFile(join(workspace, "base.txt"), "base v2\n");
    await run("git", ["add", "."], workspace);
    await run("git", ["commit", "-m", "main change"], workspace);
    await run("git", ["merge", "--no-ff", "feature", "-m", "merge feature"], workspace);
    const mergeSha = (await run("git", ["rev-parse", "HEAD"], workspace)).stdout.trim();

    // --no-merges would silently skip the merge and report its first parent.
    const commits = await getCommitHistory(
      realGitPi(),
      workspace,
      { source: "commits", target: mergeSha },
      [],
      undefined,
      1,
      true,
    );
    assert.equal(commits.length, 1);
    assert.equal(commits[0]?.hash, mergeSha);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
