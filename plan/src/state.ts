import { posix, win32 } from "node:path";

export type PlanPhase = "off" | "planning" | "awaitingClarification" | "awaitingApproval" | "executing";
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
export const MAX_PLAN_CHOICE_QUESTION_CHARS = 1_000;
export const MAX_PLAN_CHOICE_OPTIONS = 5;
export const MIN_PLAN_CHOICE_OPTIONS = 2;
export const MAX_PLAN_CHOICE_LABEL_CHARS = 160;
export const MAX_PLAN_CHOICE_DESCRIPTION_CHARS = 500;
export const MAX_PLAN_CHOICE_PAYLOAD_BYTES = 8 * 1024;

export interface PlanStep {
  id: string;
  text: string;
  status: PlanStepStatus;
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

export interface PlanState {
  version: 1;
  phase: ActivePlanPhase;
  summary?: string;
  plan?: string;
  planPath?: string;
  clarification?: PlanClarification;
  steps: PlanStep[];
  enteredWithTools: string[];
  createdAt: number;
  updatedAt: number;
}

export interface PlanJournalEntry {
  version: 1;
  action: "start" | "clarify" | "answer" | "resume" | "submit" | "approve" | "refine" | "cancel" | "step" | "complete";
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
  step: true,
  complete: true,
};

const VALID_PHASES: Record<ActivePlanPhase, true> = {
  planning: true,
  awaitingApproval: true,
  awaitingClarification: true,
  executing: true,
};

const VALID_STEP_STATUSES: Record<PlanStepStatus, true> = {
  pending: true,
  inProgress: true,
  completed: true,
  blocked: true,
};

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
    ...new Set(activeTools.filter((name) => name !== "submit_plan" && name !== "request_plan_choice" && name !== "answer_plan_choice" && name !== "update_plan_step")),
  ]);
  return {
    version: 1,
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
    status: "pending" as const,
  }));
  validatePlanPayload(summary, plan, steps);
  const { clarification: _clarification, ...submittedState } = state;
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

export function approvePlan(state: PlanState, now = Date.now()): PlanState {
  if (state.phase !== "awaitingApproval" || !state.plan || state.steps.length === 0) {
    throw new Error("No submitted plan is awaiting approval.");
  }
  return { ...state, phase: "executing", updatedAt: now };
}

export function updatePlanStep(
  state: PlanState,
  id: string,
  status: PlanStepStatus,
  now = Date.now(),
): PlanState {
  if (state.phase !== "executing") throw new Error("Plan steps can only be updated during execution.");
  if (!state.steps.some((step) => step.id === id)) throw new Error(`Unknown plan step: ${id}`);
  const steps = state.steps.map((step) => {
    if (step.id === id) return { ...step, status };
    if (status === "inProgress" && step.status === "inProgress") return { ...step, status: "pending" as const };
    return step;
  });
  return { ...state, steps, updatedAt: now };
}

export function allPlanStepsComplete(state: PlanState): boolean {
  return state.steps.length > 0 && state.steps.every((step) => step.status === "completed");
}

function decodePlanStep(value: unknown): PlanDecodeResult<PlanStep> {
  if (!isRecord(value)) return decodeFailure("Plan step must be an object.");
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
  if (!isPlanStepStatus(value.status)) return decodeFailure(`Plan step ${value.id} has an invalid status.`);
  return { ok: true, value: { id: value.id, text, status: value.status } };
}

function decodePlanClarification(value: unknown): PlanDecodeResult<PlanClarification> {
  if (!isRecord(value) || typeof value.question !== "string" || !Array.isArray(value.options)) {
    return decodeFailure("Plan choice must contain a question and options.");
  }
  const options: PlanChoiceOption[] = [];
  for (const rawOption of value.options) {
    if (!isRecord(rawOption) || typeof rawOption.label !== "string") {
      return decodeFailure("Plan choice option must contain a label.");
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
  if (value.version !== 1) return decodeFailure(`Unsupported Plan state version: ${String(value.version)}.`);
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
  const stepIds = new Set<string>();
  let inProgressSteps = 0;
  for (const rawStep of value.steps) {
    const decoded = decodePlanStep(rawStep);
    if (!decoded.ok) return decoded;
    if (stepIds.has(decoded.value.id)) return decodeFailure(`Duplicate Plan step ID: ${decoded.value.id}.`);
    stepIds.add(decoded.value.id);
    if (decoded.value.status === "inProgress") inProgressSteps += 1;
    steps.push(decoded.value);
  }
  if (inProgressSteps > 1) return decodeFailure("Plan state contains multiple in-progress steps.");

  let clarification: PlanClarification | undefined;
  if (value.clarification !== undefined) {
    const decoded = decodePlanClarification(value.clarification);
    if (!decoded.ok) return decoded;
    clarification = decoded.value;
  }
  const hasSummary = typeof value.summary === "string";
  const hasPlan = typeof value.plan === "string";
  if (hasSummary !== hasPlan) return decodeFailure("Plan summary and body must be stored together.");
  if ((value.phase === "awaitingApproval" || value.phase === "executing") && (!hasSummary || steps.length === 0)) {
    return decodeFailure(`Plan phase ${value.phase} requires a submitted plan and steps.`);
  }
  if (!hasSummary && steps.length > 0) return decodeFailure("Draft Plan state cannot contain steps without a plan.");
  if (value.phase === "awaitingClarification" && clarification?.selection !== undefined) {
    return decodeFailure("An unanswered Plan choice must not contain a selection.");
  }
  if (value.phase === "awaitingClarification" && !clarification) {
    return decodeFailure("Plan choice phase requires a pending choice.");
  }
  if (value.phase === "planning" && clarification && clarification.selection === undefined) {
    return decodeFailure("Planning phase cannot contain an unanswered Plan choice.");
  }
  if ((value.phase === "awaitingApproval" || value.phase === "executing") && clarification) {
    return decodeFailure(`Plan phase ${value.phase} cannot contain a choice.`);
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
      version: 1,
      phase: value.phase,
      summary,
      plan,
      planPath,
      clarification,
      steps,
      enteredWithTools,
      createdAt,
      updatedAt,
    },
  };
}

export function decodePlanJournalEntry(value: unknown): PlanDecodeResult<PlanJournalEntry> {
  if (!isRecord(value)) return decodeFailure("Plan journal entry must be an object.");
  if (value.version !== 1) return decodeFailure(`Unsupported Plan journal version: ${String(value.version)}.`);
  if (typeof value.action !== "string" || !Object.hasOwn(VALID_PLAN_ACTIONS, value.action)) {
    return decodeFailure("Plan journal entry has an invalid action.");
  }
  const action = value.action as PlanJournalEntry["action"];
  if (action === "cancel" || action === "complete") {
    if (value.state !== null) return decodeFailure(`Plan ${action} entry must contain null state.`);
    return { ok: true, value: { version: 1, action, state: null } };
  }

  const decoded = decodePlanState(value.state);
  if (!decoded.ok) return decoded;
  const expectedPhase: Record<Exclude<PlanJournalEntry["action"], "cancel" | "complete">, ActivePlanPhase> = {
    start: "planning",
    submit: "awaitingApproval",
    approve: "executing",
    clarify: "awaitingClarification",
    answer: "planning",
    resume: "planning",
    refine: "planning",
    step: "executing",
  };
  if (decoded.value.phase !== expectedPhase[action]) {
    return decodeFailure(`Plan ${action} entry has unexpected phase ${decoded.value.phase}.`);
  }
  return { ok: true, value: { version: 1, action, state: decoded.value } };
}
