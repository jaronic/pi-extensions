export type TodoPlanPhase =
  | "off"
  | "planning"
  | "awaitingClarification"
  | "awaitingApproval"
  | "blocked"
  | "executing";

export interface TodoPlanPhaseSync {
  readonly sessionId: string;
  readonly phase: TodoPlanPhase;
}

const TODO_PLAN_PHASES: readonly TodoPlanPhase[] = [
  "off",
  "planning",
  "awaitingClarification",
  "awaitingApproval",
  "blocked",
  "executing",
];

export function decodeTodoPlanPhaseSync(value: unknown): TodoPlanPhaseSync {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Todo Plan phase sync must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== "sessionId" && key !== "phase")) {
    throw new Error("Todo Plan phase sync contains unknown fields.");
  }
  if (
    typeof record.sessionId !== "string" ||
    record.sessionId.length === 0 ||
    record.sessionId.trim() !== record.sessionId ||
    [...record.sessionId].length > 256
  ) {
    throw new Error("Todo Plan phase sync session ID must be non-empty trimmed text within 256 characters.");
  }
  if (typeof record.phase !== "string" || !TODO_PLAN_PHASES.includes(record.phase as TodoPlanPhase)) {
    throw new Error("Todo Plan phase sync contains an invalid phase.");
  }
  return Object.freeze({ sessionId: record.sessionId, phase: record.phase as TodoPlanPhase });
}

export function planBlocksTodoMutation(phase: TodoPlanPhase): boolean {
  return phase !== "off";
}
