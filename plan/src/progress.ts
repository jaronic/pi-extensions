import type { EventBus } from "@earendil-works/pi-coding-agent";
import {
  MAX_PLAN_STEP_CHARS,
  MAX_PLAN_STEP_ID_CHARS,
  MAX_PLAN_STEPS,
  type PlanStepStatus,
} from "./state.ts";

export const EXECUTION_PROGRESS_CHANNEL = "pi-extensions:execution-progress:v1";
export const MAX_PROGRESS_PROVIDER_ID_CHARS = 128;
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

export interface ProgressProvider {
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

export interface OpenedProgressProvider {
  readonly providerId: string;
  readonly snapshot: ProgressSnapshot;
}

export interface ProgressOpenAttempt {
  readonly opened?: OpenedProgressProvider;
  readonly failures: readonly string[];
}

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

function decodeProvider(value: unknown): ProgressProvider | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const id = normalizedIdentifier(value.id, "Progress provider ID", MAX_PROGRESS_PROVIDER_ID_CHARS);
    if (typeof value.priority !== "number" || !Number.isSafeInteger(value.priority)) return undefined;
    if (
      typeof value.open !== "function" ||
      typeof value.read !== "function" ||
      typeof value.update !== "function" ||
      typeof value.close !== "function"
    ) return undefined;
    return Object.freeze({
      id,
      priority: value.priority,
      open: value.open as ProgressProvider["open"],
      read: value.read as ProgressProvider["read"],
      update: value.update as ProgressProvider["update"],
      close: value.close as ProgressProvider["close"],
    });
  } catch {
    return undefined;
  }
}

export function discoverProgressProviders(events: EventBus): readonly ProgressProvider[] {
  const offered = new Map<string, ProgressProvider>();
  const duplicateIds = new Set<string>();
  const envelope: ProgressDiscoveryEnvelope = {
    version: 1,
    kind: "discover",
    offer(value) {
      const provider = decodeProvider(value);
      if (!provider || duplicateIds.has(provider.id)) return;
      if (offered.has(provider.id)) {
        offered.delete(provider.id);
        duplicateIds.add(provider.id);
        return;
      }
      offered.set(provider.id, provider);
    },
  };
  events.emit(EXECUTION_PROGRESS_CHANNEL, envelope);
  return Object.freeze([...offered.values()].sort(
    (left, right) => right.priority - left.priority || left.id.localeCompare(right.id),
  ));
}

export function decodeProgressSnapshot(
  value: unknown,
  executionId: string,
  definitions: readonly ProgressStepDefinition[],
): ProgressSnapshot {
  if (!isRecord(value) || !hasOnlyKeys(value, PROGRESS_SNAPSHOT_KEYS)) {
    throw new Error("Progress provider returned an invalid snapshot.");
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

export async function openProgressProvider(
  events: EventBus,
  request: ProgressOpenRequest,
): Promise<ProgressOpenAttempt> {
  const executionId = normalizedIdentifier(
    request.executionId,
    "Progress execution ID",
    MAX_PROGRESS_EXECUTION_ID_CHARS,
  );
  const definitions = definitionsFrom(request.steps);
  const failures: string[] = [];
  let providers: readonly ProgressProvider[];
  try {
    providers = discoverProgressProviders(events);
  } catch (error) {
    request.signal?.throwIfAborted();
    return { failures: Object.freeze([`discovery: ${error instanceof Error ? error.message : String(error)}`]) };
  }
  for (const provider of providers) {
    request.signal?.throwIfAborted();
    try {
      const value = await provider.open({ ...request, executionId, steps: definitions });
      request.signal?.throwIfAborted();
      if (value === undefined) continue;
      return {
        opened: Object.freeze({
          providerId: provider.id,
          snapshot: decodeProgressSnapshot(value, executionId, definitions),
        }),
        failures: Object.freeze(failures),
      };
    } catch (error) {
      request.signal?.throwIfAborted();
      failures.push(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { failures: Object.freeze(failures) };
}

function requireProgressProvider(events: EventBus, providerId: string): ProgressProvider {
  const provider = discoverProgressProviders(events).find((candidate) => candidate.id === providerId);
  if (!provider) throw new Error(`Progress provider ${providerId} is unavailable.`);
  return provider;
}

export async function readProgressProvider(
  events: EventBus,
  providerId: string,
  request: ProgressReadRequest,
  definitions: readonly ProgressStepDefinition[],
): Promise<ProgressSnapshot> {
  request.signal?.throwIfAborted();
  const value = await requireProgressProvider(events, providerId).read(request);
  request.signal?.throwIfAborted();
  if (value === undefined) throw new Error(`Progress provider ${providerId} does not own execution ${request.executionId}.`);
  return decodeProgressSnapshot(value, request.executionId, definitions);
}

export async function updateProgressProvider(
  events: EventBus,
  providerId: string,
  request: ProgressUpdateRequest,
  definitions: readonly ProgressStepDefinition[],
): Promise<ProgressSnapshot> {
  request.signal?.throwIfAborted();
  const value = await requireProgressProvider(events, providerId).update(request);
  request.signal?.throwIfAborted();
  return decodeProgressSnapshot(value, request.executionId, definitions);
}

export async function closeProgressProvider(
  events: EventBus,
  providerId: string,
  request: ProgressCloseRequest,
): Promise<void> {
  request.signal?.throwIfAborted();
  await requireProgressProvider(events, providerId).close(request);
  request.signal?.throwIfAborted();
}

export function allProgressStepsComplete(snapshot: ProgressSnapshot): boolean {
  return snapshot.steps.length > 0 && snapshot.steps.every((step) => step.status === "completed");
}
