export const TELEMETRY_STATE_TYPE = "telemetry-state-v1";
export const TELEMETRY_EXPORT_VERSION = 1;
export const MAX_AGGREGATES = 256;
export const MAX_DIMENSION_CHARS = 128;
export const UNKNOWN_DIMENSION = "unknown";

export interface TelemetryDimensions {
  tool: string;
  provider: string;
  model: string;
}

export interface ToolAggregate extends TelemetryDimensions {
  calls: number;
  failures: number;
  totalDurationMs: number;
  /** Number of calls that contributed a duration sample. May be lower than calls. */
  timedCalls: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface TelemetryState {
  version: 1;
  aggregates: ToolAggregate[];
}

export interface TelemetrySnapshot {
  version: 1;
  aggregates: ToolAggregate[];
}

export interface TelemetrySummaryRow extends ToolAggregate {
  successRate: number;
  avgDurationMs: number | undefined;
}

export interface TelemetryExport {
  version: 1;
  generatedAt: number;
  totals: { calls: number; failures: number; successRate: number };
  aggregates: TelemetrySummaryRow[];
}

export type TelemetryDecodeResult =
  | { ok: true; value: TelemetrySnapshot; warning?: string }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function normalizeDimension(value: unknown): string {
  if (typeof value !== "string") return UNKNOWN_DIMENSION;
  const trimmed = value.trim();
  if (!trimmed) return UNKNOWN_DIMENSION;
  const chars = [...trimmed];
  if (chars.length > MAX_DIMENSION_CHARS) return chars.slice(0, MAX_DIMENSION_CHARS).join("");
  return trimmed;
}

export function telemetryDimensions(tool: unknown, provider: unknown, model: unknown): TelemetryDimensions {
  return {
    tool: normalizeDimension(tool),
    provider: normalizeDimension(provider),
    model: normalizeDimension(model),
  };
}

export function emptyTelemetryState(): TelemetryState {
  return { version: 1, aggregates: [] };
}

function aggregateKey(dims: TelemetryDimensions): string {
  return `${dims.tool}\n${dims.provider}\n${dims.model}`;
}

function sameDimensions(aggregate: ToolAggregate, dims: TelemetryDimensions): boolean {
  return aggregate.tool === dims.tool && aggregate.provider === dims.provider && aggregate.model === dims.model;
}

function insertBounded(aggregates: ToolAggregate[], aggregate: ToolAggregate): ToolAggregate[] {
  if (aggregates.length < MAX_AGGREGATES) return [...aggregates, aggregate];
  let oldestIndex = 0;
  for (let index = 1; index < aggregates.length; index++) {
    if (aggregates[index].lastSeenAt < aggregates[oldestIndex].lastSeenAt) oldestIndex = index;
  }
  const next = aggregates.filter((_, index) => index !== oldestIndex);
  next.push(aggregate);
  return next;
}

/** Count one tool call for the given dimensions. Returns a new state. */
export function recordCallStart(
  state: TelemetryState,
  dims: TelemetryDimensions,
  now: number,
): TelemetryState {
  const existing = state.aggregates.find((aggregate) => sameDimensions(aggregate, dims));
  if (!existing) {
    return {
      version: 1,
      aggregates: insertBounded(state.aggregates, {
        ...dims,
        calls: 1,
        failures: 0,
        totalDurationMs: 0,
        timedCalls: 0,
        firstSeenAt: now,
        lastSeenAt: now,
      }),
    };
  }
  const updated: ToolAggregate = { ...existing, calls: existing.calls + 1, lastSeenAt: now };
  return {
    version: 1,
    aggregates: state.aggregates.map((aggregate) => (aggregate === existing ? updated : aggregate)),
  };
}

export interface TelemetryOutcome {
  isError: boolean;
  durationMs?: number;
}

/**
 * Record the outcome of one tool call. When the dimensions have no aggregate
 * yet (for example a result observed without its call event after a restore),
 * the outcome implies one call. Returns a new state.
 */
export function recordCallEnd(
  state: TelemetryState,
  dims: TelemetryDimensions,
  outcome: TelemetryOutcome,
  now: number,
): TelemetryState {
  const durationMs = typeof outcome.durationMs === "number" && Number.isFinite(outcome.durationMs)
    ? Math.max(0, Math.round(outcome.durationMs))
    : undefined;
  const existing = state.aggregates.find((aggregate) => sameDimensions(aggregate, dims));
  if (!existing) {
    return {
      version: 1,
      aggregates: insertBounded(state.aggregates, {
        ...dims,
        calls: 1,
        failures: outcome.isError ? 1 : 0,
        totalDurationMs: durationMs ?? 0,
        timedCalls: durationMs === undefined ? 0 : 1,
        firstSeenAt: now,
        lastSeenAt: now,
      }),
    };
  }
  const updated: ToolAggregate = {
    ...existing,
    failures: existing.failures + (outcome.isError ? 1 : 0),
    totalDurationMs: durationMs === undefined ? existing.totalDurationMs : existing.totalDurationMs + durationMs,
    timedCalls: durationMs === undefined ? existing.timedCalls : existing.timedCalls + 1,
    lastSeenAt: now,
  };
  return {
    version: 1,
    aggregates: state.aggregates.map((aggregate) => (aggregate === existing ? updated : aggregate)),
  };
}

export function resetTelemetry(): TelemetryState {
  return emptyTelemetryState();
}

function decodeAggregate(value: unknown): ToolAggregate | undefined {
  if (!isRecord(value)) return undefined;
  const tool = typeof value.tool === "string" ? value.tool : undefined;
  const provider = typeof value.provider === "string" ? value.provider : undefined;
  const model = typeof value.model === "string" ? value.model : undefined;
  if (tool === undefined || provider === undefined || model === undefined) return undefined;
  if (tool !== normalizeDimension(tool) || provider !== normalizeDimension(provider) || model !== normalizeDimension(model)) {
    return undefined;
  }
  if (!isNonNegativeSafeInteger(value.calls) || value.calls === 0) return undefined;
  if (!isNonNegativeSafeInteger(value.failures)) return undefined;
  if (!isNonNegativeSafeInteger(value.totalDurationMs)) return undefined;
  if (!isNonNegativeSafeInteger(value.timedCalls)) return undefined;
  if (!isNonNegativeSafeInteger(value.firstSeenAt) || !isNonNegativeSafeInteger(value.lastSeenAt)) return undefined;
  if (value.failures > value.calls) return undefined;
  if (value.timedCalls > value.calls) return undefined;
  if (value.lastSeenAt < value.firstSeenAt) return undefined;
  return {
    tool,
    provider,
    model,
    calls: value.calls,
    failures: value.failures,
    totalDurationMs: value.totalDurationMs,
    timedCalls: value.timedCalls,
    firstSeenAt: value.firstSeenAt,
    lastSeenAt: value.lastSeenAt,
  };
}

/** Validate persisted snapshot data. Untrusted input is never partially applied. */
export function decodeTelemetrySnapshot(value: unknown): TelemetryDecodeResult {
  if (!isRecord(value)) return { ok: false, reason: "Telemetry snapshot must be an object." };
  if (value.version !== 1) return { ok: false, reason: `Unsupported Telemetry snapshot version: ${String(value.version)}.` };
  if (!Array.isArray(value.aggregates)) return { ok: false, reason: "Telemetry snapshot aggregates must be an array." };

  const aggregates: ToolAggregate[] = [];
  let dropped = 0;
  const seenKeys = new Set<string>();
  for (const item of value.aggregates) {
    const decoded = decodeAggregate(item);
    if (!decoded) {
      dropped += 1;
      continue;
    }
    const key = aggregateKey(decoded);
    if (seenKeys.has(key)) {
      dropped += 1;
      continue;
    }
    seenKeys.add(key);
    aggregates.push(decoded);
  }

  let overflow = 0;
  const bounded = aggregates
    .sort((left, right) => right.lastSeenAt - left.lastSeenAt)
    .slice(0, MAX_AGGREGATES);
  overflow = aggregates.length - bounded.length;

  const warnings: string[] = [];
  if (dropped > 0) warnings.push(`${dropped} malformed aggregate(s) ignored`);
  if (overflow > 0) warnings.push(`${overflow} stale aggregate(s) dropped above the ${MAX_AGGREGATES} entry limit`);
  return {
    ok: true,
    value: { version: 1, aggregates: bounded },
    warning: warnings.length ? `${warnings.join("; ")}.` : undefined,
  };
}

export function summarizeAggregates(aggregates: ToolAggregate[]): TelemetrySummaryRow[] {
  return aggregates
    .map((aggregate) => ({
      ...aggregate,
      successRate: aggregate.calls === 0 ? 1 : (aggregate.calls - aggregate.failures) / aggregate.calls,
      avgDurationMs: aggregate.timedCalls === 0
        ? undefined
        : Math.round(aggregate.totalDurationMs / aggregate.timedCalls),
    }))
    .sort((left, right) => right.calls - left.calls || left.tool.localeCompare(right.tool));
}

export function telemetryTotals(aggregates: ToolAggregate[]): { calls: number; failures: number } {
  let calls = 0;
  let failures = 0;
  for (const aggregate of aggregates) {
    calls += aggregate.calls;
    failures += aggregate.failures;
  }
  return { calls, failures };
}

export function buildTelemetryExport(state: TelemetryState, generatedAt: number): TelemetryExport {
  const totals = telemetryTotals(state.aggregates);
  return {
    version: TELEMETRY_EXPORT_VERSION,
    generatedAt,
    totals: {
      ...totals,
      successRate: totals.calls === 0 ? 1 : (totals.calls - totals.failures) / totals.calls,
    },
    aggregates: summarizeAggregates(state.aggregates),
  };
}

export function formatDurationMs(value: number): string {
  if (value < 1_000) return `${value}ms`;
  const seconds = value / 1_000;
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.round(seconds % 60);
  return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
}

export function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

export function formatTelemetryStatus(state: TelemetryState, maxRows = 10): string {
  const totals = telemetryTotals(state.aggregates);
  if (totals.calls === 0) {
    return "No tool calls recorded yet. Telemetry observes model tool calls as they happen.";
  }
  const lines: string[] = [
    `Tool calls: ${totals.calls} · failures: ${totals.failures} · success: ${formatPercent(
      totals.calls === 0 ? 1 : (totals.calls - totals.failures) / totals.calls,
    )} · groups: ${state.aggregates.length}/${MAX_AGGREGATES}`,
  ];
  const rows = summarizeAggregates(state.aggregates).slice(0, Math.max(1, maxRows));
  for (const row of rows) {
    const avg = row.avgDurationMs === undefined ? "n/a" : formatDurationMs(row.avgDurationMs);
    lines.push(
      `- ${row.tool} @ ${row.provider}/${row.model}: ${row.calls} calls, ${row.failures} failed (${formatPercent(row.successRate)} ok), avg ${avg}`,
    );
  }
  const hidden = state.aggregates.length - rows.length;
  if (hidden > 0) lines.push(`… ${hidden} more group(s). Use /telemetry export for the full data.`);
  return lines.join("\n");
}
