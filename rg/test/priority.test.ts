import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import rgExtension, { replaceGrepWithRg } from "../src/index.ts";

interface RegisteredToolSummary {
  name: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters?: unknown;
  execute?: unknown;
  renderCall?: (
    args: { pattern?: unknown; path?: unknown; glob?: unknown; limit?: unknown },
    theme: { bold(text: string): string; fg(color: string, text: string): string },
    context: { lastComponent?: unknown },
  ) => { render(width: number): string[] };
  renderResult?: (...args: unknown[]) => unknown;
}

type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>;

test("rg replacement keeps one search schema without moving unrelated tools", () => {
  const input = ["read", "grep", "lsp", "rg", "write"];
  const replacement = replaceGrepWithRg(input);

  assert.deepEqual(replacement, ["read", "rg", "lsp", "write"]);
  assert.deepEqual(input, ["read", "grep", "lsp", "rg", "write"], "replacement helper must not mutate callers");
  assert.deepEqual(
    replacement.filter((name) => name !== "rg" && name !== "grep"),
    input.filter((name) => name !== "rg" && name !== "grep"),
    "all unrelated tools must retain their relative order",
  );
  assert.deepEqual(replaceGrepWithRg(["read", "rg", "lsp", "grep"]), ["read", "rg", "lsp"]);
  assert.deepEqual(replaceGrepWithRg(["read", "grep"]), ["read", "grep"]);
  assert.deepEqual(replaceGrepWithRg(["read", "rg"]), ["read", "rg"]);
});

test("rg extension exposes one honest search contract and restores grep on shutdown", async () => {
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
  assert.match(registered.description ?? "", /alias.*ripgrep-backed grep engine/);
  assert.equal(registered.promptSnippet, "Ripgrep-backed file-content search");
  assert.deepEqual(registered.promptGuidelines, [
    "Use rg for file-content searches. It shares Pi's grep execution path, so retrying the same request as grep is not a fallback.",
  ]);
  assert.equal(typeof registered.renderResult, "function");
  const theme = {
    bold: (text: string) => text,
    fg: (_color: string, text: string) => text,
  };
  const renderedCall = registered.renderCall?.(
    { pattern: "needle", path: "src" },
    theme,
    {},
  ).render(80).join("\n");
  assert.match((renderedCall ?? "").trimEnd(), /^rg \/needle\/ in src$/);

  const resultPath =
    "digital-person-core/src/test/java/com/yiwise/digitalperson/task/SimpleGoodsImportTaskTest.java";
  const groupedResult = registered.renderResult?.(
    {
      content: [
        {
          type: "text",
          text: [
            `${resultPath}-194- *Product Link`,
            `${resultPath}-195- *Product Name`,
            `${resultPath}:196: Product Selling Points`,
            `${resultPath}-197- Benefit`,
          ].join("\n"),
        },
      ],
    },
    { expanded: true, isPartial: false },
    theme,
    { lastComponent: undefined, showImages: false, isError: false },
  ) as { render(width: number): string[] } | undefined;
  assert.ok(groupedResult);
  assert.deepEqual(groupedResult.render(200).map((line) => line.trimEnd()), [
    resultPath,
    "  194- *Product Link",
    "  195- *Product Name",
    "  196: Product Selling Points",
    "  197- Benefit",
  ]);

  const sessionStart = handlers.get("session_start");
  assert.ok(sessionStart);
  await sessionStart({ type: "session_start", reason: "startup" }, {} as ExtensionContext);
  assert.deepEqual(activeTools, ["read", "rg", "lsp", "write"]);

  activeTools.splice(1, 0, "grep");
  const sessionTree = handlers.get("session_tree");
  assert.ok(sessionTree);
  await sessionTree({ type: "session_tree" }, {} as ExtensionContext);
  assert.deepEqual(activeTools, ["read", "rg", "lsp", "write"]);

  const sessionShutdown = handlers.get("session_shutdown");
  assert.ok(sessionShutdown);
  await sessionShutdown({ type: "session_shutdown", reason: "reload" }, {} as ExtensionContext);
  assert.deepEqual(activeTools, ["read", "grep", "lsp", "write"]);
});
