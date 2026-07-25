import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import rgExtension, { prioritizeRgOverGrep } from "../src/index.ts";

interface RegisteredToolSummary {
  name: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters?: unknown;
  execute?: unknown;
  renderResult?: unknown;
}

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

test("rg priority changes only the rg/grep ordering", () => {
  const input = ["read", "grep", "lsp", "rg", "write"];
  const prioritized = prioritizeRgOverGrep(input);

  assert.deepEqual(prioritized, ["read", "rg", "grep", "lsp", "write"]);
  assert.deepEqual(input, ["read", "grep", "lsp", "rg", "write"], "priority helper must not mutate callers");
  assert.deepEqual(
    prioritized.filter((name) => name !== "rg" && name !== "grep"),
    input.filter((name) => name !== "rg" && name !== "grep"),
    "all unrelated tools must retain their relative order",
  );
  assert.deepEqual(prioritizeRgOverGrep(["read", "rg", "lsp", "grep"]), ["read", "rg", "lsp", "grep"]);
  assert.deepEqual(prioritizeRgOverGrep(["read", "grep"]), ["read", "grep"]);
});

test("rg extension registers explicit fallback guidance and prioritizes active tools", async () => {
  let registered: RegisteredToolSummary | undefined;
  let activeTools = ["read", "grep", "lsp", "rg", "write"];
  const handlers = new Map<string, EventHandler>();
  const api = {
    registerTool(definition: RegisteredToolSummary) {
      registered = definition;
    },
    on(name: string, handler: EventHandler) {
      handlers.set(name, handler);
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
  } as unknown as ExtensionAPI;

  rgExtension(api);
  assert.ok(registered);
  assert.equal(registered.name, "rg");
  assert.ok(registered.parameters);
  assert.equal(typeof registered.execute, "function");
  assert.equal(typeof registered.renderResult, "function");
  assert.match(registered.promptSnippet ?? "", /before grep/);
  assert.deepEqual(registered.promptGuidelines, [
    "When both rg and grep are active, use rg first for file-content searches.",
    "Use grep only when rg is unavailable or an rg call fails.",
  ]);

  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart);
  await sessionStart({ type: "session_start", reason: "startup" }, {} as ExtensionContext);
  assert.deepEqual(activeTools, ["read", "rg", "grep", "lsp", "write"]);
});
