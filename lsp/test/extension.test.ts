import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import lspExtension from "../src/index.ts";

interface ToolDefinition {
  name: string;
  execute: (...args: unknown[]) => unknown;
}

interface ToolResult {
  content: Array<{ type: string; text: string }>;
  details: {
    resultCount: number;
    fullOutputPath?: string;
  };
}

type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

const fakeServer = join(dirname(fileURLToPath(import.meta.url)), "fake-server.mjs");

test("lsp rename_preview reports every document change and preserves its full artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lsp-extension-"));
  const configDirectory = join(root, CONFIG_DIR_NAME);
  await mkdir(configDirectory, { recursive: true });
  await writeFile(join(root, "sample.audit"), "alpha\n", "utf8");
  await writeFile(join(configDirectory, "lsp.json"), JSON.stringify({
    servers: {
      audit: {
        command: process.execPath,
        args: [fakeServer, "many-rename"],
        fileTypes: [".audit"],
        languageId: "plaintext",
        rootMarkers: [],
        priority: 1_000,
      },
    },
  }));

  let tool: ToolDefinition | undefined;
  const handlers = new Map<string, LifecycleHandler>();
  const api = {
    registerTool(definition: ToolDefinition) {
      if (definition.name === "lsp") tool = definition;
    },
    registerCommand() {},
    on(name: string, handler: LifecycleHandler) {
      handlers.set(name, handler);
    },
  } as unknown as ExtensionAPI;
  const context = {
    cwd: root,
    isProjectTrusted: () => true,
    ui: {
      notify: () => undefined,
      setStatus: () => undefined,
    },
  } as unknown as ExtensionContext;

  lspExtension(api);
  assert.ok(tool);
  try {
    const result = await Reflect.apply(tool.execute, tool, [
      "call-1",
      { action: "rename_preview", file: "sample.audit", line: 1, column: 1, newName: "renamed", limit: 500 },
      new AbortController().signal,
      undefined,
      context,
    ]) as ToolResult;
    assert.equal(result.details.resultCount, 300);
    assert.ok(result.details.fullOutputPath);
    assert.match(await readFile(result.details.fullOutputPath, "utf8"), /__TAIL_MARKER_299/);
  } finally {
    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, context);
    await rm(root, { recursive: true, force: true });
  }
});
