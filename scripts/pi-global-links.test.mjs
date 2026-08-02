import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = dirname(SCRIPT_DIRECTORY);
const SCRIPT = join(SCRIPT_DIRECTORY, "pi-global-links.sh");
const EXTENSIONS = ["goal", "plan", "lsp", "ast-grep", "hashline", "request", "rg", "todo", "jaron", "diffreport", "telemetry", "enforce", "notify", "doclint", "loop"];
const THEMES = readdirSync(join(REPOSITORY_ROOT, "themes"))
  .filter((name) => /^pi-extensions-.*\.json$/.test(name))
  .sort();

function createAgentDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "pi global links-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "agent");
}

function run(agentDirectory, ...arguments_) {
  return spawnSync("/bin/sh", [SCRIPT, ...arguments_], {
    encoding: "utf8",
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDirectory,
    },
  });
}

function assertSucceeded(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function assertManagedLink(agentDirectory, category, name, expectedSource) {
  const target = join(agentDirectory, category, name);
  assert.equal(lstatSync(target).isSymbolicLink(), true);
  assert.equal(realpathSync(resolve(dirname(target), readlinkSync(target))), realpathSync(expectedSource));
}

test("status is read-only when the Pi agent directory is absent", (t) => {
  const agentDirectory = createAgentDirectory(t);
  const result = run(agentDirectory, "status");

  assertSucceeded(result);
  assert.match(result.stdout, new RegExp(`Summary: 0 on, ${EXTENSIONS.length + THEMES.length} off, 0 conflicts`));
  assert.equal(existsSync(agentDirectory), false);
});

test("help lists all fifteen managed extensions", (t) => {
  const result = run(createAgentDirectory(t), "--help");
  assertSucceeded(result);
  assert.match(result.stdout, /Fifteen extensions/u);
  for (const name of EXTENSIONS) assert.match(result.stdout, new RegExp(`\\b${name}\\b`, "u"));
});

test("extension links are idempotent and leave unrelated resources untouched", (t) => {
  const agentDirectory = createAgentDirectory(t);

  assertSucceeded(run(agentDirectory, "on", "extensions"));
  assertSucceeded(run(agentDirectory, "on", "extensions"));
  for (const name of EXTENSIONS) {
    assertManagedLink(agentDirectory, "extensions", name, join(REPOSITORY_ROOT, name));
  }

  const unrelated = join(agentDirectory, "extensions", "third-party");
  mkdirSync(unrelated, { recursive: true });
  assertSucceeded(run(agentDirectory, "off", "extensions"));
  assertSucceeded(run(agentDirectory, "off", "extensions"));

  for (const name of EXTENSIONS) assert.equal(existsSync(join(agentDirectory, "extensions", name)), false);
  assert.equal(existsSync(unrelated), true);
});

test("conflicts abort before any managed link changes", (t) => {
  const agentDirectory = createAgentDirectory(t);
  const conflictingTarget = join(agentDirectory, "extensions", "goal");
  mkdirSync(conflictingTarget, { recursive: true });

  const result = run(agentDirectory, "on", "extensions");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Managed target conflicts detected; no changes made/);
  assert.equal(lstatSync(conflictingTarget).isDirectory(), true);
  for (const name of EXTENSIONS.filter((name) => name !== "goal")) {
    assert.equal(existsSync(join(agentDirectory, "extensions", name)), false);
  }
});

test("active managed themes must be changed before theme links are disabled", (t) => {
  const agentDirectory = createAgentDirectory(t);
  mkdirSync(agentDirectory, { recursive: true });
  const settingsPath = join(agentDirectory, "settings.json");
  const originalSettings = "{\n  \"theme\": \"pi-extensions-graphite\",\n  \"untouched\": true\n}\n";
  writeFileSync(settingsPath, originalSettings);

  assertSucceeded(run(agentDirectory, "on", "themes"));
  const blocked = run(agentDirectory, "off", "themes");

  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /Cannot disable managed theme links/);
  assert.equal(readFileSync(settingsPath, "utf8"), originalSettings);
  for (const name of THEMES) {
    assertManagedLink(agentDirectory, "themes", name, join(REPOSITORY_ROOT, "themes", name));
  }

  writeFileSync(settingsPath, "{\n  \"theme\": \"dark\"\n}\n");
  assertSucceeded(run(agentDirectory, "off", "themes"));
  for (const name of THEMES) assert.equal(existsSync(join(agentDirectory, "themes", name)), false);
  assertSucceeded(run(agentDirectory, "on", "themes"));
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).theme, "dark");
});

test("paired managed themes are also protected", (t) => {
  const agentDirectory = createAgentDirectory(t);
  mkdirSync(agentDirectory, { recursive: true });
  writeFileSync(
    join(agentDirectory, "settings.json"),
    "{\"theme\":\"pi-extensions-paper/pi-extensions-graphite\"}\n",
  );

  assertSucceeded(run(agentDirectory, "on", "themes"));
  const result = run(agentDirectory, "off", "themes");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Choose a built-in theme through \/settings/);
});

test("toggle enables an incomplete scope and disables a fully enabled scope", (t) => {
  const agentDirectory = createAgentDirectory(t);
  mkdirSync(join(agentDirectory, "extensions"), { recursive: true });
  symlinkSync(join(REPOSITORY_ROOT, "goal"), join(agentDirectory, "extensions", "goal"), "dir");

  assertSucceeded(run(agentDirectory, "toggle", "extensions"));
  for (const name of EXTENSIONS) assert.equal(existsSync(join(agentDirectory, "extensions", name)), true);

  assertSucceeded(run(agentDirectory, "toggle", "extensions"));
  for (const name of EXTENSIONS) assert.equal(existsSync(join(agentDirectory, "extensions", name)), false);
});

test("off refuses foreign targets without removing owned links", (t) => {
  const agentDirectory = createAgentDirectory(t);
  assertSucceeded(run(agentDirectory, "on", "extensions"));

  const goalTarget = join(agentDirectory, "extensions", "goal");
  unlinkSync(goalTarget);
  mkdirSync(goalTarget);

  const result = run(agentDirectory, "off", "extensions");

  assert.equal(result.status, 1);
  assert.equal(lstatSync(goalTarget).isDirectory(), true);
  assert.equal(lstatSync(join(agentDirectory, "extensions", "plan")).isSymbolicLink(), true);
});
