import type {
  EventBus,
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { installRequestUIAdapters, type InstalledRequestUIAdapters } from "./adapters.ts";
import { RequestCoordinator } from "./dialog.ts";
import { registerRequestUIChannel, REQUEST_UI_CHANNEL, requestFromUser } from "./protocol.ts";
import type { RequestDialogOptions, RequestDialogResult, RequestQuestion } from "./request.ts";
import { registerAskTool } from "./tool.ts";

export { REQUEST_UI_CHANNEL, requestFromUser } from "./protocol.ts";
export type {
  RequestAnswer,
  RequestChoiceQuestion,
  RequestDialogOptions,
  RequestDialogResult,
  RequestOption,
  RequestQuestion,
  RequestTextQuestion,
} from "./request.ts";
export type { AskAnswerDetails, AskToolDetails } from "./tool.ts";

export interface RequestService {
  readonly lifetime: AbortSignal;
  request(
    questions: readonly RequestQuestion[],
    options?: RequestDialogOptions,
  ): Promise<RequestDialogResult>;
}

interface RequestInstallation {
  service: RequestService;
  dispose(): void;
}

const REQUEST_INSTALLATIONS = Symbol.for("pi-extensions:request-ui:installations:v1");

function requestInstallations(): WeakMap<EventBus, RequestInstallation> {
  const host = globalThis as { [key: symbol]: unknown };
  const existing = host[REQUEST_INSTALLATIONS];
  if (existing === undefined) {
    const installations = new WeakMap<EventBus, RequestInstallation>();
    host[REQUEST_INSTALLATIONS] = installations;
    return installations;
  }
  if (!(existing instanceof WeakMap)) throw new Error("Request installation registry is invalid.");
  return existing as WeakMap<EventBus, RequestInstallation>;
}

export function installRequest(pi: ExtensionAPI): RequestService {
  const installations = requestInstallations();
  const installed = installations.get(pi.events);
  if (installed) return installed.service;

  const coordinator = new RequestCoordinator();
  const lifetimeController = new AbortController();
  let currentUI: ExtensionUIContext | undefined;
  let adapters: InstalledRequestUIAdapters | undefined;
  let sessionAbortController: AbortController | undefined;
  let disposed = false;
  let unsubscribeChannel: () => void = () => undefined;
  let installation: RequestInstallation;

  function sessionOptions(options: RequestDialogOptions = {}): RequestDialogOptions {
    const sessionSignal = sessionAbortController?.signal;
    const signals = [options.signal, sessionSignal].filter((signal): signal is AbortSignal => signal !== undefined);
    return {
      ...options,
      ...(signals.length > 0 ? { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) } : {}),
    };
  }

  const request = async (
    questions: readonly RequestQuestion[],
    options: RequestDialogOptions = {},
  ): Promise<RequestDialogResult> => {
    if (lifetimeController.signal.aborted) throw new Error("Request UI installation has shut down.");
    if (!currentUI) throw new Error("Request UI is not ready for the current session.");
    return coordinator.request(currentUI, questions, sessionOptions(options));
  };
  const service = Object.freeze({ lifetime: lifetimeController.signal, request });

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    lifetimeController.abort();
    sessionAbortController?.abort();
    sessionAbortController = undefined;
    adapters?.restore();
    adapters = undefined;
    currentUI = undefined;
    unsubscribeChannel();
    if (installations.get(pi.events) === installation) installations.delete(pi.events);
  }

  installation = { service, dispose };
  installations.set(pi.events, installation);

  registerAskTool(pi, {
    ask: (questions, _ctx, signal) => request(questions, { signal }),
  });
  unsubscribeChannel = registerRequestUIChannel(pi.events, request);

  pi.on("session_start", (_event, ctx) => {
    if (disposed) return;
    adapters?.restore();
    adapters = undefined;
    sessionAbortController?.abort();
    currentUI = undefined;
    sessionAbortController = new AbortController();
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    currentUI = ctx.ui;
    adapters = installRequestUIAdapters(ctx.ui, service.request);
  });

  pi.on("session_shutdown", dispose);
  return service;
}

export default function requestUIExtension(pi: ExtensionAPI): void {
  installRequest(pi);
}
