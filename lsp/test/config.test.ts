import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, lspConfigPaths, matchingServers } from "../src/config.ts";
import type { LspConfig, ServerConfig } from "../src/types.ts";

function configuredServer(id: string, extensions: Record<string, string>): ServerConfig {
  return {
    id,
    command: ["fake-lsp"],
    extensions,
    rootMarkers: [],
    roles: ["navigation", "diagnostics", "actions"],
    priority: 1,
  };
}

function testConfig(servers: ServerConfig[]): LspConfig {
  return {
    idleTimeoutMs: 0,
    requestTimeoutMs: 1_000,
    diagnosticsSettleMs: 0,
    maxResults: 100,
    servers,
    loadedFrom: [],
  };
}

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

test("matchingServers accepts a unique language ID as a server selector", () => {
  const servers = matchingServers(
    testConfig([configuredServer("jdtls", { ".java": "java" })]),
    "/workspace/Main.java",
    "navigation",
    "java",
  );
  assert.deepEqual(servers.map((server) => server.id), ["jdtls"]);
});

test("matchingServers prioritizes exact IDs and rejects ambiguous language IDs", () => {
  const exact = matchingServers(
    testConfig([
      configuredServer("jdtls", { ".java": "java" }),
      configuredServer("java", { ".java": "java" }),
    ]),
    "/workspace/Main.java",
    "navigation",
    "java",
  );
  assert.deepEqual(exact.map((server) => server.id), ["java"]);

  assert.throws(
    () => matchingServers(
      testConfig([
        configuredServer("jdtls", { ".java": "java" }),
        configuredServer("eclipse-jdt", { ".java": "java" }),
      ]),
      "/workspace/Main.java",
      "navigation",
      "java",
    ),
    /LSP language id java is ambiguous.*(?:jdtls, eclipse-jdt|eclipse-jdt, jdtls)/,
  );
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
    [{ logLevel: "verbose" }, /logLevel must be one of error, warn, info, debug/],
    [{ logLevel: 1 }, /logLevel must be one of error, warn, info, debug/],
    [{ logEnabled: "no" }, /logEnabled must be a boolean/],
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

test("loadConfig accepts logEnabled and logLevel only in the global config", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-lsp-config-loglevel-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "workspace");
  const projectDir = join(cwd, ".pi");
  await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(projectDir, { recursive: true })]);
  try {
    await writeFile(join(agentDir, "lsp.json"), JSON.stringify({ logEnabled: true, logLevel: "debug" }));
    const globalOnly = await loadConfig(cwd, false, { agentDir });
    assert.equal(globalOnly.loadedFrom.length, 1);

    // Project-level logging keys would be silently ignored by the logger,
    // which reads only the global file at extension load, so they are rejected.
    await writeFile(join(projectDir, "lsp.json"), JSON.stringify({ logLevel: "debug" }));
    await assert.rejects(
      loadConfig(cwd, true, { agentDir }),
      /logLevel is only supported in the global config/,
    );
    await writeFile(join(projectDir, "lsp.json"), JSON.stringify({ logEnabled: false }));
    await assert.rejects(
      loadConfig(cwd, true, { agentDir }),
      /logEnabled is only supported in the global config/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
