/**
 * node:fs implementation of RepoFileSystem plus workspace-bounded root
 * resolution. The checker itself stays pure; all real I/O lives here.
 */
import fs from "node:fs";
import path from "node:path";
import type { RepoFileSystem } from "./checks.ts";

function isSkippableDir(name: string): boolean {
  return name === "node_modules" || name.startsWith(".");
}

export const nodeRepoFileSystem: RepoFileSystem = {
  readTextFile(absolutePath) {
    try {
      return fs.readFileSync(absolutePath, "utf8");
    } catch {
      return null;
    }
  },
  fileExists(absolutePath) {
    try {
      return fs.statSync(absolutePath).isFile();
    } catch {
      return false;
    }
  },
  listTopLevelDirectories(root) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.filter((entry) => entry.isDirectory() && !isSkippableDir(entry.name)).map((entry) => entry.name);
  },
  listSourceFiles(dir) {
    const results: string[] = [];
    const walk = (current: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!isSkippableDir(entry.name)) walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".ts")) {
          results.push(full);
        }
      }
    };
    walk(dir);
    return results.sort();
  },
};

/**
 * Resolve the lint root: `rootInput` is interpreted relative to `cwd` (the
 * current workspace) and must stay inside it after realpath canonicalization,
 * so symlinked paths cannot point the lint outside the workspace.
 */
export function resolveLintRoot(cwd: string, rootInput: string | undefined): string {
  let realCwd: string;
  try {
    realCwd = fs.realpathSync(cwd);
  } catch {
    throw new Error(`doc_lint cannot resolve the current workspace: ${cwd}`);
  }
  const candidate = path.resolve(cwd, rootInput ?? ".");
  let realCandidate: string;
  try {
    realCandidate = fs.realpathSync(candidate);
  } catch {
    throw new Error(`doc_lint root does not exist: ${candidate}`);
  }
  if (realCandidate !== realCwd && !realCandidate.startsWith(realCwd + path.sep)) {
    throw new Error(`doc_lint root must be the workspace or a directory inside it (got: ${rootInput ?? candidate})`);
  }
  return realCandidate;
}
