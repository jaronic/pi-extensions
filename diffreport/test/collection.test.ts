import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseDiff } from "../src/diff-parser.ts";
import { listUntrackedFiles, runGitDiff } from "../src/git-diff.ts";

// ── helpers ────────────────────────────────────────────────────────────────────

function run(command: string, args: string[], cwd: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  execFile(command, args, { cwd, encoding: "utf8" }, (error) => {
    if (error) reject(error);
    else resolve();
  });
  return promise;
}

interface CapturedExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

// Mirrors the host contract: exec resolves on non-zero exit codes instead of
// rejecting, and records every invocation for argument assertions.
function makeGitPi(workspace: string): { pi: ExtensionAPI; calls: string[][] } {
  const calls: string[][] = [];
  const pi = {
    async exec(command: string, args: string[], options: { cwd: string }) {
      assert.equal(command, "git");
      calls.push(args);
      const { promise, resolve } = Promise.withResolvers<CapturedExecResult>();
      execFile(command, args, {
        cwd: options.cwd,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (!error) resolve({ stdout, stderr, code: 0, killed: false });
        else resolve({ stdout, stderr, code: typeof error.code === "number" ? error.code : 1, killed: false });
      });
      return promise;
    },
  } as unknown as ExtensionAPI;
  return { pi, calls };
}

async function initRepo(workspace: string): Promise<void> {
  await run("git", ["init", "-b", "main"], workspace);
  await run("git", ["config", "user.email", "diffreport@example.com"], workspace);
  await run("git", ["config", "user.name", "Diffreport Test"], workspace);
}

// ── tests ──────────────────────────────────────────────────────────────────────

test("real git: oversized diff is truncated at a line boundary with the truncated flag", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "diffreport-capture-"));
  try {
    await initRepo(workspace);
    const original = Array.from({ length: 400 }, (_, index) => `const line${index} = "${"x".repeat(60)}";`).join("\n") + "\n";
    await writeFile(join(workspace, "big.ts"), original);
    await run("git", ["add", "big.ts"], workspace);
    await run("git", ["commit", "-m", "baseline"], workspace);
    const changed = Array.from({ length: 400 }, (_, index) => `const line${index} = "${"y".repeat(60)}"; // changed`).join("\n") + "\n";
    await writeFile(join(workspace, "big.ts"), changed);

    const { pi, calls } = makeGitPi(workspace);

    const capped = await runGitDiff(pi, workspace, { source: "uncommitted" }, [], 3, undefined, 16 * 1024);
    assert.equal(capped.truncated, true);
    assert.ok(Buffer.byteLength(capped.content, "utf8") <= 16 * 1024);
    assert.ok(capped.content.endsWith("\n"), "truncated content must end at a line boundary");
    // The cut lands inside the hunk; parseDiff must tolerate the unclosed hunk.
    const summary = parseDiff(capped.content);
    assert.equal(summary.totalFiles, 1);
    assert.ok(summary.files[0]?.hunks.length >= 1);
    // The captured head may contain only deletions; the point is that the
    // partially captured hunk still parses its lines instead of crashing.
    assert.ok((summary.files[0]?.hunks[0]?.lines.length ?? 0) > 0);
    assert.ok(summary.totalDeletions > 0);

    const full = await runGitDiff(pi, workspace, { source: "uncommitted" }, [], 3);
    assert.equal(full.truncated, false);
    assert.ok(Buffer.byteLength(full.content, "utf8") > 16 * 1024);
    assert.equal(parseDiff(full.content).totalAdditions, 400);

    const diffCall = calls.find((args) => args[2] === "diff");
    assert.ok(diffCall, "a git diff call must be recorded");
    assert.equal(diffCall[0], "-c");
    assert.equal(diffCall[1], "core.quotePath=false");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("real git: non-ASCII file names produce parseable diff headers", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "diffreport-cjk-"));
  try {
    await initRepo(workspace);
    await writeFile(join(workspace, "说明文档.txt"), "原始内容 v1\n");
    await run("git", ["add", "说明文档.txt"], workspace);
    await run("git", ["commit", "-m", "add doc"], workspace);
    await writeFile(join(workspace, "说明文档.txt"), "原始内容 v2 changed\n");

    const { pi, calls } = makeGitPi(workspace);

    const result = await runGitDiff(pi, workspace, { source: "uncommitted" }, [], 3);
    assert.equal(result.truncated, false);
    const diffCall = calls.find((args) => args[2] === "diff");
    assert.ok(diffCall, "a git diff call must be recorded");
    assert.equal(diffCall[0], "-c");
    assert.equal(diffCall[1], "core.quotePath=false");
    const summary = parseDiff(result.content);
    assert.ok(summary.totalFiles >= 1, `non-ASCII header must parse; got ${summary.totalFiles} files`);
    assert.equal(summary.files[0]?.newPath, "说明文档.txt");

    // A rename to another non-ASCII name stays parseable too.
    await run("git", ["checkout", "--", "说明文档.txt"], workspace);
    await run("git", ["mv", "说明文档.txt", "中文改名.md"], workspace);
    const renameResult = await runGitDiff(pi, workspace, { source: "uncommitted" }, [], 3);
    const renameSummary = parseDiff(renameResult.content);
    assert.ok(renameSummary.totalFiles >= 1, "non-ASCII rename must parse");
    assert.equal(renameSummary.files[0]?.status, "renamed");
    assert.equal(renameSummary.files[0]?.newPath, "中文改名.md");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("real git: untracked listing caps and marks truncation", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "diffreport-untracked-"));
  try {
    await initRepo(workspace);
    for (let index = 0; index < 5; index++) {
      await writeFile(join(workspace, `untracked-${index}.ts`), `export const u${index} = ${index};\n`);
    }

    const { pi } = makeGitPi(workspace);

    const all = await listUntrackedFiles(pi, workspace, []);
    assert.equal(all.truncated, false);
    assert.equal(all.files.length, 5);

    const capped = await listUntrackedFiles(pi, workspace, [], undefined, 2);
    assert.equal(capped.truncated, true);
    assert.deepEqual(capped.files, ["untracked-0.ts", "untracked-1.ts"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
