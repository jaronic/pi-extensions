import { isAbsolute } from "node:path";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { parseSnapshotToken } from "./digest.ts";
import {
  MAX_DECODED_SEEN_RANGES,
  MAX_EDITABLE_FILE_BYTES,
  MAX_EDITABLE_LINES,
  MAX_PATH_CHARS,
  MAX_SNAPSHOT_ENTRY_BYTES,
} from "./schemas.ts";
import {
  normalizeSeenRanges,
  SnapshotStore,
  type SeenRange,
  type SnapshotRecord,
} from "./snapshots.ts";

export const HASHLINE_SNAPSHOT_ENTRY = "pi-extensions:hashline-snapshot:v1";

export interface HashlineSnapshotEntryV1 {
  readonly version: 1;
  readonly kind: "record";
  readonly record: SnapshotRecord;
}

export type SnapshotEntryDecode =
  | { readonly kind: "valid"; readonly value: HashlineSnapshotEntryV1 }
  | { readonly kind: "foreign" }
  | { readonly kind: "malformed"; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const keys = new Set(allowed);
  if (Object.keys(value).some((key) => !keys.has(key))) throw new Error(`${label} contains an unknown field.`);
}

function safeInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw new Error(`${label} is outside its allowed range.`);
  }
  return value as number;
}

function decodeSeen(value: unknown, lineCount: number): readonly SeenRange[] {
  if (!Array.isArray(value) || value.length > MAX_DECODED_SEEN_RANGES) throw new Error("Snapshot seen ranges are invalid.");
  const ranges = value.map((candidate) => {
    if (!isRecord(candidate)) throw new Error("Snapshot seen range must be an object.");
    exactKeys(candidate, ["start", "end"], "Snapshot seen range");
    return { start: candidate.start as number, end: candidate.end as number };
  });
  return normalizeSeenRanges(ranges, lineCount, MAX_DECODED_SEEN_RANGES);
}

function decodeRecord(value: unknown): SnapshotRecord {
  if (!isRecord(value)) throw new Error("Snapshot record must be an object.");
  exactKeys(
    value,
    ["token", "digest", "canonicalPath", "byteLength", "lineCount", "seen", "source"],
    "Snapshot record",
  );
  const parsed = parseSnapshotToken(value.token);
  if (!parsed || typeof value.digest !== "string" || parsed.digest !== value.digest) {
    throw new Error("Snapshot token and digest are invalid or inconsistent.");
  }
  if (
    typeof value.canonicalPath !== "string" ||
    !isAbsolute(value.canonicalPath) ||
    value.canonicalPath.length === 0 ||
    value.canonicalPath.length > MAX_PATH_CHARS ||
    value.canonicalPath.includes("\0")
  ) {
    throw new Error("Snapshot canonicalPath is invalid.");
  }
  const byteLength = safeInteger(value.byteLength, "Snapshot byteLength", MAX_EDITABLE_FILE_BYTES);
  const lineCount = safeInteger(value.lineCount, "Snapshot lineCount", MAX_EDITABLE_LINES);
  if (lineCount > byteLength) throw new Error("Snapshot lineCount cannot exceed byteLength.");
  if (value.source !== "read" && value.source !== "edit") throw new Error("Snapshot source is invalid.");
  return Object.freeze({
    token: parsed.token,
    digest: parsed.digest,
    canonicalPath: value.canonicalPath,
    byteLength,
    lineCount,
    seen: decodeSeen(value.seen, lineCount),
    source: value.source,
  });
}

export function encodeSnapshotEntry(record: SnapshotRecord): HashlineSnapshotEntryV1 {
  return Object.freeze({ version: 1, kind: "record", record });
}

export function decodeSnapshotEntry(customType: unknown, data: unknown): SnapshotEntryDecode {
  if (customType !== HASHLINE_SNAPSHOT_ENTRY) return { kind: "foreign" };
  try {
    if (!isRecord(data)) throw new Error("Snapshot entry must be an object.");
    exactKeys(data, ["version", "kind", "record"], "Snapshot entry");
    if (data.version !== 1 || data.kind !== "record") throw new Error("Snapshot entry discriminant is invalid.");
    const value: HashlineSnapshotEntryV1 = Object.freeze({
      version: 1,
      kind: "record",
      record: decodeRecord(data.record),
    });
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_ENTRY_BYTES) {
      throw new Error("Snapshot entry exceeds its size limit.");
    }
    return { kind: "valid", value };
  } catch (error) {
    return { kind: "malformed", reason: error instanceof Error ? error.message : "Snapshot entry is invalid." };
  }
}

export function restoreSnapshotStore(branch: readonly SessionEntry[]): {
  readonly store: SnapshotStore;
  readonly malformed: number;
} {
  const store = new SnapshotStore();
  let malformed = 0;
  for (const entry of branch) {
    if (entry.type !== "custom" || entry.customType !== HASHLINE_SNAPSHOT_ENTRY) continue;
    const decoded = decodeSnapshotEntry(entry.customType, entry.data);
    if (decoded.kind === "valid") {
      try {
        store.put(decoded.value.record);
      } catch {
        malformed += 1;
      }
    } else if (decoded.kind === "malformed") malformed += 1;
  }
  return Object.freeze({ store, malformed });
}
