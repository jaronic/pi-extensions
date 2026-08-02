import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RequestService } from "pi-request-ui-dev";
import diffreportExtension from "../src/index.ts";
import { DiffReportCallLedger } from "../src/call-ledger.ts";

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
    assert.match(notifications[0]?.message ?? "", /Business-logic exploration started/);
    // No agent actually wrote the report, so the handler must not report success:
    // the final notification is the artifact-verification failure.
    assert.match(notifications.at(-1)?.message ?? "", /no report exists at reports\/diffreport\/payment\.md/);
    assert.equal(notifications.at(-1)?.type, "error");
  } finally {
    await Promise.all(shutdownHandlers.map((handler) => handler()));
    await rm(workspace, { recursive: true, force: true });
  }
});

test("extension queues behind a busy agent and verifies the written report artifact", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "diffreport-busy-"));
  const commands = new Map<string, RegisteredCommand>();
  const shutdownHandlers: Array<() => Promise<void>> = [];
  const userMessages: Array<{ content: string; options?: { deliverAs?: string } }> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  let turnActive = true;
  let waitForIdleCalls = 0;

  try {
    await run("git", ["init", "-b", "main"], workspace);
    await run("git", ["config", "user.email", "diffreport@example.com"], workspace);
    await run("git", ["config", "user.name", "Diffreport Test"], workspace);
    await writeFile(join(workspace, "a.ts"), "export const a = 1;\n");
    await run("git", ["add", "a.ts"], workspace);
    await run("git", ["commit", "-m", "init"], workspace);

    const pi = {
      events: {},
      registerTool() {},
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
      },
    } as unknown as ExtensionAPI;
    const requestService: RequestService = {
      lifetime: new AbortController().signal,
      async request() {
        throw new Error("Explicit command input must not open Request.");
      },
    };
    const callLedger = new DiffReportCallLedger();
    diffreportExtension(pi, {
      requestService,
      callLedger,
      now: () => new Date("2026-07-29T12:34:56.000Z"),
    });

    const command = commands.get("diff_report");
    assert.ok(command);
    const reportPath = join(workspace, "reports", "diffreport", "queued.md");
    await command.handler("uncommitted --output reports/diffreport/queued.md", {
      cwd: workspace,
      mode: "print",
      hasUI: false,
      signal: undefined,
      isIdle: () => !turnActive,
      async waitForIdle() {
        waitForIdleCalls++;
        if (waitForIdleCalls === 1) {
          // Current turn drained; the queued followUp exploration turn starts.
          turnActive = true;
        } else {
          // Exploration turn finished: the agent ran the mandated evidence
          // passes and wrote a contract-compliant report artifact.
          turnActive = false;
          callLedger.record("uncommitted", "overview");
          callLedger.record("uncommitted", "patch");
          await mkdir(join(workspace, "reports", "diffreport"), { recursive: true });
          await writeFile(reportPath, [
            "# Queued report",
            "",
            "Direct answer with [E1].",
            "",
            "```mermaid",
            "flowchart TD",
            "  A --> B",
            "```",
            "",
            "## Evidence index",
            "",
            "| ID | Type |",
          ].join("\n"));
        }
      },
      ui: {
        notify(message: string, type?: string) {
          notifications.push({ message, type });
        },
      },
    });

    assert.equal(userMessages.length, 1);
    assert.equal(userMessages[0]?.options?.deliverAs, "followUp");
    // The handler waited for both the current turn and the queued exploration turn.
    assert.equal(waitForIdleCalls, 2);
    assert.match(notifications[0]?.message ?? "", /queued behind the current turn/);
    assert.match(notifications.at(-1)?.message ?? "", /Diff report written: reports\/diffreport\/queued\.md$/);
    assert.equal(notifications.at(-1)?.type, "info");
  } finally {
    await Promise.all(shutdownHandlers.map((handler) => handler()));
    await rm(workspace, { recursive: true, force: true });
  }
});

test("extension reports contract warnings when the artifact skips evidence discipline", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "diffreport-warning-"));
  const commands = new Map<string, RegisteredCommand>();
  const shutdownHandlers: Array<() => Promise<void>> = [];
  const notifications: Array<{ message: string; type?: string }> = [];
  let turnActive = false;

  try {
    await run("git", ["init", "-b", "main"], workspace);
    await run("git", ["config", "user.email", "diffreport@example.com"], workspace);
    await run("git", ["config", "user.name", "Diffreport Test"], workspace);
    await writeFile(join(workspace, "a.ts"), "export const a = 1;\n");
    await run("git", ["add", "a.ts"], workspace);
    await run("git", ["commit", "-m", "init"], workspace);

    const pi = {
      events: {},
      registerTool() {},
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
      sendUserMessage() {
        turnActive = true;
      },
    } as unknown as ExtensionAPI;
    const requestService: RequestService = {
      lifetime: new AbortController().signal,
      async request() {
        throw new Error("Explicit command input must not open Request.");
      },
    };
    diffreportExtension(pi, {
      requestService,
      now: () => new Date("2026-07-29T12:34:56.000Z"),
    });

    const command = commands.get("diff_report");
    assert.ok(command);
    await command.handler("uncommitted --output reports/diffreport/warning.md", {
      cwd: workspace,
      mode: "print",
      hasUI: false,
      signal: undefined,
      isIdle: () => !turnActive,
      async waitForIdle() {
        // The agent wrote a report without evidence IDs, without an evidence
        // index, and without a single diff_report evidence pass.
        turnActive = false;
        await mkdir(join(workspace, "reports", "diffreport"), { recursive: true });
        await writeFile(join(workspace, "reports", "diffreport", "warning.md"), "# Thin report\n\nNo evidence here.\n");
      },
      ui: {
        notify(message: string, type?: string) {
          notifications.push({ message, type });
        },
      },
    });

    const last = notifications.at(-1);
    assert.equal(last?.type, "warning");
    assert.match(last?.message ?? "", /contract warnings/);
    assert.match(last?.message ?? "", /no inline evidence IDs/);
    assert.match(last?.message ?? "", /no evidence index section/);
    assert.match(last?.message ?? "", /no diff_report overview pass/);
    assert.match(last?.message ?? "", /no targeted diff_report patch\/history pass/);
  } finally {
    await Promise.all(shutdownHandlers.map((handler) => handler()));
    await rm(workspace, { recursive: true, force: true });
  }
});

test("tool truncates an oversized overview diff and reports it in details and text", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "diffreport-toolcap-"));
  const tools = new Map<string, RegisteredTool>();
  const shutdownHandlers: Array<() => Promise<void>> = [];

  try {
    await run("git", ["init", "-b", "main"], workspace);
    await run("git", ["config", "user.email", "diffreport@example.com"], workspace);
    await run("git", ["config", "user.name", "Diffreport Test"], workspace);
    const original = Array.from({ length: 4_000 }, (_, index) => `const line${index} = "${"x".repeat(60)}";`).join("\n") + "\n";
    await writeFile(join(workspace, "huge.ts"), original);
    await run("git", ["add", "huge.ts"], workspace);
    await run("git", ["commit", "-m", "baseline"], workspace);
    const changed = Array.from({ length: 4_000 }, (_, index) => `const line${index} = "${"y".repeat(60)}"; // changed`).join("\n") + "\n";
    await writeFile(join(workspace, "huge.ts"), changed);

    const pi = {
      events: {},
      registerTool(tool: RegisteredTool & { name: string }) {
        tools.set(tool.name, tool);
      },
      registerCommand() {},
      on(event: string, handler: () => Promise<void>) {
        if (event === "session_shutdown") shutdownHandlers.push(handler);
      },
      async exec(command: string, args: string[], options: { cwd: string; signal?: AbortSignal; timeout?: number }) {
        const result = await run(command, args, options.cwd, options.signal, options.timeout);
        return { ...result, code: 0, killed: false };
      },
      sendUserMessage() {},
    } as unknown as ExtensionAPI;
    const requestService: RequestService = {
      lifetime: new AbortController().signal,
      async request() {
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
      "cap",
      { source: "uncommitted", view: "overview" },
      undefined,
      undefined,
      { cwd: workspace },
    );
    assert.equal(overview.details.truncated, true);
    assert.equal(overview.details.totalFiles, 1);
    assert.match(overview.content[0]?.text ?? "", /Evidence collection truncated/);
    assert.match(overview.content[0]?.text ?? "", /tracked diff capped at 512\.0KB/);

    // The patch view uses a larger cap; the same diff fits the collection cap
    // (no collection-truncation notice), even though the formatted output may
    // still hit the host's own 50KB output bound.
    const patch = await tool.execute(
      "cap-patch",
      { source: "uncommitted", view: "patch" },
      undefined,
      undefined,
      { cwd: workspace },
    );
    assert.doesNotMatch(patch.content[0]?.text ?? "", /Evidence collection truncated/);
    assert.match(patch.content[0]?.text ?? "", /-const line0 = "/);
  } finally {
    await Promise.all(shutdownHandlers.map((handler) => handler()));
    await rm(workspace, { recursive: true, force: true });
  }
});
