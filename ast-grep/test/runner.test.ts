import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { BinaryManager, ReadyBinary } from "../src/binary.ts";
import { markTerminalCause } from "../src/operations.ts";
import { AstGrepRunner, type NativeRunRequest } from "../src/runner.ts";
import { NativeScheduler } from "../src/scheduler.ts";
import { materializeFakeAstGrep, operationRecord, temporaryWorkspace } from "./helpers.ts";

const configPath = fileURLToPath(new URL("../assets/empty-sgconfig.yml", import.meta.url));
const fakeReady = {
  path: "",
  version: "0.45.0",
  identity: {},
  configPath,
  configIdentity: {},
  configSha256: "a".repeat(64),
} as unknown as ReadyBinary;

function binaryManager(value: string | ReadyBinary): BinaryManager {
  const ready = typeof value === "string" ? { ...fakeReady, path: value } as ReadyBinary : value;
  return {
    async ready() {
      return ready;
    },
    async revalidate() {},
    async shutdown() {},
  } as unknown as BinaryManager;
}

function request(cwd: string, pattern: string): NativeRunRequest {
  return {
    mode: "search",
    cwd,
    language: "typescript",
    pattern,
    strictness: "smart",
    stdin: Buffer.from(pattern === "split-valid" ? "foo(é)" : "foo(x)"),
  };
}

async function observeActiveChild(runner: AstGrepRunner): Promise<void> {
  for (let turn = 0; turn < 100 && runner.activeChildren === 0; turn += 1) {
    await Promise.resolve();
  }
  assert.equal(runner.activeChildren, 1, "the fake child must be active before interruption");
}

test("runner streams split NDJSON, EOF records, and no-match status", async (t) => {
  const cwd = await temporaryWorkspace(t, "pi-ast-grep-runner-");
  const binary = await materializeFakeAstGrep(cwd);
  const scheduler = new NativeScheduler(2);
  const runner = new AstGrepRunner(scheduler, binaryManager(binary), { HOME: cwd });
  try {
    for (const mode of ["valid", "split-valid", "eof-record"] as const) {
      const records: string[] = [];
      const result = await runner.withSession(operationRecord(), (execution) => execution.run(request(cwd, mode), async (match) => {
        records.push(match.text);
      }));
      assert.equal(result.records, 1, mode);
      assert.equal(records.length, 1, mode);
    }
    const noMatch = await runner.withSession(operationRecord(), (execution) => execution.run(request(cwd, "no-match"), async () => {
      assert.fail("no-match must not emit records");
    }));
    assert.equal(noMatch.records, 0);
  } finally {
    await runner.shutdown();
  }
});

test("runner keeps one async consumer outstanding while stdout and stderr flood", async (t) => {
  const cwd = await temporaryWorkspace(t, "pi-ast-grep-runner-flood-");
  const binary = await materializeFakeAstGrep(cwd);
  const scheduler = new NativeScheduler(2);
  const runner = new AstGrepRunner(scheduler, binaryManager(binary));
  const firstStarted = Promise.withResolvers<void>();
  const releaseFirst = Promise.withResolvers<void>();
  let seen = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  try {
    const pending = runner.withSession(operationRecord(), (execution) => execution.run(request(cwd, "consumer-flood"), async () => {
      seen += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (seen === 1) {
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      inFlight -= 1;
    }));
    await firstStarted.promise;
    assert.equal(seen, 1);
    assert.equal(maxInFlight, 1);
    assert.equal(runner.activeChildren, 1);
    releaseFirst.resolve();
    const result = await pending;
    assert.equal(result.records, 5_000);
    assert.equal(seen, 5_000);
    assert.equal(maxInFlight, 1);
  } finally {
    releaseFirst.resolve();
    await runner.shutdown();
  }
});

test("runner rejects corrupt NDJSON and contradictory exit statuses", async (t) => {
  const cwd = await temporaryWorkspace(t, "pi-ast-grep-runner-corrupt-");
  const binary = await materializeFakeAstGrep(cwd);
  for (const [mode, pattern] of [
    ["malformed", /malformed UTF-8 JSON record/u],
    ["empty-line", /empty NDJSON line/u],
    ["oversized", /NDJSON line exceeds 1048576 bytes/u],
    ["status-zero", /exit status and record count disagree/u],
    ["status-one-record", /exit status and record count disagree/u],
  ] as const) {
    const scheduler = new NativeScheduler(2);
    const runner = new AstGrepRunner(scheduler, binaryManager(binary));
    try {
      await assert.rejects(runner.withSession(operationRecord(), (execution) => execution.run(request(cwd, mode), async () => undefined)), pattern, mode);
    } finally {
      await runner.shutdown();
    }
  }
});

test("runner uses shell-free argv and sanitizes bounded diagnostics", async (t) => {
  const cwd = await temporaryWorkspace(t, "pi-ast-grep-runner-argv-");
  const binary = await materializeFakeAstGrep(cwd);
  const marker = join(cwd, "shell-owned");
  const scheduler = new NativeScheduler(2);
  const runner = new AstGrepRunner(scheduler, binaryManager(binary), { HOME: cwd, PATH: "/attacker/bin" });
  try {
    await runner.withSession(operationRecord(), (execution) => execution.run(request(cwd, "valid;touch shell-owned"), async () => undefined));
    await assert.rejects(access(marker));
    await assert.rejects(
      runner.withSession(operationRecord(), (execution) => execution.run(request(cwd, "failure"), async () => undefined)),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /query failed with exit code 2/u);
        assert.match(error.message, /<workspace>/u);
        assert.doesNotMatch(error.message, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
        assert.doesNotMatch(error.message, /\x1b/u);
        return true;
      },
    );
  } finally {
    await runner.shutdown();
  }
});

test("runner propagates mid-stream abort and drains the child", async (t) => {
  const cwd = await temporaryWorkspace(t, "pi-ast-grep-runner-abort-");
  const binary = await materializeFakeAstGrep(cwd);
  const scheduler = new NativeScheduler(2);
  const runner = new AstGrepRunner(scheduler, binaryManager(binary));
  const record = operationRecord();
  const pending = runner.withSession(record, async (execution) => {
    const running = execution.run(request(cwd, "hang"), async () => undefined);
    await observeActiveChild(runner);
    markTerminalCause(record, "external-abort");
    return running;
  });
  await assert.rejects(pending, /operation was aborted/u);
  assert.equal(runner.activeChildren, 0);
  await runner.shutdown();
});

test("runner terminates an uncooperative child during shutdown", async (t) => {
  const cwd = await temporaryWorkspace(t, "pi-ast-grep-runner-force-kill-");
  const binary = await materializeFakeAstGrep(cwd);
  const scheduler = new NativeScheduler(2);
  const runner = new AstGrepRunner(scheduler, binaryManager(binary));
  const ready = Promise.withResolvers<void>();
  const pending = runner.withSession(operationRecord(), async (execution) => {
    const running = execution.run(request(cwd, "hang-ignore-term"), async () => ready.resolve());
    await observeActiveChild(runner);
    return running;
  });
  await ready.promise;
  const interrupted = assert.rejects(pending, process.platform === "win32" ? /signal SIGTERM/u : /signal SIGKILL/u);
  // POSIX permits the fake child to ignore SIGTERM and exercises the real 1s escalation; Windows terminates on SIGTERM.
  await runner.shutdown();
  await interrupted;
  assert.equal(runner.activeChildren, 0);
});

test("runner reports spawn failures without exposing raw command construction", async (t) => {
  const cwd = await temporaryWorkspace(t, "pi-ast-grep-runner-spawn-");
  const scheduler = new NativeScheduler(2);
  const missingReady = { ...fakeReady, path: join(cwd, "missing-ast-grep") } as ReadyBinary;
  const runner = new AstGrepRunner(scheduler, binaryManager(missingReady));
  try {
    await assert.rejects(
      runner.withSession(operationRecord(), (execution) => execution.run(request(cwd, "valid"), async () => undefined)),
      /failed to start installed ast-grep binary \(ENOENT\)/u,
    );
  } finally {
    await runner.shutdown();
  }
});
