import type { EventBus } from "@earendil-works/pi-coding-agent";

export interface FixtureQuestion {
  id: string;
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  recommended?: number;
  multi?: boolean;
}

export interface FixtureResult {
  cancelled: boolean;
  results: Array<{
    id: string;
    selectedOptions: string[];
    customInput?: string;
  }>;
}

export function requestFromExternalFixture(events: EventBus, questions: FixtureQuestion[]): Promise<FixtureResult> {
  const { promise, resolve, reject } = Promise.withResolvers<FixtureResult>();
  let accepted = false;
  let settled = false;
  events.emit("pi-extensions:request-ui:v1", {
    version: 1,
    questions,
    accept: () => {
      if (accepted) return false;
      accepted = true;
      return true;
    },
    resolve: (result: FixtureResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    },
    reject: (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    },
  });
  if (!accepted && !settled) reject(new Error("Request UI fixture was not accepted."));
  return promise;
}
