import type { SnapshotToken } from "./digest.ts";
import type { HashlineSnapshotEntryV1 } from "./persistence.ts";
import type { SnapshotRecord, SnapshotStore } from "./snapshots.ts";

export interface HashlineRuntime {
  getGeneration(): number;
  getStore(): SnapshotStore;
  getRecoveryBytes(canonicalPath: string, token: SnapshotToken): Buffer | undefined;
  commitRecord(record: SnapshotRecord, entry: HashlineSnapshotEntryV1, recoveryBytes?: Buffer): void;
}
