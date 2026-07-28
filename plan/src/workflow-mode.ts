import type { EventBus } from "@earendil-works/pi-coding-agent";

export const EXCLUSIVE_WORKFLOW_CHANNEL = "pi-extensions:exclusive-workflow:v1";
export type ExclusiveWorkflowMode = "plan" | "goal";

interface WorkflowQuery {
  readonly version: 1;
  readonly kind: "query";
  readonly sessionId: string;
  readonly target: ExclusiveWorkflowMode;
  respond(active: boolean): void;
}

const QUERY_KEYS = new Set(["version", "kind", "sessionId", "target", "respond"]);

function isWorkflowQuery(value: unknown): value is WorkflowQuery {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !QUERY_KEYS.has(key))) return false;
  return record.version === 1 &&
    record.kind === "query" &&
    typeof record.sessionId === "string" &&
    record.sessionId.length > 0 &&
    record.sessionId.trim() === record.sessionId &&
    [...record.sessionId].length <= 256 &&
    (record.target === "plan" || record.target === "goal") &&
    typeof record.respond === "function";
}

export function isExclusiveWorkflowActive(
  events: EventBus,
  sessionId: string,
  target: ExclusiveWorkflowMode,
): boolean {
  let active = false;
  const query: WorkflowQuery = Object.freeze({
    version: 1,
    kind: "query",
    sessionId,
    target,
    respond(value: boolean): void {
      if (value === true) active = true;
    },
  });
  events.emit(EXCLUSIVE_WORKFLOW_CHANNEL, query);
  return active;
}

export function registerExclusiveWorkflow(
  events: EventBus,
  mode: ExclusiveWorkflowMode,
  isActive: (sessionId: string) => boolean,
): () => void {
  return events.on(EXCLUSIVE_WORKFLOW_CHANNEL, (value: unknown) => {
    if (!isWorkflowQuery(value) || value.target !== mode) return;
    value.respond(isActive(value.sessionId));
  });
}
