import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { HoverRequest } from "vscode-languageserver-protocol";
import { ServerManager } from "../src/server-manager.ts";
import type { Logger } from "../src/logger.ts";
import type { LspConfig, ServerConfig } from "../src/types.ts";

interface RecordedLog {
  readonly level: string;
  readonly event: string;
  readonly context?: Record<string, unknown>;
}

function recordingLogger(): { readonly events: RecordedLog[]; readonly logger: Logger } {
  const events: RecordedLog[] = [];
  const record = (level: string) => (event: string, context?: Record<string, unknown>) => {
    events.push({ level, event, context });
  };
  return { events, logger: { error: record("error"), warn: record("warn"), info: record("info"), debug: record("debug") } };
}

const fakeServer = join(dirname(fileURLToPath(import.meta.url)), "fake-server.mjs");

function server(id: string, mode: string, priority = 1): ServerConfig {
  return {
    id,
    command: [process.execPath, fakeServer, mode],
    extensions: { ".ts": "typescript" },
    rootMarkers: [],
    roles: ["navigation", "diagnostics", "actions"],
    priority,
  };
}

function config(servers: ServerConfig[], idleTimeoutMs = 0): LspConfig {
  return {
    idleTimeoutMs,
    requestTimeoutMs: 1_000,
    diagnosticsSettleMs: 20,
    maxResults: 100,
    servers,
    loadedFrom: [],
  };
}

async function workspace(context: TestContext): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), "pi-lsp-manager-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const file = join(root, "sample.ts");
  await writeFile(file, "const alpha = 1;\n", "utf8");
  return { root: await realpath(root), file: await realpath(file) };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail("Condition did not become true.");
}

test("ServerManager logs the server lifecycle and unexpected exits", async (context) => {
  const { root, file } = await workspace(context);
  const { events, logger } = recordingLogger();
  const manager = new ServerManager(root, config([server("normal", "normal")]), logger);
  context.after(async () => await manager.shutdown());
  await manager.clientForAction(file, "hover");
  const started = events.find((entry) => entry.event === "server_started");
  assert.equal(started?.level, "info");
  assert.equal(started?.context?.server, "normal");
  assert.match(String(started?.context?.command), /fake-server\.mjs/);

  await manager.syncActiveFile(file);
  const synced = events.find((entry) => entry.event === "file_synced");
  assert.equal(synced?.level, "debug");
  assert.deepEqual(synced?.context?.servers, ["normal"]);

  await manager.shutdown();
  assert.ok(events.some((entry) => entry.level === "info" && entry.event === "shutdown"));
  assert.ok(!events.some((entry) => entry.event === "server_exited"), "deliberate shutdown is not a crash");

  const crashLog = recordingLogger();
  const crashManager = new ServerManager(root, config([server("crash", "crash-hover")]), crashLog.logger);
  context.after(async () => await crashManager.shutdown());
  const crashing = await crashManager.clientForAction(file, "hover");
  const document = await crashing.client.syncFile(file, crashing.languageId);
  await assert.rejects(crashing.client.request(HoverRequest.method, {
    textDocument: { uri: document.uri },
    position: { line: 0, character: 0 },
  }));
  await waitUntil(() => crashLog.events.some((entry) => entry.event === "server_exited"));
  const exited = crashLog.events.find((entry) => entry.event === "server_exited");
  assert.equal(exited?.level, "warn");
  assert.equal(exited?.context?.server, "crash");
});

test("ServerManager logs idle shutdown at debug", async (context) => {
  const { root, file } = await workspace(context);
  const { events, logger } = recordingLogger();
  const manager = new ServerManager(root, config([server("idle", "normal")], 20), logger);
  context.after(async () => await manager.shutdown());
  await manager.clientForAction(file, "hover");
  await waitUntil(() => events.some((entry) => entry.event === "server_idle_shutdown"));
  const idle = events.find((entry) => entry.event === "server_idle_shutdown");
  assert.equal(idle?.level, "debug");
  assert.equal(idle?.context?.server, "idle");
});

test("ServerManager coalesces concurrent startup for one server and root", async (context) => {
  const { root, file } = await workspace(context);
  const manager = new ServerManager(root, config([server("normal", "normal")]));
  context.after(async () => await manager.shutdown());
  const [first, second] = await Promise.all([
    manager.clientForAction(file, "hover"),
    manager.clientForAction(file, "hover"),
  ]);
  assert.equal(first.client, second.client);
  assert.equal(manager.status().active.length, 1);
});

test("ServerManager removes idle and crashed clients", async (context) => {
  const { root, file } = await workspace(context);
  const idleManager = new ServerManager(root, config([server("idle", "normal")], 20));
  const routed = await idleManager.clientForAction(file, "hover");
  await waitUntil(() => idleManager.status().active.length === 0 && routed.client.state === "closed");
  assert.equal(routed.client.state, "closed");
  await idleManager.shutdown();

  const crashManager = new ServerManager(root, config([server("crash", "crash-hover")]));
  const crashing = await crashManager.clientForAction(file, "hover");
  const document = await crashing.client.syncFile(file, crashing.languageId);
  await assert.rejects(crashing.client.request(HoverRequest.method, {
    textDocument: { uri: document.uri },
    position: { line: 0, character: 0 },
  }));
  await waitUntil(() => crashManager.status().active.length === 0);
  await crashManager.shutdown();
});

test("ServerManager shutdown waits for pending startup and closes it", async (context) => {
  const { root, file } = await workspace(context);
  const manager = new ServerManager(root, config([server("delayed", "delay-initialize")]));
  const pending = manager.clientForAction(file, "hover");
  const rejection = assert.rejects(pending, /shut down during server startup/);
  await delay(20);
  await manager.shutdown();
  await rejection;
  assert.equal(manager.status().active.length, 0);
});

test("ServerManager diagnostics preserve partial success", async (context) => {
  const { root, file } = await workspace(context);
  const manager = new ServerManager(root, config([
    server("working", "normal", 2),
    server("broken", "crash-initialize", 1),
  ]));
  context.after(async () => await manager.shutdown());
  const results = await manager.diagnostics(file, undefined);
  assert.equal(results.length, 2);
  assert.equal(results.find(({ server: id }) => id === "working")?.diagnostics?.length, 1);
  assert.match(results.find(({ server: id }) => id === "broken")?.error ?? "", /Failed to start/);
});

test("ServerManager falls through unsupported capabilities", async (context) => {
  const { root, file } = await workspace(context);
  const manager = new ServerManager(root, config([
    server("unsupported", "unsupported", 2),
    server("working", "normal", 1),
  ]));
  context.after(async () => await manager.shutdown());
  const routed = await manager.clientForAction(file, "hover");
  assert.equal(routed.server.id, "working");
});

test("ServerManager accepts a unique language ID for workspace symbols", async (context) => {
  const { root } = await workspace(context);
  const javaServer = { ...server("jdtls", "normal"), extensions: { ".java": "java" } };
  const manager = new ServerManager(root, config([javaServer]));
  context.after(async () => await manager.shutdown());
  const clients = await manager.workspaceClients("java");
  assert.equal(clients.length, 1);
  assert.equal(clients[0].server.id, "jdtls");
});
