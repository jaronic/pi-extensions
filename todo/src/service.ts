import type { EventBus, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decodeTodoToolDetails, type TodoToolDetails } from "./persistence.ts";
import { MAX_MODEL_OUTPUT_BYTES } from "./state.ts";
import type { TodoPlanPhaseSync } from "./protocol.ts";

export const TODO_SERVICE_CHANNEL = "pi-extensions:todo-service:v1";
export const MAX_TODO_SERVICE_SESSION_ID_CHARS = 256;

export type TodoServiceOperation =
  | { readonly op: "init"; readonly list: readonly { readonly phase: string; readonly items: readonly string[] }[] }
  | { readonly op: "append"; readonly phase: string; readonly items: readonly string[] }
  | { readonly op: "start"; readonly id: number }
  | { readonly op: "done"; readonly id: number; readonly note?: string | null }
  | { readonly op: "block"; readonly id: number; readonly reason: string }
  | { readonly op: "drop"; readonly id: number | readonly number[]; readonly reason: string }
  | { readonly op: "reopen"; readonly id: number; readonly reason: string }
  | { readonly op: "edit"; readonly id: number; readonly content: string }
  | { readonly op: "get"; readonly id: number }
  | {
      readonly op: "view";
      readonly phase?: string | null;
      readonly includeClosed?: boolean | null;
      readonly offset?: number | null;
      readonly limit?: number | null;
    };

export interface TodoServiceRequest {
  readonly sessionId: string;
  readonly operation: TodoServiceOperation;
  readonly signal?: AbortSignal;
}

export interface TodoServiceResult {
  readonly content: string;
  readonly details: TodoToolDetails;
}

export interface TodoPlanHandoffRequest {
  readonly sessionId: string;
  readonly phase: string;
  readonly items: readonly string[];
  readonly signal?: AbortSignal;
}

export interface TodoService {
  readonly lifetime: AbortSignal;
  execute(request: TodoServiceRequest): TodoServiceResult;
  handoffPlan(request: TodoPlanHandoffRequest): TodoServiceResult;
  syncPlanPhase(input: TodoPlanPhaseSync): void;
}

interface TodoServiceEnvelope {
  readonly version: 1;
  readonly kind: "request";
  readonly request: TodoServiceRequest;
  accept(): boolean;
  resolve(result: unknown): void;
  reject(error: unknown): void;
}

export type TodoServiceHandler = (request: TodoServiceRequest) => TodoServiceResult;

const ENVELOPE_KEYS = new Set(["version", "kind", "request", "accept", "resolve", "reject"]);
const REQUEST_KEYS = new Set(["sessionId", "operation", "signal"]);
const RESULT_KEYS = new Set(["content", "details"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function normalizedSessionId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    [...value].length > MAX_TODO_SERVICE_SESSION_ID_CHARS
  ) {
    throw new Error(
      `Todo service session ID must be non-empty trimmed text within ${MAX_TODO_SERVICE_SESSION_ID_CHARS} characters.`,
    );
  }
  return value;
}

function frozenOperation(operation: TodoServiceOperation): TodoServiceOperation {
  let clone: TodoServiceOperation;
  try {
    clone = structuredClone(operation);
  } catch {
    throw new Error("Todo service operation must be structured-cloneable.");
  }
  if (!isRecord(clone)) throw new Error("Todo service operation must be an object.");
  for (const value of Object.values(clone)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (isRecord(item)) {
        for (const nested of Object.values(item)) if (Array.isArray(nested)) Object.freeze(nested);
        Object.freeze(item);
      }
    }
    Object.freeze(value);
  }
  return Object.freeze(clone);
}

function isEnvelope(value: unknown): value is TodoServiceEnvelope {
  if (!isRecord(value) || !hasOnlyKeys(value, ENVELOPE_KEYS)) return false;
  if (value.version !== 1 || value.kind !== "request" || !isRecord(value.request)) return false;
  if (!hasOnlyKeys(value.request, REQUEST_KEYS)) return false;
  if (typeof value.request.sessionId !== "string" || !isRecord(value.request.operation)) return false;
  if (value.request.signal !== undefined && !(value.request.signal instanceof AbortSignal)) return false;
  return typeof value.accept === "function" && typeof value.resolve === "function" && typeof value.reject === "function";
}

function decodeResult(value: unknown, expectedOp: TodoServiceOperation["op"]): TodoServiceResult {
  if (!isRecord(value) || !hasOnlyKeys(value, RESULT_KEYS) || typeof value.content !== "string") {
    throw new Error("Todo service returned an invalid result.");
  }
  if (Buffer.byteLength(value.content, "utf8") > MAX_MODEL_OUTPUT_BYTES) {
    throw new Error(`Todo service result content exceeds ${MAX_MODEL_OUTPUT_BYTES} bytes.`);
  }
  const decoded = decodeTodoToolDetails(value.details);
  if (decoded.kind !== "valid") throw new Error("Todo service returned invalid details.");
  if (decoded.value.op !== expectedOp) throw new Error("Todo service result operation does not match the request.");
  return Object.freeze({ content: value.content, details: decoded.value });
}

export function requestTodoService(
  pi: Pick<ExtensionAPI, "events">,
  request: TodoServiceRequest,
): Promise<TodoServiceResult> {
  let sessionId: string;
  let operation: TodoServiceOperation;
  try {
    sessionId = normalizedSessionId(request.sessionId);
    request.signal?.throwIfAborted();
    operation = frozenOperation(request.operation);
  } catch (error) {
    return Promise.reject(error);
  }
  const { promise, resolve, reject } = Promise.withResolvers<TodoServiceResult>();
  let accepted = false;
  let settled = false;
  const abort = (): void => settleReject(request.signal?.reason ?? new Error("Todo service request aborted."));
  const cleanup = (): void => request.signal?.removeEventListener("abort", abort);
  const settleReject = (error: unknown): void => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(error);
  };
  const envelope: TodoServiceEnvelope = {
    version: 1,
    kind: "request",
    request: Object.freeze({ sessionId, operation, ...(request.signal === undefined ? {} : { signal: request.signal }) }),
    accept: () => {
      if (accepted || settled) return false;
      accepted = true;
      return true;
    },
    resolve: (result) => {
      if (settled) return;
      try {
        const decoded = decodeResult(result, operation.op);
        settled = true;
        cleanup();
        resolve(decoded);
      } catch (error) {
        settleReject(error);
      }
    },
    reject: settleReject,
  };
  request.signal?.addEventListener("abort", abort, { once: true });
  try {
    pi.events.emit(TODO_SERVICE_CHANNEL, envelope);
  } catch (error) {
    settleReject(error);
  }
  if (!accepted && !settled) {
    settleReject(new Error("The Todo service extension is not loaded or not ready."));
  }
  return promise;
}

export function registerTodoService(events: EventBus, handler: TodoServiceHandler): () => void {
  return events.on(TODO_SERVICE_CHANNEL, (value: unknown) => {
    if (!isEnvelope(value) || !value.accept()) return;
    try {
      value.request.signal?.throwIfAborted();
      value.resolve(handler(value.request));
    } catch (error) {
      value.reject(error);
    }
  });
}
