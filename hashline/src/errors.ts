export type HashlineErrorCode =
  | "E_BAD_REQUEST"
  | "E_SNAPSHOT_REQUIRED"
  | "E_SNAPSHOT_UNKNOWN"
  | "E_BRANCH_CHANGED"
  | "E_PATH_MISMATCH"
  | "E_STALE_SNAPSHOT"
  | "E_UNSEEN_LINE"
  | "E_RANGE"
  | "E_EDIT_CONFLICT"
  | "E_NO_CHANGE"
  | "E_WOULD_EMPTY"
  | "E_NOT_EDITABLE"
  | "E_TOO_LARGE"
  | "E_ABORTED"
  | "E_WRITE_FAILED";

export function hashlineError(code: HashlineErrorCode, message: string): Error {
  return new Error(`[${code}] ${message}`);
}

export function fail(code: HashlineErrorCode, message: string): never {
  throw hashlineError(code, message);
}

export function abortIfNeeded(signal: AbortSignal | undefined): void {
  if (signal?.aborted) fail("E_ABORTED", "Hashline operation was cancelled before any file write.");
}
