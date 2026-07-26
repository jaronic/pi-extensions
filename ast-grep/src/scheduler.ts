import { availableParallelism } from "node:os";
import type { OperationRecord } from "./operations.ts";
import { terminalError, throwIfCancelledOrExpired } from "./operations.ts";

interface Waiter {
  prev?: Waiter;
  next?: Waiter;
  record: OperationRecord;
  resolve: (permit: NativePermit) => void;
  reject: (error: Error) => void;
  settled: boolean;
  onAbort: () => void;
}

export interface NativePermit {
  release(): void;
}

export class NativeScheduler {
  readonly capacity: number;
  readonly workerThreads: number;
  readonly maxWaiters: number;
  #active = 0;
  #waiting = 0;
  #head?: Waiter;
  #tail?: Waiter;
  #closing = false;

  constructor(parallelism = availableParallelism(), maxWaiters = 8) {
    this.capacity = Math.min(2, Math.max(1, parallelism));
    this.workerThreads = Math.max(1, Math.floor(Math.min(4, Math.max(1, parallelism)) / this.capacity));
    this.maxWaiters = maxWaiters;
  }

  get activeCount(): number {
    return this.#active;
  }

  get waitingCount(): number {
    return this.#waiting;
  }

  async acquire(record: OperationRecord): Promise<NativePermit> {
    throwIfCancelledOrExpired(record);
    if (this.#closing) {
      throw new Error("ast-grep native scheduler is closed.");
    }
    if (this.#active < this.capacity) {
      this.#active += 1;
      return this.#createPermit();
    }
    if (this.#waiting >= this.maxWaiters) {
      throw new Error(`ast-grep native queue is full; at most ${this.maxWaiters} calls may wait.`);
    }

    return new Promise<NativePermit>((resolve, reject) => {
      const waiter: Waiter = {
        record,
        resolve,
        reject,
        settled: false,
        onAbort: () => {
          if (waiter.settled) {
            return;
          }
          waiter.settled = true;
          this.#unlink(waiter);
          reject(terminalError(record));
        },
      };
      if (this.#tail === undefined) {
        this.#head = waiter;
        this.#tail = waiter;
      } else {
        waiter.prev = this.#tail;
        this.#tail.next = waiter;
        this.#tail = waiter;
      }
      this.#waiting += 1;
      record.controller.signal.addEventListener("abort", waiter.onAbort, { once: true });
      if (record.controller.signal.aborted) {
        waiter.onAbort();
      }
    });
  }

  close(): void {
    if (this.#closing) {
      return;
    }
    this.#closing = true;
    let waiter = this.#head;
    while (waiter !== undefined) {
      const next = waiter.next;
      if (!waiter.settled) {
        waiter.settled = true;
        waiter.record.controller.signal.removeEventListener("abort", waiter.onAbort);
        waiter.reject(new Error("ast-grep native scheduler closed before this call could start."));
      }
      waiter = next;
    }
    this.#head = undefined;
    this.#tail = undefined;
    this.#waiting = 0;
  }

  #createPermit(): NativePermit {
    let released = false;
    return {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.#releaseOne();
      },
    };
  }

  #releaseOne(): void {
    if (this.#active <= 0) {
      throw new Error("ast-grep native scheduler permit underflow.");
    }
    this.#active -= 1;
    if (this.#closing) {
      return;
    }
    let waiter = this.#head;
    while (waiter !== undefined) {
      const next = waiter.next;
      this.#unlink(waiter);
      if (!waiter.settled) {
        waiter.settled = true;
        waiter.record.controller.signal.removeEventListener("abort", waiter.onAbort);
        try {
          throwIfCancelledOrExpired(waiter.record);
        } catch (error) {
          waiter.reject(error instanceof Error ? error : new Error(String(error)));
          waiter = next;
          continue;
        }
        this.#active += 1;
        waiter.resolve(this.#createPermit());
        return;
      }
      waiter = next;
    }
  }

  #unlink(waiter: Waiter): void {
    if (waiter.prev !== undefined) {
      waiter.prev.next = waiter.next;
    } else if (this.#head === waiter) {
      this.#head = waiter.next;
    }
    if (waiter.next !== undefined) {
      waiter.next.prev = waiter.prev;
    } else if (this.#tail === waiter) {
      this.#tail = waiter.prev;
    }
    if (this.#waiting > 0) {
      this.#waiting -= 1;
    }
    waiter.prev = undefined;
    waiter.next = undefined;
  }
}
