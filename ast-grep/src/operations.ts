import { performance } from "node:perf_hooks";

export type TerminalCause = "external-abort" | "timeout" | "shutdown";

export interface OperationRecord {
  readonly id: string;
  readonly startedAt: number;
  readonly deadline: number;
  readonly now: () => number;
  readonly controller: AbortController;
  readonly externalSignal?: AbortSignal;
  terminalCause?: TerminalCause;
  committed: boolean;
  timer?: NodeJS.Timeout;
}

interface TrackedOperation extends OperationRecord {
  rejectInterrupt: (error: Error) => void;
  workSettlement?: Promise<unknown>;
  removeExternalListener?: () => void;
}

const MAX_OPERATIONS = 8;

export function terminalError(record: OperationRecord): Error {
  if (record.terminalCause === "timeout") {
    return new Error("ast-grep operation timed out before completion.");
  }
  if (record.terminalCause === "shutdown") {
    return new Error("ast-grep extension is shutting down; no new work can complete.");
  }
  return new Error("ast-grep operation was aborted.");
}

export function markTerminalCause(record: OperationRecord, cause: TerminalCause): void {
  if (record.committed || record.terminalCause !== undefined) {
    return;
  }
  record.terminalCause = cause;
  record.controller.abort(terminalError(record));
  if ("rejectInterrupt" in record) {
    (record as TrackedOperation).rejectInterrupt(terminalError(record));
  }
}

export function throwIfCancelledOrExpired(record: OperationRecord): void {
  if (record.committed) {
    return;
  }
  if (record.terminalCause !== undefined) {
    throw terminalError(record);
  }
  if (record.now() >= record.deadline) {
    markTerminalCause(record, "timeout");
    throw terminalError(record);
  }
  if (record.externalSignal?.aborted) {
    markTerminalCause(record, "external-abort");
    throw terminalError(record);
  }
  if (record.controller.signal.aborted) {
    throw terminalError(record);
  }
}

export function markCommitted(record: OperationRecord): void {
  record.committed = true;
  if (record.timer !== undefined) {
    clearTimeout(record.timer);
    record.timer = undefined;
  }
}

export function createInternalOperation(timeoutMs: number, now: () => number = performance.now.bind(performance)): OperationRecord {
  const startedAt = now();
  const record: OperationRecord = {
    id: "internal",
    startedAt,
    deadline: startedAt + timeoutMs,
    now,
    controller: new AbortController(),
    committed: false,
  };
  const timer = setTimeout(() => markTerminalCause(record, "timeout"), timeoutMs);
  timer.unref();
  record.timer = timer;
  return record;
}

export class OperationTracker {
  readonly #operations = new Set<TrackedOperation>();
  readonly #now: () => number;
  #closing = false;
  #nextId = 1;

  constructor(now: () => number = performance.now.bind(performance)) {
    this.#now = now;
  }

  get activeCount(): number {
    return this.#operations.size;
  }

  get closing(): boolean {
    return this.#closing;
  }

  run<T>(externalSignal: AbortSignal | undefined, timeoutMs: number, work: (record: OperationRecord) => Promise<T>): Promise<T> {
    if (this.#closing) {
      throw new Error("ast-grep extension is shutting down; new operations are closed.");
    }
    if (this.#operations.size >= MAX_OPERATIONS) {
      throw new Error(`ast-grep resource limit reached: at most ${MAX_OPERATIONS} operations may be unsettled.`);
    }

    const startedAt = this.#now();
    let rejectInterrupt!: (error: Error) => void;
    const interrupt = new Promise<never>((_resolve, reject) => {
      rejectInterrupt = reject;
    });
    void interrupt.catch(() => undefined);

    const record: TrackedOperation = {
      id: `ast-grep-${this.#nextId++}`,
      startedAt,
      deadline: startedAt + timeoutMs,
      now: this.#now,
      controller: new AbortController(),
      externalSignal,
      committed: false,
      rejectInterrupt,
    };
    const timerDelay = Math.max(0, record.deadline - this.#now());
    const timer = setTimeout(() => markTerminalCause(record, "timeout"), timerDelay);
    timer.unref();
    record.timer = timer;

    if (externalSignal !== undefined) {
      const onAbort = () => markTerminalCause(record, "external-abort");
      externalSignal.addEventListener("abort", onAbort, { once: true });
      record.removeExternalListener = () => externalSignal.removeEventListener("abort", onAbort);
      if (externalSignal.aborted) {
        markTerminalCause(record, "external-abort");
      }
    }

    this.#operations.add(record);
    const workSettlement = (async () => {
      throwIfCancelledOrExpired(record);
      return work(record);
    })();
    record.workSettlement = workSettlement;
    void workSettlement.catch(() => undefined);
    void workSettlement.finally(() => {
      if (record.timer !== undefined) {
        clearTimeout(record.timer);
      }
      record.removeExternalListener?.();
      this.#operations.delete(record);
    }).catch(() => undefined);

    return Promise.race([workSettlement, interrupt]);
  }

  async shutdown(timeoutMs = 5000): Promise<void> {
    if (!this.#closing) {
      this.#closing = true;
      for (const operation of this.#operations) {
        markTerminalCause(operation, "shutdown");
      }
    }
    const settlements = [...this.#operations]
      .map((operation) => operation.workSettlement)
      .filter((settlement): settlement is Promise<unknown> => settlement !== undefined);
    if (settlements.length === 0) {
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(settlements),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      }),
    ]);
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
