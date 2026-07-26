import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fail } from "./errors.ts";
import { MAX_PATH_CHARS } from "./schemas.ts";

export function normalizeAuthoredPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) fail("E_BAD_REQUEST", "path must be a non-empty string.");
  const stripped = value.startsWith("@") ? value.slice(1) : value;
  if (stripped.length === 0) fail("E_BAD_REQUEST", "path must name a file.");
  if (stripped.length > MAX_PATH_CHARS) fail("E_TOO_LARGE", `path exceeds ${MAX_PATH_CHARS} characters.`);
  if (stripped.includes("\0")) fail("E_BAD_REQUEST", "path must not contain NUL.");
  return stripped;
}

export function resolveAuthoredPath(value: unknown, cwd: string): string {
  const authored = normalizeAuthoredPath(value);
  const expanded = authored === "~"
    ? homedir()
    : authored.startsWith(`~${sep}`) || authored.startsWith("~/")
      ? resolve(homedir(), authored.slice(2))
      : authored;
  return resolve(cwd, expanded);
}

export function displayPath(absolutePath: string, cwd: string): string {
  const candidate = relative(cwd, absolutePath);
  const outside = candidate === ".." || candidate.startsWith(`..${sep}`) || isAbsolute(candidate);
  return (outside ? absolutePath : candidate || ".").split(sep).join("/");
}
export function escapeDisplayPath(path: string): string {
  return JSON.stringify(path).slice(1, -1);
}
