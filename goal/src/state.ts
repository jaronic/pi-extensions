import { randomUUID } from "node:crypto";

export const MAX_GOAL_OBJECTIVE_CHARS = 4_000;
export const MAX_GOAL_ID_CHARS = 128;

export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";
const VALID_GOAL_STATUSES: Record<GoalStatus, true> = {
  active: true,
  paused: true,
  blocked: true,
  usageLimited: true,
  budgetLimited: true,
  complete: true,
};

function isGoalStatus(value: unknown): value is GoalStatus {
  return typeof value === "string" && Object.hasOwn(VALID_GOAL_STATUSES, value);
}

export interface GoalState {
  version: 1;
  id: string;
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

export interface GoalJournalEntry {
  version: 1;
  action: "set" | "edit" | "status" | "clear" | "account";
  goal: GoalState | null;
}

export type GoalDecodeResult<T> =
  | { ok: true; value: T; warning?: string }
  | { ok: false; reason: string };

const VALID_GOAL_ACTIONS: Record<GoalJournalEntry["action"], true> = {
  set: true,
  edit: true,
  status: true,
  clear: true,
  account: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeFailure<T>(reason: string): GoalDecodeResult<T> {
  return { ok: false, reason };
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export interface ParsedGoalInput {
  objective: string;
  tokenBudget?: number;
}


export function validateObjective(input: string): string {
  const objective = input.trim();
  if (!objective) throw new Error("Goal objective must not be empty.");
  const length = [...objective].length;
  if (length > MAX_GOAL_OBJECTIVE_CHARS) {
    throw new Error(
      `Goal objective is too long: ${length.toLocaleString()} characters. ` +
        `Limit: ${MAX_GOAL_OBJECTIVE_CHARS.toLocaleString()} characters. ` +
        "Put longer instructions in a file and refer to that file from the goal.",
    );
  }
  return objective;
}

export function normalizeTokenBudget(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Goal token budget must be a positive integer.");
  }
  return value;
}

export function parseGoalInput(input: string): ParsedGoalInput {
  const budgetMatch = input.match(/(?:^|\s)--tokens(?:=|\s+)(\S+)(?=\s|$)/i);
  if (!budgetMatch) return { objective: validateObjective(input) };

  const raw = budgetMatch[1];
  const suffix = raw.slice(-1).toLowerCase();
  const numberPart = suffix === "k" || suffix === "m" ? raw.slice(0, -1) : raw;
  const numeric = Number(numberPart);
  const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
  const tokenBudget = Math.round(numeric * multiplier);
  if (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0) {
    throw new Error("Goal token budget must be a positive safe integer, for example --tokens 50k.");
  }

  const start = budgetMatch.index ?? 0;
  const beforeBudget = input.slice(0, start).trimEnd();
  const afterBudget = input.slice(start + budgetMatch[0].length).trimStart();
  const objective = [beforeBudget, afterBudget].filter(Boolean).join(" ");
  return { objective: validateObjective(objective), tokenBudget };
}

export function createGoal(
  objectiveInput: string,
  tokenBudgetInput?: number,
  now = Date.now(),
  id: string = randomUUID(),
): GoalState {
  return {
    version: 1,
    id,
    objective: validateObjective(objectiveInput),
    status: "active",
    tokenBudget: normalizeTokenBudget(tokenBudgetInput),
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function editGoal(goal: GoalState, objectiveInput: string, now = Date.now()): GoalState {
  const status = goal.status === "complete" ? "active" : goal.status;
  return {
    ...goal,
    objective: validateObjective(objectiveInput),
    status,
    updatedAt: now,
  };
}

export function setGoalStatus(goal: GoalState, status: GoalStatus, now = Date.now()): GoalState {
  return { ...goal, status, updatedAt: now };
}

export function accountGoalTurn(
  goal: GoalState,
  tokenDelta: number,
  elapsedSeconds: number,
  now = Date.now(),
): GoalState {
  const tokensUsed = goal.tokensUsed + Math.max(0, Math.floor(tokenDelta));
  const timeUsedSeconds = goal.timeUsedSeconds + Math.max(0, Math.floor(elapsedSeconds));
  let status = goal.status;
  if (status === "active" && goal.tokenBudget !== undefined && tokensUsed >= goal.tokenBudget) {
    status = "budgetLimited";
  }
  return { ...goal, status, tokensUsed, timeUsedSeconds, updatedAt: now };
}

export function tokenDeltaFromMessage(message: unknown): number {
  if (!message || typeof message !== "object" || !("usage" in message)) return 0;
  const usage = message.usage;
  if (!usage || typeof usage !== "object") return 0;
  const totalTokens = "totalTokens" in usage ? usage.totalTokens : undefined;
  if (typeof totalTokens === "number" && Number.isFinite(totalTokens)) {
    return Math.max(0, Math.floor(totalTokens));
  }
  const input = "input" in usage && typeof usage.input === "number" ? usage.input : 0;
  const output = "output" in usage && typeof usage.output === "number" ? usage.output : 0;
  const cacheRead = "cacheRead" in usage && typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
  const cacheWrite = "cacheWrite" in usage && typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
  return Math.max(0, Math.floor(input + output + cacheRead + cacheWrite));
}

export function decodeGoalState(value: unknown): GoalDecodeResult<GoalState> {
  if (!isRecord(value)) return decodeFailure("Goal state must be an object.");
  if (value.version !== 1) return decodeFailure(`Unsupported Goal state version: ${String(value.version)}.`);

  if (typeof value.id !== "string" || value.id.trim() !== value.id || value.id.length === 0) {
    return decodeFailure("Goal state has an invalid ID.");
  }
  if ([...value.id].length > MAX_GOAL_ID_CHARS) {
    return decodeFailure(`Goal ID exceeds the ${MAX_GOAL_ID_CHARS} character limit.`);
  }

  if (typeof value.objective !== "string") return decodeFailure("Goal state has no objective.");
  let objective: string;
  try {
    objective = validateObjective(value.objective);
  } catch (error) {
    return decodeFailure(error instanceof Error ? error.message : String(error));
  }
  if (objective !== value.objective) return decodeFailure("Goal objective is not normalized.");

  let warning: string | undefined;
  let status: GoalStatus;
  if (isGoalStatus(value.status)) {
    status = value.status;
  } else if (typeof value.status === "string" && value.status.trim()) {
    status = "paused";
    warning = `Unknown Goal status ${JSON.stringify(value.status)} was restored as paused.`;
  } else {
    return decodeFailure("Goal state has an invalid status.");
  }

  let tokenBudget: number | undefined;
  try {
    tokenBudget = normalizeTokenBudget(value.tokenBudget);
  } catch (error) {
    return decodeFailure(error instanceof Error ? error.message : String(error));
  }
  if (!isNonNegativeSafeInteger(value.tokensUsed)) {
    return decodeFailure("Goal tokensUsed must be a non-negative safe integer.");
  }
  if (!isNonNegativeSafeInteger(value.timeUsedSeconds)) {
    return decodeFailure("Goal timeUsedSeconds must be a non-negative safe integer.");
  }
  if (!isNonNegativeSafeInteger(value.createdAt) || !isNonNegativeSafeInteger(value.updatedAt)) {
    return decodeFailure("Goal timestamps must be non-negative safe integers.");
  }
  if (value.updatedAt < value.createdAt) return decodeFailure("Goal updatedAt precedes createdAt.");
  if (status === "active" && tokenBudget !== undefined && value.tokensUsed >= tokenBudget) {
    status = "budgetLimited";
    const budgetWarning = "An exhausted active Goal was restored as budget limited.";
    warning = warning ? `${warning} ${budgetWarning}` : budgetWarning;
  }

  return {
    ok: true,
    value: {
      version: 1,
      id: value.id,
      objective,
      status,
      tokenBudget,
      tokensUsed: value.tokensUsed,
      timeUsedSeconds: value.timeUsedSeconds,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    },
    warning,
  };
}

export function decodeGoalJournalEntry(value: unknown): GoalDecodeResult<GoalJournalEntry> {
  if (!isRecord(value)) return decodeFailure("Goal journal entry must be an object.");
  if (value.version !== 1) return decodeFailure(`Unsupported Goal journal version: ${String(value.version)}.`);
  if (typeof value.action !== "string" || !Object.hasOwn(VALID_GOAL_ACTIONS, value.action)) {
    return decodeFailure("Goal journal entry has an invalid action.");
  }
  const action = value.action as GoalJournalEntry["action"];
  if (action === "clear") {
    if (value.goal !== null) return decodeFailure("A Goal clear entry must contain a null goal.");
    return { ok: true, value: { version: 1, action, goal: null } };
  }
  const decoded = decodeGoalState(value.goal);
  if (!decoded.ok) return decoded;
  return {
    ok: true,
    value: { version: 1, action, goal: decoded.value },
    warning: decoded.warning,
  };
}

export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1_000) return `${Math.round(value / 100) / 10}K`;
  return String(value);
}

export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function statusLabel(status: GoalStatus): string {
  switch (status) {
    case "active":
      return "active";
    case "paused":
      return "paused";
    case "blocked":
      return "blocked";
    case "usageLimited":
      return "usage limited";
    case "budgetLimited":
      return "budget reached";
    case "complete":
      return "complete";
  }
}
