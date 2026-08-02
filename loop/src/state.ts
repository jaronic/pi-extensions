import { randomUUID } from "node:crypto";

export const MAX_LOOP_OBJECTIVE_CHARS = 4_000;
export const MAX_LOOP_ID_CHARS = 128;
export const MAX_ROUND_LOG = 8;
export const MAX_ROUND_SUMMARY_CHARS = 240;
export const MAX_ATTEMPT_REASON_CHARS = 200;

export type LoopStatus = "running" | "paused" | "finished" | "stopped";
const VALID_LOOP_STATUSES: Record<LoopStatus, true> = {
  running: true,
  paused: true,
  finished: true,
  stopped: true,
};

export type PauseReason =
  | "user"
  | "error"
  | "usage-limit"
  | "abort"
  | "reload"
  | "restore"
  | "send-failed";
const VALID_PAUSE_REASONS: Record<PauseReason, true> = {
  user: true,
  error: true,
  "usage-limit": true,
  abort: true,
  reload: true,
  restore: true,
  "send-failed": true,
};

export interface LoopSpec {
  objective: string;
  iterations: number;
}

export interface RoundLogEntry {
  round: number;
  status: "ok" | "length";
  turns: number;
  summary: string;
  at: number;
}

export interface LastAttempt {
  round: number;
  status: "error" | "aborted";
  reason: string;
  at: number;
}

export interface LoopState {
  version: 1;
  id: string;
  generation: number;
  status: LoopStatus;
  spec: LoopSpec;
  completedIterations: number;
  roundLog: RoundLogEntry[];
  lastAttempt?: LastAttempt;
  pauseReason?: PauseReason;
  createdAt: number;
  finishedAt?: number;
}

export interface LoopJournalEntry {
  version: 1;
  action: "create" | "settle" | "status" | "clear";
  loop: LoopState | null;
}

export type LoopDecodeResult<T> =
  | { ok: true; value: T; warning?: string }
  | { ok: false; reason: string };

const VALID_LOOP_ACTIONS: Record<LoopJournalEntry["action"], true> = {
  create: true,
  settle: true,
  status: true,
  clear: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeFailure<T>(reason: string): LoopDecodeResult<T> {
  return { ok: false, reason };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function validateObjective(input: string): string {
  const objective = input.trim();
  if (!objective) throw new Error("Loop objective must not be empty.");
  const length = [...objective].length;
  if (length > MAX_LOOP_OBJECTIVE_CHARS) {
    throw new Error(
      `Loop objective is too long: ${length.toLocaleString()} characters. ` +
        `Limit: ${MAX_LOOP_OBJECTIVE_CHARS.toLocaleString()} characters. ` +
        "Put longer instructions in a file and refer to that file from the objective.",
    );
  }
  return objective;
}

export interface ParsedLoopInput {
  objective: string;
  iterations: number;
}

export function parseLoopInput(input: string): ParsedLoopInput {
  const trimmed = input.trim();
  const match = trimmed.match(/^([0-9]{1,3})(?:\s+([\s\S]*))?$/);
  if (!match) {
    throw new Error("Usage: /loop <N> <objective> with N an integer from 1 to 50.");
  }
  const iterations = Number(match[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 50) {
    throw new Error("Loop iterations must be an integer from 1 to 50.");
  }
  return { iterations, objective: validateObjective(match[2] ?? "") };
}

export function createLoop(
  objectiveInput: string,
  iterations: number,
  now = Date.now(),
  id: string = randomUUID(),
): LoopState {
  const parsed = parseLoopInput(`${iterations} ${objectiveInput}`);
  return {
    version: 1,
    id,
    generation: 1,
    status: "running",
    spec: { objective: parsed.objective, iterations: parsed.iterations },
    completedIterations: 0,
    roundLog: [],
    createdAt: now,
  };
}

export function settleRound(
  loop: LoopState,
  outcome: { status: "ok" | "length"; turns: number; summary: string },
  now = Date.now(),
): LoopState {
  if (loop.status !== "running") return loop;
  if (loop.completedIterations >= loop.spec.iterations) return loop;
  const completedIterations = loop.completedIterations + 1;
  const entry: RoundLogEntry = {
    round: completedIterations,
    status: outcome.status,
    turns: Math.max(0, Math.floor(outcome.turns)),
    summary: clampText(outcome.summary, MAX_ROUND_SUMMARY_CHARS),
    at: now,
  };
  const roundLog = [...loop.roundLog, entry];
  while (roundLog.length > MAX_ROUND_LOG) roundLog.shift();
  const finished = completedIterations >= loop.spec.iterations;
  return {
    ...loop,
    status: finished ? "finished" : "running",
    completedIterations,
    roundLog,
    finishedAt: finished ? now : undefined,
  };
}

export function failAttempt(
  loop: LoopState,
  outcome: { status: "error" | "aborted"; reason: string },
  now = Date.now(),
): LoopState {
  if (loop.status !== "running") return loop;
  const round = loop.completedIterations + 1;
  if (round > loop.spec.iterations) return loop;
  const lastAttempt: LastAttempt = {
    round,
    status: outcome.status,
    reason: clampText(outcome.reason, MAX_ATTEMPT_REASON_CHARS),
    at: now,
  };
  const pauseReason: PauseReason = outcome.status === "error" && isUsageLimitError(outcome.reason)
    ? "usage-limit"
    : outcome.status === "error"
      ? "error"
      : "abort";
  return { ...loop, status: "paused", lastAttempt, pauseReason };
}

export function resumeLoop(loop: LoopState, now = Date.now()): LoopState {
  if (loop.status !== "paused") return loop;
  return { ...loop, status: "running", generation: loop.generation + 1 };
}

export function setLoopStatus(
  loop: LoopState,
  status: LoopStatus,
  pauseReason?: PauseReason,
  now = Date.now(),
): LoopState {
  return {
    ...loop,
    status,
    pauseReason: status === "paused" || status === "stopped" ? pauseReason : undefined,
    finishedAt: status === "finished" ? loop.finishedAt ?? now : loop.finishedAt,
  };
}

export function isUsageLimitError(text: string): boolean {
  return /\b(usage|rate|quota|limit)\b/i.test(text);
}

export function clampText(text: string, maxChars: number): string {
  const chars = [...text];
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

export function statusLabel(status: LoopStatus): string {
  switch (status) {
    case "running":
      return "running";
    case "paused":
      return "paused";
    case "finished":
      return "finished";
    case "stopped":
      return "stopped";
  }
}

export function pauseReasonLabel(reason: PauseReason): string {
  switch (reason) {
    case "user":
      return "paused by user";
    case "error":
      return "agent error";
    case "usage-limit":
      return "usage limit";
    case "abort":
      return "aborted";
    case "reload":
      return "paused after reload";
    case "restore":
      return "paused after restore";
    case "send-failed":
      return "continuation send failed";
  }
}

export function decodeLoopState(value: unknown): LoopDecodeResult<LoopState> {
  if (!isRecord(value)) return decodeFailure("Loop state must be an object.");
  if (value.version !== 1) return decodeFailure(`Unsupported Loop state version: ${String(value.version)}.`);

  if (typeof value.id !== "string" || value.id.trim() !== value.id || value.id.length === 0) {
    return decodeFailure("Loop state has an invalid ID.");
  }
  if ([...value.id].length > MAX_LOOP_ID_CHARS) {
    return decodeFailure(`Loop ID exceeds the ${MAX_LOOP_ID_CHARS} character limit.`);
  }
  if (!isNonNegativeSafeInteger(value.generation) || value.generation < 1) {
    return decodeFailure("Loop generation must be a positive integer.");
  }
  if (!isRecord(value.spec)) return decodeFailure("Loop state has no spec.");
  if (typeof value.spec.objective !== "string") return decodeFailure("Loop spec has no objective.");
  let objective: string;
  try {
    objective = validateObjective(value.spec.objective);
  } catch (error) {
    return decodeFailure(error instanceof Error ? error.message : String(error));
  }
  if (objective !== value.spec.objective) return decodeFailure("Loop objective is not normalized.");
  if (
    typeof value.spec.iterations !== "number" ||
    !Number.isSafeInteger(value.spec.iterations) ||
    value.spec.iterations < 1 ||
    value.spec.iterations > 50
  ) {
    return decodeFailure("Loop iterations must be an integer from 1 to 50.");
  }

  let warning: string | undefined;
  let status: LoopStatus;
  if (typeof value.status === "string" && Object.hasOwn(VALID_LOOP_STATUSES, value.status)) {
    status = value.status as LoopStatus;
  } else if (typeof value.status === "string" && value.status.trim()) {
    status = "paused";
    warning = `Unknown Loop status ${JSON.stringify(value.status)} was restored as paused.`;
  } else {
    return decodeFailure("Loop state has an invalid status.");
  }

  if (!isNonNegativeSafeInteger(value.completedIterations)) {
    return decodeFailure("Loop completedIterations must be a non-negative safe integer.");
  }
  if (value.completedIterations > value.spec.iterations) {
    return decodeFailure("Loop completedIterations exceeds the iteration limit.");
  }
  if (!Array.isArray(value.roundLog)) return decodeFailure("Loop roundLog must be an array.");
  if (value.roundLog.length > MAX_ROUND_LOG) return decodeFailure("Loop roundLog exceeds the bounded size.");
  if (value.roundLog.length !== value.completedIterations) {
    return decodeFailure("Loop roundLog length must equal completedIterations.");
  }
  const roundLog: RoundLogEntry[] = [];
  for (const [index, raw] of value.roundLog.entries()) {
    const decodedRound = decodeRoundLogEntry(raw, index + 1);
    if (!decodedRound.ok) return decodedRound;
    roundLog.push(decodedRound.value);
  }

  let lastAttempt: LastAttempt | undefined;
  if (value.lastAttempt !== undefined && value.lastAttempt !== null) {
    const decodedAttempt = decodeLastAttempt(value.lastAttempt, value.completedIterations, value.spec.iterations);
    if (!decodedAttempt.ok) return decodedAttempt;
    lastAttempt = decodedAttempt.value;
  }

  let pauseReason: PauseReason | undefined;
  if (value.pauseReason !== undefined && value.pauseReason !== null) {
    if (typeof value.pauseReason !== "string" || !Object.hasOwn(VALID_PAUSE_REASONS, value.pauseReason)) {
      return decodeFailure("Loop pauseReason is invalid.");
    }
    pauseReason = value.pauseReason as PauseReason;
  }

  if (!isNonNegativeSafeInteger(value.createdAt)) {
    return decodeFailure("Loop createdAt must be a non-negative safe integer.");
  }
  let finishedAt: number | undefined;
  if (value.finishedAt !== undefined && value.finishedAt !== null) {
    if (!isNonNegativeSafeInteger(value.finishedAt)) {
      return decodeFailure("Loop finishedAt must be a non-negative safe integer.");
    }
    finishedAt = value.finishedAt;
  }

  if (status === "finished") {
    if (value.completedIterations !== value.spec.iterations) {
      return decodeFailure("A finished Loop must have completed all iterations.");
    }
    if (finishedAt === undefined) {
      status = "paused";
      warning = warning ? `${warning} A finished Loop without finishedAt was restored as paused.` : "A finished Loop without finishedAt was restored as paused.";
    }
  }
  if (value.completedIterations >= value.spec.iterations && status !== "finished") {
    status = "finished";
    if (finishedAt === undefined) finishedAt = value.createdAt;
    const capped = "A Loop that reached its iteration limit was restored as finished.";
    warning = warning ? `${warning} ${capped}` : capped;
  }
  if ((status === "paused" || status === "stopped") && pauseReason === undefined) {
    return decodeFailure(`A ${status} Loop must carry a pauseReason.`);
  }
  if (finishedAt !== undefined && finishedAt < value.createdAt) {
    return decodeFailure("Loop finishedAt precedes createdAt.");
  }

  return {
    ok: true,
    value: {
      version: 1,
      id: value.id,
      generation: value.generation,
      status,
      spec: { objective, iterations: value.spec.iterations },
      completedIterations: value.completedIterations,
      roundLog,
      lastAttempt,
      pauseReason,
      createdAt: value.createdAt,
      ...(finishedAt !== undefined ? { finishedAt } : {}),
    },
    warning,
  };
}

function decodeRoundLogEntry(value: unknown, expectedRound: number): LoopDecodeResult<RoundLogEntry> {
  if (!isRecord(value)) return decodeFailure("Loop roundLog entry must be an object.");
  if (value.round !== expectedRound || !isNonNegativeSafeInteger(value.round) || value.round < 1) {
    return decodeFailure(`Loop roundLog entry ${expectedRound} has an invalid round number.`);
  }
  if (value.status !== "ok" && value.status !== "length") {
    return decodeFailure(`Loop roundLog entry ${expectedRound} has an invalid status.`);
  }
  if (!isNonNegativeSafeInteger(value.turns)) {
    return decodeFailure(`Loop roundLog entry ${expectedRound} has an invalid turns count.`);
  }
  if (typeof value.summary !== "string" || [...value.summary].length > MAX_ROUND_SUMMARY_CHARS) {
    return decodeFailure(`Loop roundLog entry ${expectedRound} has an invalid summary.`);
  }
  if (!isNonNegativeSafeInteger(value.at)) {
    return decodeFailure(`Loop roundLog entry ${expectedRound} has an invalid timestamp.`);
  }
  return {
    ok: true,
    value: {
      round: value.round,
      status: value.status,
      turns: value.turns,
      summary: value.summary,
      at: value.at,
    },
  };
}

function decodeLastAttempt(value: unknown, completedIterations: number, iterations: number): LoopDecodeResult<LastAttempt> {
  if (!isRecord(value)) return decodeFailure("Loop lastAttempt must be an object.");
  if (!isNonNegativeSafeInteger(value.round) || value.round < 1) {
    return decodeFailure("Loop lastAttempt has an invalid round.");
  }
  if (value.round !== completedIterations + 1 || value.round > iterations) {
    return decodeFailure("Loop lastAttempt round must be the next pending round.");
  }
  if (value.status !== "error" && value.status !== "aborted") {
    return decodeFailure("Loop lastAttempt has an invalid status.");
  }
  if (typeof value.reason !== "string" || [...value.reason].length > MAX_ATTEMPT_REASON_CHARS) {
    return decodeFailure("Loop lastAttempt has an invalid reason.");
  }
  if (!isNonNegativeSafeInteger(value.at)) {
    return decodeFailure("Loop lastAttempt has an invalid timestamp.");
  }
  return {
    ok: true,
    value: { round: value.round, status: value.status, reason: value.reason, at: value.at },
  };
}

export function decodeLoopJournalEntry(value: unknown): LoopDecodeResult<LoopJournalEntry> {
  if (!isRecord(value)) return decodeFailure("Loop journal entry must be an object.");
  if (value.version !== 1) return decodeFailure(`Unsupported Loop journal version: ${String(value.version)}.`);
  if (typeof value.action !== "string" || !Object.hasOwn(VALID_LOOP_ACTIONS, value.action)) {
    return decodeFailure("Loop journal entry has an invalid action.");
  }
  const action = value.action as LoopJournalEntry["action"];
  if (action === "clear") {
    if (value.loop !== null) return decodeFailure("A Loop clear entry must contain a null loop.");
    return { ok: true, value: { version: 1, action, loop: null } };
  }
  const decoded = decodeLoopState(value.loop);
  if (!decoded.ok) return decoded;
  return {
    ok: true,
    value: { version: 1, action, loop: decoded.value },
    warning: decoded.warning,
  };
}
