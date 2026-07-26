import { access, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

async function resolveFile(rawPath: string, cwd: string, stripMention: boolean): Promise<string> {
  const normalizedInput = stripMention && rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
  const absolute = isAbsolute(normalizedInput) ? normalizedInput : resolve(cwd, normalizedInput);
  const [canonicalFile, canonicalCwd] = await Promise.all([realpath(absolute), realpath(cwd)]);
  if (!isWithin(canonicalFile, canonicalCwd)) throw new Error(`LSP paths must stay inside the workspace: ${rawPath}`);
  const info = await stat(canonicalFile);
  if (!info.isFile()) throw new Error(`LSP path is not a file: ${rawPath}`);
  return canonicalFile;
}

export async function resolveWorkspaceFile(rawPath: string, cwd: string): Promise<string> {
  return resolveFile(rawPath, cwd, true);
}

export async function resolveWorkspaceMachineFile(rawPath: string, cwd: string): Promise<string> {
  return resolveFile(rawPath, cwd, false);
}

export async function findWorkspaceRoot(file: string, markers: string[], cwd: string): Promise<string> {
  const canonicalCwd = await realpath(cwd);
  let current = dirname(file);
  if (!isWithin(current, canonicalCwd)) throw new Error(`File is outside workspace: ${file}`);

  let selectedRoot = canonicalCwd;
  let selectedRank = markers.length;
  while (true) {
    let currentRank: number | undefined;
    for (let rank = 0; rank < markers.length; rank += 1) {
      try {
        await access(resolve(current, markers[rank]));
        currentRank = rank;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (currentRank !== undefined && currentRank < selectedRank) {
      selectedRoot = current;
      selectedRank = currentRank;
      if (currentRank === 0) return selectedRoot;
    }
    if (current === canonicalCwd) return selectedRoot;
    const parent = dirname(current);
    if (parent === current || !isWithin(parent, canonicalCwd)) return selectedRoot;
    current = parent;
  }
}

export function isWithin(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
