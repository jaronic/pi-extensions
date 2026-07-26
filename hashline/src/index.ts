import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createHashlineEditTool } from "./edit-tool.ts";
import { createHashlineReadTool } from "./read-tool.ts";
import {
  HASHLINE_SNAPSHOT_ENTRY,
  restoreSnapshotStore,
  type HashlineSnapshotEntryV1,
} from "./persistence.ts";
import type { HashlineRuntime } from "./runtime.ts";
import { SnapshotStore, type SnapshotRecord } from "./snapshots.ts";

export default function hashlineExtension(pi: ExtensionAPI): void {
  let generation = 0;
  let store = new SnapshotStore();

  const runtime: HashlineRuntime = {
    getGeneration: () => generation,
    getStore: () => store,
    commitRecord(record: SnapshotRecord, entry: HashlineSnapshotEntryV1): void {
      pi.appendEntry<HashlineSnapshotEntryV1>(HASHLINE_SNAPSHOT_ENTRY, entry);
      store.put(record);
    },
  };

  function restoreFromBranch(ctx: ExtensionContext): void {
    generation += 1;
    const restored = restoreSnapshotStore(ctx.sessionManager.getBranch());
    store = restored.store;
    if (restored.malformed > 0 && ctx.hasUI) {
      ctx.ui.notify(
        `Hashline ignored ${restored.malformed} malformed snapshot entr${restored.malformed === 1 ? "y" : "ies"} on this branch.`,
        "warning",
      );
    }
  }

  pi.registerTool(createHashlineReadTool(runtime));
  pi.registerTool(createHashlineEditTool(runtime));

  pi.on("session_start", (_event, ctx) => restoreFromBranch(ctx));
  pi.on("session_tree", (_event, ctx) => restoreFromBranch(ctx));
  pi.on("session_shutdown", () => {
    generation += 1;
    store.clear();
    store = new SnapshotStore();
  });
}
