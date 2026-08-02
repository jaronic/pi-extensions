import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createRequestComponent } from "./component.ts";
import {
  normalizeRequestQuestions,
  type RequestDialogOptions,
  type RequestDialogResult,
  type RequestQuestion,
  unansweredRequestResult,
} from "./request.ts";

export class RequestCoordinator {
  private tail: Promise<void> = Promise.resolve();

  request(
    ui: ExtensionUIContext,
    questions: readonly RequestQuestion[],
    options: RequestDialogOptions = {},
  ): Promise<RequestDialogResult> {
    const normalized = normalizeRequestQuestions(questions);
    const { promise, resolve, reject } = Promise.withResolvers<RequestDialogResult>();
    let settled = false;
    const timeoutMilliseconds = options.timeout !== undefined && Number.isFinite(options.timeout) && options.timeout > 0
      ? Math.min(options.timeout, 2_147_483_647)
      : undefined;
    const deadline = timeoutMilliseconds === undefined ? undefined : Date.now() + timeoutMilliseconds;

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      options.signal?.removeEventListener("abort", abort);
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      timeoutHandle = undefined;
    };
    const settleCancelled = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(unansweredRequestResult(normalized, true));
    };
    const abort = () => settleCancelled();

    if (deadline !== undefined) {
      timeoutHandle = setTimeout(settleCancelled, Math.max(0, deadline - Date.now()));
    }
    if (options.signal?.aborted) settleCancelled();
    else options.signal?.addEventListener("abort", abort, { once: true });

    const run = this.tail.then(async () => {
      if (settled) return;
      cleanup();
      const remaining = deadline === undefined ? undefined : deadline - Date.now();
      if (remaining !== undefined && remaining <= 0) {
        settleCancelled();
        return;
      }
      try {
        const result = await ui.custom<RequestDialogResult>((tui, theme, keybindings, done) => {
          const component = createRequestComponent({
            tui,
            theme,
            keybindings,
            questions: normalized,
            done,
            signal: options.signal,
            timeout: remaining,
          });
          return component;
        });
        if (!settled) {
          settled = true;
          resolve(result);
        }
      } catch (error) {
        if (!settled) {
          settled = true;
          reject(error);
        }
      }
    });
    this.tail = run.then(() => undefined, () => undefined);
    return promise;
  }
}
