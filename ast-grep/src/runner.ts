import { spawn, type ChildProcess } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { SupportedLanguage } from "./languages.ts";
import type { NormalizedSearchInput, NormalizedEditInput } from "./schema.ts";
import type { DecodedMatch, RunnerMode } from "./types.ts";
import type { OperationRecord } from "./operations.ts";
import { throwIfCancelledOrExpired } from "./operations.ts";
import type { NativeScheduler } from "./scheduler.ts";
import type { BinaryManager, ReadyBinary } from "./binary.ts";
import { assertArgvBudget, buildBoundedEnv } from "./binary.ts";
import { decodeMatch } from "./protocol.ts";

const MAX_NDJSON_LINE_BYTES = 1024 * 1024;
const STDERR_TAIL_BYTES = 64 * 1024;
const EXPOSED_ERROR_BYTES = 24 * 1024;
const EXPOSED_ERROR_LINES = 200;
const FORCE_KILL_DELAY_MS = 1000;

export interface PatternRunRequest {
  mode: "search" | "rewrite";
  cwd: string;
  language: SupportedLanguage;
  pattern: string;
  strictness: NormalizedSearchInput["strictness"] | NormalizedEditInput["strictness"];
  selector?: string;
  globs?: readonly string[];
  rewrite?: string;
  stdin?: Buffer;
  directoryScope?: string;
}

export interface ErrorGuardRunRequest {
  mode: "error-guard";
  cwd: string;
  language: SupportedLanguage;
  stdin: Buffer;
}

export type NativeRunRequest = PatternRunRequest | ErrorGuardRunRequest;

export interface NativeRunResult {
  records: number;
}

export interface NativeExecution {
  run(request: NativeRunRequest, onRecord: (match: DecodedMatch) => Promise<void>): Promise<NativeRunResult>;
}

interface ManagedChild {
  child: ChildProcess;
  settlement: Promise<void>;
  stop: () => void;
}

class ByteTail {
  readonly #capacity: number;
  readonly #buffer: Buffer;
  #start = 0;
  #length = 0;
  totalBytes = 0;

  constructor(capacity: number) {
    this.#capacity = capacity;
    this.#buffer = Buffer.allocUnsafe(capacity);
  }

  push(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    if (chunk.length >= this.#capacity) {
      chunk.copy(this.#buffer, 0, chunk.length - this.#capacity);
      this.#start = 0;
      this.#length = this.#capacity;
      return;
    }
    const overflow = Math.max(0, this.#length + chunk.length - this.#capacity);
    if (overflow > 0) {
      this.#start = (this.#start + overflow) % this.#capacity;
      this.#length -= overflow;
    }
    const writeOffset = (this.#start + this.#length) % this.#capacity;
    const firstLength = Math.min(chunk.length, this.#capacity - writeOffset);
    chunk.copy(this.#buffer, writeOffset, 0, firstLength);
    if (firstLength < chunk.length) {
      chunk.copy(this.#buffer, 0, firstLength);
    }
    this.#length += chunk.length;
  }

  bytes(): Buffer {
    if (this.#length === 0) {
      return Buffer.alloc(0);
    }
    if (this.#start + this.#length <= this.#capacity) {
      return this.#buffer.subarray(this.#start, this.#start + this.#length);
    }
    const first = this.#buffer.subarray(this.#start);
    return Buffer.concat([first, this.#buffer.subarray(0, this.#length - first.length)], this.#length);
  }
}

function sanitizeDiagnostic(bytes: Buffer, replacements: readonly [string, string][]): string {
  let text = new TextDecoder("utf-8").decode(bytes);
  for (const [secret, label] of replacements) {
    if (secret.length > 0) {
      text = text.split(secret).join(label);
    }
  }
  text = text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200E\u200F\u061C\u202A-\u202E\u2066-\u2069\u001B]/gu, (character) => {
      const code = character.codePointAt(0)!;
      return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u{${code.toString(16)}}`;
    });
  const lines = text.split("\n");
  if (lines.length > EXPOSED_ERROR_LINES) {
    text = `[earlier diagnostic lines omitted]\n${lines.slice(-EXPOSED_ERROR_LINES).join("\n")}`;
  }
  const encoded = Buffer.from(text);
  if (encoded.length > EXPOSED_ERROR_BYTES) {
    text = `[earlier diagnostic bytes omitted]\n${new TextDecoder("utf-8").decode(encoded.subarray(encoded.length - EXPOSED_ERROR_BYTES))}`;
  }
  return text.trim();
}

function buildArguments(request: NativeRunRequest, binary: ReadyBinary, workerThreads: number): string[] {
  const args = ["run", "--config", binary.configPath];
  if (request.mode === "error-guard") {
    args.push(`--kind=ERROR`, `--lang=${request.language}`);
  } else {
    args.push(`--pattern=${request.pattern}`, `--lang=${request.language}`, `--strictness=${request.strictness}`);
    if (request.selector !== undefined) {
      args.push(`--selector=${request.selector}`);
    }
    for (const glob of request.globs ?? []) {
      args.push(`--globs=${glob}`);
    }
    if (request.mode === "rewrite") {
      args.push(`--rewrite=${request.rewrite ?? ""}`);
    }
  }
  args.push("--json=stream", "--color=never", `--threads=${workerThreads}`);
  if (request.stdin !== undefined) {
    args.push("--stdin");
  } else if (request.mode !== "error-guard" && request.directoryScope !== undefined) {
    args.push("--", request.directoryScope);
  } else {
    throw new Error("internal ast-grep request must provide stdin or an explicit directory scope.");
  }
  assertArgvBudget(binary.path, args);
  return args;
}

export class AstGrepRunner {
  readonly #scheduler: NativeScheduler;
  readonly #binary: BinaryManager;
  readonly #env: NodeJS.ProcessEnv;
  readonly #children = new Set<ManagedChild>();
  #closing = false;

  constructor(scheduler: NativeScheduler, binary: BinaryManager, env: NodeJS.ProcessEnv = process.env) {
    this.#scheduler = scheduler;
    this.#binary = binary;
    this.#env = env;
  }

  get activeChildren(): number {
    return this.#children.size;
  }

  async withSession<T>(record: OperationRecord, work: (execution: NativeExecution) => Promise<T>): Promise<T> {
    throwIfCancelledOrExpired(record);
    if (this.#closing) {
      throw new Error("ast-grep runner is shutting down.");
    }
    const ready = await this.#binary.ready(record);
    throwIfCancelledOrExpired(record);
    const permit = await this.#scheduler.acquire(record);
    try {
      throwIfCancelledOrExpired(record);
      const execution: NativeExecution = {
        run: (request, onRecord) => this.#runChild(ready, request, record, onRecord),
      };
      return await work(execution);
    } finally {
      permit.release();
    }
  }

  async shutdown(): Promise<void> {
    if (!this.#closing) {
      this.#closing = true;
      this.#scheduler.close();
    }
    const children = [...this.#children];
    for (const managed of children) {
      managed.stop();
    }
    await Promise.allSettled([
      this.#binary.shutdown(),
      ...children.map((managed) => managed.settlement),
    ]);
  }

  async #runChild(
    binary: ReadyBinary,
    request: NativeRunRequest,
    record: OperationRecord,
    onRecord: (match: DecodedMatch) => Promise<void>,
  ): Promise<NativeRunResult> {
    throwIfCancelledOrExpired(record);
    await this.#binary.revalidate(binary, record);
    throwIfCancelledOrExpired(record);
    const args = buildArguments(request, binary, this.#scheduler.workerThreads);
    const env = buildBoundedEnv(this.#env);
    throwIfCancelledOrExpired(record);

    const child = spawn(binary.path, args, {
      cwd: request.cwd,
      shell: false,
      stdio: [request.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env,
    });
    if (child.stdout === null || child.stderr === null) {
      child.kill("SIGTERM");
      throw new Error("ast-grep child did not expose its required output pipes.");
    }

    let stopped = false;
    let closeObserved = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const stop = () => {
      if (stopped || closeObserved) {
        return;
      }
      stopped = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (!closeObserved) {
          child.kill("SIGKILL");
        }
      }, FORCE_KILL_DELAY_MS);
      forceKillTimer.unref();
    };
    let settleManaged!: () => void;
    const settlement = new Promise<void>((resolveSettlement) => {
      settleManaged = resolveSettlement;
    });
    const managed: ManagedChild = { child, settlement, stop };
    this.#children.add(managed);

    const stderrTail = new ByteTail(STDERR_TAIL_BYTES);
    let spawnError: Error | undefined;
    let stdoutError: Error | undefined;
    let stderrError: Error | undefined;
    let stdinError: NodeJS.ErrnoException | undefined;
    let consumerError: Error | undefined;
    let records = 0;

    child.once("error", (error) => {
      spawnError = error;
    });
    const onAbort = () => stop();
    record.controller.signal.addEventListener("abort", onAbort, { once: true });

    const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose) => {
      child.once("close", (code, signal) => {
        closeObserved = true;
        if (forceKillTimer !== undefined) {
          clearTimeout(forceKillTimer);
          forceKillTimer = undefined;
        }
        resolveClose({ code, signal });
      });
    });

    const stderrPromise = (async () => {
      try {
        for await (const raw of child.stderr!) {
          stderrTail.push(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
        }
      } catch (error) {
        stderrError = error instanceof Error ? error : new Error(String(error));
        stop();
      }
    })();

    const stdoutPromise = (async () => {
      const lineBuffer = Buffer.allocUnsafe(MAX_NDJSON_LINE_BYTES);
      let pendingBytes = 0;
      const consumeLine = async (): Promise<void> => {
        let line = lineBuffer.subarray(0, pendingBytes);
        pendingBytes = 0;
        if (line.length > 0 && line[line.length - 1] === 0x0d) {
          line = line.subarray(0, line.length - 1);
        }
        if (line.length === 0) {
          throw new Error("incompatible/corrupt ast-grep output: empty NDJSON line.");
        }
        let parsed: unknown;
        try {
          const json = new TextDecoder("utf-8", { fatal: true }).decode(line);
          parsed = JSON.parse(json) as unknown;
        } catch {
          throw new Error("incompatible/corrupt ast-grep output: malformed UTF-8 JSON record.");
        }
        const match = decodeMatch(parsed, request.mode as RunnerMode, request.language);
        records += 1;
        await onRecord(match);
        throwIfCancelledOrExpired(record);
      };

      try {
        for await (const raw of child.stdout!) {
          if (consumerError !== undefined) {
            continue;
          }
          try {
            throwIfCancelledOrExpired(record);
            const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
            let start = 0;
            for (let index = 0; index < chunk.length; index += 1) {
              if (chunk[index] !== 0x0a) {
                continue;
              }
              const segment = chunk.subarray(start, index);
              if (pendingBytes + segment.length > MAX_NDJSON_LINE_BYTES) {
                throw new Error(`incompatible/corrupt ast-grep output: NDJSON line exceeds ${MAX_NDJSON_LINE_BYTES} bytes.`);
              }
              segment.copy(lineBuffer, pendingBytes);
              pendingBytes += segment.length;
              await consumeLine();
              start = index + 1;
            }
            if (start < chunk.length) {
              const remainder = chunk.subarray(start);
              if (pendingBytes + remainder.length > MAX_NDJSON_LINE_BYTES) {
                throw new Error(`incompatible/corrupt ast-grep output: NDJSON line exceeds ${MAX_NDJSON_LINE_BYTES} bytes.`);
              }
              remainder.copy(lineBuffer, pendingBytes);
              pendingBytes += remainder.length;
            }
          } catch (error) {
            consumerError = error instanceof Error ? error : new Error(String(error));
            pendingBytes = 0;
            stop();
          }
        }
        if (consumerError === undefined && pendingBytes > 0) {
          try {
            await consumeLine();
          } catch (error) {
            consumerError = error instanceof Error ? error : new Error(String(error));
            stop();
          }
        }
      } catch (error) {
        stdoutError = error instanceof Error ? error : new Error(String(error));
        stop();
      }
    })();

    const stdinPromise = request.stdin === undefined || child.stdin === null
      ? Promise.resolve()
      : pipeline(Readable.from([request.stdin]), child.stdin).catch((error: NodeJS.ErrnoException) => {
          stdinError = error;
        });

    const [closeResult] = await Promise.all([
      closePromise,
      stdoutPromise,
      stderrPromise,
      stdinPromise,
    ]);
    record.controller.signal.removeEventListener("abort", onAbort);
    this.#children.delete(managed);
    settleManaged();

    throwIfCancelledOrExpired(record);
    if (consumerError !== undefined) {
      throw consumerError;
    }
    if (spawnError !== undefined) {
      const code = (spawnError as NodeJS.ErrnoException).code ?? "unknown";
      throw new Error(`failed to start installed ast-grep binary (${code}).`);
    }
    if (stdoutError !== undefined || stderrError !== undefined) {
      throw new Error("ast-grep output pipe failed before the child settled.");
    }
    if (stdinError !== undefined && stdinError.code !== "EPIPE") {
      throw new Error(`failed to stream the bounded source snapshot to ast-grep (${stdinError.code ?? "unknown"}).`);
    }

    const diagnostic = sanitizeDiagnostic(stderrTail.bytes(), [
      [binary.path, "<ast-grep-binary>"],
      [binary.configPath, "<ast-grep-config>"],
      [request.cwd, "<workspace>"],
    ]);
    if (closeResult.code === 0 && closeResult.signal === null && records > 0 && stdinError === undefined) {
      return { records };
    }
    if (closeResult.code === 1 && closeResult.signal === null && records === 0 && stdinError === undefined) {
      return { records: 0 };
    }
    if ((closeResult.code === 0 && records === 0) || (closeResult.code === 1 && records > 0)) {
      throw new Error("incompatible/corrupt ast-grep output: exit status and record count disagree.");
    }
    if (closeResult.signal !== null) {
      throw new Error(`ast-grep child exited from signal ${closeResult.signal}${diagnostic ? `: ${diagnostic}` : "."}`);
    }
    throw new Error(`ast-grep query failed with exit code ${closeResult.code ?? "unknown"}${diagnostic ? `: ${diagnostic}` : "."}`);
  }
}
