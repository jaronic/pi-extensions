import type { EventBus, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export const EXECUTION_PROGRESS_CHANNEL = "pi-extensions:execution-progress:v1";
export const TODO_PROGRESS_PROVIDER_ID = "todo";
export const TODO_MANAGED_PROGRESS_TYPE = "todo-managed-progress-v1";

const MAX_STEPS = 50;
const MAX_STEP_ID_CHARS = 64;
const MAX_STEP_TEXT_CHARS = 500;
const MAX_EXECUTION_ID_CHARS = 128;
const MAX_SESSION_ID_CHARS = 256;
const MAX_REQUEST_ID_CHARS = 256;
const MAX_ENTRY_BYTES = 64 * 1024;
const MAX_WIDGET_ROWS = 12;
const MAX_PROMPT_STEPS = 20;
const FORBIDDEN_DISPLAY_CODE_POINT = /[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028-\u202E\u2066-\u206F]/u;

const MANAGED_STATE_KEYS = new Set(["version", "sessionId", "executionId", "revision", "steps", "lastRequest", "createdAt", "updatedAt"]);
const MANAGED_STEP_KEYS = new Set(["id", "text", "status"]);
const MANAGED_LAST_REQUEST_KEYS = new Set(["id", "stepId", "status"]);
const MANAGED_ENTRY_KEYS = new Set(["version", "state"]);

export type ManagedProgressStatus = "pending" | "inProgress" | "completed" | "blocked";

export interface ManagedProgressStep {
  readonly id: string;
  readonly text: string;
  readonly status: ManagedProgressStatus;
}

export interface ManagedProgressState {
  readonly version: 1;
  readonly sessionId: string;
  readonly executionId: string;
  readonly revision: number;
  readonly steps: readonly ManagedProgressStep[];
  readonly lastRequest?: {
    readonly id: string;
    readonly stepId: string;
    readonly status: ManagedProgressStatus;
  };
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface ManagedProgressEntry {
  readonly version: 1;
  readonly state: ManagedProgressState | null;
}

interface ProgressStepDefinition {
  readonly id: string;
  readonly text: string;
}

interface ProgressOpenRequest {
  readonly sessionId: string;
  readonly executionId: string;
  readonly steps: readonly ProgressStepDefinition[];
  readonly signal?: AbortSignal;
}

interface ProgressReadRequest {
  readonly sessionId: string;
  readonly executionId: string;
  readonly signal?: AbortSignal;
}

interface ProgressUpdateRequest extends ProgressReadRequest {
  readonly requestId: string;
  readonly stepId: string;
  readonly status: ManagedProgressStatus;
}

interface ProgressCloseRequest extends ProgressReadRequest {
  readonly outcome: "completed" | "cancelled";
}

interface ProgressProvider {
  readonly id: string;
  readonly priority: number;
  open(request: ProgressOpenRequest): Promise<unknown>;
  read(request: ProgressReadRequest): Promise<unknown>;
  update(request: ProgressUpdateRequest): Promise<unknown>;
  close(request: ProgressCloseRequest): Promise<void>;
}

interface ProgressDiscoveryEnvelope {
  readonly version: 1;
  readonly kind: "discover";
  offer(provider: unknown): void;
}

export interface ManagedProgressRuntime {
  getState(): ManagedProgressState | null;
  getSessionId(): string | undefined;
  getPlanPhase(): string;
  now(): number;
  commit(state: ManagedProgressState | null): void;
}

export interface ManagedProgressRestoreResult {
  readonly state: ManagedProgressState | null;
  readonly warning?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function identifier(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.trim() !== value || [...value].length > maximum) {
    throw new Error(`${label} must be non-empty trimmed text within ${maximum} characters.`);
  }
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function status(value: unknown, label: string): ManagedProgressStatus {
  if (value !== "pending" && value !== "inProgress" && value !== "completed" && value !== "blocked") {
    throw new Error(`${label} has an invalid status.`);
  }
  return value;
}

function normalizedStep(value: unknown, index: number): ManagedProgressStep {
  if (!isRecord(value) || !hasOnlyKeys(value, MANAGED_STEP_KEYS)) {
    throw new Error(`Managed progress step ${index + 1} must be an exact object.`);
  }
  const id = identifier(value.id, `Managed progress step ${index + 1} ID`, MAX_STEP_ID_CHARS);
  if (typeof value.text !== "string" || !value.text || value.text.trim() !== value.text || [...value.text].length > MAX_STEP_TEXT_CHARS) {
    throw new Error(`Managed progress step ${id} has invalid text.`);
  }
  if (FORBIDDEN_DISPLAY_CODE_POINT.test(value.text)) {
    throw new Error(`Managed progress step ${id} contains a forbidden display control character.`);
  }
  return Object.freeze({ id, text: value.text, status: status(value.status, `Managed progress step ${id}`) });
}

function freezeState(candidate: ManagedProgressState): ManagedProgressState {
  const ids = new Set<string>();
  let inProgress = 0;
  const steps = candidate.steps.map((step, index) => {
    const normalized = normalizedStep(step, index);
    if (ids.has(normalized.id)) throw new Error(`Duplicate managed progress step ID: ${normalized.id}.`);
    ids.add(normalized.id);
    if (normalized.status === "inProgress") inProgress += 1;
    return normalized;
  });
  if (steps.length < 1 || steps.length > MAX_STEPS) throw new Error(`Managed progress requires 1 to ${MAX_STEPS} steps.`);
  if (inProgress > 1) throw new Error("Managed progress contains multiple in-progress steps.");
  const createdAt = timestamp(candidate.createdAt, "Managed progress createdAt");
  const updatedAt = timestamp(candidate.updatedAt, "Managed progress updatedAt");
  if (updatedAt < createdAt) throw new Error("Managed progress updatedAt precedes createdAt.");
  if (!Number.isSafeInteger(candidate.revision) || candidate.revision < 1) {
    throw new Error("Managed progress revision must be a positive safe integer.");
  }
  let lastRequest: ManagedProgressState["lastRequest"];
  if (candidate.lastRequest !== undefined) {
    lastRequest = Object.freeze({
      id: identifier(candidate.lastRequest.id, "Managed progress request ID", MAX_REQUEST_ID_CHARS),
      stepId: identifier(candidate.lastRequest.stepId, "Managed progress request step ID", MAX_STEP_ID_CHARS),
      status: status(candidate.lastRequest.status, "Managed progress request"),
    });
    if (!ids.has(lastRequest.stepId)) throw new Error("Managed progress request references an unknown step.");
  }
  const state = Object.freeze({
    version: 1 as const,
    sessionId: identifier(candidate.sessionId, "Managed progress session ID", MAX_SESSION_ID_CHARS),
    executionId: identifier(candidate.executionId, "Managed progress execution ID", MAX_EXECUTION_ID_CHARS),
    revision: candidate.revision,
    steps: Object.freeze(steps),
    ...(lastRequest === undefined ? {} : { lastRequest }),
    createdAt,
    updatedAt,
  });
  if (Buffer.byteLength(JSON.stringify(state)) > MAX_ENTRY_BYTES) {
    throw new Error(`Managed progress state exceeds the ${MAX_ENTRY_BYTES.toLocaleString()} byte limit.`);
  }
  return state;
}

function decodeState(value: unknown): ManagedProgressState {
  if (!isRecord(value) || !hasOnlyKeys(value, MANAGED_STATE_KEYS) || value.version !== 1 || !Array.isArray(value.steps)) {
    throw new Error("Managed progress state is invalid.");
  }
  if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new Error("Managed progress revision must be a positive safe integer.");
  }
  let lastRequest: ManagedProgressState["lastRequest"];
  if (value.lastRequest !== undefined) {
    if (!isRecord(value.lastRequest) || !hasOnlyKeys(value.lastRequest, MANAGED_LAST_REQUEST_KEYS)) {
      throw new Error("Managed progress last request is invalid.");
    }
    lastRequest = {
      id: identifier(value.lastRequest.id, "Managed progress request ID", MAX_REQUEST_ID_CHARS),
      stepId: identifier(value.lastRequest.stepId, "Managed progress request step ID", MAX_STEP_ID_CHARS),
      status: status(value.lastRequest.status, "Managed progress request"),
    };
  }
  return freezeState({
    version: 1,
    sessionId: identifier(value.sessionId, "Managed progress session ID", MAX_SESSION_ID_CHARS),
    executionId: identifier(value.executionId, "Managed progress execution ID", MAX_EXECUTION_ID_CHARS),
    revision: value.revision,
    steps: value.steps.map((step, index) => normalizedStep(step, index)),
    ...(lastRequest === undefined ? {} : { lastRequest }),
    createdAt: timestamp(value.createdAt, "Managed progress createdAt"),
    updatedAt: timestamp(value.updatedAt, "Managed progress updatedAt"),
  });
}

function entryFor(state: ManagedProgressState | null): ManagedProgressEntry {
  const entry = Object.freeze({ version: 1 as const, state });
  if (Buffer.byteLength(JSON.stringify(entry)) > MAX_ENTRY_BYTES) {
    throw new Error(`Managed progress entry exceeds the ${MAX_ENTRY_BYTES.toLocaleString()} byte limit.`);
  }
  return entry;
}

export function buildManagedProgressEntry(state: ManagedProgressState | null): ManagedProgressEntry {
  return entryFor(state);
}

export function restoreManagedProgress(
  entries: readonly unknown[],
  sessionId: string,
): ManagedProgressRestoreResult {
  let state: ManagedProgressState | null = null;
  let warned = false;
  for (const value of entries) {
    if (!isRecord(value) || value.type !== "custom" || value.customType !== TODO_MANAGED_PROGRESS_TYPE) continue;
    try {
      if (
        !isRecord(value.data) ||
        !hasOnlyKeys(value.data, MANAGED_ENTRY_KEYS) ||
        value.data.version !== 1 ||
        !("state" in value.data)
      ) throw new Error("Managed progress entry is invalid.");
      state = value.data.state === null ? null : decodeState(value.data.state);
    } catch {
      state = null;
      warned = true;
    }
  }
  if (state?.sessionId !== sessionId) state = null;
  return Object.freeze({
    state,
    ...(warned ? { warning: "Some managed Todo progress records were ignored because they were invalid." } : {}),
  });
}

function snapshot(state: ManagedProgressState): object {
  return Object.freeze({
    executionId: state.executionId,
    revision: state.revision,
    steps: Object.freeze(state.steps.map((step) => Object.freeze({ id: step.id, status: step.status }))),
  });
}

function matchesDefinitions(state: ManagedProgressState, steps: readonly ProgressStepDefinition[]): boolean {
  return state.steps.length === steps.length && state.steps.every(
    (step, index) => step.id === steps[index]?.id && step.text === steps[index]?.text,
  );
}

function validateOpenRequest(request: ProgressOpenRequest): readonly ManagedProgressStep[] {
  identifier(request.sessionId, "Progress session ID", MAX_SESSION_ID_CHARS);
  identifier(request.executionId, "Progress execution ID", MAX_EXECUTION_ID_CHARS);
  if (!Array.isArray(request.steps) || request.steps.length < 1 || request.steps.length > MAX_STEPS) {
    throw new Error(`Todo progress provider requires 1 to ${MAX_STEPS} steps.`);
  }
  return Object.freeze(request.steps.map((step, index) => normalizedStep({ ...step, status: "pending" }, index)));
}

export function createTodoProgressProvider(runtime: ManagedProgressRuntime): ProgressProvider {
  return Object.freeze({
    id: TODO_PROGRESS_PROVIDER_ID,
    priority: 100,
    async open(request: ProgressOpenRequest) {
      request.signal?.throwIfAborted();
      const steps = validateOpenRequest(request);
      if (runtime.getSessionId() !== request.sessionId) return undefined;
      const current = runtime.getState();
      if (current?.executionId === request.executionId) {
        if (!matchesDefinitions(current, request.steps)) {
          throw new Error("Todo progress execution was reopened with different approved steps.");
        }
        return snapshot(current);
      }
      if (current && runtime.getPlanPhase() === "executing") return undefined;
      const now = timestamp(runtime.now(), "Managed progress timestamp");
      const next = freezeState({
        version: 1,
        sessionId: request.sessionId,
        executionId: request.executionId,
        revision: 1,
        steps,
        createdAt: now,
        updatedAt: now,
      });
      request.signal?.throwIfAborted();
      runtime.commit(next);
      return snapshot(next);
    },
    async read(request: ProgressReadRequest) {
      request.signal?.throwIfAborted();
      const current = runtime.getState();
      if (
        !current ||
        runtime.getSessionId() !== request.sessionId ||
        current.sessionId !== request.sessionId ||
        current.executionId !== request.executionId
      ) return undefined;
      return snapshot(current);
    },
    async update(request: ProgressUpdateRequest) {
      request.signal?.throwIfAborted();
      identifier(request.requestId, "Progress request ID", MAX_REQUEST_ID_CHARS);
      const current = runtime.getState();
      if (
        !current ||
        runtime.getSessionId() !== request.sessionId ||
        current.sessionId !== request.sessionId ||
        current.executionId !== request.executionId
      ) throw new Error("Todo progress provider does not own this execution.");
      const nextStatus = status(request.status, "Progress update");
      const stepId = identifier(request.stepId, "Progress update step ID", MAX_STEP_ID_CHARS);
      const lastRequest = current.lastRequest;
      if (lastRequest?.id === request.requestId) {
        if (lastRequest.stepId !== stepId || lastRequest.status !== nextStatus) {
          throw new Error("Progress request ID was reused with different input.");
        }
        return snapshot(current);
      }
      if (!current.steps.some((step) => step.id === stepId)) throw new Error(`Unknown progress step: ${stepId}`);
      const steps = current.steps.map((step) => {
        if (step.id === stepId) return { ...step, status: nextStatus };
        if (nextStatus === "inProgress" && step.status === "inProgress") return { ...step, status: "pending" as const };
        return step;
      });
      if (current.revision >= Number.MAX_SAFE_INTEGER) throw new Error("Managed progress revision exhausted.");
      const next = freezeState({
        ...current,
        revision: current.revision + 1,
        steps,
        lastRequest: { id: request.requestId, stepId, status: nextStatus },
        updatedAt: Math.max(timestamp(runtime.now(), "Managed progress timestamp"), current.updatedAt),
      });
      request.signal?.throwIfAborted();
      runtime.commit(next);
      return snapshot(next);
    },
    async close(request: ProgressCloseRequest) {
      request.signal?.throwIfAborted();
      const current = runtime.getState();
      if (!current || current.executionId !== request.executionId || current.sessionId !== request.sessionId) return;
      runtime.commit(null);
    },
  });
}

export function registerTodoProgressProvider(events: EventBus, provider: ProgressProvider): () => void {
  return events.on(EXECUTION_PROGRESS_CHANNEL, (value: unknown) => {
    if (!isRecord(value) || value.version !== 1 || value.kind !== "discover" || typeof value.offer !== "function") return;
    (value as unknown as ProgressDiscoveryEnvelope).offer(provider);
  });
}

function progressCounts(state: ManagedProgressState): Record<ManagedProgressStatus, number> {
  const counts: Record<ManagedProgressStatus, number> = { pending: 0, inProgress: 0, completed: 0, blocked: 0 };
  for (const step of state.steps) counts[step.status] += 1;
  return counts;
}

function managedStepLabel(state: ManagedProgressState, step: ManagedProgressStep): string {
  const index = state.steps.indexOf(step);
  if (index < 0) throw new Error("Managed progress step is not part of its state.");
  return `#${index + 1}`;
}

export function managedProgressFooter(state: ManagedProgressState): { text: string; color: "accent" | "warning" | "success" } {
  const counts = progressCounts(state);
  const active = state.steps.find((step) => step.status === "inProgress");
  if (counts.completed === state.steps.length) return { text: `Todo · Plan ${counts.completed}/${state.steps.length} · settled`, color: "success" };
  if (counts.blocked > 0 && counts.pending === 0 && counts.inProgress === 0) {
    return { text: `Todo · Plan ${counts.completed}/${state.steps.length} · ${counts.blocked} blocked`, color: "warning" };
  }
  return {
    text: `Todo · Plan ${counts.completed}/${state.steps.length}${active ? ` · ${managedStepLabel(state, active)} ${active.text}` : ""}`,
    color: "accent",
  };
}

export function managedProgressWidget(state: ManagedProgressState, theme: Theme, width = 120): string[] {
  const counts = progressCounts(state);
  const active = state.steps.find((step) => step.status === "inProgress");
  const ordered = [
    ...(active ? [active] : []),
    ...state.steps.filter((step) => step.status === "pending"),
    ...state.steps.filter((step) => step.status === "blocked"),
  ];
  const headingColor = counts.completed === state.steps.length ? "success" : counts.blocked > 0 && ordered.every((step) => step.status === "blocked") ? "warning" : "accent";
  const lines = [truncateToWidth(theme.fg(headingColor, `Todo · Plan · ${counts.completed}/${state.steps.length} completed · ${counts.blocked} blocked`), width, "")];
  const visible = ordered.slice(0, MAX_WIDGET_ROWS - 1);
  for (const step of visible) {
    const symbol = step.status === "inProgress" ? "→" : step.status === "blocked" ? "!" : "·";
    const color = step.status === "inProgress" ? "accent" : step.status === "blocked" ? "warning" : "dim";
    lines.push(truncateToWidth(`${theme.fg(color, symbol)} ${theme.fg("accent", managedStepLabel(state, step))} ${theme.fg(step.status === "inProgress" ? "text" : "muted", step.text)}`, width, ""));
  }
  if (ordered.length > visible.length && lines.length < MAX_WIDGET_ROWS) {
    lines.push(theme.fg("dim", `… ${ordered.length - visible.length} more`));
  }
  return lines.slice(0, MAX_WIDGET_ROWS);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function managedProgressPrompt(state: ManagedProgressState): string | undefined {
  const open = state.steps.filter((step) => step.status !== "completed");
  if (open.length === 0) return undefined;
  const counts = progressCounts(state);
  const lines = [
    "Todo is the selected execution-progress provider for the active Plan.",
    "",
    `<untrusted_execution_progress execution_id="${escapeXml(state.executionId)}" revision="${state.revision}">`,
    `Counts: total=${state.steps.length} pending=${counts.pending} inProgress=${counts.inProgress} blocked=${counts.blocked} completed=${counts.completed}`,
  ];
  for (const step of open.slice(0, MAX_PROMPT_STEPS)) {
    lines.push(`${escapeXml(step.id)} [${step.status}] ${escapeXml(step.text)}`);
  }
  if (open.length > MAX_PROMPT_STEPS) lines.push(`... ${open.length - MAX_PROMPT_STEPS} more open steps`);
  lines.push("</untrusted_execution_progress>");
  lines.push("");
  lines.push("Call update_plan_step for every progress change; do not mutate this managed ledger with the todo tool.");
  return lines.join("\n");
}
