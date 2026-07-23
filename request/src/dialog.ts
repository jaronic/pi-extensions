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
    const run = this.tail.then(async () => {
      if (options.signal?.aborted) return unansweredRequestResult(normalized, true);
      return ui.custom<RequestDialogResult>((tui, theme, keybindings, done) => {
        const component = createRequestComponent({
          tui,
          theme,
          keybindings,
          questions: normalized,
          done,
          signal: options.signal,
          timeout: options.timeout,
        });
        return component;
      });
    });
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}
