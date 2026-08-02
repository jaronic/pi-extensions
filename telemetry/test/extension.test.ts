import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import telemetryExtension from "../src/index.ts";
import { TELEMETRY_STATE_TYPE } from "../src/state.ts";
import { TelemetryHarness } from "./harness.ts";

const VALID_SNAPSHOT = {
  version: 1,
  aggregates: [
    {
      tool: "read",
      provider: "anthropic",
      model: "claude-test",
      calls: 3,
      failures: 1,
      totalDurationMs: 300,
      timedCalls: 3,
      firstSeenAt: 10,
      lastSeenAt: 20,
    },
  ],
};

function toolExecutionStart(id: string, toolName: string) {
  return { type: "tool_execution_start", toolCallId: id, toolName, args: {} };
}

function toolExecutionEnd(id: string, toolName: string, isError = false) {
  return { type: "tool_execution_end", toolCallId: id, toolName, result: {}, isError };
}

async function withTempCwd(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-telemetry-test-"));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("factory registers exactly one command and no tools", () => {
  const harness = new TelemetryHarness();
  telemetryExtension(harness.api);
  assert.equal(harness.commandRegistrationCounts.get("telemetry"), 1);
  assert.equal(harness.toolRegistrationCounts.size, 0, "telemetry must not register model tools");
  assert.deepEqual(harness.commandCompletions("telemetry", "e"), [{ value: "export", label: "export" }]);
});

test("tool_execution_start/end pairs aggregate and persist on turn_end without blocking", async () => {
  const harness = new TelemetryHarness();
  telemetryExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });

  const callResults = await harness.emit("tool_execution_start", toolExecutionStart("c1", "read"));
  assert.deepEqual(callResults, [undefined], "observer must not block tool calls");
  await harness.emit("tool_execution_end", toolExecutionEnd("c1", "read"));
  await harness.emit("tool_execution_start", toolExecutionStart("c2", "read"));
  await harness.emit("tool_execution_end", toolExecutionEnd("c2", "read", true));
  assert.equal(harness.entries.length, 0, "nothing persists before turn_end");

  await harness.emit("turn_end", { type: "turn_end", turnIndex: 0 });
  assert.equal(harness.entries.length, 1);
  const entry = harness.entries[0];
  assert.equal(entry.customType, TELEMETRY_STATE_TYPE);
  const data = entry.data as { version: number; aggregates: Array<Record<string, unknown>> };
  assert.equal(data.version, 1);
  assert.equal(data.aggregates.length, 1);
  assert.equal(data.aggregates[0].tool, "read");
  assert.equal(data.aggregates[0].provider, "anthropic");
  assert.equal(data.aggregates[0].model, "claude-test");
  assert.equal(data.aggregates[0].calls, 2);
  assert.equal(data.aggregates[0].failures, 1);
  assert.equal(data.aggregates[0].timedCalls, 2);

  await harness.emit("turn_end", { type: "turn_end", turnIndex: 1 });
  assert.equal(harness.entries.length, 1, "clean turns do not append entries");
});

test("model dimension changes split aggregates and missing model degrades to unknown", async () => {
  const harness = new TelemetryHarness();
  telemetryExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.emit("tool_execution_start", toolExecutionStart("c1", "bash"));
  await harness.emit("tool_execution_end", toolExecutionEnd("c1", "bash"));
  harness.model = { provider: "openai", id: "gpt-test" };
  await harness.emit("tool_execution_start", toolExecutionStart("c2", "bash"));
  await harness.emit("tool_execution_end", toolExecutionEnd("c2", "bash"));
  harness.model = undefined;
  await harness.emit("tool_execution_start", toolExecutionStart("c3", "bash"));
  await harness.emit("tool_execution_end", toolExecutionEnd("c3", "bash"));
  await harness.emit("turn_end", { type: "turn_end", turnIndex: 0 });

  const data = harness.entries.at(-1)?.data as { aggregates: Array<Record<string, unknown>> };
  assert.equal(data.aggregates.length, 3);
  const providers = data.aggregates.map((aggregate) => `${aggregate.provider}/${aggregate.model}`).sort();
  assert.deepEqual(providers, ["anthropic/claude-test", "openai/gpt-test", "unknown/unknown"]);
});

test("session_start restores state from the branch and status reports it", async () => {
  const harness = new TelemetryHarness();
  telemetryExtension(harness.api);
  harness.entries.push({ type: "custom", customType: TELEMETRY_STATE_TYPE, data: structuredClone(VALID_SNAPSHOT) });
  await harness.emit("session_start", { type: "session_start", reason: "resume" });
  await harness.command("telemetry", "status");
  const status = harness.notifications.at(-1);
  assert.ok(status);
  assert.match(status.message, /Tool calls: 3 · failures: 1/);
  assert.match(status.message, /read @ anthropic\/claude-test/);
});

test("malformed persisted snapshots restore to empty with a warning", async () => {
  const harness = new TelemetryHarness();
  telemetryExtension(harness.api);
  harness.entries.push({ type: "custom", customType: TELEMETRY_STATE_TYPE, data: { version: 99, aggregates: [] } });
  harness.entries.push({ type: "custom", customType: TELEMETRY_STATE_TYPE, data: "garbage" });
  await harness.emit("session_start", { type: "session_start", reason: "resume" });
  const warning = harness.notifications.find((notification) => notification.type === "warning");
  assert.ok(warning, "a warning is surfaced for malformed state");
  assert.match(warning.message, /not fully restored/);
  await harness.command("telemetry", "status");
  assert.match(harness.notifications.at(-1)?.message ?? "", /No tool calls recorded yet/);
});

test("a trailing invalid snapshot keeps the last valid state instead of clearing it", async () => {
  const harness = new TelemetryHarness();
  telemetryExtension(harness.api);
  harness.entries.push({ type: "custom", customType: TELEMETRY_STATE_TYPE, data: structuredClone(VALID_SNAPSHOT) });
  harness.entries.push({ type: "custom", customType: TELEMETRY_STATE_TYPE, data: "garbage" });
  await harness.emit("session_start", { type: "session_start", reason: "resume" });
  const warning = harness.notifications.find((notification) => notification.type === "warning");
  assert.ok(warning, "a warning is surfaced for the invalid snapshot");
  assert.match(warning.message, /not fully restored/);
  await harness.command("telemetry", "status");
  assert.match(harness.notifications.at(-1)?.message ?? "", /Tool calls: 3 · failures: 1/);
});

test("an invalid snapshot before the last valid one restores the valid state", async () => {
  const harness = new TelemetryHarness();
  telemetryExtension(harness.api);
  harness.entries.push({ type: "custom", customType: TELEMETRY_STATE_TYPE, data: "garbage" });
  harness.entries.push({ type: "custom", customType: TELEMETRY_STATE_TYPE, data: structuredClone(VALID_SNAPSHOT) });
  await harness.emit("session_start", { type: "session_start", reason: "resume" });
  await harness.command("telemetry", "status");
  assert.match(harness.notifications.at(-1)?.message ?? "", /Tool calls: 3 · failures: 1/);
});

test("restore clears in-flight calls so unmatched ends still count once", async () => {
  const harness = new TelemetryHarness();
  telemetryExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.emit("tool_execution_start", toolExecutionStart("c1", "edit"));
  // A tree switch drops the pending call before its result arrives.
  await harness.emit("session_tree", { type: "session_tree" });
  await harness.emit("tool_execution_end", toolExecutionEnd("c1", "edit", true));
  await harness.emit("turn_end", { type: "turn_end", turnIndex: 0 });
  const data = harness.entries.at(-1)?.data as { aggregates: Array<Record<string, unknown>> };
  assert.equal(data.aggregates.length, 1);
  assert.equal(data.aggregates[0].calls, 1);
  assert.equal(data.aggregates[0].failures, 1);
});

test("unknown tool, schema failure, and gate block paths are counted as calls and failures", async () => {
  // The host emits only tool_execution_start/end for these immediate-failure
  // paths (agent-loop prepareToolCall); tool_call/tool_result hooks never fire.
  const harness = new TelemetryHarness();
  telemetryExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });

  await harness.emit("tool_execution_start", toolExecutionStart("u1", "unknown_tool"));
  await harness.emit("tool_execution_end", toolExecutionEnd("u1", "unknown_tool", true));
  await harness.emit("tool_execution_start", toolExecutionStart("s1", "read"));
  await harness.emit("tool_execution_end", toolExecutionEnd("s1", "read", true));
  await harness.emit("tool_execution_start", toolExecutionStart("g1", "edit"));
  await harness.emit("tool_execution_end", toolExecutionEnd("g1", "edit", true));
  await harness.emit("turn_end", { type: "turn_end", turnIndex: 0 });

  const data = harness.entries.at(-1)?.data as { aggregates: Array<Record<string, unknown>> };
  assert.equal(data.aggregates.length, 3);
  const byTool = new Map(data.aggregates.map((aggregate) => [aggregate.tool, aggregate]));
  for (const tool of ["unknown_tool", "read", "edit"]) {
    const aggregate = byTool.get(tool);
    assert.ok(aggregate, `${tool} is recorded`);
    assert.equal(aggregate.calls, 1, `${tool} counts the attempt`);
    assert.equal(aggregate.failures, 1, `${tool} counts the failure`);
  }
});

test("orphan end after a restore still counts as a call when the aggregate exists", async () => {
  const harness = new TelemetryHarness();
  telemetryExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.emit("tool_execution_start", toolExecutionStart("c1", "read"));
  await harness.emit("tool_execution_end", toolExecutionEnd("c1", "read"));
  await harness.emit("turn_end", { type: "turn_end", turnIndex: 0 });

  // The tree switch replays the persisted snapshot (read: 1 call) but clears
  // the pending table; the end for c2 arrives without its start while the
  // aggregate already exists. It must imply one more call, not just a failure.
  await harness.emit("session_tree", { type: "session_tree" });
  await harness.emit("tool_execution_end", toolExecutionEnd("c2", "read", true));
  await harness.emit("turn_end", { type: "turn_end", turnIndex: 1 });

  const data = harness.entries.at(-1)?.data as { aggregates: Array<Record<string, unknown>> };
  assert.equal(data.aggregates.length, 1);
  assert.equal(data.aggregates[0].calls, 2);
  assert.equal(data.aggregates[0].failures, 1);
  assert.equal(data.aggregates[0].timedCalls, 1);
});

test("no-UI path restores silently and reset works without confirmation", async () => {
  const harness = new TelemetryHarness({ hasUI: false });
  telemetryExtension(harness.api);
  harness.entries.push({ type: "custom", customType: TELEMETRY_STATE_TYPE, data: { version: 99 } });
  await harness.emit("session_start", { type: "session_start", reason: "resume" });
  assert.equal(harness.notifications.length, 0, "no notifications without UI");
  await harness.emit("tool_execution_start", toolExecutionStart("c1", "ls"));
  await harness.emit("tool_execution_end", toolExecutionEnd("c1", "ls"));
  await harness.command("telemetry", "reset");
  const entry = harness.entries.at(-1);
  assert.equal(entry?.customType, TELEMETRY_STATE_TYPE);
  assert.deepEqual((entry?.data as { aggregates: unknown[] }).aggregates, []);
});

test("export writes bounded JSON inside the cwd and reports totals", async () => {
  await withTempCwd(async (cwd) => {
    const harness = new TelemetryHarness({ cwd });
    telemetryExtension(harness.api);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    await harness.emit("tool_execution_start", toolExecutionStart("c1", "read"));
    await harness.emit("tool_execution_end", toolExecutionEnd("c1", "read"));

    await harness.command("telemetry", "export");
    const target = path.join(cwd, "telemetry-export.json");
    const payload = JSON.parse(await readFile(target, "utf8")) as {
      version: number;
      totals: { calls: number; failures: number };
      aggregates: Array<Record<string, unknown>>;
    };
    assert.equal(payload.version, 1);
    assert.equal(payload.totals.calls, 1);
    assert.equal(payload.totals.failures, 0);
    assert.equal(payload.aggregates[0].tool, "read");
    assert.ok(!("input" in payload.aggregates[0]), "export never contains tool arguments");
    assert.match(harness.notifications.at(-1)?.message ?? "", /Telemetry exported \(1 calls\)/);

    await harness.command("telemetry", "export");
    assert.match(harness.notifications.at(-1)?.message ?? "", /already exists/);
  });
});

test("export rejects traversal, absolute paths, and symlink escapes", async () => {
  await withTempCwd(async (cwd) => {
    const harness = new TelemetryHarness({ cwd });
    telemetryExtension(harness.api);
    await harness.emit("session_start", { type: "session_start", reason: "startup" });

    await harness.command("telemetry", "export ../escape.json");
    assert.match(harness.notifications.at(-1)?.message ?? "", /rejected/);

    await harness.command("telemetry", "export /tmp/telemetry-absolute.json");
    assert.match(harness.notifications.at(-1)?.message ?? "", /rejected/);

    const outside = await mkdtemp(path.join(tmpdir(), "pi-telemetry-outside-"));
    try {
      await symlink(outside, path.join(cwd, "link-out"));
      await harness.command("telemetry", "export link-out/evil.json");
      assert.match(harness.notifications.at(-1)?.message ?? "", /symlink/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }

    await mkdir(path.join(cwd, "reports"));
    await harness.command("telemetry", "export reports/ok.json");
    assert.match(harness.notifications.at(-1)?.message ?? "", /Telemetry exported/);
    JSON.parse(await readFile(path.join(cwd, "reports", "ok.json"), "utf8"));

    await writeFile(path.join(cwd, "dir-as-file"), "occupied");
    await harness.command("telemetry", "export dir-as-file/child.json");
    assert.match(harness.notifications.at(-1)?.message ?? "", /rejected|failed/i);
  });
});

test("reset requires confirmation with UI and appends a cleared snapshot", async () => {
  const harness = new TelemetryHarness();
  telemetryExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.emit("tool_execution_start", toolExecutionStart("c1", "grep"));
  await harness.emit("tool_execution_end", toolExecutionEnd("c1", "grep"));

  harness.confirmResponses.push(false);
  await harness.command("telemetry", "reset");
  assert.equal(harness.entries.length, 0, "declined reset keeps state and does not persist");

  harness.confirmResponses.push(true);
  await harness.command("telemetry", "reset");
  assert.equal(harness.entries.length, 1);
  assert.deepEqual((harness.entries[0].data as { aggregates: unknown[] }).aggregates, []);
  await harness.command("telemetry", "status");
  assert.match(harness.notifications.at(-1)?.message ?? "", /No tool calls recorded yet/);
});

test("reset reports failure when persisting the empty snapshot fails, then retries on the next turn", async () => {
  const harness = new TelemetryHarness();
  telemetryExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.emit("tool_execution_start", toolExecutionStart("c1", "grep"));
  await harness.emit("tool_execution_end", toolExecutionEnd("c1", "grep"));
  await harness.emit("turn_end", { type: "turn_end", turnIndex: 0 });
  assert.equal(harness.entries.length, 1);

  harness.appendEntryError = new Error("journal unavailable");
  await harness.command("telemetry", "reset");
  const notice = harness.notifications.at(-1);
  assert.ok(notice);
  assert.equal(notice.type, "error", "reset failure is surfaced as an error");
  assert.match(notice.message, /failed/i);
  assert.equal(harness.entries.length, 1, "the failed reset appends nothing");

  // The dirty flag survives the failure; the next turn_end retries, so the
  // cleared state becomes durable and a restart no longer revives old data.
  harness.appendEntryError = undefined;
  await harness.emit("turn_end", { type: "turn_end", turnIndex: 1 });
  assert.equal(harness.entries.length, 2);
  assert.deepEqual((harness.entries[1].data as { aggregates: unknown[] }).aggregates, []);
  await harness.emit("session_start", { type: "session_start", reason: "resume" });
  await harness.command("telemetry", "status");
  assert.match(harness.notifications.at(-1)?.message ?? "", /No tool calls recorded yet/);
});

test("session_shutdown clears pending calls idempotently", async () => {
  const harness = new TelemetryHarness();
  telemetryExtension(harness.api);
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
  await harness.emit("tool_execution_start", toolExecutionStart("c1", "find"));
  await harness.emit("session_shutdown", { type: "session_shutdown" });
  await harness.emit("session_shutdown", { type: "session_shutdown" });
  await harness.emit("session_start", { type: "session_start", reason: "reload" });
  await harness.emit("tool_execution_end", toolExecutionEnd("c1", "find"));
  await harness.emit("turn_end", { type: "turn_end", turnIndex: 0 });
  const data = harness.entries.at(-1)?.data as { aggregates: Array<Record<string, unknown>> };
  assert.equal(data.aggregates[0].calls, 1, "the restored end counts as one implied call");
});
