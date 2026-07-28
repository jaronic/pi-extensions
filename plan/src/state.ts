import { posix, win32 } from "node:path";
import { MAX_PHASE_NAME_CHARS } from "pi-todo-dev";

export type PlanPhase = "off" | "planning" | "awaitingClarification" | "awaitingApproval" | "blocked";
export type ActivePlanPhase = Exclude<PlanPhase, "off">;

export const MAX_PLAN_SUMMARY_CHARS = 500;
export const MAX_PLAN_TEXT_CHARS = 20_000;
export const MAX_PLAN_STEPS = 50;
export const MAX_PLAN_STEP_CHARS = 240;
export const MAX_PLAN_TOOLS = 256;
export const MAX_PLAN_TOOL_NAME_CHARS = 128;
export const MAX_PLAN_PAYLOAD_BYTES = 40 * 1024;
export const MAX_PLAN_PATH_BYTES = 4_096;
export const MAX_PLAN_CHOICE_QUESTION_CHARS = 1_000;
export const MAX_PLAN_CHOICE_OPTIONS = 5;
export const MIN_PLAN_CHOICE_OPTIONS = 2;
export const MAX_PLAN_CHOICE_LABEL_CHARS = 160;
export const MAX_PLAN_CHOICE_DESCRIPTION_CHARS = 500;
export const MAX_PLAN_CHOICE_PAYLOAD_BYTES = 8 * 1024;
export const MAX_PLAN_BLOCKING_FACTS = 10;
export const MAX_PLAN_EVIDENCE_SOURCES = 10;
export const MAX_PLAN_BLOCKER_RESOLUTIONS = 5;
export const MAX_PLAN_BLOCKER_SUMMARY_CHARS = 500;
export const MAX_PLAN_BLOCKING_FACT_CHARS = 1_000;
export const MAX_PLAN_EVIDENCE_SOURCE_CHARS = 1_000;
export const MAX_PLAN_BLOCKER_LABEL_CHARS = 160;
export const MAX_PLAN_BLOCKER_DESCRIPTION_CHARS = 500;
export const MAX_PLAN_BLOCKER_PAYLOAD_BYTES = 16 * 1024;

/**
 * Derives the Todo phase name for an approved Plan handoff from the Plan summary:
 * single-line, free of Todo-forbidden display controls, within the Todo phase
 * character limit, and never empty. Falls back to "Plan" when nothing survives.
 */
export function planHandoffPhaseName(summary: string | undefined): string {
  const cleaned = (summary ?? "")
    .replace(/[\u0000-\u001F\u007F-\u009F\u061C\u200E\u200F\u2028-\u202E\u2066-\u206F]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) return "Plan";
  if (cleaned.length <= MAX_PHASE_NAME_CHARS) return cleaned;
  let head = cleaned.slice(0, MAX_PHASE_NAME_CHARS - 1);
  if (/[\ud800-\udbff]$/u.test(head)) head = head.slice(0, -1);
  return `${head.trimEnd()}…`;
}


export interface PlanChoiceOption {
  label: string;
  description?: string;
}

export interface PlanClarification {
  question: string;
  options: PlanChoiceOption[];
  selection?: number;
}

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
  clarification?: PlanClarification;
  blocker?: PlanBlocker;
  steps: string[];
  enteredWithTools: string[];
  createdAt: number;
  updatedAt: number;
}

export interface PlanJournalEntry {
  version: 4;
  action: "start" | "clarify" | "answer" | "resume" | "submit" | "block" | "approve" | "refine" | "cancel";
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
  clarify: true,
  answer: true,
  resume: true,
  approve: true,
  refine: true,
  cancel: true,
  block: true,
};

const VALID_PHASES: Record<ActivePlanPhase, true> = {
  planning: true,
  awaitingApproval: true,
  awaitingClarification: true,
  blocked: true,
};

const LEGACY_PLAN_ACTIONS = new Set([
  "start",
  "submit",
  "clarify",
  "answer",
  "resume",
  "approve",
  "refine",
  "cancel",
  "step",
  "complete",
  "block",
]);
const PLAN_STATE_V1_KEYS = new Set(["version", "phase", "summary", "plan", "planPath", "clarification", "steps", "enteredWithTools", "createdAt", "updatedAt"]);
const PLAN_STATE_V2_KEYS = new Set([...PLAN_STATE_V1_KEYS, "progress"]);
const PLAN_STATE_V3_KEYS = new Set([...PLAN_STATE_V2_KEYS, "blocker"]);
const PLAN_STATE_V4_KEYS = new Set(["version", "phase", "summary", "plan", "planPath", "clarification", "blocker", "steps", "enteredWithTools", "createdAt", "updatedAt"]);
const PLAN_STEP_V1_KEYS = new Set(["id", "text", "status"]);
const PLAN_STEP_V2_KEYS = new Set(["id", "text"]);
const PLAN_CLARIFICATION_KEYS = new Set(["question", "options", "selection"]);
const PLAN_CHOICE_OPTION_KEYS = new Set(["label", "description"]);
const PLAN_BLOCKER_KEYS = new Set(["summary", "blockingFacts", "evidenceSources", "resolutions"]);
const PLAN_BLOCKER_RESOLUTION_KEYS = new Set(["kind", "label", "description"]);
const PLAN_JOURNAL_KEYS = new Set(["version", "action", "state"]);

function isActivePlanPhase(value: unknown): value is ActivePlanPhase {
  return typeof value === "string" && Object.hasOwn(VALID_PHASES, value);
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

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
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

function validatePlanPayload(summary: string, plan: string, steps: readonly string[]): void {
  let bytes = Buffer.byteLength(summary) + Buffer.byteLength(plan);
  for (const step of steps) bytes += Buffer.byteLength(step);
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

function validatePlanClarification(value: PlanClarification): PlanClarification {
  const question = validatePlanText(value.question, "Plan choice question", MAX_PLAN_CHOICE_QUESTION_CHARS);
  if (!Array.isArray(value.options) || value.options.length < MIN_PLAN_CHOICE_OPTIONS || value.options.length > MAX_PLAN_CHOICE_OPTIONS) {
    throw new Error(`A Plan choice requires ${MIN_PLAN_CHOICE_OPTIONS} to ${MAX_PLAN_CHOICE_OPTIONS} options.`);
  }
  const labels = new Set<string>();
  const options = value.options.map((option, index) => {
    const label = validatePlanText(option.label, `Plan choice option ${index + 1} label`, MAX_PLAN_CHOICE_LABEL_CHARS);
    if (labels.has(label)) throw new Error(`Plan choice option ${index + 1} duplicates an earlier label.`);
    labels.add(label);
    if (option.description === undefined) return { label };
    return {
      label,
      description: validatePlanText(option.description, `Plan choice option ${index + 1} description`, MAX_PLAN_CHOICE_DESCRIPTION_CHARS),
    };
  });
  const bytes = Buffer.byteLength(question) + options.reduce(
    (total, option) => total + Buffer.byteLength(option.label) + Buffer.byteLength(option.description ?? ""),
    0,
  );
  if (bytes > MAX_PLAN_CHOICE_PAYLOAD_BYTES) {
    throw new Error(`Plan choice payload exceeds the ${MAX_PLAN_CHOICE_PAYLOAD_BYTES.toLocaleString()} byte limit.`);
  }
  if (value.selection !== undefined) {
    if (!Number.isSafeInteger(value.selection) || value.selection < 0 || value.selection >= options.length) {
      throw new Error("Plan choice selection is invalid.");
    }
  }
  return value.selection === undefined ? { question, options } : { question, options, selection: value.selection };
}

export function createPlanningState(activeTools: string[], now = Date.now()): PlanState {
  const enteredWithTools = validateEnteredTools([
    ...new Set(activeTools.filter((name) => name !== "submit_plan" && name !== "request_plan_choice" && name !== "answer_plan_choice" && name !== "report_plan_blocked")),
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

export function requestPlanChoice(state: PlanState, clarification: PlanClarification, now = Date.now()): PlanState {
  if (state.phase !== "planning") throw new Error("A Plan choice can only be requested during planning.");
  const validated = validatePlanClarification(clarification);
  if (validated.selection !== undefined) throw new Error("A new Plan choice cannot include a selection.");
  return { ...state, phase: "awaitingClarification", clarification: validated, updatedAt: now };
}

export function answerPlanChoice(state: PlanState, selection: number, now = Date.now()): PlanState {
  if (state.phase !== "awaitingClarification" || !state.clarification) {
    throw new Error("No Plan choice is awaiting an answer.");
  }
  return {
    ...state,
    phase: "planning",
    clarification: validatePlanClarification({ ...state.clarification, selection }),
    updatedAt: now,
  };
}

export function consumePlanChoice(state: PlanState): PlanState {
  if (state.phase !== "planning" || state.clarification?.selection === undefined) {
    throw new Error("No answered Plan choice is ready to consume.");
  }
  const { clarification: _clarification, ...resumed } = state;
  return resumed;
}

export function reportPlanBlocked(state: PlanState, blocker: PlanBlocker, now = Date.now()): PlanState {
  if (state.phase !== "planning") throw new Error("A Plan can only be blocked during planning.");
  const validated = validatePlanBlocker(blocker);
  const {
    summary: _summary,
    plan: _plan,
    planPath: _planPath,
    clarification: _clarification,
    blocker: _blocker,
    steps: _steps,
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
  const steps = submitted.steps.map((text, index) =>
    validatePlanText(text, `Step ${index + 1}`, MAX_PLAN_STEP_CHARS)
  );
  if (new Set(steps).size !== steps.length) throw new Error("Plan execution steps must be unique.");
  validatePlanPayload(summary, plan, steps);
  const { clarification: _clarification, blocker: _blocker, ...submittedState } = state;
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


function decodePlanStep(value: unknown, version: 1 | 2 | 3 | 4, index: number): PlanDecodeResult<string> {
  if (version === 4) {
    if (typeof value !== "string") return decodeFailure(`Plan step ${index + 1} must be text.`);
    try {
      const text = validatePlanText(value, `Plan step ${index + 1}`, MAX_PLAN_STEP_CHARS);
      return text === value ? { ok: true, value: text } : decodeFailure(`Plan step ${index + 1} text is not normalized.`);
    } catch (error) {
      return decodeFailure(error instanceof Error ? error.message : String(error));
    }
  }
  if (!isRecord(value) || !hasOnlyKeys(value, version === 1 ? PLAN_STEP_V1_KEYS : PLAN_STEP_V2_KEYS)) {
    return decodeFailure("Legacy Plan step must be an exact versioned object.");
  }
  if (typeof value.id !== "string" || !value.id || value.id.trim() !== value.id || [...value.id].length > 64) {
    return decodeFailure("Legacy Plan step has an invalid ID.");
  }
  if (version === 1 && !["pending", "inProgress", "completed", "blocked"].includes(String(value.status))) {
    return decodeFailure(`Legacy Plan step ${value.id} has an invalid status.`);
  }
  if (typeof value.text !== "string") return decodeFailure(`Legacy Plan step ${value.id} has invalid text.`);
  try {
    const text = validatePlanText(value.text, `Legacy Plan step ${value.id}`, MAX_PLAN_STEP_CHARS);
    return text === value.text ? { ok: true, value: text } : decodeFailure(`Legacy Plan step ${value.id} text is not normalized.`);
  } catch (error) {
    return decodeFailure(error instanceof Error ? error.message : String(error));
  }
}

function decodePlanClarification(value: unknown): PlanDecodeResult<PlanClarification> {
  if (!isRecord(value) || typeof value.question !== "string" || !Array.isArray(value.options)) {
    return decodeFailure("Plan choice must contain a question and options.");
  }
  if (!hasOnlyKeys(value, PLAN_CLARIFICATION_KEYS)) return decodeFailure("Plan choice contains unknown fields.");
  const options: PlanChoiceOption[] = [];
  for (const rawOption of value.options) {
    if (!isRecord(rawOption) || !hasOnlyKeys(rawOption, PLAN_CHOICE_OPTION_KEYS) || typeof rawOption.label !== "string") {
      return decodeFailure("Plan choice option must contain only a label and optional description.");
    }
    if (rawOption.description !== undefined && typeof rawOption.description !== "string") {
      return decodeFailure("Plan choice option description must be a string.");
    }
    options.push(rawOption.description === undefined ? { label: rawOption.label } : { label: rawOption.label, description: rawOption.description });
  }
  if (value.selection !== undefined && (!Number.isSafeInteger(value.selection) || typeof value.selection !== "number")) {
    return decodeFailure("Plan choice selection must be an integer.");
  }
  try {
    const decoded = validatePlanClarification({
      question: value.question,
      options,
      selection: value.selection as number | undefined,
    });
    if (
      decoded.question !== value.question ||
      decoded.options.some((option, index) => option.label !== options[index].label || option.description !== options[index].description)
    ) {
      return decodeFailure("Stored Plan choice is not normalized.");
    }
    return { ok: true, value: decoded };
  } catch (error) {
    return decodeFailure(error instanceof Error ? error.message : String(error));
  }
}


export function decodePlanState(value: unknown): PlanDecodeResult<PlanState> {
  if (!isRecord(value)) return decodeFailure("Plan state must be an object.");
  if (value.version !== 1 && value.version !== 2 && value.version !== 3 && value.version !== 4) {
    return decodeFailure(`Unsupported Plan state version: ${String(value.version)}.`);
  }
  const version = value.version;
  const allowedKeys = version === 1
    ? PLAN_STATE_V1_KEYS
    : version === 2
      ? PLAN_STATE_V2_KEYS
      : version === 3
        ? PLAN_STATE_V3_KEYS
        : PLAN_STATE_V4_KEYS;
  if (!hasOnlyKeys(value, allowedKeys)) {
    return decodeFailure(`Plan state v${version} contains unknown fields.`);
  }
  if (value.phase === "executing") {
    return decodeFailure("Executing Plan state is obsolete; approved work is now owned by the ordinary Todo board.");
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
  const steps: string[] = [];
  const stepIds = new Set<string>();
  for (let index = 0; index < value.steps.length; index += 1) {
    const rawStep = value.steps[index];
    if (version < 4 && isRecord(rawStep)) {
      if (stepIds.has(String(rawStep.id))) return decodeFailure(`Duplicate legacy Plan step ID: ${String(rawStep.id)}.`);
      stepIds.add(String(rawStep.id));
    }
    const decoded = decodePlanStep(rawStep, version, index);
    if (!decoded.ok) return decoded;
    if (steps.includes(decoded.value)) return decodeFailure("Plan execution steps must be unique.");
    steps.push(decoded.value);
  }
  if ((version === 2 || version === 3) && value.progress !== undefined) {
    return decodeFailure(`Plan phase ${value.phase} cannot contain obsolete execution progress.`);
  }

  let clarification: PlanClarification | undefined;
  if (value.clarification !== undefined) {
    const decoded = decodePlanClarification(value.clarification);
    if (!decoded.ok) return decoded;
    clarification = decoded.value;
  }
  let blocker: PlanBlocker | undefined;
  if (value.blocker !== undefined) {
    if ((version !== 3 && version !== 4) || !isRecord(value.blocker) || !hasOnlyKeys(value.blocker, PLAN_BLOCKER_KEYS)) {
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
  if (value.phase === "awaitingApproval" && (!hasSummary || steps.length === 0)) {
    return decodeFailure("Plan phase awaitingApproval requires a submitted plan and steps.");
  }
  if (!hasSummary && steps.length > 0) return decodeFailure("Draft Plan state cannot contain steps without a plan.");
  if (value.phase === "blocked") {
    if (!blocker) return decodeFailure("Blocked Plan phase requires a blocker.");
    if (hasSummary || steps.length > 0 || clarification) return decodeFailure("Blocked Plan phase cannot contain a submitted plan or choice.");
  }
  if (value.phase === "awaitingClarification" && clarification?.selection !== undefined) {
    return decodeFailure("An unanswered Plan choice must not contain a selection.");
  }
  if (value.phase === "awaitingClarification" && !clarification) {
    return decodeFailure("Plan choice phase requires a pending choice.");
  }
  if (value.phase === "planning" && clarification && clarification.selection === undefined) {
    return decodeFailure("Planning phase cannot contain an unanswered Plan choice.");
  }
  if (value.phase === "awaitingApproval" && clarification) {
    return decodeFailure("Plan phase awaitingApproval cannot contain a choice.");
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
      clarification,
      blocker,
      steps,
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
  if (typeof value.action !== "string") return decodeFailure("Plan journal entry has an invalid action.");

  if (value.version < 4) {
    if (!LEGACY_PLAN_ACTIONS.has(value.action)) return decodeFailure("Legacy Plan journal entry has an invalid action.");
    if (value.action === "cancel" || value.action === "complete") {
      if (value.state !== null) return decodeFailure(`Legacy Plan ${value.action} entry must contain null state.`);
      return { ok: true, value: { version: 4, action: value.action === "cancel" ? "cancel" : "approve", state: null } };
    }
    if (value.action === "approve" || value.action === "step") {
      if (!isRecord(value.state) || value.state.version !== value.version || value.state.phase !== "executing") {
        return decodeFailure(`Legacy Plan ${value.action} entry requires matching executing state.`);
      }
      return { ok: true, value: { version: 4, action: "approve", state: null } };
    }
  } else if (!Object.hasOwn(VALID_PLAN_ACTIONS, value.action)) {
    return decodeFailure("Plan journal entry has an invalid action.");
  }

  const action = value.action as Exclude<PlanJournalEntry["action"], "approve" | "cancel">;
  if (value.version === 4 && (value.action === "approve" || value.action === "cancel")) {
    if (value.state !== null) return decodeFailure(`Plan ${value.action} entry must contain null state.`);
    return { ok: true, value: { version: 4, action: value.action, state: null } };
  }
  if (!isRecord(value.state) || value.state.version !== value.version) {
    return decodeFailure(`Plan journal v${value.version} entry requires matching Plan state version.`);
  }
  const decoded = decodePlanState(value.state);
  if (!decoded.ok) return decoded;
  const expectedPhase: Record<typeof action, ActivePlanPhase> = {
    start: "planning",
    submit: "awaitingApproval",
    clarify: "awaitingClarification",
    answer: "planning",
    resume: "planning",
    refine: "planning",
    block: "blocked",
  };
  if (decoded.value.phase !== expectedPhase[action]) {
    return decodeFailure(`Plan ${action} entry has unexpected phase ${decoded.value.phase}.`);
  }
  return { ok: true, value: { version: 4, action, state: decoded.value } };
}
