import { resolveWorkspaceMachineFile } from "./roots.ts";

interface ToolResultLike {
  toolName: string;
  isError: boolean;
  input: Record<string, unknown>;
  details: unknown;
}

interface ActiveFileSynchronizer {
  cwd: string;
  syncActiveFile(file: string): Promise<void>;
}

const APPLY_DETAIL_KEYS: Record<string, true> = {
  version: true,
  kind: true,
  path: true,
  replacements: true,
  previewId: true,
  beforeSha256: true,
  afterSha256: true,
  cliVersion: true,
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodeAstGrepApplyPath(value: unknown): string {
  if (!isObject(value)
    || Object.keys(value).length !== Object.keys(APPLY_DETAIL_KEYS).length
    || Object.keys(value).some((key) => !Object.hasOwn(APPLY_DETAIL_KEYS, key))) {
    throw new Error("invalid ast_grep_edit apply details shape");
  }
  if (value.version !== 1 || value.kind !== "edit-apply" || value.cliVersion !== "0.45.0") {
    throw new Error("invalid ast_grep_edit apply details version or kind");
  }
  if (typeof value.path !== "string" || value.path.length === 0 || !value.path.isWellFormed() || value.path.includes("\0")) {
    throw new Error("invalid ast_grep_edit apply path");
  }
  if (!Number.isSafeInteger(value.replacements) || (value.replacements as number) < 1 || (value.replacements as number) > 50) {
    throw new Error("invalid ast_grep_edit replacement count");
  }
  for (const field of ["previewId", "beforeSha256", "afterSha256"] as const) {
    if (typeof value[field] !== "string" || !/^[a-f0-9]{64}$/u.test(value[field])) {
      throw new Error(`invalid ast_grep_edit ${field}`);
    }
  }
  return value.path;
}

export async function syncSuccessfulToolResult(
  manager: ActiveFileSynchronizer | undefined,
  event: ToolResultLike,
  cwd: string,
  resolveFile: (rawPath: string, cwd: string) => Promise<string> = resolveWorkspaceMachineFile,
): Promise<void> {
  if (manager === undefined || manager.cwd !== cwd || event.isError) {
    return;
  }
  try {
    let rawPath: string;
    if (event.toolName === "ast_grep_edit") {
      rawPath = decodeAstGrepApplyPath(event.details);
    } else if (event.toolName === "edit" || event.toolName === "write") {
      if (typeof event.input.path !== "string") {
        return;
      }
      rawPath = event.input.path;
    } else {
      return;
    }
    const file = await resolveFile(rawPath, cwd);
    await manager.syncActiveFile(file);
  } catch {
    // A later explicit LSP request performs a full disk sync and reports errors.
  }
}
