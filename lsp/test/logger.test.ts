import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLogger } from "../src/logger.ts";

// getAgentDir() resolves the lsp.json config and logs/ under this directory.
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

async function withAgentDir(
  config: string | undefined,
  fn: (logFile: string) => Promise<void> | void,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-lsp-log-"));
  const saved = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = dir;
  try {
    if (config !== undefined) await writeFile(join(dir, "lsp.json"), config);
    await fn(join(dir, "logs", "lsp.log"));
  } finally {
    if (saved === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = saved;
    await rm(dir, { recursive: true, force: true });
  }
}

async function readLines(logFile: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(logFile, "utf8");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

test("logging is off by default and writes nothing", async () => {
  await withAgentDir(undefined, async (logFile) => {
    const logger = createLogger("lsp");
    logger.error("boom", { detail: 1 });
    await assert.rejects(stat(logFile), "no log file should be created when disabled");
  });
});

test("a config without logLevel keeps logging off", async () => {
  await withAgentDir(JSON.stringify({ maxResults: 25 }), async (logFile) => {
    const logger = createLogger("lsp");
    logger.error("boom");
    await assert.rejects(stat(logFile), "no log file should be created without logLevel");
  });
});

test("an unknown logLevel value keeps logging off", async () => {
  await withAgentDir(JSON.stringify({ logLevel: "verbose" }), async (logFile) => {
    const logger = createLogger("lsp");
    logger.error("boom");
    await assert.rejects(stat(logFile), "no log file should be created for an unknown level");
  });
});

test("a malformed config file keeps logging off", async () => {
  await withAgentDir("{", async (logFile) => {
    const logger = createLogger("lsp");
    logger.error("boom");
    await assert.rejects(stat(logFile), "no log file should be created for malformed JSON");
  });
});

test("an enabled logger writes a structured JSON line", async () => {
  await withAgentDir(JSON.stringify({ logLevel: "error" }), async (logFile) => {
    const logger = createLogger("lsp");
    logger.error("tool_failed", { action: "hover", file: "a.ts" });
    const [entry] = await readLines(logFile);
    assert.equal(entry.level, "error");
    assert.equal(entry.ext, "lsp");
    assert.equal(entry.event, "tool_failed");
    assert.deepEqual(entry.context, { action: "hover", file: "a.ts" });
    assert.equal(typeof entry.ts, "string");
  });
});

test("the threshold filters lower-severity levels", async () => {
  await withAgentDir(JSON.stringify({ logLevel: "error" }), async (logFile) => {
    const logger = createLogger("lsp");
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
    const logger = createLogger("lsp");
    logger.debug("d");
    logger.error("e");
    const lines = await readLines(logFile);
    assert.deepEqual(lines.map((line) => line.event), ["d", "e"]);
  });
});

test("Error context is serialized with message and stack", async () => {
  await withAgentDir(JSON.stringify({ logLevel: "error" }), async (logFile) => {
    const logger = createLogger("lsp");
    logger.error("tool_failed", { error: new Error("kaboom") });
    const [entry] = await readLines(logFile);
    const context = entry.context as Record<string, Record<string, unknown>>;
    assert.equal(context.error.name, "Error");
    assert.equal(context.error.message, "kaboom");
    assert.equal(typeof context.error.stack, "string");
  });
});

test("C1 control characters are neutralized in logged strings", async () => {
  await withAgentDir(JSON.stringify({ logLevel: "error" }), async (logFile) => {
    const logger = createLogger("lsp");
    logger.error("evt", { note: "before\u009Bafter" });
    const [entry] = await readLines(logFile);
    const context = entry.context as Record<string, unknown>;
    assert.equal(context.note, "before\uFFFDafter");
  });
});

test("the log rotates to .log.1 once it exceeds the size cap", async () => {
  await withAgentDir(JSON.stringify({ logLevel: "error" }), async (logFile) => {
    // Creating the logger first ensures the logs/ directory exists, then a
    // pre-filled file forces the size-cap branch on the next append.
    const logger = createLogger("lsp");
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
  const dir = await mkdtemp(join(tmpdir(), "pi-lsp-log-"));
  const saved = process.env[AGENT_DIR_ENV];
  process.env[AGENT_DIR_ENV] = dir;
  try {
    await writeFile(join(dir, "lsp.json"), JSON.stringify({ logLevel: "error" }));
    // A regular file named "logs" makes join(dir, "logs") impossible to mkdir.
    await writeFile(join(dir, "logs"), "not a directory");
    const logger = createLogger("lsp");
    assert.doesNotThrow(() => logger.error("swallowed"));
  } finally {
    if (saved === undefined) delete process.env[AGENT_DIR_ENV];
    else process.env[AGENT_DIR_ENV] = saved;
    await rm(dir, { recursive: true, force: true });
  }
});
