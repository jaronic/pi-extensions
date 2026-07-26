import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

const dryRun = JSON.parse(run(npm, ["pack", "--dry-run", "--json"], packageRoot));
assert.equal(dryRun.length, 1);
const packedFiles = new Set(dryRun[0].files.map((file) => file.path));
for (const required of ["package.json", "README.md", "assets/empty-sgconfig.yml", "src/index.ts"]) {
  assert.equal(packedFiles.has(required), true, `packed artifact is missing ${required}`);
}
assert.equal([...packedFiles].some((path) => path.startsWith("test/")), false);

const scratch = await mkdtemp(join(tmpdir(), "pi-ast-grep-release-"));
try {
  const packDir = join(scratch, "pack");
  const installRoot = join(scratch, "install");
  const workspace = join(scratch, "workspace");
  await Promise.all([
    mkdir(packDir, { recursive: true }),
    mkdir(installRoot, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);
  const packed = JSON.parse(run(npm, ["pack", "--json", "--pack-destination", packDir], packageRoot));
  assert.equal(packed.length, 1);
  const tarball = join(packDir, packed[0].filename);
  await writeFile(join(installRoot, "package.json"), JSON.stringify({ private: true, type: "module" }), "utf8");
  run(npm, ["install", "--omit=dev", "--ignore-scripts", tarball], installRoot);

  const extensionRoot = join(installRoot, "node_modules", "pi-ast-grep-dev");
  const installedManifest = JSON.parse(await readFile(join(extensionRoot, "package.json"), "utf8"));
  assert.equal(installedManifest.version, "0.1.0");
  await assert.rejects(access(join(installRoot, "node_modules", "typescript", "package.json")));
  assert.equal(run(npm, ["ls", "--omit=dev", "--depth=0"], installRoot).includes("pi-ast-grep-dev@0.1.0"), true);

  const driver = join(packageRoot, "test", "packed-host-smoke.mjs");
  const output = run(process.execPath, [driver, installRoot, workspace], packageRoot);
  assert.match(output, /PACKED_PI_SMOKE_OK/u);

  await writeFile(join(workspace, "sample.ts"), "const value = oldName(first);\n", "utf8");
  const providerSource = await readFile(join(packageRoot, "test", "packed-smoke-provider.mjs"), "utf8");
  const providerPath = join(installRoot, "packed-smoke-provider.mjs");
  await writeFile(providerPath, providerSource, "utf8");
  const piCli = join(installRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  const cliOutput = run(process.execPath, [
    piCli,
    "--no-session",
    "--print",
    "--offline",
    "--approve",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--extension",
    extensionRoot,
    "--extension",
    providerPath,
    "--provider",
    "packed-smoke",
    "--model",
    "packed-smoke-model",
    "--api-key",
    "packed-smoke-key",
    "--tools",
    "ast_grep_search,ast_grep_edit,write",
    "Run the deterministic packed ast-grep smoke sequence.",
  ], workspace, { ...process.env, PACKED_SMOKE_API_KEY: "packed-smoke-key" });
  assert.match(cliOutput, /PACKED_PI_CLI_SMOKE_OK/u);
  assert.equal(await readFile(join(workspace, "sample.ts"), "utf8"), "const value = newName(first);\n");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
