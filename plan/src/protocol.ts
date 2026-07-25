import type { PlanPhase } from "./state.ts";

export const PLAN_COORDINATION_CHANNEL = "pi-extensions:plan-state:v1";
export const PLAN_STATE_TYPE = "plan-state-v2";
export const LEGACY_PLAN_STATE_TYPE = "plan-state-v1";
export const PLAN_CONTROL_TYPE = "plan-control-v1";
export const PLAN_TOOL_NAMES = ["submit_plan", "request_plan_choice", "answer_plan_choice", "update_plan_step"] as const;

export interface PlanCoordinationSignal {
  version: 1;
  sessionId: string;
  phase: PlanPhase;
  readOnly: boolean;
  awaitingApproval: boolean;
  willTriggerTurn: boolean;
  reason: string;
}

export function controlPlanUpdatedAt(message: unknown): number | undefined {
  if (!message || typeof message !== "object" || !("customType" in message)) return undefined;
  if (message.customType !== PLAN_CONTROL_TYPE || !("details" in message)) return undefined;
  const details = message.details;
  if (!details || typeof details !== "object" || !("planUpdatedAt" in details)) return undefined;
  return typeof details.planUpdatedAt === "number" ? details.planUpdatedAt : undefined;
}
