import type { ManagedProgressService } from "pi-todo-dev";
import {
  MAX_PLAN_STEP_CHARS,
  MAX_PLAN_STEP_ID_CHARS,
  MAX_PLAN_STEPS,
  type PlanStepStatus,
} from "./state.ts";

const PROGRESS_SNAPSHOT_KEYS = new Set(["executionId", "revision", "steps"]);
const PROGRESS_STEP_SNAPSHOT_KEYS = new Set(["id", "status"]);
export const MAX_PROGRESS_EXECUTION_ID_CHARS = 128;

export interface ProgressStepDefinition {
  readonly id: string;
  readonly text: string;
}

export interface ProgressStepSnapshot {
  readonly id: string;
  readonly status: PlanStepStatus;
}

export interface ProgressSnapshot {
  readonly executionId: string;
  readonly revision: number;
  readonly steps: readonly ProgressStepSnapshot[];
}

export interface ProgressOpenRequest {
  readonly sessionId: string;
  readonly executionId: string;
  readonly steps: readonly ProgressStepDefinition[];
  readonly signal?: AbortSignal;
}

export interface ProgressReadRequest {
  readonly sessionId: string;
  readonly executionId: string;
  readonly signal?: AbortSignal;
}

export interface ProgressUpdateRequest extends ProgressReadRequest {
  readonly requestId: string;
  readonly stepId: string;
  readonly status: PlanStepStatus;
}

export interface ProgressCloseRequest extends ProgressReadRequest {
  readonly outcome: "completed" | "cancelled";
}

export type TodoManagedProgressService = Pick<ManagedProgressService, "open" | "read" | "update" | "close">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function normalizedIdentifier(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.trim() !== value || [...value].length > maximum) {
    throw new Error(`${label} must be non-empty trimmed text within ${maximum} characters.`);
  }
  return value;
}

export function decodeProgressSnapshot(
  value: unknown,
  executionId: string,
  definitions: readonly ProgressStepDefinition[],
): ProgressSnapshot {
  if (!isRecord(value) || !hasOnlyKeys(value, PROGRESS_SNAPSHOT_KEYS)) {
    throw new Error("Todo managed progress returned an invalid snapshot.");
  }
  if (value.executionId !== executionId) throw new Error("Progress snapshot executionId does not match the active Plan.");
  if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new Error("Progress snapshot revision must be a positive safe integer.");
  }
  if (!Array.isArray(value.steps) || value.steps.length !== definitions.length) {
    throw new Error("Progress snapshot does not contain every approved Plan step.");
  }
  let inProgress = 0;
  const steps = value.steps.map((candidate, index): ProgressStepSnapshot => {
    if (!isRecord(candidate)) throw new Error("Progress snapshot contains an invalid step.");
    if (!hasOnlyKeys(candidate, PROGRESS_STEP_SNAPSHOT_KEYS)) {
      throw new Error("Progress snapshot step contains unknown fields.");
    }
    const definition = definitions[index];
    if (!definition || candidate.id !== definition.id) {
      throw new Error("Progress snapshot step order or IDs do not match the approved Plan.");
    }
    if (
      candidate.status !== "pending" &&
      candidate.status !== "inProgress" &&
      candidate.status !== "completed" &&
      candidate.status !== "blocked"
    ) throw new Error(`Progress snapshot step ${definition.id} has an invalid status.`);
    if (candidate.status === "inProgress") inProgress += 1;
    return Object.freeze({ id: definition.id, status: candidate.status });
  });
  if (inProgress > 1) throw new Error("Progress snapshot contains multiple in-progress steps.");
  return Object.freeze({
    executionId,
    revision: value.revision,
    steps: Object.freeze(steps),
  });
}

function definitionsFrom(steps: readonly ProgressStepDefinition[]): readonly ProgressStepDefinition[] {
  if (steps.length < 1 || steps.length > MAX_PLAN_STEPS) {
    throw new Error(`Execution progress requires 1 to ${MAX_PLAN_STEPS} steps.`);
  }
  const ids = new Set<string>();
  return Object.freeze(steps.map((step, index) => {
    const id = normalizedIdentifier(step.id, `Progress step ${index + 1} ID`, MAX_PLAN_STEP_ID_CHARS);
    if (ids.has(id)) throw new Error(`Duplicate progress step ID: ${id}.`);
    ids.add(id);
    if (typeof step.text !== "string" || !step.text.trim() || step.text.trim() !== step.text || [...step.text].length > MAX_PLAN_STEP_CHARS) {
      throw new Error(`Progress step ${id} has invalid text.`);
    }
    return Object.freeze({ id, text: step.text });
  }));
}

export async function openTodoProgress(
  progress: TodoManagedProgressService,
  request: ProgressOpenRequest,
): Promise<ProgressSnapshot> {
  const executionId = normalizedIdentifier(
    request.executionId,
    "Progress execution ID",
    MAX_PROGRESS_EXECUTION_ID_CHARS,
  );
  const definitions = definitionsFrom(request.steps);
  request.signal?.throwIfAborted();
  const value = await progress.open({ ...request, executionId, steps: definitions });
  request.signal?.throwIfAborted();
  if (value === undefined) throw new Error(`Todo managed progress could not open execution ${executionId}.`);
  return decodeProgressSnapshot(value, executionId, definitions);
}

export async function readTodoProgress(
  progress: TodoManagedProgressService,
  request: ProgressReadRequest,
  definitions: readonly ProgressStepDefinition[],
): Promise<ProgressSnapshot> {
  request.signal?.throwIfAborted();
  const value = await progress.read(request);
  request.signal?.throwIfAborted();
  if (value === undefined) throw new Error(`Todo managed progress does not own execution ${request.executionId}.`);
  return decodeProgressSnapshot(value, request.executionId, definitions);
}

export async function updateTodoProgress(
  progress: TodoManagedProgressService,
  request: ProgressUpdateRequest,
  definitions: readonly ProgressStepDefinition[],
): Promise<ProgressSnapshot> {
  request.signal?.throwIfAborted();
  const value = await progress.update(request);
  request.signal?.throwIfAborted();
  return decodeProgressSnapshot(value, request.executionId, definitions);
}

export async function closeTodoProgress(
  progress: TodoManagedProgressService,
  request: ProgressCloseRequest,
): Promise<void> {
  request.signal?.throwIfAborted();
  await progress.close(request);
  request.signal?.throwIfAborted();
}

export function allProgressStepsComplete(snapshot: ProgressSnapshot): boolean {
  return snapshot.steps.length > 0 && snapshot.steps.every((step) => step.status === "completed");
}
