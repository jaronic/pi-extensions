import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import lspExtension from "../src/index.ts";
import { decodeAstGrepApplyPath, syncSuccessfulToolResult } from "../src/tool-sync.ts";

interface ToolDefinition {
  name: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
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


test("lsp tool ships a prompt snippet and references-before-rename guidance", () => {
  let tool: ToolDefinition | undefined;
  const api = {
    registerTool(definition: ToolDefinition) {
      if (definition.name === "lsp") tool = definition;
    },
    registerCommand() {},
    on() {},
  } as unknown as ExtensionAPI;

  lspExtension(api);
  // Pi lists a tool in the system prompt only when it carries a promptSnippet,
  // and the rename workflow depends on the model seeing the references-first rule.
  assert.ok(tool?.promptSnippet && tool.promptSnippet.length > 0, "lsp must define promptSnippet");
  const guidelines = tool?.promptGuidelines ?? [];
  assert.ok(guidelines.some((g) => g.includes("action=references") && /MUST/u.test(g)), "guidelines must require references before rename");
  assert.ok(guidelines.some((g) => g.includes("rename_preview")), "guidelines must mention rename_preview");
  // Each guideline must name the tool explicitly; vague "use this tool" bullets
  // lose their binding when Pi composes guidelines from many extensions.
  assert.ok(guidelines.length >= 1 && guidelines.length <= 3, "lsp guidelines must stay within the 1-3 system-prompt budget");
  for (const guideline of guidelines) assert.ok(guideline.includes("lsp"), "every lsp guideline must name the tool");
});
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

test("ast-grep apply details decode exactly and sync failures stay best-effort", async () => {
  const machinePath = "sample\x1b\r.ts";
  const details = {
    version: 1,
    kind: "edit-apply",
    path: machinePath,
    replacements: 2,
    previewId: "a".repeat(64),
    beforeSha256: "b".repeat(64),
    afterSha256: "c".repeat(64),
    cliVersion: "0.45.0",
  };
  assert.equal(decodeAstGrepApplyPath(details), machinePath);
  assert.throws(() => decodeAstGrepApplyPath({ ...details, kind: "edit-preview" }));
  assert.throws(() => decodeAstGrepApplyPath({ ...details, extra: true }));
  assert.throws(() => decodeAstGrepApplyPath({ ...details, replacements: 0 }));
  assert.throws(() => decodeAstGrepApplyPath({ ...details, beforeSha256: "not-a-hash" }));

  let resolvedPath: string | undefined;
  let calls = 0;
  await assert.doesNotReject(syncSuccessfulToolResult({
    cwd: "/workspace",
    async syncActiveFile() {
      calls += 1;
      throw new Error("synthetic sync rejection");
    },
  }, {
    toolName: "ast_grep_edit",
    isError: false,
    input: {},
    details,
  }, "/workspace", async (rawPath) => {
    resolvedPath = rawPath;
    return "/workspace/sample.ts";
  }));
  assert.equal(calls, 1);
  assert.equal(resolvedPath, machinePath);
});

test("lsp syncs only a successful ast-grep apply result", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lsp-ast-grep-sync-"));
  const configDirectory = join(root, CONFIG_DIR_NAME);
  const samplePath = join(root, "sample.audit");
  await mkdir(configDirectory, { recursive: true });
  await writeFile(samplePath, "alpha\n", "utf8");
  const notificationsPath = join(root, "notifications.jsonl");
  await writeFile(join(configDirectory, "lsp.json"), JSON.stringify({
    servers: {
      audit: {
        command: process.execPath,
        args: [fakeServer, "document-content", notificationsPath],
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
  const hover = async (): Promise<string> => {
    const result = await Reflect.apply(tool!.execute, tool, [
      "hover-call",
      { action: "hover", file: "sample.audit", line: 1, column: 1 },
      new AbortController().signal,
      undefined,
      context,
    ]) as ToolResult;
    return result.content[0]?.text ?? "";
  };
  const applyDetails = {
    version: 1,
    kind: "edit-apply",
    path: "sample.audit",
    replacements: 1,
    previewId: "a".repeat(64),
    beforeSha256: "b".repeat(64),
    afterSha256: "c".repeat(64),
    cliVersion: "0.45.0",
  };

  try {
    assert.match(await hover(), /alpha/);
    assert.match(await readFile(notificationsPath, "utf8"), /"method":"didOpen"/u);
    await writeFile(samplePath, "beta\n", "utf8");
    await handlers.get("tool_result")?.({
      type: "tool_result",
      toolName: "ast_grep_edit",
      isError: false,
      input: {},
      details: { ...applyDetails, kind: "edit-preview" },
    }, context);
    assert.doesNotMatch(await readFile(notificationsPath, "utf8"), /"method":"didChange"/u);

    await handlers.get("tool_result")?.({
      type: "tool_result",
      toolName: "ast_grep_edit",
      isError: true,
      input: {},
      details: applyDetails,
    }, context);
    assert.doesNotMatch(await readFile(notificationsPath, "utf8"), /"method":"didChange"/u);

    await handlers.get("tool_result")?.({
      type: "tool_result",
      toolName: "ast_grep_edit",
      isError: false,
      input: {},
      details: applyDetails,
    }, context);
    await Reflect.apply(tool!.execute, tool, [
      "barrier-call",
      { action: "workspace_symbols" },
      new AbortController().signal,
      undefined,
      context,
    ]);
    assert.match(await readFile(notificationsPath, "utf8"), /"method":"didChange".*beta\\n/u);
    assert.match(await hover(), /beta/u);
  } finally {
    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" }, context);
    await rm(root, { recursive: true, force: true });
  }
});
