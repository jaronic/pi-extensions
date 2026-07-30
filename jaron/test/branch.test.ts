import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BranchMonitor } from "../src/branch.ts";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for branch refresh");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test("refreshes the branch after a linked worktree switches", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "jaron-"));
  const repository = join(root, "repository");
  const worktree = join(root, "worktree");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  mkdirSync(repository);
  git(repository, ["init"]);
  git(repository, ["config", "user.email", "promptline@example.test"]);
  git(repository, ["config", "user.name", "Promptline Test"]);
  writeFileSync(join(repository, "README.md"), "initial\n");
  git(repository, ["add", "README.md"]);
  git(repository, ["commit", "-m", "initial"]);
  git(repository, ["branch", "live"]);
  git(repository, ["worktree", "add", "-b", "promptline-test", worktree, "HEAD"]);

  const branches: Array<string | undefined> = [];
  const monitor = new BranchMonitor({
    runGit,
    onBranch: (branch) => branches.push(branch),
  });
  t.after(() => monitor.stop());

  await monitor.start(worktree);
  assert.equal(branches.at(-1), "promptline-test");

  git(worktree, ["switch", "live"]);
  await waitFor(() => branches.at(-1) === "live");

  assert.equal(branches.at(-1), "live");
});
