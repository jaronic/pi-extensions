import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { constants, type BigIntStats } from "node:fs";
import type { NativeScheduler } from "./scheduler.ts";
import {
  createInternalOperation,
  markTerminalCause,
  terminalError,
  throwIfCancelledOrExpired,
  type OperationRecord,
} from "./operations.ts";
import { AST_GREP_VERSION } from "./types.ts";

const CONFIG_BYTES = Buffer.from("ruleDirs: []", "ascii");
const CONFIG_SHA256 = createHash("sha256").update(CONFIG_BYTES).digest("hex");
const VERSION_TIMEOUT_MS = 2000;
const VERSION_FORCE_KILL_MS = 1000;
const VERSION_OUTPUT_BYTES = 4096;
const ARG_BUDGET = 24 * 1024;
const ENV_VALUE_BUDGET = 4 * 1024;
const ENV_BLOCK_BUDGET = 16 * 1024;
const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "XDG_CONFIG_HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "SYSTEMROOT",
  "WINDIR",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
] as const;

interface NativeIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mode: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

export interface ReadyBinary {
  path: string;
  version: typeof AST_GREP_VERSION;
  identity: NativeIdentity;
  configPath: string;
  configIdentity: NativeIdentity;
  configSha256: string;
}

export interface BinaryResolverOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
  resolvePackage?: (specifier: string) => string;
  report?: typeof process.report;
  extensionRoot?: string;
  versionTimeoutMs?: number;
  versionForceKillMs?: number;
}

function identityFrom(stats: BigIntStats): NativeIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mode: stats.mode,
    mtimeNs: stats.mtimeNs,
    ctimeNs: stats.ctimeNs,
  };
}

function identitiesEqual(left: NativeIdentity, right: NativeIdentity): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mode === right.mode
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

interface CanonicalConfig {
  identity: NativeIdentity;
  bytes: Buffer;
}

async function readCanonicalConfig(path: string, expectedIdentity?: NativeIdentity): Promise<CanonicalConfig> {
  const pathStats = await lstat(path, { bigint: true });
  const pathIdentity = identityFrom(pathStats);
  if (!pathStats.isFile() || pathStats.isSymbolicLink()
    || pathStats.size !== BigInt(CONFIG_BYTES.length)
    || (expectedIdentity !== undefined && !identitiesEqual(pathIdentity, expectedIdentity))) {
    throw new Error("the package-owned ast-grep configuration is not the expected canonical 12-byte file.");
  }

  const flags = process.platform === "win32" || typeof constants.O_NOFOLLOW !== "number"
    ? constants.O_RDONLY
    : constants.O_RDONLY | constants.O_NOFOLLOW;
  const handle = await open(path, flags);
  try {
    const before = await handle.stat({ bigint: true });
    const beforeIdentity = identityFrom(before);
    if (!before.isFile() || !identitiesEqual(beforeIdentity, pathIdentity)) {
      throw new Error("the package-owned ast-grep configuration changed before its bounded read.");
    }

    const buffer = Buffer.alloc(CONFIG_BYTES.length + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (offset !== CONFIG_BYTES.length
      || !identitiesEqual(identityFrom(after), beforeIdentity)
      || !buffer.subarray(0, offset).equals(CONFIG_BYTES)) {
      throw new Error("the package-owned ast-grep configuration does not contain the canonical 12 bytes 'ruleDirs: []'.");
    }
    return { identity: beforeIdentity, bytes: buffer.subarray(0, offset) };
  } finally {
    await handle.close();
  }
}

function assertContained(root: string, candidate: string, label: string): void {
  const relation = relative(root, candidate);
  if (relation === "" || relation === ".") {
    throw new Error(`${label} unexpectedly resolves to its package root.`);
  }
  if (relation === ".." || relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || resolve(root, relation) !== candidate) {
    throw new Error(`${label} resolves outside its package root.`);
  }
}

export function platformPackage(
  platform: NodeJS.Platform,
  arch: string,
  report: typeof process.report | undefined = process.report,
): string {
  if (platform === "darwin" && arch === "arm64") {
    return "@ast-grep/cli-darwin-arm64";
  }
  if (platform === "darwin" && arch === "x64") {
    return "@ast-grep/cli-darwin-x64";
  }
  if (platform === "win32" && arch === "x64") {
    return "@ast-grep/cli-win32-x64-msvc";
  }
  if (platform === "linux" && (arch === "arm64" || arch === "x64")) {
    const reportValue = report?.getReport();
    const header = typeof reportValue === "object" && reportValue !== null && "header" in reportValue
      ? reportValue.header as Record<string, unknown>
      : undefined;
    if (typeof header?.glibcVersionRuntime !== "string" || header.glibcVersionRuntime.length === 0) {
      throw new Error(`ast-grep does not support unverified Linux libc on ${arch}; glibc is required.`);
    }
    return arch === "arm64" ? "@ast-grep/cli-linux-arm64-gnu" : "@ast-grep/cli-linux-x64-gnu";
  }
  throw new Error(`ast-grep is unsupported on ${platform}/${arch}; supported tuples are darwin arm64/x64, glibc Linux arm64/x64, and win32 x64.`);
}

export function buildBoundedEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { NO_COLOR: "1" };
  let utf8Size = Buffer.byteLength("NO_COLOR=1\0");
  let utf16Size = "NO_COLOR=1\0".length;
  for (const key of ENV_KEYS) {
    const value = source[key];
    if (value === undefined) {
      continue;
    }
    if (!value.isWellFormed() || value.includes("\0")) {
      throw new Error(`environment variable ${key} is not safe to pass to ast-grep.`);
    }
    const valueUtf8 = Buffer.byteLength(value);
    if (valueUtf8 > ENV_VALUE_BUDGET || value.length > ENV_VALUE_BUDGET) {
      throw new Error(`environment variable ${key} exceeds the ${ENV_VALUE_BUDGET}-unit limit.`);
    }
    const entry = `${key}=${value}\0`;
    utf8Size += Buffer.byteLength(entry);
    utf16Size += entry.length;
    if (utf8Size > ENV_BLOCK_BUDGET || utf16Size > ENV_BLOCK_BUDGET) {
      throw new Error(`ast-grep environment exceeds the ${ENV_BLOCK_BUDGET}-unit aggregate limit.`);
    }
    result[key] = value;
  }
  return result;
}

export function assertArgvBudget(binary: string, args: readonly string[]): void {
  let utf8Size = Buffer.byteLength(binary) + 1;
  let conservativeUtf16 = 2 * binary.length + 2;
  for (const argument of args) {
    if (!argument.isWellFormed() || argument.includes("\0")) {
      throw new Error("constructed ast-grep arguments contain invalid Unicode or NUL.");
    }
    utf8Size += Buffer.byteLength(argument) + 1;
    conservativeUtf16 += 2 * argument.length + 2;
  }
  if (utf8Size > ARG_BUDGET || conservativeUtf16 > ARG_BUDGET) {
    throw new Error(`constructed ast-grep command exceeds the ${ARG_BUDGET}-unit safety budget.`);
  }
}

export class BinaryManager {
  readonly #scheduler: NativeScheduler;
  readonly #platform: NodeJS.Platform;
  readonly #arch: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #resolvePackage: (specifier: string) => string;
  readonly #report: typeof process.report | undefined;
  readonly #extensionRoot: string;
  readonly #versionTimeoutMs: number;
  readonly #versionForceKillMs: number;
  #startup?: Promise<ReadyBinary>;
  #startupRecord?: OperationRecord;
  #versionChild?: ChildProcess;
  #closing = false;

  constructor(scheduler: NativeScheduler, options: BinaryResolverOptions = {}) {
    this.#scheduler = scheduler;
    this.#platform = options.platform ?? process.platform;
    this.#arch = options.arch ?? process.arch;
    this.#env = options.env ?? process.env;
    this.#resolvePackage = options.resolvePackage ?? createRequire(import.meta.url).resolve;
    this.#report = options.report ?? process.report;
    this.#extensionRoot = options.extensionRoot ?? fileURLToPath(new URL("..", import.meta.url));
    this.#versionTimeoutMs = options.versionTimeoutMs ?? VERSION_TIMEOUT_MS;
    this.#versionForceKillMs = options.versionForceKillMs ?? VERSION_FORCE_KILL_MS;
    if (!Number.isSafeInteger(this.#versionTimeoutMs) || this.#versionTimeoutMs <= 0
      || !Number.isSafeInteger(this.#versionForceKillMs) || this.#versionForceKillMs <= 0) {
      throw new Error("ast-grep version timeout and force-kill delay must be positive safe integers.");
    }
  }

  async ready(record: OperationRecord): Promise<ReadyBinary> {
    throwIfCancelledOrExpired(record);
    if (this.#closing) {
      throw new Error("ast-grep binary manager is shutting down.");
    }
    if (this.#startup === undefined) {
      const startup = this.#startHandshake();
      this.#startup = startup;
      void startup.catch(() => {
        if (this.#startup === startup) {
          this.#startup = undefined;
        }
      });
    }
    return this.#waitForCaller(this.#startup, record);
  }

  async revalidate(binary: ReadyBinary, record: OperationRecord): Promise<void> {
    throwIfCancelledOrExpired(record);
    const [binaryStats, config] = await Promise.all([
      lstat(binary.path, { bigint: true }),
      readCanonicalConfig(binary.configPath, binary.configIdentity),
    ]);
    throwIfCancelledOrExpired(record);
    if (!binaryStats.isFile() || binaryStats.isSymbolicLink() || !identitiesEqual(identityFrom(binaryStats), binary.identity)) {
      throw new Error("installed ast-grep binary changed after its version handshake; retry after reinstalling dependencies.");
    }
    const configHash = createHash("sha256").update(config.bytes).digest("hex");
    if (configHash !== binary.configSha256) {
      throw new Error("the package-owned ast-grep empty configuration changed; reinstall this extension before retrying.");
    }
  }

  async shutdown(): Promise<void> {
    this.#closing = true;
    if (this.#startupRecord !== undefined) {
      markTerminalCause(this.#startupRecord, "shutdown");
    }
    this.#versionChild?.kill("SIGTERM");
    await this.#startup?.catch(() => undefined);
  }

  async #startHandshake(): Promise<ReadyBinary> {
    const startupRecord = createInternalOperation(this.#versionTimeoutMs);
    this.#startupRecord = startupRecord;
    const permit = await this.#scheduler.acquire(startupRecord);
    try {
      throwIfCancelledOrExpired(startupRecord);
      const packageName = platformPackage(this.#platform, this.#arch, this.#report);
      let packageJson: string;
      try {
        packageJson = this.#resolvePackage(`${packageName}/package.json`);
      } catch {
        throw new Error(`ast-grep native package ${packageName}@${AST_GREP_VERSION} is missing; reinstall without --omit=optional.`);
      }
      const packageRoot = await realpath(dirname(packageJson));
      const binaryCandidate = resolve(packageRoot, this.#platform === "win32" ? "ast-grep.exe" : "ast-grep");
      const binaryPath = await realpath(binaryCandidate);
      assertContained(packageRoot, binaryPath, "ast-grep binary");

      const extensionRoot = await realpath(this.#extensionRoot);
      const configCandidate = resolve(extensionRoot, "assets", "empty-sgconfig.yml");
      const configPath = await realpath(configCandidate);
      assertContained(extensionRoot, configPath, "ast-grep configuration");

      const [binaryStats, config] = await Promise.all([
        lstat(binaryCandidate, { bigint: true }),
        readCanonicalConfig(configCandidate),
      ]);
      throwIfCancelledOrExpired(startupRecord);
      if (!binaryStats.isFile() || binaryStats.isSymbolicLink() || binaryPath !== binaryCandidate) {
        throw new Error("installed ast-grep executable must be a regular non-symlink file inside its platform package.");
      }
      if (this.#platform !== "win32" && (binaryStats.mode & 0o111n) === 0n) {
        throw new Error("installed ast-grep executable is not marked executable.");
      }
      if (configPath !== configCandidate) {
        throw new Error("package-owned ast-grep configuration must be a regular non-symlink file inside the extension package.");
      }
      const configSha256 = createHash("sha256").update(config.bytes).digest("hex");
      if (configSha256 !== CONFIG_SHA256) {
        throw new Error("package-owned ast-grep configuration hash does not match the release contract.");
      }

      const identity = identityFrom(binaryStats);
      const configIdentity = config.identity;
      const version = await this.#runVersion(binaryPath, configPath, startupRecord);
      throwIfCancelledOrExpired(startupRecord);
      return {
        path: binaryPath,
        version,
        identity,
        configPath,
        configIdentity,
        configSha256,
      };
    } finally {
      clearTimeout(startupRecord.timer);
      permit.release();
      if (this.#startupRecord === startupRecord) {
        this.#startupRecord = undefined;
      }
    }
  }

  async #runVersion(binary: string, configPath: string, record: OperationRecord): Promise<typeof AST_GREP_VERSION> {
    const args = ["--config", configPath, "--version"];
    assertArgvBudget(binary, args);
    const child = spawn(binary, args, {
      cwd: this.#extensionRoot,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildBoundedEnv(this.#env),
    });
    this.#versionChild = child;
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let stdoutOverflow = false;
    let stderrOverflow = false;
    let spawnError: Error | undefined;
    let stdoutError: Error | undefined;
    let stderrError: Error | undefined;
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
      }, this.#versionForceKillMs);
      forceKillTimer.unref();
    };
    const capture = (current: Buffer, chunk: Buffer): Buffer => {
      const remaining = VERSION_OUTPUT_BYTES + 1 - current.length;
      return remaining <= 0 ? current : Buffer.concat([current, chunk.subarray(0, remaining)]);
    };
    const onAbort = () => stop();
    record.controller.signal.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.stdout.once("error", (error) => {
      stdoutError = error;
      stop();
    });
    child.stderr.once("error", (error) => {
      stderrError = error;
      stop();
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = capture(stdout, chunk);
      if (stdout.length > VERSION_OUTPUT_BYTES) {
        stdoutOverflow = true;
        stop();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = capture(stderr, chunk);
      if (stderr.length > VERSION_OUTPUT_BYTES) {
        stderrOverflow = true;
        stop();
      }
    });
    const closeResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose) => {
      child.once("close", (code, signal) => {
        closeObserved = true;
        if (forceKillTimer !== undefined) {
          clearTimeout(forceKillTimer);
          forceKillTimer = undefined;
        }
        resolveClose({ code, signal });
      });
    });
    record.controller.signal.removeEventListener("abort", onAbort);
    if (this.#versionChild === child) {
      this.#versionChild = undefined;
    }
    throwIfCancelledOrExpired(record);
    if (spawnError !== undefined) {
      const code = (spawnError as NodeJS.ErrnoException).code ?? "unknown";
      throw new Error(`failed to start the installed ast-grep binary (${code}).`);
    }
    if (stdoutError !== undefined || stderrError !== undefined) {
      throw new Error("installed ast-grep version output pipe failed before the child settled.");
    }
    if (stdoutOverflow || stderrOverflow || closeResult.code !== 0 || closeResult.signal !== null) {
      throw new Error("installed ast-grep binary failed its bounded version handshake.");
    }
    let output: string;
    try {
      output = new TextDecoder("utf-8", { fatal: true }).decode(stdout);
    } catch {
      throw new Error("installed ast-grep version output is not valid UTF-8.");
    }
    if (!/^ast-grep 0\.45\.0\r?\n?$/u.test(output) || stderr.length !== 0) {
      throw new Error(`installed ast-grep version is incompatible; expected exactly ${AST_GREP_VERSION}.`);
    }
    return AST_GREP_VERSION;
  }

  async #waitForCaller(promise: Promise<ReadyBinary>, record: OperationRecord): Promise<ReadyBinary> {
    const interrupted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(terminalError(record));
      record.controller.signal.addEventListener("abort", onAbort, { once: true });
      void promise.finally(() => record.controller.signal.removeEventListener("abort", onAbort)).catch(() => undefined);
    });
    const ready = await Promise.race([promise, interrupted]);
    throwIfCancelledOrExpired(record);
    return ready;
  }
}
