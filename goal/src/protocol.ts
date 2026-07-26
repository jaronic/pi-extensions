export const PLAN_COORDINATION_CHANNEL = "pi-extensions:plan-state:v1";
export const GOAL_STATE_TYPE = "goal-state-v1";
export const GOAL_CONTINUATION_TYPE = "goal-continuation-v1";

export type CoordinatedPlanPhase = "off" | "planning" | "awaitingApproval" | "blocked" | "executing";

const PLAN_PHASES: readonly CoordinatedPlanPhase[] = ["off", "planning", "awaitingApproval", "blocked", "executing"];

export interface PlanCoordinationSignal {
  version: 1;
  sessionId: string;
  phase: CoordinatedPlanPhase;
  readOnly: boolean;
  awaitingApproval: boolean;
  willTriggerTurn: boolean;
  reason: string;
}

export function parsePlanSignal(data: unknown): PlanCoordinationSignal | null {
  if (!data || typeof data !== "object") return null;
  if (!("version" in data) || data.version !== 1) return null;
  if (!("sessionId" in data) || typeof data.sessionId !== "string") return null;
  if (!("phase" in data) || typeof data.phase !== "string" || !PLAN_PHASES.includes(data.phase as CoordinatedPlanPhase)) return null;
  return {
    version: 1,
    sessionId: data.sessionId,
    phase: data.phase as CoordinatedPlanPhase,
    readOnly: "readOnly" in data && data.readOnly === true,
    awaitingApproval: "awaitingApproval" in data && data.awaitingApproval === true,
    willTriggerTurn: "willTriggerTurn" in data && data.willTriggerTurn === true,
    reason: "reason" in data && typeof data.reason === "string" ? data.reason : "state-sync",
  };
}

export function continuationGoalId(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || !("customType" in message)) return undefined;
  if (message.customType !== GOAL_CONTINUATION_TYPE || !("details" in message)) return undefined;
  const details = message.details;
  if (!details || typeof details !== "object" || !("goalId" in details)) return undefined;
  return typeof details.goalId === "string" ? details.goalId : undefined;
}

export function lastAssistantStop(messages: unknown[]): { stopReason?: string; errorMessage?: string } | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") continue;
    const stopReason = "stopReason" in message && typeof message.stopReason === "string" ? message.stopReason : undefined;
    const errorMessage = "errorMessage" in message && typeof message.errorMessage === "string" ? message.errorMessage : undefined;
    return { stopReason, errorMessage };
  }
  return undefined;
}
