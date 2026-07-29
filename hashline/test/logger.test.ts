import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLogger } from "../src/logger.ts";

// getAgentDir() resolves logs under this directory in the test environment.
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const LOG_ENV = "PI_HASHLINE_LOG";

interface EnvOverrides {
  [key: string]: string | undefined;
}

async function withAgentDir(
  overrides: EnvOverrides,
  fn: (logFile: string) => Promise<void> | void,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-hashline-log-"));
  const saved: EnvOverrides = {};
  const applied = { [AGENT_DIR_ENV]: dir, PI_EXT_LOG: undefined, [LOG_ENV]: undefined, ...overrides };
  for (const [key, value] of Object.entries(applied)) {
    saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn(join(dir, "logs", "hashline.log"));
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function readLines(logFile: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(logFile, "utf8");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("logging is off by default and writes nothing", async () => {
  await withAgentDir({}, async (logFile) => {
    const logger = createLogger("hashline", LOG_ENV);
    logger.error("boom", { detail: 1 });
    await assert.rejects(stat(logFile), "no log file should be created when disabled");
  });
});

test("an enabled logger writes a structured JSON line", async () => {
  await withAgentDir({ [LOG_ENV]: "error" }, async (logFile) => {
    const logger = createLogger("hashline", LOG_ENV);
    logger.error("edit_failed", { code: "E_WRITE_FAILED", path: "a.ts" });
    const [entry] = await readLines(logFile);
    assert.equal(entry.level, "error");
    assert.equal(entry.ext, "hashline");
    assert.equal(entry.event, "edit_failed");
    assert.deepEqual(entry.context, { code: "E_WRITE_FAILED", path: "a.ts" });
    assert.equal(typeof entry.ts, "string");
  });
});

test("the threshold filters lower-severity levels", async () => {
  await withAgentDir({ [LOG_ENV]: "error" }, async (logFile) => {
    const logger = createLogger("hashline", LOG_ENV);
    logger.debug("noise");
    logger.warn("noise");
    logger.error("kept");
    const lines = await readLines(logFile);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, "kept");
  });
});

test("debug threshold admits every level", async () => {
  await withAgentDir({ [LOG_ENV]: "debug" }, async (logFile) => {
    const logger = createLogger("hashline", LOG_ENV);
    logger.debug("d");
    logger.error("e");
    const lines = await readLines(logFile);
    assert.deepEqual(lines.map((line) => line.event), ["d", "e"]);
  });
});

test("truthy switch values mean the error level", async () => {
  await withAgentDir({ [LOG_ENV]: "1" }, async (logFile) => {
    const logger = createLogger("hashline", LOG_ENV);
    logger.debug("skip");
    logger.error("kept");
    const lines = await readLines(logFile);
    assert.deepEqual(lines.map((line) => line.event), ["kept"]);
  });
});

test("the per-extension variable overrides the shared PI_EXT_LOG", async () => {
  await withAgentDir({ PI_EXT_LOG: "off", [LOG_ENV]: "debug" }, async (logFile) => {
    const logger = createLogger("hashline", LOG_ENV);
    logger.debug("kept");
    const lines = await readLines(logFile);
    assert.equal(lines.length, 1);
  });
});

test("Error context is serialized with message and stack", async () => {
  await withAgentDir({ [LOG_ENV]: "error" }, async (logFile) => {
    const logger = createLogger("hashline", LOG_ENV);
    logger.error("edit_failed", { error: new Error("kaboom") });
    const [entry] = await readLines(logFile);
    const context = entry.context as Record<string, Record<string, unknown>>;
    assert.equal(context.error.name, "Error");
    assert.equal(context.error.message, "kaboom");
    assert.equal(typeof context.error.stack, "string");
  });
});

test("C1 control characters are neutralized in logged strings", async () => {
  await withAgentDir({ [LOG_ENV]: "error" }, async (logFile) => {
    const logger = createLogger("hashline", LOG_ENV);
    logger.error("evt", { note: "before\u009Bafter" });
    const [entry] = await readLines(logFile);
    const context = entry.context as Record<string, unknown>;
    assert.equal(context.note, "before\uFFFDafter");
  });
});

test("the log rotates to .log.1 once it exceeds the size cap", async () => {
  await withAgentDir({ [LOG_ENV]: "error" }, async (logFile) => {
    // Creating the logger first ensures the logs/ directory exists, then a
    // pre-filled file forces the size-cap branch on the next append.
    const logger = createLogger("hashline", LOG_ENV);
    await writeFile(logFile, "x".repeat(5 * 1024 * 1024 + 1));
    logger.error("after_rotate");
    const rotated = await stat(`${logFile}.1`);
    assert.ok(rotated.size > 5 * 1024 * 1024, "old content moved to backup");
    const lines = await readLines(logFile);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, "after_rotate");
  });
});

test("a log directory that cannot be created degrades to a no-op", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-hashline-log-"));
  const blocker = join(dir, "blocker");
  await writeFile(blocker, "not a directory");
  const savedAgent = process.env[AGENT_DIR_ENV];
  const savedLog = process.env[LOG_ENV];
  const savedShared = process.env.PI_EXT_LOG;
  // Point the agent dir at a regular file so join(file, "logs") cannot mkdir.
  process.env[AGENT_DIR_ENV] = blocker;
  process.env[LOG_ENV] = "error";
  delete process.env.PI_EXT_LOG;
  try {
    const logger = createLogger("hashline", LOG_ENV);
    assert.doesNotThrow(() => logger.error("swallowed"));
  } finally {
    if (savedAgent === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = savedAgent;
    if (savedLog === undefined) delete process.env[LOG_ENV];
    else process.env[LOG_ENV] = savedLog;
    if (savedShared === undefined) delete process.env.PI_EXT_LOG;
    else process.env.PI_EXT_LOG = savedShared;
    await rm(dir, { recursive: true, force: true });
  }
});
