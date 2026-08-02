import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTelemetryExport,
  decodeTelemetrySnapshot,
  emptyTelemetryState,
  formatDurationMs,
  formatTelemetryStatus,
  MAX_AGGREGATES,
  MAX_DIMENSION_CHARS,
  normalizeDimension,
  recordCallEnd,
  recordCallStart,
  summarizeAggregates,
  telemetryDimensions,
  telemetryTotals,
  type TelemetryState,
} from "../src/state.ts";

const DIMS = { tool: "read", provider: "anthropic", model: "claude-test" } as const;

function aggregateOf(state: TelemetryState, tool = "read") {
  return state.aggregates.find((aggregate) => aggregate.tool === tool);
}

test("normalizeDimension trims, caps, and falls back to unknown", () => {
  assert.equal(normalizeDimension("  read  "), "read");
  assert.equal(normalizeDimension(""), "unknown");
  assert.equal(normalizeDimension("   "), "unknown");
  assert.equal(normalizeDimension(undefined), "unknown");
  assert.equal(normalizeDimension(42), "unknown");
  const long = "x".repeat(MAX_DIMENSION_CHARS + 50);
  assert.equal([...normalizeDimension(long)].length, MAX_DIMENSION_CHARS);
});

test("telemetryDimensions normalizes each dimension independently", () => {
  assert.deepEqual(telemetryDimensions("bash", undefined, "model-1"), {
    tool: "bash",
    provider: "unknown",
    model: "model-1",
  });
});

test("recordCallStart creates an aggregate and counts repeated calls immutably", () => {
  const initial = emptyTelemetryState();
  const once = recordCallStart(initial, DIMS, 1_000);
  assert.equal(initial.aggregates.length, 0, "input state must not be mutated");
  const twice = recordCallStart(once, DIMS, 2_000);
  const aggregate = aggregateOf(twice);
  assert.ok(aggregate);
  assert.equal(aggregate.calls, 2);
  assert.equal(aggregate.failures, 0);
  assert.equal(aggregate.firstSeenAt, 1_000);
  assert.equal(aggregate.lastSeenAt, 2_000);
  assert.equal(aggregateOf(once)?.calls, 1, "earlier state stays intact");
});

test("recordCallEnd accumulates failures and duration samples", () => {
  let state = recordCallStart(emptyTelemetryState(), DIMS, 1_000);
  state = recordCallStart(state, DIMS, 1_100);
  state = recordCallEnd(state, DIMS, { isError: false, durationMs: 250 }, 1_400);
  state = recordCallEnd(state, DIMS, { isError: true, durationMs: 1_000.4 }, 1_600);
  const aggregate = aggregateOf(state);
  assert.ok(aggregate);
  assert.equal(aggregate.calls, 2);
  assert.equal(aggregate.failures, 1);
  assert.equal(aggregate.timedCalls, 2);
  assert.equal(aggregate.totalDurationMs, 1_250);
});

test("recordCallEnd without a matching start implies one call", () => {
  const state = recordCallEnd(emptyTelemetryState(), DIMS, { isError: true }, 500);
  const aggregate = aggregateOf(state);
  assert.ok(aggregate);
  assert.equal(aggregate.calls, 1);
  assert.equal(aggregate.failures, 1);
  assert.equal(aggregate.timedCalls, 0);
});

test("recordCallEnd with impliesCall adds a call even when the aggregate exists", () => {
  let state = recordCallStart(emptyTelemetryState(), DIMS, 1_000);
  state = recordCallEnd(state, DIMS, { isError: false, impliesCall: true, durationMs: 100 }, 2_000);
  const aggregate = aggregateOf(state);
  assert.ok(aggregate);
  assert.equal(aggregate.calls, 2, "the orphan end implies one call on top of the existing aggregate");
  assert.equal(aggregate.failures, 0);
  assert.equal(aggregate.timedCalls, 1);
  assert.equal(aggregate.totalDurationMs, 100);
});

test("recordCallEnd without impliesCall never adds a call to an existing aggregate", () => {
  let state = recordCallStart(emptyTelemetryState(), DIMS, 1_000);
  state = recordCallEnd(state, DIMS, { isError: true, durationMs: 50 }, 2_000);
  const aggregate = aggregateOf(state);
  assert.ok(aggregate);
  assert.equal(aggregate.calls, 1, "a paired end settles the existing call only");
  assert.equal(aggregate.failures, 1);
  assert.equal(aggregate.timedCalls, 1);
});

test("recordCallEnd separates dimensions into distinct aggregates", () => {
  let state = recordCallStart(emptyTelemetryState(), DIMS, 1);
  state = recordCallStart(state, { ...DIMS, model: "other-model" }, 2);
  assert.equal(state.aggregates.length, 2);
});

test("aggregates are bounded and evict the least recently seen group", () => {
  let state = emptyTelemetryState();
  for (let index = 0; index < MAX_AGGREGATES; index++) {
    state = recordCallStart(state, { ...DIMS, tool: `tool-${index}` }, index);
  }
  assert.equal(state.aggregates.length, MAX_AGGREGATES);
  state = recordCallStart(state, { ...DIMS, tool: "newest" }, MAX_AGGREGATES + 1);
  assert.equal(state.aggregates.length, MAX_AGGREGATES);
  assert.ok(aggregateOf(state, "newest"), "new group is kept");
  assert.equal(aggregateOf(state, "tool-0"), undefined, "oldest group is evicted");
  assert.ok(aggregateOf(state, "tool-1"), "other groups survive");
});

const STORED_SNAPSHOT = {
  version: 1,
  aggregates: [
    {
      tool: "read",
      provider: "anthropic",
      model: "claude-test",
      calls: 4,
      failures: 1,
      totalDurationMs: 800,
      timedCalls: 2,
      firstSeenAt: 10,
      lastSeenAt: 20,
    },
  ],
} as const;

test("decodeTelemetrySnapshot round-trips a valid snapshot", () => {
  const decoded = decodeTelemetrySnapshot(structuredClone(STORED_SNAPSHOT));
  assert.ok(decoded.ok);
  assert.equal(decoded.warning, undefined);
  assert.deepEqual(decoded.value, STORED_SNAPSHOT);
});

test("decodeTelemetrySnapshot rejects non-objects and wrong versions", () => {
  assert.deepEqual(decodeTelemetrySnapshot(null), { ok: false, reason: "Telemetry snapshot must be an object." });
  assert.deepEqual(decodeTelemetrySnapshot("telemetry"), { ok: false, reason: "Telemetry snapshot must be an object." });
  const wrongVersion = decodeTelemetrySnapshot({ version: 2, aggregates: [] });
  assert.equal(wrongVersion.ok, false);
  const missingAggregates = decodeTelemetrySnapshot({ version: 1 });
  assert.equal(missingAggregates.ok, false);
});

test("decodeTelemetrySnapshot skips malformed aggregates with a warning", () => {
  const decoded = decodeTelemetrySnapshot({
    version: 1,
    aggregates: [
      structuredClone(STORED_SNAPSHOT.aggregates[0]),
      { tool: "bash" },
      { ...structuredClone(STORED_SNAPSHOT.aggregates[0]), tool: "edit", failures: 9 },
      { ...structuredClone(STORED_SNAPSHOT.aggregates[0]), tool: "grep", timedCalls: 9 },
      { ...structuredClone(STORED_SNAPSHOT.aggregates[0]), tool: "ls", lastSeenAt: 1 },
      { ...structuredClone(STORED_SNAPSHOT.aggregates[0]), tool: "find", calls: 0 },
      { ...structuredClone(STORED_SNAPSHOT.aggregates[0]), tool: " x " },
      structuredClone(STORED_SNAPSHOT.aggregates[0]),
    ],
  });
  assert.ok(decoded.ok);
  assert.equal(decoded.value.aggregates.length, 1);
  assert.equal(decoded.value.aggregates[0].tool, "read");
  assert.match(decoded.warning ?? "", /7 malformed aggregate\(s\) ignored/);
});

test("decodeTelemetrySnapshot enforces the aggregate cap keeping the most recent", () => {
  const aggregates = [];
  for (let index = 0; index < MAX_AGGREGATES + 5; index++) {
    aggregates.push({
      tool: `tool-${index}`,
      provider: "p",
      model: "m",
      calls: 1,
      failures: 0,
      totalDurationMs: 0,
      timedCalls: 0,
      firstSeenAt: index,
      lastSeenAt: index,
    });
  }
  const decoded = decodeTelemetrySnapshot({ version: 1, aggregates });
  assert.ok(decoded.ok);
  assert.equal(decoded.value.aggregates.length, MAX_AGGREGATES);
  assert.ok(decoded.value.aggregates.some((aggregate) => aggregate.tool === `tool-${MAX_AGGREGATES + 4}`));
  assert.match(decoded.warning ?? "", /5 stale aggregate\(s\) dropped/);
});

test("summarizeAggregates sorts by calls and derives rates", () => {
  let state = emptyTelemetryState();
  state = recordCallStart(state, { ...DIMS, tool: "bash" }, 1);
  state = recordCallStart(state, DIMS, 2);
  state = recordCallStart(state, DIMS, 3);
  state = recordCallEnd(state, DIMS, { isError: true, durationMs: 100 }, 4);
  state = recordCallEnd(state, DIMS, { isError: false, durationMs: 300 }, 5);
  const rows = summarizeAggregates(state.aggregates);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tool, "read");
  assert.equal(rows[0].calls, 2);
  assert.equal(rows[0].successRate, 0.5);
  assert.equal(rows[0].avgDurationMs, 200);
  assert.equal(rows[1].tool, "bash");
  assert.equal(rows[1].avgDurationMs, undefined);
});

test("telemetryTotals and buildTelemetryExport aggregate the whole state", () => {
  let state = recordCallStart(emptyTelemetryState(), DIMS, 1);
  state = recordCallEnd(state, DIMS, { isError: true, durationMs: 50 }, 2);
  state = recordCallStart(state, { ...DIMS, tool: "bash" }, 3);
  assert.deepEqual(telemetryTotals(state.aggregates), { calls: 2, failures: 1 });
  const exported = buildTelemetryExport(state, 9_999);
  assert.equal(exported.version, 1);
  assert.equal(exported.generatedAt, 9_999);
  assert.equal(exported.totals.calls, 2);
  assert.equal(exported.totals.failures, 1);
  assert.equal(exported.totals.successRate, 0.5);
  assert.equal(exported.aggregates.length, 2);
  assert.equal(JSON.parse(JSON.stringify(exported)).aggregates.length, 2, "export stays JSON-serializable");
});

test("formatTelemetryStatus covers the empty and populated cases", () => {
  assert.match(formatTelemetryStatus(emptyTelemetryState()), /No tool calls recorded yet/);
  let state = recordCallStart(emptyTelemetryState(), DIMS, 1);
  state = recordCallEnd(state, DIMS, { isError: false, durationMs: 120 }, 2);
  const status = formatTelemetryStatus(state);
  assert.match(status, /Tool calls: 1 · failures: 0 · success: 100%/);
  assert.match(status, /read @ anthropic\/claude-test: 1 calls, 0 failed/);
  assert.match(status, /avg 120ms/);
});

test("formatDurationMs scales units", () => {
  assert.equal(formatDurationMs(999), "999ms");
  assert.equal(formatDurationMs(1_500), "1.5s");
  assert.equal(formatDurationMs(60_000), "1m");
  assert.equal(formatDurationMs(61_000), "1m 1s");
});
