import {
  MAX_ACTIVE_SNAPSHOTS,
  MAX_SEEN_RANGES,
  MAX_SNAPSHOT_PATHS,
  MAX_VERSIONS_PER_PATH,
} from "./schemas.ts";
import type { SnapshotToken } from "./digest.ts";

export interface SeenRange {
  readonly start: number;
  readonly end: number;
}

export interface SnapshotRecord {
  readonly token: SnapshotToken;
  readonly digest: string;
  readonly canonicalPath: string;
  readonly byteLength: number;
  readonly lineCount: number;
  readonly seen: readonly SeenRange[];
  readonly source: "read" | "edit";
}

export function normalizeSeenRanges(
  input: readonly SeenRange[],
  lineCount: number,
  maxInputRanges = MAX_SEEN_RANGES,
): readonly SeenRange[] {
  if (!Number.isSafeInteger(lineCount) || lineCount < 0) throw new Error("Snapshot lineCount is invalid.");
  if (!Array.isArray(input) || input.length > maxInputRanges) throw new Error("Snapshot has too many seen ranges.");
  const sorted = input.map((range) => {
    if (
      typeof range !== "object" || range === null ||
      !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) ||
      range.start < 1 || range.end < range.start || range.end > lineCount
    ) {
      throw new Error("Snapshot seen range is invalid.");
    }
    return { start: range.start, end: range.end };
  }).sort((left, right) => left.start - right.start || left.end - right.end);

  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  if (merged.length > MAX_SEEN_RANGES) throw new Error("Snapshot has too many normalized seen ranges.");
  return Object.freeze(merged.map((range) => Object.freeze(range)));
}

export function mergeSeenRanges(
  left: readonly SeenRange[],
  right: readonly SeenRange[],
  lineCount: number,
): readonly SeenRange[] {
  return normalizeSeenRanges([...left, ...right], lineCount, MAX_SEEN_RANGES * 2);
}

function freezeRecord(record: SnapshotRecord): SnapshotRecord {
  return Object.freeze({ ...record, seen: normalizeSeenRanges(record.seen, record.lineCount) });
}

export class SnapshotStore {
  private readonly byPath = new Map<string, Map<SnapshotToken, SnapshotRecord>>();
  private readonly pathLru = new Map<string, true>();
  private readonly recordLru = new Map<string, true>();

  get size(): number {
    return this.recordLru.size;
  }

  get pathCount(): number {
    return this.byPath.size;
  }

  clear(): void {
    this.byPath.clear();
    this.pathLru.clear();
    this.recordLru.clear();
  }

  get(canonicalPath: string, token: SnapshotToken): SnapshotRecord | undefined {
    const record = this.byPath.get(canonicalPath)?.get(token);
    if (!record) return undefined;
    this.touchRecord(canonicalPath, token, record);
    return record;
  }

  hasTokenAtAnotherPath(canonicalPath: string, token: SnapshotToken): boolean {
    for (const [path, records] of this.byPath) {
      if (path !== canonicalPath && records.has(token)) return true;
    }
    return false;
  }

  private touchRecord(canonicalPath: string, token: SnapshotToken, record: SnapshotRecord): void {
    const records = this.byPath.get(canonicalPath);
    if (!records) return;
    records.delete(token);
    records.set(token, record);
    this.touch(canonicalPath, token);
  }

  put(input: SnapshotRecord): SnapshotRecord {
    const existing = this.byPath.get(input.canonicalPath)?.get(input.token);
    if (existing && (
      existing.digest !== input.digest ||
      existing.byteLength !== input.byteLength ||
      existing.lineCount !== input.lineCount
    )) {
      throw new Error("Snapshot token metadata conflicts with an existing record.");
    }
    const record = freezeRecord(existing
      ? { ...input, seen: mergeSeenRanges(existing.seen, input.seen, input.lineCount) }
      : input);
    let records = this.byPath.get(record.canonicalPath);
    if (!records) {
      records = new Map();
      this.byPath.set(record.canonicalPath, records);
    }
    records.delete(record.token);
    records.set(record.token, record);
    this.touch(record.canonicalPath, record.token);
    while (records.size > MAX_VERSIONS_PER_PATH) {
      const oldest = records.keys().next().value as SnapshotToken | undefined;
      if (!oldest) break;
      this.removeRecord(record.canonicalPath, oldest);
    }
    while (this.byPath.size > MAX_SNAPSHOT_PATHS) {
      const oldestPath = this.pathLru.keys().next().value as string | undefined;
      if (!oldestPath) break;
      this.removePath(oldestPath);
    }
    while (this.recordLru.size > MAX_ACTIVE_SNAPSHOTS) {
      const oldestKey = this.recordLru.keys().next().value as string | undefined;
      if (!oldestKey) break;
      const separator = oldestKey.indexOf("\0");
      this.removeRecord(oldestKey.slice(0, separator), oldestKey.slice(separator + 1) as SnapshotToken);
    }
    return record;
  }

  private touch(canonicalPath: string, token: SnapshotToken): void {
    this.pathLru.delete(canonicalPath);
    this.pathLru.set(canonicalPath, true);
    const key = `${canonicalPath}\0${token}`;
    this.recordLru.delete(key);
    this.recordLru.set(key, true);
  }

  private removeRecord(canonicalPath: string, token: SnapshotToken): void {
    const records = this.byPath.get(canonicalPath);
    if (!records) return;
    records.delete(token);
    this.recordLru.delete(`${canonicalPath}\0${token}`);
    if (records.size === 0) this.removePath(canonicalPath);
  }

  private removePath(canonicalPath: string): void {
    const records = this.byPath.get(canonicalPath);
    if (records) {
      for (const token of records.keys()) this.recordLru.delete(`${canonicalPath}\0${token}`);
    }
    this.byPath.delete(canonicalPath);
    this.pathLru.delete(canonicalPath);
  }
}
