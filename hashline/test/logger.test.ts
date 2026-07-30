import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createLogger } from "../src/logger.ts";

// getAgentDir() resolves the hashline.json config and logs/ under this directory.
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const LOG_ENV_VARS = ["PI_HASHLINE_LOG", "PI_EXT_LOG"] as const;

async function withAgentDir(
  config: string | undefined,
  fn: (logFile: string) => Promise<void> | void,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-hashline-log-"));
  const saved = process.env[AGENT_DIR_ENV];
  const savedLogEnv = LOG_ENV_VARS.map((name) => [name, process.env[name]] as const);
  process.env[AGENT_DIR_ENV] = dir;
  for (const name of LOG_ENV_VARS) delete process.env[name];
  try {
    if (config !== undefined) await writeFile(join(dir, "hashline.json"), config);
    await fn(join(dir, "logs", "hashline.log"));
  } finally {
    if (saved === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = saved;
    for (const [name, value] of savedLogEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

async function readLines(logFile: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(logFile, "utf8");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("logging is on at the error threshold by default", async () => {
  await withAgentDir(undefined, async (logFile) => {
    const logger = createLogger("hashline");
    logger.debug("skipped");
    logger.error("boom", { detail: 1 });
    const lines = await readLines(logFile);
    assert.deepEqual(lines.map((line) => line.event), ["boom"]);
  });
});

test("logEnabled false turns logging off", async () => {
  await withAgentDir(JSON.stringify({ logEnabled: false, logLevel: "debug" }), async (logFile) => {
    const logger = createLogger("hashline");
    logger.error("boom");
    await assert.rejects(stat(logFile), "no log file should be created when disabled");
  });
});

test("a config without logging keys keeps the error default", async () => {
  await withAgentDir(JSON.stringify({ maxResults: 25 }), async (logFile) => {
    const logger = createLogger("hashline");
    logger.warn("skipped");
    logger.error("kept");
    const lines = await readLines(logFile);
    assert.deepEqual(lines.map((line) => line.event), ["kept"]);
  });
});

test("an unknown logLevel value falls back to error", async () => {
  await withAgentDir(JSON.stringify({ logLevel: "verbose" }), async (logFile) => {
    const logger = createLogger("hashline");
    logger.warn("skipped");
    logger.error("kept");
    const lines = await readLines(logFile);
    assert.deepEqual(lines.map((line) => line.event), ["kept"]);
  });
});

test("a malformed config file keeps the error default", async () => {
  await withAgentDir("{", async (logFile) => {
    const logger = createLogger("hashline");
    logger.error("kept");
    const lines = await readLines(logFile);
    assert.deepEqual(lines.map((line) => line.event), ["kept"]);
  });
});

test("an enabled logger writes a structured JSON line", async () => {
  await withAgentDir(JSON.stringify({ logLevel: "error" }), async (logFile) => {
    const logger = createLogger("hashline");
    logger.error("edit_failed", { code: "E_WRITE_FAILED", path: "a.ts" });
    const [entry] = await readLines(logFile);
    assert.equal(entry.level, "error");
    assert.equal(entry.ext, "hashline");
    assert.equal(entry.event, "edit_failed");
    assert.deepEqual(entry.context, { code: "E_WRITE_FAILED", path: "a.ts" });
    assert.equal(typeof entry.ts, "string");
  });
});

test("PI_HASHLINE_LOG sets the threshold without any config file", async () => {
  await withAgentDir(undefined, async (logFile) => {
    process.env.PI_HASHLINE_LOG = "info";
    const logger = createLogger("hashline");
    logger.debug("skipped");
    logger.info("kept");
    const lines = await readLines(logFile);
    assert.deepEqual(lines.map((line) => line.event), ["kept"]);
    assert.equal(lines[0]?.level, "info");
  });
});

test("PI_HASHLINE_LOG=debug admits the lowest-severity events", async () => {
  await withAgentDir(undefined, async (logFile) => {
    process.env.PI_HASHLINE_LOG = "debug";
    const logger = createLogger("hashline");
    logger.debug("d");
    logger.error("e");
    const lines = await readLines(logFile);
    assert.deepEqual(lines.map((line) => line.event), ["d", "e"]);
  });
});

test("a truthy non-level PI_HASHLINE_LOG value selects the debug threshold", async () => {
  await withAgentDir(undefined, async (logFile) => {
    process.env.PI_HASHLINE_LOG = "1";
    const logger = createLogger("hashline");
    logger.debug("kept");
    const lines = await readLines(logFile);
    assert.deepEqual(lines.map((line) => line.event), ["kept"]);
  });
});

test("PI_HASHLINE_LOG=off disables logging even when the config enables it", async () => {
  await withAgentDir(JSON.stringify({ logLevel: "debug" }), async (logFile) => {
    process.env.PI_HASHLINE_LOG = "off";
    const logger = createLogger("hashline");
    logger.error("boom");
    await assert.rejects(stat(logFile), "env off must win over the config file");
  });
});

test("PI_HASHLINE_LOG=debug wins over logEnabled:false in the config", async () => {
  await withAgentDir(JSON.stringify({ logEnabled: false }), async (logFile) => {
    process.env.PI_HASHLINE_LOG = "debug";
    const logger = createLogger("hashline");
    logger.debug("kept");
    const lines = await readLines(logFile);
    assert.deepEqual(lines.map((line) => line.event), ["kept"]);
  });
});

test("PI_EXT_LOG is the shared fallback and the specific variable wins", async () => {
  await withAgentDir(undefined, async (logFile) => {
    process.env.PI_EXT_LOG = "debug";
    const fallback = createLogger("hashline");
    fallback.debug("via_shared");
    process.env.PI_HASHLINE_LOG = "error";
    const specific = createLogger("hashline");
    specific.debug("skipped");
    specific.error("via_specific");
    const lines = await readLines(logFile);
    assert.deepEqual(lines.map((line) => line.event), ["via_shared", "via_specific"]);
  });
});

test("the threshold filters lower-severity levels", async () => {
  await withAgentDir(JSON.stringify({ logLevel: "error" }), async (logFile) => {
    const logger = createLogger("hashline");
    logger.debug("noise");
    logger.warn("noise");
    logger.error("kept");
    const lines = await readLines(logFile);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].event, "kept");
  });
});

test("debug threshold admits every level", async () => {
  await withAgentDir(JSON.stringify({ logLevel: "debug" }), async (logFile) => {
    const logger = createLogger("hashline");
    logger.debug("d");
    logger.error("e");
    const lines = await readLines(logFile);
    assert.deepEqual(lines.map((line) => line.event), ["d", "e"]);
  });
});

test("Error context is serialized with message and stack", async () => {
  await withAgentDir(undefined, async (logFile) => {
    const logger = createLogger("hashline");
    logger.error("edit_failed", { error: new Error("kaboom") });
    const [entry] = await readLines(logFile);
    const context = entry.context as Record<string, Record<string, unknown>>;
    assert.equal(context.error.name, "Error");
    assert.equal(context.error.message, "kaboom");
    assert.equal(typeof context.error.stack, "string");
  });
});

test("C1 control characters are neutralized in logged strings", async () => {
  await withAgentDir(undefined, async (logFile) => {
    const logger = createLogger("hashline");
    logger.error("evt", { note: "before\u009Bafter" });
    const [entry] = await readLines(logFile);
    const context = entry.context as Record<string, unknown>;
    assert.equal(context.note, "before\uFFFDafter");
  });
});

test("the log rotates to .log.1 once it exceeds the size cap", async () => {
  await withAgentDir(undefined, async (logFile) => {
    // The log directory is created lazily on the first write; pre-create it so
    // a full-size file forces the size-cap branch on the next append.
    await mkdir(dirname(logFile), { recursive: true });
    await writeFile(logFile, "x".repeat(5 * 1024 * 1024 + 1));
    const logger = createLogger("hashline");
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
  const saved = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = dir;
  try {
    // A regular file named "logs" makes join(dir, "logs") impossible to mkdir.
    await writeFile(join(dir, "logs"), "not a directory");
    const logger = createLogger("hashline");
    assert.doesNotThrow(() => logger.error("swallowed"));
  } finally {
    if (saved === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = saved;
    await rm(dir, { recursive: true, force: true });
  }
});
