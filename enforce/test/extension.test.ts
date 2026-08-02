import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import enforceExtension, { ENFORCE_NUDGE_TYPE, type EnforceExtensionDependencies } from "../src/index.ts";
import { loadConfig } from "../src/config.ts";
import { BUILTIN_RULES, normalizeRule } from "../src/rules.ts";
import type { EnforceConfig } from "../src/types.ts";
import { blockedDecision, EnforceHarness } from "./harness.ts";

function builtinConfig(): EnforceConfig {
  return {
    rules: Object.entries(BUILTIN_RULES).map(([id, input]) => normalizeRule(id, input, "builtin")),
    loadedFrom: [],
  };
}

function register(harness: EnforceHarness, overrides: EnforceExtensionDependencies = {}): void {
  const configLoader = overrides.configLoader ?? (async () => builtinConfig());
  enforceExtension(harness.api, { ...overrides, configLoader });
}

async function startSession(harness: EnforceHarness): Promise<void> {
  await harness.emit("session_start", { type: "session_start", reason: "startup" });
}

test("registers the /enforce command and lifecycle handlers, but no tools", () => {
  const harness = new EnforceHarness();
  register(harness);
  assert.equal(harness.commandRegistrationCounts.get("enforce"), 1);
  assert.equal(harness.lifecycleRegistrationCounts.get("session_start"), 1);
  assert.equal(harness.lifecycleRegistrationCounts.get("tool_call"), 1);
  assert.equal(harness.lifecycleRegistrationCounts.get("session_shutdown"), 1);
  assert.equal(harness.toolRegistrationCounts.size, 0);
});

test("nudge steers toward the recommended tool and fires at most once per session", async () => {
  const harness = new EnforceHarness(["read", "grep", "lsp"]);
  register(harness);
  await startSession(harness);

  const first = await harness.emitToolCall("grep", { pattern: "parseConfig", path: "src" });
  assert.equal(blockedDecision(first), undefined);
  assert.equal(harness.sentMessages.length, 1);
  const nudge = harness.sentMessages[0];
  assert.equal((nudge.message as { customType: string }).customType, ENFORCE_NUDGE_TYPE);
  assert.equal((nudge.message as { display: boolean }).display, false);
  assert.equal((nudge.options as { deliverAs: string }).deliverAs, "steer");
  assert.match((nudge.message as { content: string }).content, /workspace_symbols/);
  assert.match((nudge.message as { content: string }).content, /"query": "parseConfig"/);

  await harness.emitToolCall("grep", { pattern: "otherSymbol", path: "src" });
  assert.equal(harness.sentMessages.length, 1, "the same rule nudges only once per session");
});

test("nudge does not fire when the recommended tool is inactive", async () => {
  const harness = new EnforceHarness(["read", "grep"]);
  register(harness);
  await startSession(harness);
  await harness.emitToolCall("grep", { pattern: "parseConfig" });
  assert.equal(harness.sentMessages.length, 0);
});

test("unmatched calls pass through silently", async () => {
  const harness = new EnforceHarness(["read", "grep", "lsp"]);
  register(harness);
  await startSession(harness);
  const results = await harness.emitToolCall("grep", { pattern: "foo.*bar\\d+" });
  assert.deepEqual(results, [undefined]);
  assert.equal(harness.sentMessages.length, 0);
});

test("a gate rule blocks with a copyable replacement call", async () => {
  const root = await mkdtemp(join(tmpdir(), "enforce-ext-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "enforce.json"), JSON.stringify({
    rules: { "prefer-lsp-symbols-grep": { action: "gate" } },
  }));
  const harness = new EnforceHarness(["read", "grep", "lsp"], true, { cwd: join(root, "project") });
  register(harness, { configLoader: (cwd, includeProject) => loadConfig(cwd, includeProject, { agentDir }) });
  await startSession(harness);

  const results = await harness.emitToolCall("grep", { pattern: "parseConfig" });
  const blocked = blockedDecision(results);
  assert.ok(blocked);
  assert.match(blocked.reason, /Suggested replacement call:/);
  assert.match(blocked.reason, /"query": "parseConfig"/);
  assert.equal(harness.sentMessages.length, 0, "gates block instead of steering");

  // Gates keep blocking: every repeated call is rejected.
  const again = await harness.emitToolCall("grep", { pattern: "parseConfig" });
  assert.ok(blockedDecision(again));
});

test("a failed nudge delivery never breaks the original call", async () => {
  const harness = new EnforceHarness(["read", "grep", "lsp"]);
  register(harness);
  await startSession(harness);
  harness.failNextSendMessage = new Error("session busy");
  const results = await harness.emitToolCall("grep", { pattern: "parseConfig" });
  assert.deepEqual(results, [undefined]);
});

test("invalid config fails closed and warns once at session start", async () => {
  const root = await mkdtemp(join(tmpdir(), "enforce-ext-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "enforce.json"), "{ broken");
  const harness = new EnforceHarness(["read", "grep", "lsp"], true, { cwd: join(root, "project") });
  register(harness, { configLoader: (cwd, includeProject) => loadConfig(cwd, includeProject, { agentDir }) });
  await startSession(harness);

  assert.match(harness.notifications.at(-1)?.message ?? "", /Invalid enforce configuration/);
  assert.equal(harness.notifications.at(-1)?.type, "warning");

  // Built-in nudge rules still apply.
  await harness.emitToolCall("grep", { pattern: "parseConfig" });
  assert.equal(harness.sentMessages.length, 1);
});

test("headless sessions still nudge and never touch UI notifications", async () => {
  const root = await mkdtemp(join(tmpdir(), "enforce-ext-"));
  const agentDir = join(root, "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "enforce.json"), "{ broken");
  const harness = new EnforceHarness(["read", "grep", "lsp"], false, { cwd: join(root, "project") });
  register(harness, { configLoader: (cwd, includeProject) => loadConfig(cwd, includeProject, { agentDir }) });
  await startSession(harness);
  assert.equal(harness.notifications.length, 0, "no UI path is exercised without a UI");
  await harness.emitToolCall("grep", { pattern: "parseConfig" });
  assert.equal(harness.sentMessages.length, 1);
});

test("/enforce status, rules, reload, and unknown actions", async () => {
  const harness = new EnforceHarness(["read", "grep", "lsp"]);
  register(harness);
  await startSession(harness);

  await harness.command("enforce", "status");
  assert.match(harness.notifications.at(-1)?.message ?? "", /5 rule\(s\) active \(0 gate, 5 nudge\)/);

  await harness.emitToolCall("grep", { pattern: "parseConfig" });
  await harness.command("enforce");
  assert.match(harness.notifications.at(-1)?.message ?? "", /1 nudge\(s\) sent this session/);

  await harness.command("enforce", "rules");
  assert.match(harness.notifications.at(-1)?.message ?? "", /prefer-lsp-symbols-grep \[nudge, builtin, requires lsp active\] → grep/);

  await harness.command("enforce", "reload");
  assert.match(harness.notifications.at(-1)?.message ?? "", /Enforce reloaded: 5 rule\(s\) active/);

  await harness.command("enforce", "nonsense");
  assert.equal(harness.notifications.at(-1)?.type, "error");
  assert.match(harness.notifications.at(-1)?.message ?? "", /Unknown \/enforce action/);
});

test("reload resets the once-per-session nudge memory", async () => {
  const harness = new EnforceHarness(["read", "grep", "lsp"]);
  register(harness);
  await startSession(harness);
  await harness.emitToolCall("grep", { pattern: "parseConfig" });
  assert.equal(harness.sentMessages.length, 1);
  await harness.command("enforce", "reload");
  await harness.emitToolCall("grep", { pattern: "parseConfig" });
  assert.equal(harness.sentMessages.length, 2);
});

test("session_shutdown is idempotent and clears loaded state", async () => {
  const harness = new EnforceHarness(["read", "grep", "lsp"]);
  register(harness);
  await startSession(harness);
  await harness.emit("session_shutdown", { type: "session_shutdown" });
  await harness.emit("session_shutdown", { type: "session_shutdown" });
  await harness.command("enforce", "status");
  assert.match(harness.notifications.at(-1)?.message ?? "", /rules not loaded yet/);
});
