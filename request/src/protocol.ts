import type { EventBus, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RequestDialogOptions, RequestDialogResult, RequestQuestion } from "./request.ts";

export const REQUEST_UI_CHANNEL = "pi-extensions:request-ui:v1";

export interface RequestUIEnvelope {
  version: 1;
  questions: readonly RequestQuestion[];
  options?: RequestDialogOptions;
  accept(): boolean;
  resolve(result: RequestDialogResult): void;
  reject(error: unknown): void;
}

export type RequestUIHandler = (
  questions: readonly RequestQuestion[],
  options?: RequestDialogOptions,
) => Promise<RequestDialogResult>;

function isEnvelope(value: unknown): value is RequestUIEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<RequestUIEnvelope>;
  return candidate.version === 1 &&
    Array.isArray(candidate.questions) &&
    typeof candidate.accept === "function" &&
    typeof candidate.resolve === "function" &&
    typeof candidate.reject === "function";
}

export function requestFromUser(
  pi: Pick<ExtensionAPI, "events">,
  questions: readonly RequestQuestion[],
  options?: RequestDialogOptions,
): Promise<RequestDialogResult> {
  const { promise, resolve, reject } = Promise.withResolvers<RequestDialogResult>();
  let accepted = false;
  let settled = false;
  const envelope: RequestUIEnvelope = {
    version: 1,
    questions,
    options,
    accept: () => {
      if (accepted) return false;
      accepted = true;
      return true;
    },
    resolve: (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    },
    reject: (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    },
  };
  try {
    pi.events.emit(REQUEST_UI_CHANNEL, envelope);
  } catch (error) {
    settled = true;
    reject(error);
  }
  if (!accepted && !settled) {
    settled = true;
    reject(new Error("The Request UI extension is not loaded or not ready."));
  }
  return promise;
}

export function registerRequestUIChannel(
  events: EventBus,
  handler: RequestUIHandler,
): () => void {
  return events.on(REQUEST_UI_CHANNEL, (value) => {
    if (!isEnvelope(value) || !value.accept()) return;
    try {
      void handler(value.questions, value.options).then(value.resolve, value.reject);
    } catch (error) {
      value.reject(error);
    }
  });
}
