import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIDialogOptions,
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

export default function requestUIExtension(pi: ExtensionAPI): void {
  const coordinator = new RequestCoordinator();
  let currentUI: ExtensionUIContext | undefined;
  let adapters: InstalledRequestUIAdapters | undefined;
  let sessionAbortController: AbortController | undefined;

  function sessionOptions(options: RequestDialogOptions = {}): RequestDialogOptions {
    const sessionSignal = sessionAbortController?.signal;
    const signals = [options.signal, sessionSignal].filter((signal): signal is AbortSignal => signal !== undefined);
    return {
      ...options,
      ...(signals.length > 0 ? { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) } : {}),
    };
  }

  function nativeDialogOptions(options?: ExtensionUIDialogOptions): RequestDialogOptions {
    return sessionOptions(options);
  }

  async function ask(
    questions: readonly RequestQuestion[],
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<RequestDialogResult> {
    if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("Request UI requires Pi's interactive TUI.");
    return coordinator.request(ctx.ui, questions, sessionOptions({ signal }));
  }

  registerAskTool(pi, { ask });
  const unsubscribeChannel = registerRequestUIChannel(pi.events, async (questions, options) => {
    if (!currentUI) throw new Error("Request UI is not ready for the current session.");
    return coordinator.request(currentUI, questions, sessionOptions(options));
  });

  pi.on("session_start", (_event, ctx) => {
    adapters?.restore();
    adapters = undefined;
    sessionAbortController?.abort();
    currentUI = undefined;
    sessionAbortController = new AbortController();
    if (ctx.mode !== "tui" || !ctx.hasUI) return;
    currentUI = ctx.ui;
    adapters = installRequestUIAdapters(ctx.ui, coordinator, nativeDialogOptions);
  });

  pi.on("session_shutdown", () => {
    sessionAbortController?.abort();
    sessionAbortController = undefined;
    adapters?.restore();
    adapters = undefined;
    currentUI = undefined;
    unsubscribeChannel();
  });
}
