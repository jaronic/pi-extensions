import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import doclintExtension from "../src/index.ts";
import { DEMO_AGENTS, DEMO_MANIFEST, DEMO_README, DEMO_SOURCE } from "./mock-fs.ts";

interface RegisteredToolSummary {
  name: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: (
    toolCallId: string,
    params: { action: string; root?: string; maxFindings?: number },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ content: { type: string; text: string }[]; details: Record<string, unknown> }>;
  renderCall?: (...args: unknown[]) => unknown;
  renderResult?: (...args: unknown[]) => unknown;
}

interface RegisteredCommandSummary {
  name: string;
  handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
}

function registerExtension(): { tool: RegisteredToolSummary; command: RegisteredCommandSummary } {
  let tool: RegisteredToolSummary | undefined;
  let command: RegisteredCommandSummary | undefined;
  const api = {
    registerTool(definition: RegisteredToolSummary) {
      tool = definition;
    },
    registerCommand(name: string, options: { handler: RegisteredCommandSummary["handler"] }) {
      command = { name, handler: options.handler };
    },
  } as unknown as ExtensionAPI;
  doclintExtension(api);
  assert.ok(tool, "doc_lint tool must be registered");
  assert.ok(command, "/doclint command must be registered");
  return { tool, command };
}

function writeFixture(root: string, readme = DEMO_README): void {
  fs.writeFileSync(path.join(root, "AGENTS.md"), DEMO_AGENTS);
  fs.mkdirSync(path.join(root, "demo", "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "demo", "package.json"), DEMO_MANIFEST);
  fs.writeFileSync(path.join(root, "demo", "src", "index.ts"), DEMO_SOURCE);
  fs.writeFileSync(path.join(root, "demo", "README.md"), readme);
}

function tempRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "doclint-test-"));
}

test("doc_lint executes a clean check against the workspace root", async () => {
  const { tool } = registerExtension();
  assert.equal(tool.name, "doc_lint");
  assert.match(tool.description ?? "", /documentation contract/);
  assert.equal(tool.promptSnippet, "Lint AGENTS.md/README documentation-contract drift");
  assert.ok(tool.promptGuidelines?.every((line) => line.includes("doc_lint")));

  const root = tempRepo();
  try {
    writeFixture(root);
    const result = await tool.execute("call-1", { action: "check" }, undefined, undefined, {
      cwd: root,
    } as ExtensionContext);
    assert.match(result.content[0].text, /no findings; the documentation contract holds/);
    assert.equal(result.details.errors, 0);
    assert.deepEqual(result.details.packagesScanned, ["demo"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("doc_lint reports real drift and fails on roots outside the workspace", async () => {
  const { tool } = registerExtension();
  const root = tempRepo();
  try {
    writeFixture(root, "# Demo\n\nnpm run check\nnpm test\n");
    const drift = await tool.execute("call-2", { action: "check" }, undefined, undefined, {
      cwd: root,
    } as ExtensionContext);
    assert.match(drift.content[0].text, /tool "demo_tool" is registered in src but never appears/);
    assert.equal(drift.details.errors, 2);

    await assert.rejects(
      tool.execute("call-3", { action: "check", root: ".." }, undefined, undefined, {
        cwd: root,
      } as ExtensionContext),
      /must be the workspace or a directory inside it/,
    );
    await assert.rejects(
      tool.execute("call-4", { action: "check", root: "nope" }, undefined, undefined, {
        cwd: root,
      } as ExtensionContext),
      /does not exist/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("doc_lint aborts before touching the filesystem when cancelled", async () => {
  const { tool } = registerExtension();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    tool.execute("call-5", { action: "check" }, controller.signal, undefined, { cwd: "/nonexistent" } as ExtensionContext),
    /cancelled/,
  );
});

test("doc_lint wires renderCall/renderResult that accept its own real results", async () => {
  const { tool } = registerExtension();
  assert.equal(typeof tool.renderCall, "function");
  assert.equal(typeof tool.renderResult, "function");

  const theme = {
    fg(token: string, text: string): string {
      return `«${token}:${text}»`;
    },
    bold(text: string): string {
      return `**${text}**`;
    },
  };
  const root = tempRepo();
  try {
    writeFixture(root, "# Demo\n\nnpm run check\nnpm test\n");
    const result = await tool.execute("call-6", { action: "check" }, undefined, undefined, {
      cwd: root,
    } as ExtensionContext);
    const component = tool.renderResult!(
      result,
      { expanded: false, isPartial: false },
      theme,
      { isError: false },
    ) as { render(width: number): string[] };
    const lines = component.render(500);
    assert.ok(lines.some((line) => line.includes("«error:✕»")), "error status row must render");
    assert.ok(lines.some((line) => line.includes("«accent:demo/README.md:»")), "finding groups must render");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("/doclint notifies in all modes, including print mode without UI dialogs", async () => {
  const { command } = registerExtension();
  assert.equal(command.name, "doclint");
  const root = tempRepo();
  const notifications: { message: string; type?: string }[] = [];
  const ctx = {
    cwd: root,
    mode: "print",
    hasUI: false,
    ui: {
      notify(message: string, type?: string) {
        notifications.push({ message, type });
      },
    },
  } as unknown as ExtensionCommandContext;
  try {
    writeFixture(root, "# Demo\n\nnpm run check\nnpm test\n");
    await command.handler("", ctx);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].type, "error");
    assert.match(notifications[0].message, /2 error\(s\)/);

    notifications.length = 0;
    await command.handler("..", ctx);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].type, "error");
    assert.match(notifications[0].message, /doclint failed: doc_lint root must be the workspace/);

    notifications.length = 0;
    fs.writeFileSync(path.join(root, "demo", "README.md"), DEMO_README);
    await command.handler("", ctx);
    assert.equal(notifications[0].type, "info");
    assert.match(notifications[0].message, /no findings/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
