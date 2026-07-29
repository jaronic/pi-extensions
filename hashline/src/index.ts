import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHashlineEditTool } from "./edit-tool.ts";
import { createHashlineReadTool } from "./read-tool.ts";
import { createLogger } from "./logger.ts";
import {
  HASHLINE_SNAPSHOT_ENTRY,
  restoreSnapshotStore,
  type HashlineSnapshotEntryV1,
} from "./persistence.ts";
import { RecoveryStore } from "./recovery.ts";
import type { HashlineRuntime } from "./runtime.ts";
import { SnapshotStore, type SnapshotRecord } from "./snapshots.ts";

export default function hashlineExtension(pi: ExtensionAPI): void {
  let generation = 0;
  let store = new SnapshotStore();
  const recovery = new RecoveryStore();
  const logger = createLogger("hashline");

  const runtime: HashlineRuntime = {
    getGeneration: () => generation,
    getStore: () => store,
    getRecoveryBytes: (canonicalPath, token) => recovery.get(canonicalPath, token),
    commitRecord(record: SnapshotRecord, entry: HashlineSnapshotEntryV1, recoveryBytes?: Buffer): void {
      pi.appendEntry<HashlineSnapshotEntryV1>(HASHLINE_SNAPSHOT_ENTRY, entry);
      store.put(record);
      if (recoveryBytes) recovery.put(record, recoveryBytes);
    },
  };

  function restoreFromBranch(ctx: ExtensionContext): void {
    generation += 1;
    recovery.clear();
    store.clear();
    store = new SnapshotStore();
    const restored = restoreSnapshotStore(ctx.sessionManager.getBranch());
    store = restored.store;
    if (restored.malformed > 0 && ctx.hasUI) {
      ctx.ui.notify(
        `Hashline ignored ${restored.malformed} malformed snapshot entr${restored.malformed === 1 ? "y" : "ies"} on this branch.`,
        "warning",
      );
    }
  }

  pi.registerTool(createHashlineReadTool(runtime, logger));
  pi.registerTool(createHashlineEditTool(runtime, {}, logger));

  pi.on("session_start", (_event, ctx) => restoreFromBranch(ctx));
  pi.on("session_tree", (_event, ctx) => restoreFromBranch(ctx));
  pi.on("session_shutdown", () => {
    generation += 1;
    store.clear();
    recovery.clear();
    store = new SnapshotStore();
  });
}
