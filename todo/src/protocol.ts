export const PLAN_COORDINATION_CHANNEL = "pi-extensions:plan-state:v1";

export type CoordinatedPlanPhase =
  | "off"
  | "planning"
  | "awaitingClarification"
  | "awaitingApproval"
  | "executing";

export interface PlanCoordinationSignal {
  readonly version: 1;
  readonly sessionId: string;
  readonly phase: CoordinatedPlanPhase;
  readonly readOnly: boolean;
  readonly awaitingApproval: boolean;
  readonly willTriggerTurn: boolean;
  readonly reason: string;
}

const PLAN_PHASES: readonly CoordinatedPlanPhase[] = [
  "off",
  "planning",
  "awaitingClarification",
  "awaitingApproval",
  "executing",
];

export function decodePlanCoordinationSignal(value: unknown): PlanCoordinationSignal | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "version",
    "sessionId",
    "phase",
    "readOnly",
    "awaitingApproval",
    "willTriggerTurn",
    "reason",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return undefined;
  if (
    record.version !== 1 ||
    typeof record.sessionId !== "string" ||
    !record.sessionId ||
    record.sessionId.length > 256 ||
    typeof record.phase !== "string" ||
    !PLAN_PHASES.includes(record.phase as CoordinatedPlanPhase) ||
    typeof record.readOnly !== "boolean" ||
    typeof record.awaitingApproval !== "boolean" ||
    typeof record.willTriggerTurn !== "boolean" ||
    typeof record.reason !== "string" ||
    record.reason.length > 500
  ) return undefined;
  return Object.freeze({
    version: 1,
    sessionId: record.sessionId,
    phase: record.phase as CoordinatedPlanPhase,
    readOnly: record.readOnly,
    awaitingApproval: record.awaitingApproval,
    willTriggerTurn: record.willTriggerTurn,
    reason: record.reason,
  });
}

export function planBlocksTodoMutation(phase: CoordinatedPlanPhase): boolean {
  return phase !== "off";
}
