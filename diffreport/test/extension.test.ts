import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RequestService } from "pi-request-ui-dev";
import diffreportExtension from "../src/index.ts";

interface RegisteredTool {
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: { cwd: string },
  ): Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
}

interface RegisteredCommand {
  handler(args: string, context: Record<string, unknown>): Promise<void>;
}

function run(command: string, args: string[], cwd: string, signal?: AbortSignal, timeout?: number): Promise<{ stdout: string; stderr: string }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ stdout: string; stderr: string }>();
  execFile(command, args, {
    cwd,
    signal,
    timeout,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }, (error, stdout, stderr) => {
    if (error) reject(error);
    else resolve({ stdout, stderr });
  });
  return promise;
}

test("extension explores real Git evidence and launches a Markdown business report", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "diffreport-extension-"));
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, RegisteredCommand>();
  const shutdownHandlers: Array<() => Promise<void>> = [];
  const userMessages: Array<{ content: string; options?: { deliverAs?: string } }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  let requestCalls = 0;
  let turnActive = false;
  let waitForIdleCalls = 0;

  try {
    await run("git", ["init", "-b", "main"], workspace);
    await run("git", ["config", "user.email", "diffreport@example.com"], workspace);
    await run("git", ["config", "user.name", "Diffreport Test"], workspace);
    await writeFile(join(workspace, "payment.ts"), "export function charge() { return 'created'; }\n");
    await run("git", ["add", "payment.ts"], workspace);
    await run("git", ["commit", "-m", "Create payment flow"], workspace);
    await run("git", ["checkout", "-b", "feature/payment"], workspace);
    await writeFile(join(workspace, "payment.ts"), "export function charge() { return 'retryable'; }\n");
    await run("git", ["add", "payment.ts"], workspace);
    await run("git", ["commit", "-m", "Add payment retry", "-m", "Preserve the original payment intent."], workspace);
    await writeFile(join(workspace, "payment.ts"), "export function charge() { return 'retrying'; }\n");
    await writeFile(join(workspace, "retry-policy.ts"), "export const maxAttempts = 3;\n");

    const pi = {
      events: {},
      registerTool(tool: RegisteredTool & { name: string }) {
        tools.set(tool.name, tool);
      },
      registerCommand(name: string, command: RegisteredCommand) {
        commands.set(name, command);
      },
      on(event: string, handler: () => Promise<void>) {
        if (event === "session_shutdown") shutdownHandlers.push(handler);
      },
      async exec(command: string, args: string[], options: { cwd: string; signal?: AbortSignal; timeout?: number }) {
        const result = await run(command, args, options.cwd, options.signal, options.timeout);
        return { ...result, code: 0, killed: false };
      },
      sendUserMessage(content: string, options?: { deliverAs?: string }) {
        userMessages.push({ content, ...(options ? { options } : {}) });
        turnActive = true;
      },
    } as unknown as ExtensionAPI;
    const requestService: RequestService = {
      lifetime: new AbortController().signal,
      async request() {
        requestCalls++;
        throw new Error("Explicit command input must not open Request.");
      },
    };
    diffreportExtension(pi, {
      requestService,
      now: () => new Date("2026-07-29T12:34:56.000Z"),
    });

    const tool = tools.get("diff_report");
    assert.ok(tool);
    const overview = await tool.execute(
      "overview",
      { source: "uncommitted", view: "overview" },
      undefined,
      undefined,
      { cwd: workspace },
    );
    assert.match(overview.content[0]?.text ?? "", /payment\.ts/);
    assert.match(overview.content[0]?.text ?? "", /retry-policy\.ts/);
    assert.equal(overview.details.totalFiles, 1);
    assert.equal(overview.details.untrackedCount, 1);

    const patch = await tool.execute(
      "patch",
      { source: "uncommitted", view: "patch", paths: ["payment.ts"] },
      undefined,
      undefined,
      { cwd: workspace },
    );
    assert.match(patch.content[0]?.text ?? "", /-export function charge\(\) \{ return 'retryable'; \}/);
    assert.match(patch.content[0]?.text ?? "", /\+export function charge\(\) \{ return 'retrying'; \}/);

    const history = await tool.execute(
      "history",
      { source: "branch", target: "feature/payment", base: "main", view: "history" },
      undefined,
      undefined,
      { cwd: workspace },
    );
    assert.match(history.content[0]?.text ?? "", /Add payment retry/);
    assert.match(history.content[0]?.text ?? "", /Preserve the original payment intent/);

    const command = commands.get("diff_report");
    assert.ok(command);
    await command.handler(
      "branch feature/payment 支付失败后的重试 --base main --output reports/diffreport/payment.md",
      {
        cwd: workspace,
        mode: "print",
        hasUI: false,
        signal: undefined,
        isIdle: () => !turnActive,
        async waitForIdle() {
          waitForIdleCalls++;
          turnActive = false;
        },
        ui: {
          notify(message: string, type?: string) {
            notifications.push({ message, type });
          },
        },
      },
    );
    assert.equal(requestCalls, 0);
    assert.equal(userMessages.length, 1);
    assert.equal(waitForIdleCalls, 1);
    assert.match(userMessages[0]?.content ?? "", /"userContext": "支付失败后的重试"/);
    assert.match(userMessages[0]?.content ?? "", /must not filter commits, files, or evidence/);
    assert.match(userMessages[0]?.content ?? "", /reports\/diffreport\/payment\.md/);
    assert.match(userMessages[0]?.content ?? "", /Mermaid flow\/sequence\/state diagrams/);
    assert.match(notifications.at(-1)?.message ?? "", /Business-logic exploration started/);
  } finally {
    await Promise.all(shutdownHandlers.map((handler) => handler()));
    await rm(workspace, { recursive: true, force: true });
  }
});
