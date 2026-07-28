export const GOAL_STATE_TYPE = "goal-state-v1";
export const GOAL_CONTINUATION_TYPE = "goal-continuation-v1";


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
