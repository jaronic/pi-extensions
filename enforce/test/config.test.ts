import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { enforceConfigPaths, loadConfig } from "../src/config.ts";
import { BUILTIN_RULES } from "../src/rules.ts";

async function makeDirs(): Promise<{ agentDir: string; projectDir: string; cwd: string }> {
  const root = await mkdtemp(join(tmpdir(), "enforce-config-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const projectDir = join(cwd, ".pi");
  await mkdir(agentDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  return { agentDir, projectDir, cwd };
}

test("without config files only built-in nudge rules are active", async () => {
  const { agentDir, cwd } = await makeDirs();
  const config = await loadConfig(cwd, true, { agentDir });
  assert.equal(config.error, undefined);
  assert.deepEqual(config.loadedFrom, []);
  assert.equal(config.rules.length, Object.keys(BUILTIN_RULES).length);
  assert.ok(config.rules.every((rule) => rule.action === "nudge" && rule.source === "builtin"));
});

test("global config upgrades a built-in rule to gate and adds custom rules", async () => {
  const { agentDir, cwd } = await makeDirs();
  await writeFile(join(agentDir, "enforce.json"), JSON.stringify({
    rules: {
      "prefer-lsp-symbols-grep": { action: "gate" },
      "no-curl": {
        tool: "bash",
        action: "gate",
        message: "Use the request UI instead of curl.",
        paramField: "command",
        paramPattern: "\\bcurl\\b",
      },
    },
  }));
  const config = await loadConfig(cwd, true, { agentDir });
  assert.equal(config.error, undefined);
  assert.deepEqual(config.loadedFrom, [join(agentDir, "enforce.json")]);
  const upgraded = config.rules.find((rule) => rule.id === "prefer-lsp-symbols-grep");
  assert.equal(upgraded?.action, "gate");
  assert.equal(upgraded?.source, "global");
  const custom = config.rules.find((rule) => rule.id === "no-curl");
  assert.equal(custom?.action, "gate");
});

test("project config overrides global and honors project trust", async () => {
  const { agentDir, projectDir, cwd } = await makeDirs();
  await writeFile(join(agentDir, "enforce.json"), JSON.stringify({
    rules: { "prefer-lsp-symbols-grep": { message: "global message" } },
  }));
  await writeFile(join(projectDir, "enforce.json"), JSON.stringify({
    rules: { "prefer-lsp-symbols-grep": { message: "project message", once: false } },
  }));
  const trusted = await loadConfig(cwd, true, { agentDir });
  const rule = trusted.rules.find((candidate) => candidate.id === "prefer-lsp-symbols-grep");
  assert.equal(rule?.message, "project message");
  assert.equal(rule?.source, "project");
  assert.equal(rule?.once, false);
  assert.equal(trusted.loadedFrom.length, 2);

  const untrusted = await loadConfig(cwd, false, { agentDir });
  const untrustedRule = untrusted.rules.find((candidate) => candidate.id === "prefer-lsp-symbols-grep");
  assert.equal(untrustedRule?.message, "global message");
  assert.equal(untrusted.loadedFrom.length, 1);
});

test("disabled removes a built-in rule", async () => {
  const { agentDir, cwd } = await makeDirs();
  await writeFile(join(agentDir, "enforce.json"), JSON.stringify({
    rules: { "prefer-ast-grep-edit-sed": { disabled: true } },
  }));
  const config = await loadConfig(cwd, true, { agentDir });
  assert.equal(config.rules.some((rule) => rule.id === "prefer-ast-grep-edit-sed"), false);
});

test("malformed JSON fails closed to built-in nudge rules", async () => {
  const { agentDir, cwd } = await makeDirs();
  await writeFile(join(agentDir, "enforce.json"), "{ not json");
  const config = await loadConfig(cwd, true, { agentDir });
  assert.match(config.error ?? "", /Invalid enforce configuration/);
  assert.deepEqual(config.loadedFrom, []);
  assert.equal(config.rules.length, Object.keys(BUILTIN_RULES).length);
  assert.ok(config.rules.every((rule) => rule.action === "nudge"));
});

test("unknown keys, bad regex, and wrong types all fail closed", async () => {
  const cases = [
    { root: { surprise: true }, label: /unknown property surprise/ },
    { root: { rules: { "x": { tool: "grep", action: "nudge", message: "m", bogus: 1 } } }, label: /unknown property bogus/ },
    { root: { rules: { "x": { tool: "grep", action: "nudge", message: "m", paramField: "p", paramPattern: "([" } } }, label: /does not compile/ },
    { root: { rules: { "x": { tool: "grep", action: "block", message: "m" } } }, label: /action must be/ },
    { root: { rules: [] }, label: /rules must be an object/ },
  ];
  for (const { root, label } of cases) {
    const { agentDir, cwd } = await makeDirs();
    await writeFile(join(agentDir, "enforce.json"), JSON.stringify(root));
    const config = await loadConfig(cwd, true, { agentDir });
    assert.match(config.error ?? "", label);
    assert.ok(config.rules.every((rule) => rule.action === "nudge" && rule.source === "builtin"));
  }
});

test("a broken project config also discards a valid global config (fail closed)", async () => {
  const { agentDir, projectDir, cwd } = await makeDirs();
  await writeFile(join(agentDir, "enforce.json"), JSON.stringify({
    rules: { "prefer-lsp-symbols-grep": { action: "gate" } },
  }));
  await writeFile(join(projectDir, "enforce.json"), JSON.stringify({ rules: { x: 1 } }));
  const config = await loadConfig(cwd, true, { agentDir });
  assert.match(config.error ?? "", /must be an object/);
  assert.ok(config.rules.every((rule) => rule.action === "nudge"));
});

test("enforceConfigPaths uses CONFIG_DIR_NAME for the project layer", () => {
  const paths = enforceConfigPaths("/work", true, { agentDir: "/agent" });
  assert.equal(paths[0], "/agent/enforce.json");
  assert.match(paths[1] ?? "", /^\/work\//);
  assert.match(paths[1] ?? "", /enforce\.json$/);
  assert.equal(enforceConfigPaths("/work", false, { agentDir: "/agent" }).length, 1);
});
