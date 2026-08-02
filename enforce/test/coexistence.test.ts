import assert from "node:assert/strict";
import test from "node:test";
import planExtension from "../../plan/src/index.ts";
import { blockedDecision, ExtensionHarness, InMemoryPlanArtifactStore } from "../../plan/test/harness.ts";
import enforceExtension, { ENFORCE_NUDGE_TYPE } from "../src/index.ts";
import { BUILTIN_RULES, normalizeRule } from "../src/rules.ts";
import type { EnforceConfig } from "../src/types.ts";

function builtinConfig(overrides: Record<string, { action?: "nudge" | "gate" }> = {}): EnforceConfig {
  return {
    rules: Object.entries(BUILTIN_RULES).map(([id, input]) =>
      normalizeRule(id, { ...input, ...overrides[id] }, "builtin")),
    loadedFrom: [],
  };
}

function nudgeMessages(harness: ExtensionHarness): unknown[] {
  return harness.sentMessages.filter(
    (entry) => (entry.message as { customType?: string }).customType === ENFORCE_NUDGE_TYPE,
  );
}

test("Plan and Enforce compose: read-only nudges fire, Plan blocks stay intact", async () => {
  const harness = new ExtensionHarness(["read", "bash", "edit", "write", "grep", "lsp"]);
  planExtension(harness.api, { artifactStore: new InMemoryPlanArtifactStore() });
  enforceExtension(harness.api, { configLoader: async () => builtinConfig() });
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("plan");

  // grep is read-only and Plan-allowed; Enforce nudges toward lsp exactly once.
  const first = await harness.emit("tool_call", { type: "tool_call", toolName: "grep", toolCallId: "c1", input: { pattern: "parseConfig" } });
  assert.equal(blockedDecision(first), undefined);
  assert.equal(nudgeMessages(harness).length, 1);

  // Repeated attempts during Plan do not spam the session.
  await harness.emit("tool_call", { type: "tool_call", toolName: "grep", toolCallId: "c2", input: { pattern: "parseConfig" } });
  assert.equal(nudgeMessages(harness).length, 1);

  // Plan still blocks mutations; Enforce neither unblocks nor double-blocks.
  const blocked = await harness.emit("tool_call", { type: "tool_call", toolName: "write", toolCallId: "c3", input: {} });
  assert.equal(blockedDecision(blocked)?.block, true);
  assert.equal(nudgeMessages(harness).length, 1, "Enforce stays silent on tools its rules do not match");
});

test("an Enforce gate composes with Plan's read-only gate without deadlock or double reason loss", async () => {
  const harness = new ExtensionHarness(["read", "bash", "edit", "write", "grep", "lsp"]);
  // Register Enforce first to prove handler order does not matter.
  enforceExtension(harness.api, {
    configLoader: async () => builtinConfig({ "prefer-lsp-symbols-grep": { action: "gate" } }),
  });
  planExtension(harness.api, { artifactStore: new InMemoryPlanArtifactStore() });
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.command("plan");

  const results = await harness.emit("tool_call", { type: "tool_call", toolName: "grep", toolCallId: "c1", input: { pattern: "parseConfig" } });
  const blocked = blockedDecision(results);
  assert.ok(blocked);
  assert.match(blocked.reason, /Suggested replacement call:/);
  assert.equal(nudgeMessages(harness).length, 0, "a gate blocks instead of nudging");

  // Plan-approved read-only tools without a matching rule still pass.
  const allowed = await harness.emit("tool_call", { type: "tool_call", toolName: "read", toolCallId: "c2", input: {} });
  assert.equal(blockedDecision(allowed), undefined);
});
