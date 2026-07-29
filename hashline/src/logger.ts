import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// Opt-in troubleshooting log. This module is duplicated byte-for-byte across
// extensions (same precedent as workflow-mode.ts) so each package stays free of
// cross-package production imports; keep the copies in sync when this contract
// changes. Logging never participates in any tool contract: it is best-effort,
// bounded, and any failure is swallowed so it can never break the tool path.

export type LogLevel = "error" | "warn" | "info" | "debug";

// Ordered so a configured threshold admits every equal or more severe level.
const LEVEL_ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

// Rotate before the active file can grow without bound, mirroring the "output
// has limits" rule the rest of the codebase follows. One backup generation is
// kept so a crash loop cannot fill the disk.
const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface Logger {
  error(event: string, context?: Record<string, unknown>): void;
  warn(event: string, context?: Record<string, unknown>): void;
  info(event: string, context?: Record<string, unknown>): void;
  debug(event: string, context?: Record<string, unknown>): void;
}

const NOOP: Logger = { error() {}, warn() {}, info() {}, debug() {} };

// Logging is off by default so an ordinary session performs no disk writes. The
// level comes from the extension's own global Pi config file,
// getAgentDir()/<extension>.json, via its top-level "logLevel" key; anything
// else (missing file, malformed JSON, absent or unknown value) keeps logging
// off. The file is read once when the extension loads; /reload re-reads it.
function resolveLevel(extension: string): LogLevel | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(getAgentDir(), `${extension}.json`), "utf8"));
  } catch {
    // Missing or unreadable config simply means logging stays off.
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const raw = (parsed as Record<string, unknown>).logLevel;
  if (raw === "error" || raw === "warn" || raw === "info" || raw === "debug") return raw;
  return undefined;
}

export function createLogger(extension: string): Logger {
  const threshold = resolveLevel(extension);
  if (threshold === undefined) return NOOP;
  let file: string;
  try {
    const directory = join(getAgentDir(), "logs");
    mkdirSync(directory, { recursive: true });
    file = join(directory, `${extension}.log`);
  } catch {
    // Cannot prepare a log directory; degrade to a no-op rather than fail.
    return NOOP;
  }
  const thresholdRank = LEVEL_ORDER[threshold];
  const target = file;

  const write = (level: LogLevel, event: string, context?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[level] > thresholdRank) return;
    try {
      rotateIfNeeded(target);
      appendFileSync(target, formatLine(extension, level, event, context));
    } catch {
      // Troubleshooting logs are advisory; never surface a write error.
    }
  };

  return {
    error: (event, context) => write("error", event, context),
    warn: (event, context) => write("warn", event, context),
    info: (event, context) => write("info", event, context),
    debug: (event, context) => write("debug", event, context),
  };
}

function rotateIfNeeded(file: string): void {
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    return; // No file yet, or stat failed; the append below will create it.
  }
  if (size < MAX_LOG_BYTES) return;
  try {
    renameSync(file, `${file}.1`); // Keep exactly one previous generation.
  } catch {
    // If rotation fails, keep appending rather than drop the new entry.
  }
}

function formatLine(
  extension: string,
  level: LogLevel,
  event: string,
  context?: Record<string, unknown>,
): string {
  const record = {
    ts: new Date().toISOString(),
    level,
    ext: extension,
    event,
    ...(context ? { context } : {}),
  };
  let serialized: string;
  try {
    serialized = JSON.stringify(record, replacer);
  } catch {
    // Any residual serialization hazard still yields a usable, greppable line.
    serialized = JSON.stringify({ ts: record.ts, level, ext: extension, event, context: "<unserializable>" });
  }
  // One JSON object per line keeps the log greppable and machine-parseable.
  return `${serialized}\n`;
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitize(value.message),
      ...(value.stack ? { stack: sanitize(value.stack) } : {}),
    };
  }
  if (typeof value === "string") return sanitize(value);
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return `<Buffer ${value.length} bytes>`;
  return value;
}

// Neutralize C1 controls and DEL so opening the log in a terminal or editor
// cannot execute escape sequences (JSON already escapes C0). This mirrors the
// terminal-control hygiene applied at other external display boundaries.
function sanitize(value: string): string {
  return value.replace(/[\u007F-\u009F]/g, "\uFFFD");
}
