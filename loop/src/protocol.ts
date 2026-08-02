export const LOOP_STATE_TYPE = "loop-state-v1";
export const LOOP_CONTINUATION_TYPE = "loop-continuation-v1";

export interface LoopContinuationDetails {
  loopId: string;
  generation: number;
  round: number;
}

export function isLoopContinuationDetails(value: unknown): value is LoopContinuationDetails {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.loopId === "string" &&
    record.loopId.trim() === record.loopId &&
    record.loopId.length > 0 &&
    typeof record.generation === "number" &&
    Number.isSafeInteger(record.generation) &&
    record.generation >= 1 &&
    typeof record.round === "number" &&
    Number.isSafeInteger(record.round) &&
    record.round >= 1;
}

export function continuationLoopDetails(message: unknown): LoopContinuationDetails | undefined {
  if (!message || typeof message !== "object" || !("customType" in message)) return undefined;
  if (message.customType !== LOOP_CONTINUATION_TYPE || !("details" in message)) return undefined;
  const details = message.details;
  return isLoopContinuationDetails(details) ? details : undefined;
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

export function assistantTailText(message: unknown, maxChars: number): string {
  if (!message || typeof message !== "object") return "";
  const content = "content" in message ? message.content : undefined;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (!block || typeof block !== "object" || !("type" in block) || block.type !== "text") continue;
    if ("text" in block && typeof block.text === "string") text += block.text;
  }
  const chars = [...text];
  return chars.length <= maxChars ? text : chars.slice(chars.length - maxChars).join("");
}
