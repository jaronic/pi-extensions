import type { HashlineSnapshotEntryV1 } from "./persistence.ts";
import type { SnapshotRecord, SnapshotStore } from "./snapshots.ts";

export interface HashlineRuntime {
  getGeneration(): number;
  getStore(): SnapshotStore;
  commitRecord(record: SnapshotRecord, entry: HashlineSnapshotEntryV1): void;
}
