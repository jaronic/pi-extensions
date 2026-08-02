import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { ServerManager } from "../src/server-manager.ts";
import type { LspConfig, ServerConfig } from "../src/types.ts";

const hangingServer = join(dirname(fileURLToPath(import.meta.url)), "hanging-server.mjs");

function server(id: string): ServerConfig {
  return {
    id,
    command: [process.execPath, hangingServer],
    extensions: { ".ts": "typescript" },
    rootMarkers: [],
    roles: ["navigation", "diagnostics", "actions"],
    priority: 1,
  };
}

function config(servers: ServerConfig[]): LspConfig {
  return {
    idleTimeoutMs: 0,
    // Long initialize timeout: a prompt abort/shutdown proves cancellation
    // works instead of waiting out the request timeout.
    requestTimeoutMs: 10_000,
    diagnosticsSettleMs: 20,
    maxResults: 100,
    servers,
    loadedFrom: [],
  };
}

async function workspace(context: TestContext): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-lsp-startup-cancel-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const file = join(root, "sample.ts");
  await writeFile(file, "const alpha = 1;\n", "utf8");
  return { root: await realpath(root), file: await realpath(file) };
}

test("clientForAction rejects with AbortError promptly when the caller aborts during startup", async (context) => {
  const { root, file } = await workspace(context);
  const manager = new ServerManager(root, config([server("hanging")]));
  context.after(async () => await manager.shutdown());
  const controller = new AbortController();
  const rejection = assert.rejects(
    manager.clientForAction(file, "hover", undefined, controller.signal),
    (error: Error) => error.name === "AbortError",
  );
  await delay(50);
  const startedAt = Date.now();
  controller.abort();
  await rejection;
  assert.ok(Date.now() - startedAt < 2_000, "abort must not wait for the initialize timeout");
});

test("ServerManager shutdown aborts pending startup instead of waiting for the initialize timeout", async (context) => {
  const { root, file } = await workspace(context);
  const manager = new ServerManager(root, config([server("hanging")]));
  context.after(async () => await manager.shutdown());
  const pending = manager.clientForAction(file, "hover");
  const rejection = assert.rejects(pending, /Failed to start LSP server .*LSP request aborted/);
  await delay(50);
  const startedAt = Date.now();
  await manager.shutdown();
  await rejection;
  assert.ok(Date.now() - startedAt < 2_000, "shutdown must not wait for the initialize timeout");
  assert.equal(manager.status().active.length, 0);
});
