import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_EXPORT_BASENAME = "telemetry-export.json";
export const MAX_EXPORT_NAME_CHARS = 200;

/**
 * Resolve a user-supplied export path against the session cwd.
 * The result is guaranteed to stay inside the (real) cwd tree; absolute
 * paths, traversal outside cwd, and symlink escapes are rejected.
 */
export async function resolveExportPath(cwd: string, requested: string | undefined): Promise<string> {
  const name = (requested ?? "").trim() || DEFAULT_EXPORT_BASENAME;
  if ([...name].length > MAX_EXPORT_NAME_CHARS) {
    throw new Error(`Export path is too long. Limit: ${MAX_EXPORT_NAME_CHARS} characters.`);
  }
  if (name.includes("\0")) throw new Error("Export path must not contain NUL bytes.");
  if (path.isAbsolute(name)) throw new Error("Export path must be relative to the working directory.");

  const cwdReal = await realpath(cwd);
  const resolved = path.resolve(cwdReal, name);
  const relative = path.relative(cwdReal, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Export path must stay inside the working directory.");
  }

  const parent = path.dirname(resolved);
  let parentReal: string;
  try {
    parentReal = await realpath(parent);
  } catch {
    throw new Error(`Export directory does not exist: ${path.relative(cwdReal, parent) || "."}`);
  }
  const parentRelative = path.relative(cwdReal, parentReal);
  if (parentRelative.startsWith("..") || path.isAbsolute(parentRelative)) {
    throw new Error("Export path escapes the working directory through a symlink.");
  }
  if (parentReal !== parent) {
    // Keep the canonical location so the reported path matches the real file.
    return path.join(parentReal, path.basename(resolved));
  }
  return resolved;
}

/** Write export JSON to a path previously validated by resolveExportPath. Never overwrites. */
export async function writeExportFile(targetPath: string, payload: unknown): Promise<void> {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  try {
    await writeFile(targetPath, text, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw new Error(`Export file already exists: ${targetPath}. Remove it or choose another name.`);
    }
    throw error;
  }
}
