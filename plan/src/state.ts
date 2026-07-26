import { posix, win32 } from "node:path";

export type PlanPhase = "off" | "planning" | "awaitingApproval" | "blocked" | "executing";
export type ActivePlanPhase = Exclude<PlanPhase, "off">;
export type PlanStepStatus = "pending" | "inProgress" | "completed" | "blocked";

export const MAX_PLAN_SUMMARY_CHARS = 500;
export const MAX_PLAN_TEXT_CHARS = 20_000;
export const MAX_PLAN_STEPS = 50;
export const MAX_PLAN_STEP_CHARS = 500;
export const MAX_PLAN_STEP_ID_CHARS = 64;
export const MAX_PLAN_TOOLS = 256;
export const MAX_PLAN_TOOL_NAME_CHARS = 128;
export const MAX_PLAN_PAYLOAD_BYTES = 40 * 1024;
export const MAX_PLAN_PATH_BYTES = 4_096;
export const MAX_PLAN_BLOCKING_FACTS = 10;
export const MAX_PLAN_EVIDENCE_SOURCES = 10;
export const MAX_PLAN_BLOCKER_RESOLUTIONS = 5;
export const MAX_PLAN_BLOCKER_SUMMARY_CHARS = 500;
export const MAX_PLAN_BLOCKING_FACT_CHARS = 1_000;
export const MAX_PLAN_EVIDENCE_SOURCE_CHARS = 1_000;
export const MAX_PLAN_BLOCKER_LABEL_CHARS = 160;
export const MAX_PLAN_BLOCKER_DESCRIPTION_CHARS = 500;
export const MAX_PLAN_BLOCKER_PAYLOAD_BYTES = 16 * 1024;

export interface PlanStep {
  id: string;
  text: string;
}

export interface PlanStepProgress {
  id: string;
  status: PlanStepStatus;
}

export type PlanProgressTracking =
  | {
      kind: "local";
      steps: PlanStepProgress[];
    }
  | {
      kind: "external";
      providerId: string;
      executionId: string;
    };


export type PlanBlockerResolutionKind = "prerequisite" | "alternative";

export interface PlanBlockerResolution {
  kind: PlanBlockerResolutionKind;
  label: string;
  description: string;
}

export interface PlanBlocker {
  summary: string;
  blockingFacts: string[];
  evidenceSources: string[];
  resolutions: PlanBlockerResolution[];
}

export interface PlanState {
  version: 4;
  phase: ActivePlanPhase;
  summary?: string;
  plan?: string;
  planPath?: string;
  blocker?: PlanBlocker;
  steps: PlanStep[];
  progress?: PlanProgressTracking;
  enteredWithTools: string[];
  createdAt: number;
  updatedAt: number;
}

export interface PlanJournalEntry {
  version: 4;
  action: "start" | "resume" | "submit" | "block" | "approve" | "refine" | "cancel" | "step" | "complete";
  state: PlanState | null;
}

export interface SubmittedPlan {
  summary: string;
  plan: string;
  steps: string[];
}

export type PlanDecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

const VALID_PLAN_ACTIONS: Record<PlanJournalEntry["action"], true> = {
  start: true,
  submit: true,
  resume: true,
  approve: true,
  refine: true,
  cancel: true,
  step: true,
  complete: true,
  block: true,
};

const VALID_PHASES: Record<ActivePlanPhase, true> = {
  planning: true,
  awaitingApproval: true,
  executing: true,
  blocked: true,
};

const VALID_STEP_STATUSES: Record<PlanStepStatus, true> = {
  pending: true,
  inProgress: true,
  completed: true,
  blocked: true,
};

const PLAN_STATE_V1_KEYS: Record<string, true> = {
  version: true, phase: true, summary: true, plan: true, planPath: true, clarification: true,
  steps: true, enteredWithTools: true, createdAt: true, updatedAt: true,
};
const PLAN_STATE_V2_KEYS: Record<string, true> = { ...PLAN_STATE_V1_KEYS, progress: true };
const PLAN_STATE_V3_KEYS: Record<string, true> = { ...PLAN_STATE_V2_KEYS, blocker: true };
const PLAN_STATE_V4_KEYS: Record<string, true> = {
  version: true, phase: true, summary: true, plan: true, planPath: true, steps: true,
  progress: true, blocker: true, enteredWithTools: true, createdAt: true, updatedAt: true,
};
const PLAN_STEP_V1_KEYS: Record<string, true> = { id: true, text: true, status: true };
const PLAN_STEP_V2_KEYS: Record<string, true> = { id: true, text: true };
const PLAN_BLOCKER_KEYS: Record<string, true> = { summary: true, blockingFacts: true, evidenceSources: true, resolutions: true };
const PLAN_BLOCKER_RESOLUTION_KEYS: Record<string, true> = { kind: true, label: true, description: true };
const LOCAL_PROGRESS_KEYS: Record<string, true> = { kind: true, steps: true };
const EXTERNAL_PROGRESS_KEYS: Record<string, true> = { kind: true, providerId: true, executionId: true };
const PROGRESS_STEP_KEYS: Record<string, true> = { id: true, status: true };
const PLAN_JOURNAL_KEYS: Record<string, true> = { version: true, action: true, state: true };

function isActivePlanPhase(value: unknown): value is ActivePlanPhase {
  return typeof value === "string" && Object.hasOwn(VALID_PHASES, value);
}

function isPlanStepStatus(value: unknown): value is PlanStepStatus {
  return typeof value === "string" && Object.hasOwn(VALID_STEP_STATUSES, value);
}

function validatePlanText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  const length = [...normalized].length;
  if (length > maximum) throw new Error(`${label} exceeds the ${maximum.toLocaleString()} character limit.`);
  return normalized;
}

export function validatePlanPath(value: unknown): string {
  if (typeof value !== "string") throw new Error("Plan path must be a string.");
  if (Buffer.byteLength(value) > MAX_PLAN_PATH_BYTES) {
    throw new Error(`Plan path exceeds the ${MAX_PLAN_PATH_BYTES.toLocaleString()} byte limit.`);
  }
  if (value.includes("\0")) throw new Error("Plan path must not contain a NUL byte.");
  const flavor = posix.isAbsolute(value) ? posix : win32.isAbsolute(value) ? win32 : undefined;
  if (!flavor) throw new Error("Plan path must be absolute.");
  if (flavor.extname(value) !== ".md") throw new Error("Plan path must end in .md.");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Record<string, true>): boolean {
  return Object.keys(value).every((key) => Object.hasOwn(allowed, key));
}

function decodeFailure<T>(reason: string): PlanDecodeResult<T> {
  return { ok: false, reason };
}

function validateTimestamp(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function validateEnteredTools(tools: string[]): string[] {
  if (tools.length > MAX_PLAN_TOOLS) throw new Error(`Plan tool snapshot exceeds ${MAX_PLAN_TOOLS} entries.`);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const tool of tools) {
    if (!tool || tool.trim() !== tool || [...tool].length > MAX_PLAN_TOOL_NAME_CHARS) {
      throw new Error("Plan tool snapshot contains an invalid tool name.");
    }
    if (seen.has(tool)) throw new Error(`Plan tool snapshot contains duplicate tool ${JSON.stringify(tool)}.`);
    seen.add(tool);
    result.push(tool);
  }
  return result;
}

function validatePlanPayload(summary: string, plan: string, steps: PlanStep[]): void {
  let bytes = Buffer.byteLength(summary) + Buffer.byteLength(plan);
  for (const step of steps) bytes += Buffer.byteLength(step.id) + Buffer.byteLength(step.text);
  if (bytes > MAX_PLAN_PAYLOAD_BYTES) {
    throw new Error(`Plan payload exceeds the ${MAX_PLAN_PAYLOAD_BYTES.toLocaleString()} byte limit.`);
  }
}

function validatePlanBlocker(value: PlanBlocker): PlanBlocker {
  const summary = validatePlanText(value.summary, "Plan blocker summary", MAX_PLAN_BLOCKER_SUMMARY_CHARS);
  if (!Array.isArray(value.blockingFacts) || value.blockingFacts.length === 0 || value.blockingFacts.length > MAX_PLAN_BLOCKING_FACTS) {
    throw new Error(`A Plan blocker requires 1 to ${MAX_PLAN_BLOCKING_FACTS} verified blocking facts.`);
  }
  if (!Array.isArray(value.evidenceSources) || value.evidenceSources.length === 0 || value.evidenceSources.length > MAX_PLAN_EVIDENCE_SOURCES) {
    throw new Error(`A Plan blocker requires 1 to ${MAX_PLAN_EVIDENCE_SOURCES} evidence sources.`);
  }
  if (!Array.isArray(value.resolutions) || value.resolutions.length === 0 || value.resolutions.length > MAX_PLAN_BLOCKER_RESOLUTIONS) {
    throw new Error(`A Plan blocker requires 1 to ${MAX_PLAN_BLOCKER_RESOLUTIONS} prerequisite or alternative paths.`);
  }
  const blockingFacts = value.blockingFacts.map((fact, index) =>
    validatePlanText(fact, `Plan blocker fact ${index + 1}`, MAX_PLAN_BLOCKING_FACT_CHARS)
  );
  const evidenceSources = value.evidenceSources.map((source, index) =>
    validatePlanText(source, `Plan blocker evidence source ${index + 1}`, MAX_PLAN_EVIDENCE_SOURCE_CHARS)
  );
  const labels = new Set<string>();
  const resolutions = value.resolutions.map((resolution, index) => {
    if (resolution.kind !== "prerequisite" && resolution.kind !== "alternative") {
      throw new Error(`Plan blocker resolution ${index + 1} has an invalid kind.`);
    }
    const label = validatePlanText(resolution.label, `Plan blocker resolution ${index + 1} label`, MAX_PLAN_BLOCKER_LABEL_CHARS);
    if (labels.has(label)) throw new Error(`Plan blocker resolution ${index + 1} duplicates an earlier label.`);
    labels.add(label);
    return {
      kind: resolution.kind,
      label,
      description: validatePlanText(resolution.description, `Plan blocker resolution ${index + 1} description`, MAX_PLAN_BLOCKER_DESCRIPTION_CHARS),
    };
  });
  const bytes = Buffer.byteLength(summary) + blockingFacts.reduce((total, fact) => total + Buffer.byteLength(fact), 0) +
    evidenceSources.reduce((total, source) => total + Buffer.byteLength(source), 0) +
    resolutions.reduce((total, resolution) => total + Buffer.byteLength(resolution.kind) + Buffer.byteLength(resolution.label) + Buffer.byteLength(resolution.description), 0);
  if (bytes > MAX_PLAN_BLOCKER_PAYLOAD_BYTES) {
    throw new Error(`Plan blocker payload exceeds the ${MAX_PLAN_BLOCKER_PAYLOAD_BYTES.toLocaleString()} byte limit.`);
  }
  return { summary, blockingFacts, evidenceSources, resolutions };
}


export function createPlanningState(activeTools: string[], now = Date.now()): PlanState {
  const enteredWithTools = validateEnteredTools([
    ...new Set(activeTools.filter((name) => name !== "submit_plan" && name !== "report_plan_blocked" && name !== "update_plan_step")),
  ]);
  return {
    version: 4,
    phase: "planning",
    steps: [],
    enteredWithTools,
    createdAt: now,
    updatedAt: now,
  };
}


export function reportPlanBlocked(state: PlanState, blocker: PlanBlocker, now = Date.now()): PlanState {
  if (state.phase !== "planning") throw new Error("A Plan can only be blocked during planning.");
  const validated = validatePlanBlocker(blocker);
  const {
    summary: _summary,
    plan: _plan,
    planPath: _planPath,
    blocker: _blocker,
    steps: _steps,
    progress: _progress,
    ...blockedState
  } = state;
  return { ...blockedState, phase: "blocked", blocker: validated, steps: [], updatedAt: now };
}

export function resumeBlockedPlan(state: PlanState, now = Date.now()): PlanState {
  if (state.phase !== "blocked" || !state.blocker) throw new Error("No blocked Plan is awaiting new information.");
  return { ...state, phase: "planning", updatedAt: now };
}

export function submitPlan(state: PlanState, submitted: SubmittedPlan, now = Date.now()): PlanState {
  if (state.phase !== "planning") throw new Error("A plan can only be submitted during planning.");
  if (!Array.isArray(submitted.steps) || submitted.steps.length === 0) {
    throw new Error("A plan requires at least one execution step.");
  }
  if (submitted.steps.length > MAX_PLAN_STEPS) {
    throw new Error(`A plan supports at most ${MAX_PLAN_STEPS} execution steps.`);
  }
  const summary = validatePlanText(submitted.summary, "Plan summary", MAX_PLAN_SUMMARY_CHARS);
  const plan = validatePlanText(submitted.plan, "Plan", MAX_PLAN_TEXT_CHARS);
  const steps = submitted.steps.map((text, index) => ({
    id: `step-${index + 1}`,
    text: validatePlanText(text, `Step ${index + 1}`, MAX_PLAN_STEP_CHARS),
  }));
  validatePlanPayload(summary, plan, steps);
  const { blocker: _blocker, ...submittedState } = state;
  return {
    ...submittedState,
    phase: "awaitingApproval",
    summary,
    plan,
    steps,
    updatedAt: now,
  };
}

export function refinePlan(state: PlanState, now = Date.now()): PlanState {
  if (state.phase !== "awaitingApproval") throw new Error("Only a submitted plan can be refined.");
  const { planPath: _planPath, ...planningState } = state;
  return { ...planningState, phase: "planning", updatedAt: now };
}

function pendingProgress(steps: PlanStep[]): PlanStepProgress[] {
  return steps.map((step) => ({ id: step.id, status: "pending" }));
}

function assertApprovable(state: PlanState): void {
  if (state.phase !== "awaitingApproval" || !state.plan || state.steps.length === 0) {
    throw new Error("No submitted plan is awaiting approval.");
  }
}

export function approvePlan(state: PlanState, now = Date.now()): PlanState {
  assertApprovable(state);
  return {
    ...state,
    phase: "executing",
    progress: { kind: "local", steps: pendingProgress(state.steps) },
    updatedAt: now,
  };
}

export function approvePlanWithExternalProgress(
  state: PlanState,
  providerId: string,
  executionId: string,
  now = Date.now(),
): PlanState {
  assertApprovable(state);
  const normalizedProviderId = validatePlanText(providerId, "Progress provider ID", 128);
  const normalizedExecutionId = validatePlanText(executionId, "Progress execution ID", 128);
  return {
    ...state,
    phase: "executing",
    progress: { kind: "external", providerId: normalizedProviderId, executionId: normalizedExecutionId },
    updatedAt: now,
  };
}

export function updatePlanStep(
  state: PlanState,
  id: string,
  status: PlanStepStatus,
  now = Date.now(),
): PlanState {
  if (state.phase !== "executing" || state.progress?.kind !== "local") {
    throw new Error("Plan steps can only be updated locally during local execution.");
  }
  if (!state.steps.some((step) => step.id === id)) throw new Error(`Unknown plan step: ${id}`);
  const steps = state.progress.steps.map((step) => {
    if (step.id === id) return { ...step, status };
    if (status === "inProgress" && step.status === "inProgress") return { ...step, status: "pending" as const };
    return step;
  });
  return { ...state, progress: { kind: "local", steps }, updatedAt: now };
}

export function allPlanStepsComplete(state: PlanState): boolean {
  return state.phase === "executing" && state.progress?.kind === "local" &&
    state.progress.steps.length > 0 && state.progress.steps.every((step) => step.status === "completed");
}

export function localPlanProgress(state: PlanState): readonly PlanStepProgress[] | undefined {
  return state.phase === "executing" && state.progress?.kind === "local" ? state.progress.steps : undefined;
}

function decodePlanStep(value: unknown, legacy: boolean): PlanDecodeResult<PlanStep> {
  if (!isRecord(value) || !hasOnlyKeys(value, legacy ? PLAN_STEP_V1_KEYS : PLAN_STEP_V2_KEYS)) {
    return decodeFailure("Plan step must be an exact versioned object.");
  }
  if (typeof value.id !== "string" || !value.id || value.id.trim() !== value.id) {
    return decodeFailure("Plan step has an invalid ID.");
  }
  if ([...value.id].length > MAX_PLAN_STEP_ID_CHARS) {
    return decodeFailure(`Plan step ID exceeds ${MAX_PLAN_STEP_ID_CHARS} characters.`);
  }
  if (typeof value.text !== "string") return decodeFailure(`Plan step ${value.id} has invalid text.`);
  let text: string;
  try {
    text = validatePlanText(value.text, `Plan step ${value.id}`, MAX_PLAN_STEP_CHARS);
  } catch (error) {
    return decodeFailure(error instanceof Error ? error.message : String(error));
  }
  if (text !== value.text) return decodeFailure(`Plan step ${value.id} text is not normalized.`);
  return { ok: true, value: { id: value.id, text } };
}


function decodeLocalProgress(value: unknown, steps: readonly PlanStep[]): PlanDecodeResult<PlanStepProgress[]> {
  if (!Array.isArray(value) || value.length !== steps.length) {
    return decodeFailure("Local Plan progress must contain every approved step.");
  }
  let inProgress = 0;
  const progress: PlanStepProgress[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const candidate = value[index];
    const definition = steps[index];
    if (
      !isRecord(candidate) ||
      !hasOnlyKeys(candidate, PROGRESS_STEP_KEYS) ||
      !definition ||
      candidate.id !== definition.id ||
      !isPlanStepStatus(candidate.status)
    ) return decodeFailure("Local Plan progress does not match the approved step definitions.");
    if (candidate.status === "inProgress") inProgress += 1;
    progress.push({ id: definition.id, status: candidate.status });
  }
  if (inProgress > 1) return decodeFailure("Plan state contains multiple in-progress steps.");
  return { ok: true, value: progress };
}

function decodePlanProgress(value: unknown, steps: readonly PlanStep[]): PlanDecodeResult<PlanProgressTracking> {
  if (!isRecord(value) || (value.kind !== "local" && value.kind !== "external")) {
    return decodeFailure("Executing Plan state has invalid progress tracking.");
  }
  if (!hasOnlyKeys(value, value.kind === "local" ? LOCAL_PROGRESS_KEYS : EXTERNAL_PROGRESS_KEYS)) {
    return decodeFailure("Executing Plan progress contains unknown fields.");
  }
  if (value.kind === "local") {
    const decoded = decodeLocalProgress(value.steps, steps);
    return decoded.ok ? { ok: true, value: { kind: "local", steps: decoded.value } } : decoded;
  }
  try {
    const providerId = validatePlanText(value.providerId as string, "Progress provider ID", 128);
    const executionId = validatePlanText(value.executionId as string, "Progress execution ID", 128);
    if (providerId !== value.providerId || executionId !== value.executionId) {
      return decodeFailure("External Plan progress identifiers are not normalized.");
    }
    return { ok: true, value: { kind: "external", providerId, executionId } };
  } catch (error) {
    return decodeFailure(error instanceof Error ? error.message : String(error));
  }
}

export function decodePlanState(value: unknown): PlanDecodeResult<PlanState> {
  if (!isRecord(value)) return decodeFailure("Plan state must be an object.");
  if (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4) {
    return decodeFailure(`Unsupported Plan state version: ${String(value.version)}.`);
  }
  const legacy = value.version === 1;
  const allowedKeys = value.version === 1
    ? PLAN_STATE_V1_KEYS
    : value.version === 2
      ? PLAN_STATE_V2_KEYS
      : value.version === 3
        ? PLAN_STATE_V3_KEYS
        : PLAN_STATE_V4_KEYS;
  if (!hasOnlyKeys(value, allowedKeys)) {
    return decodeFailure(`Plan state v${value.version} contains unknown fields.`);
  }
  if (value.clarification !== undefined) {
    return decodeFailure("Stored Plan choices cannot be restored; restart Plan mode and use the external ask tool.");
  }
  if (!isActivePlanPhase(value.phase)) return decodeFailure("Plan state has an invalid phase.");
  if (!Array.isArray(value.enteredWithTools) || !value.enteredWithTools.every((tool) => typeof tool === "string")) {
    return decodeFailure("Plan state has an invalid tool snapshot.");
  }
  let enteredWithTools: string[];
  try {
    enteredWithTools = validateEnteredTools(value.enteredWithTools);
  } catch (error) {
    return decodeFailure(error instanceof Error ? error.message : String(error));
  }

  if (!Array.isArray(value.steps) || value.steps.length > MAX_PLAN_STEPS) {
    return decodeFailure(`Plan state must contain at most ${MAX_PLAN_STEPS} steps.`);
  }
  const steps: PlanStep[] = [];
  const legacyProgress: PlanStepProgress[] = [];
  const stepIds = new Set<string>();
  for (const rawStep of value.steps) {
    const decoded = decodePlanStep(rawStep, legacy);
    if (!decoded.ok) return decoded;
    if (stepIds.has(decoded.value.id)) return decodeFailure(`Duplicate Plan step ID: ${decoded.value.id}.`);
    stepIds.add(decoded.value.id);
    steps.push(decoded.value);
    if (legacy) {
      if (!isRecord(rawStep) || !isPlanStepStatus(rawStep.status)) {
        return decodeFailure(`Legacy Plan step ${decoded.value.id} has an invalid status.`);
      }
      legacyProgress.push({ id: decoded.value.id, status: rawStep.status });
    }
  }

  let progress: PlanProgressTracking | undefined;
  if (value.phase === "executing") {
    if (legacy) {
      const decoded = decodeLocalProgress(legacyProgress, steps);
      if (!decoded.ok) return decoded;
      progress = { kind: "local", steps: decoded.value };
    } else {
      const decoded = decodePlanProgress(value.progress, steps);
      if (!decoded.ok) return decoded;
      progress = decoded.value;
    }
  } else if (!legacy && value.progress !== undefined) {
    return decodeFailure(`Plan phase ${value.phase} cannot contain execution progress.`);
  }

  let blocker: PlanBlocker | undefined;
  if (value.blocker !== undefined) {
    if ((value.version !== 3 && value.version !== 4) || !isRecord(value.blocker) || !hasOnlyKeys(value.blocker, PLAN_BLOCKER_KEYS)) {
      return decodeFailure("Plan blocker must be an exact v3 or v4 object.");
    }
    if (
      typeof value.blocker.summary !== "string" ||
      !Array.isArray(value.blocker.blockingFacts) ||
      !value.blocker.blockingFacts.every((fact) => typeof fact === "string") ||
      !Array.isArray(value.blocker.evidenceSources) ||
      !value.blocker.evidenceSources.every((source) => typeof source === "string") ||
      !Array.isArray(value.blocker.resolutions) ||
      !value.blocker.resolutions.every((resolution) =>
        isRecord(resolution) && hasOnlyKeys(resolution, PLAN_BLOCKER_RESOLUTION_KEYS) &&
        typeof resolution.kind === "string" && typeof resolution.label === "string" && typeof resolution.description === "string"
      )
    ) return decodeFailure("Plan blocker has invalid fields.");
    const rawBlocker = value.blocker as {
      summary: string;
      blockingFacts: string[];
      evidenceSources: string[];
      resolutions: Array<{ kind: string; label: string; description: string }>;
    };
    try {
      const decodedBlocker = validatePlanBlocker({
        summary: rawBlocker.summary,
        blockingFacts: rawBlocker.blockingFacts,
        evidenceSources: rawBlocker.evidenceSources,
        resolutions: rawBlocker.resolutions.map((resolution) => ({
          kind: resolution.kind as PlanBlockerResolutionKind,
          label: resolution.label,
          description: resolution.description,
        })),
      });
      if (
        decodedBlocker.summary !== rawBlocker.summary ||
        decodedBlocker.blockingFacts.some((fact, index) => fact !== rawBlocker.blockingFacts[index]) ||
        decodedBlocker.evidenceSources.some((source, index) => source !== rawBlocker.evidenceSources[index]) ||
        decodedBlocker.resolutions.some((resolution, index) => {
          const raw = rawBlocker.resolutions[index];
          return resolution.kind !== raw?.kind || resolution.label !== raw?.label || resolution.description !== raw?.description;
        })
      ) return decodeFailure("Stored Plan blocker is not normalized.");
      blocker = decodedBlocker;
    } catch (error) {
      return decodeFailure(error instanceof Error ? error.message : String(error));
    }
  }
  const hasSummary = typeof value.summary === "string";
  const hasPlan = typeof value.plan === "string";
  if (hasSummary !== hasPlan) return decodeFailure("Plan summary and body must be stored together.");
  if ((value.phase === "awaitingApproval" || value.phase === "executing") && (!hasSummary || steps.length === 0)) {
    return decodeFailure(`Plan phase ${value.phase} requires a submitted plan and steps.`);
  }
  if (!hasSummary && steps.length > 0) return decodeFailure("Draft Plan state cannot contain steps without a plan.");
  if (value.phase === "blocked") {
    if (!blocker) return decodeFailure("Blocked Plan phase requires a blocker.");
    if (hasSummary || steps.length > 0) return decodeFailure("Blocked Plan phase cannot contain a submitted plan.");
  }
  if (value.phase !== "planning" && value.phase !== "blocked" && blocker) {
    return decodeFailure(`Plan phase ${value.phase} cannot contain a blocker.`);
  }

  let summary: string | undefined;
  let plan: string | undefined;
  if (hasSummary && hasPlan) {
    try {
      summary = validatePlanText(value.summary as string, "Plan summary", MAX_PLAN_SUMMARY_CHARS);
      plan = validatePlanText(value.plan as string, "Plan", MAX_PLAN_TEXT_CHARS);
      if (summary !== value.summary || plan !== value.plan) {
        return decodeFailure("Stored Plan text is not normalized.");
      }
      validatePlanPayload(summary, plan, steps);
    } catch (error) {
      return decodeFailure(error instanceof Error ? error.message : String(error));
    }
  }

  let planPath: string | undefined;
  if (value.planPath !== undefined) {
    if (!hasSummary || !hasPlan) return decodeFailure("Plan path requires a submitted plan.");
    try {
      planPath = validatePlanPath(value.planPath);
    } catch (error) {
      return decodeFailure(error instanceof Error ? error.message : String(error));
    }
  }

  let createdAt: number;
  let updatedAt: number;
  try {
    createdAt = validateTimestamp(value.createdAt, "Plan createdAt");
    updatedAt = validateTimestamp(value.updatedAt, "Plan updatedAt");
  } catch (error) {
    return decodeFailure(error instanceof Error ? error.message : String(error));
  }
  if (updatedAt < createdAt) return decodeFailure("Plan updatedAt precedes createdAt.");

  return {
    ok: true,
    value: {
      version: 4,
      phase: value.phase,
      summary,
      plan,
      planPath,
      blocker,
      steps,
      progress,
      enteredWithTools,
      createdAt,
      updatedAt,
    },
  };
}

export function decodePlanJournalEntry(value: unknown): PlanDecodeResult<PlanJournalEntry> {
  if (!isRecord(value)) return decodeFailure("Plan journal entry must be an object.");
  if (!hasOnlyKeys(value, PLAN_JOURNAL_KEYS)) return decodeFailure("Plan journal entry contains unknown fields.");
  if (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4) {
    return decodeFailure(`Unsupported Plan journal version: ${String(value.version)}.`);
  }
  if (typeof value.action !== "string" || !Object.hasOwn(VALID_PLAN_ACTIONS, value.action)) {
    return decodeFailure("Plan journal entry has an invalid action.");
  }
  const action = value.action as PlanJournalEntry["action"];
  if (action === "cancel" || action === "complete") {
    if (value.state !== null) return decodeFailure(`Plan ${action} entry must contain null state.`);
    return { ok: true, value: { version: 4, action, state: null } };
  }

  if (!isRecord(value.state) || value.state.version !== value.version) {
    return decodeFailure(`Plan journal v${value.version} entry requires matching Plan state version.`);
  }
  const decoded = decodePlanState(value.state);
  if (!decoded.ok) return decoded;
  const expectedPhase: Record<Exclude<PlanJournalEntry["action"], "cancel" | "complete">, ActivePlanPhase> = {
    start: "planning",
    submit: "awaitingApproval",
    approve: "executing",
    resume: "planning",
    refine: "planning",
    step: "executing",
    block: "blocked",
  };
  if (decoded.value.phase !== expectedPhase[action]) {
    return decodeFailure(`Plan ${action} entry has unexpected phase ${decoded.value.phase}.`);
  }
  if (action === "step" && decoded.value.progress?.kind !== "local") {
    return decodeFailure("Plan step entries require local progress ownership.");
  }
  return { ok: true, value: { version: 4, action, state: decoded.value } };
}
