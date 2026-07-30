import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import astGrepExtension from "../src/index.ts";

interface ToolDefinition {
  name: string;
  executionMode?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: (...args: unknown[]) => unknown;
}

type LifecycleHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

test("extension factory registers two narrow tools without starting native work", async () => {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, LifecycleHandler[]>();
  const api = {
    registerTool(definition: ToolDefinition) {
      tools.set(definition.name, definition);
    },
    on(name: string, handler: LifecycleHandler) {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
    },
  } as unknown as ExtensionAPI;

  astGrepExtension(api);
  assert.deepEqual([...tools.keys()], ["ast_grep_search", "ast_grep_edit"]);
  assert.equal(tools.get("ast_grep_search")?.executionMode, "parallel");
  assert.equal(tools.get("ast_grep_edit")?.executionMode, "sequential");
  // Discoverability contract: Pi lists a tool in the system prompt only when it
  // carries a one-line promptSnippet, so both tools must ship one.
  for (const name of ["ast_grep_search", "ast_grep_edit"]) {
    const tool = tools.get(name);
    assert.ok(tool?.promptSnippet && tool.promptSnippet.length > 0, `${name} must define promptSnippet`);
    assert.ok((tool?.promptGuidelines?.length ?? 0) > 0, `${name} must define promptGuidelines`);
  }
  assert.equal(handlers.get("session_start"), undefined);
  assert.equal(handlers.get("session_tree"), undefined);
  assert.equal(handlers.get("session_shutdown")?.length, 1);

  const context = {
    cwd: process.cwd(),
    ui: { setStatus: () => undefined },
  } as unknown as ExtensionContext;
  await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, context);
  await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown", reason: "quit" }, context);
});
