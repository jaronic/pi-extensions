import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, lspConfigPaths } from "../src/config.ts";

test("lspConfigPaths uses injected Pi global and project directory names", () => {
  assert.deepEqual(
    lspConfigPaths("/workspace", true, { agentDir: "/agent", projectConfigDirName: ".custom-pi" }),
    ["/agent/lsp.json", "/workspace/.custom-pi/lsp.json"],
  );
  assert.deepEqual(lspConfigPaths("/workspace", false, { agentDir: "/agent" }), ["/agent/lsp.json"]);
});

test("loadConfig applies trusted project config after global config", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lsp-config-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  const projectDir = join(cwd, ".custom-pi");
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(projectDir, { recursive: true })]);
  const globalPath = join(agentDir, "lsp.json");
  const projectPath = join(projectDir, "lsp.json");
  try {
    await writeFile(globalPath, JSON.stringify({
      maxResults: 25,
      servers: {
        test: {
          command: "node",
          fileTypes: [".test"],
          languageId: "plaintext",
          priority: 1,
        },
      },
    }));
    await writeFile(projectPath, JSON.stringify({ maxResults: 5, servers: { test: { priority: 9 } } }));

    const trusted = await loadConfig(cwd, true, { agentDir, projectConfigDirName: ".custom-pi" });
    assert.equal(trusted.maxResults, 5);
    assert.deepEqual(trusted.loadedFrom, [globalPath, projectPath]);
    assert.equal(trusted.servers.find(({ id }) => id === "test")?.priority, 9);

    const untrusted = await loadConfig(cwd, false, { agentDir, projectConfigDirName: ".custom-pi" });
    assert.equal(untrusted.maxResults, 25);
    assert.deepEqual(untrusted.loadedFrom, [globalPath]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadConfig reports the malformed config source", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lsp-config-invalid-"));
  const path = join(root, "lsp.json");
  try {
    await writeFile(path, "{");
    await assert.rejects(
      loadConfig(join(root, "workspace"), false, { agentDir: root }),
      (error: Error) => error.message.includes(path),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadConfig rejects unknown properties, wrong types, and unsafe bounds", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lsp-config-strict-"));
  const path = join(root, "lsp.json");
  const cases: Array<[unknown, RegExp]> = [
    [{ maxReslts: 1 }, /unknown property maxReslts/],
    [{ idleTimeoutMs: 2_147_483_648 }, /no greater than 2147483647/],
    [{ maxResults: 501 }, /no greater than 500/],
    [{ servers: { bad: { disabled: "false" } } }, /disabled must be a boolean/],
    [{ servers: { bad: { env: ["TOKEN"] } } }, /env must be an object with string values/],
    [{ servers: { bad: { priority: "high" } } }, /priority must be a finite number/],
    [{ servers: { bad: { readyNotification: { method: "ready", typo: true } } } }, /unknown property typo/],
  ];
  try {
    for (const [value, pattern] of cases) {
      await writeFile(path, JSON.stringify(value));
      await assert.rejects(loadConfig(join(root, "workspace"), false, { agentDir: root }), pattern);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
