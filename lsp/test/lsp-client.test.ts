import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  DefinitionRequest,
  ReferencesRequest,
  RenameRequest,
  HoverRequest,
  type Location,
  type WorkspaceEdit,
} from "vscode-languageserver-protocol";
import { LspClient } from "../src/lsp-client.ts";
import type { ServerConfig } from "../src/types.ts";

const fakeServer = join(dirname(fileURLToPath(import.meta.url)), "fake-server.mjs");

function fakeServerConfig(mode = "normal", overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    id: `fake-${mode}`,
    command: [process.execPath, fakeServer, mode],
    extensions: { ".ts": "typescript" },
    rootMarkers: [],
    roles: ["navigation", "diagnostics", "actions"],
    priority: 1,
    ...overrides,
  };
}

async function waitForStderr(client: LspClient, pattern: RegExp): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (client.status().stderr.some((line) => pattern.test(line))) return;
    await delay(10);
  }
  assert.fail(`Expected LSP stderr to match ${pattern}`);
}

test("LspClient initializes, syncs, queries, receives diagnostics, and shuts down", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pi-lsp-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const file = join(root, "sample.ts");
  await writeFile(file, "😀alpha\nalpha\n", "utf8");
  const server: ServerConfig = {
    id: "fake",
    command: [process.execPath, fakeServer],
    extensions: { ".ts": "typescript" },
    rootMarkers: [],
    roles: ["navigation", "diagnostics", "actions"],
    priority: 1,
  };
  let closed = 0;
  const client = await LspClient.start(server, root, 3_000, () => { closed += 1; });
  try {
    const document = await client.syncFile(file, "typescript");
    assert.deepEqual(client.toPosition(document, 1, 2), { line: 0, character: 4 });

    const textDocument = { uri: document.uri };
    const position = { line: 0, character: 4 };
    const definition = await client.request<Location>(DefinitionRequest.method, { textDocument, position });
    assert.equal(definition.uri, document.uri);

    const references = await client.request<Location[]>(ReferencesRequest.method, {
      textDocument,
      position,
      context: { includeDeclaration: true },
    });
    assert.equal(references.length, 2);

    const diagnostics = await client.getDiagnostics(file, "typescript", 10, 3_000);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].source, "fake-lsp");

    const rename = await client.request<WorkspaceEdit>(RenameRequest.method, {
      textDocument,
      position,
      newName: "welcome",
    });
    assert.equal(rename.changes?.[document.uri]?.length, 2);
  } finally {
    await client.shutdown();
  }
  assert.equal(client.state, "closed");
  assert.equal(closed, 1);
});

test("LspClient propagates AbortSignal cancellation to JSON-RPC", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pi-lsp-abort-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const file = join(root, "sample.ts");
  await writeFile(file, "const alpha = 1;\n", "utf8");
  const client = await LspClient.start(fakeServerConfig("hang-hover"), root, 3_000, () => {});
  context.after(async () => await client.shutdown());
  const document = await client.syncFile(file, "typescript");
  const controller = new AbortController();
  const rejection = assert.rejects(
    client.request(HoverRequest.method, {
      textDocument: { uri: document.uri },
      position: { line: 0, character: 0 },
    }, controller.signal),
    (error: Error) => error.name === "AbortError",
  );
  await delay(20);
  controller.abort();
  await rejection;
  await waitForStderr(client, /hover request cancelled/);
});

test("LspClient times out requests and cancels the server work", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pi-lsp-timeout-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const client = await LspClient.start(fakeServerConfig("hang-hover"), root, 3_000, () => {});
  context.after(async () => await client.shutdown());
  await assert.rejects(
    client.request(HoverRequest.method, {}, undefined, 30),
    /timed out after 30ms/,
  );
  await waitForStderr(client, /hover request cancelled/);
});

test("LspClient reports initialize and in-flight server crashes", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pi-lsp-crash-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  await assert.rejects(
    LspClient.start(fakeServerConfig("crash-initialize"), root, 3_000, () => {}),
    /Failed to start LSP server.*synthetic initialize crash/s,
  );

  const client = await LspClient.start(fakeServerConfig("crash-hover"), root, 3_000, () => {});
  await assert.rejects(client.request(HoverRequest.method, {}));
  await waitForStderr(client, /synthetic hover crash/);
  assert.equal(client.state, "closed");
});

test("LspClient settles on the latest diagnostic revision", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pi-lsp-diagnostics-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const file = join(root, "sample.ts");
  await writeFile(file, "const alpha = 1;\n", "utf8");
  const client = await LspClient.start(fakeServerConfig("multi-diagnostics"), root, 3_000, () => {});
  context.after(async () => await client.shutdown());
  const diagnostics = await client.getDiagnostics(file, "typescript", 30, 1_000);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].message, "settled diagnostic");
});

test("LspClient times out when a server publishes no diagnostics", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pi-lsp-no-diagnostics-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const file = join(root, "sample.ts");
  await writeFile(file, "const alpha = 1;\n", "utf8");
  const client = await LspClient.start(fakeServerConfig("no-diagnostics"), root, 3_000, () => {});
  context.after(async () => await client.shutdown());
  await assert.rejects(
    client.getDiagnostics(file, "typescript", 10, 40),
    /Timed out waiting for diagnostics/,
  );
});

test("LspClient honors advertised capabilities and bounds stderr", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pi-lsp-capabilities-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const unsupported = await LspClient.start(fakeServerConfig("unsupported"), root, 3_000, () => {});
  assert.equal(unsupported.supports("hover"), false);
  await unsupported.shutdown();

  const noisy = await LspClient.start(fakeServerConfig("stderr-spam"), root, 3_000, () => {});
  context.after(async () => await noisy.shutdown());
  await waitForStderr(noisy, /stderr-59/);
  assert.equal(noisy.status().stderr.length, 40);
  assert.ok(noisy.status().stderr.every((line) => line.length <= 1_000));
});

test("LspClient shutdown is bounded and idempotent when shutdown is ignored", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pi-lsp-shutdown-"));
  context.after(async () => await rm(root, { recursive: true, force: true }));
  const client = await LspClient.start(fakeServerConfig("ignore-shutdown"), root, 3_000, () => {});
  const startedAt = Date.now();
  await Promise.all([client.shutdown(), client.shutdown()]);
  assert.equal(client.state, "closed");
  assert.ok(Date.now() - startedAt < 2_000);
});
