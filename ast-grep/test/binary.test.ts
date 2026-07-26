import assert from "node:assert/strict";
import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
  assertArgvBudget,
  BinaryManager,
  buildBoundedEnv,
  platformPackage,
} from "../src/binary.ts";
import { markTerminalCause } from "../src/operations.ts";
import { NativeScheduler } from "../src/scheduler.ts";
import { operationRecord, temporaryWorkspace } from "./helpers.ts";

const glibcReport = {
  getReport: () => ({ header: { glibcVersionRuntime: "2.36" } }),
} as unknown as typeof process.report;

function requirePosixExecutableFixture(t: TestContext): boolean {
  if (process.platform !== "win32") {
    return true;
  }
  t.skip("this fault-injection fixture is a POSIX shebang executable; Windows real .exe coverage remains mandatory");
  return false;
}

async function binaryFixture(root: string, version = "0.45.0", program?: string): Promise<{
  extensionRoot: string;
  packageJson: string;
  binaryPath: string;
}> {
  const extensionRoot = join(root, "extension");
  const packageRoot = join(root, "native-package");
  const binaryPath = join(packageRoot, "ast-grep");
  await mkdir(join(extensionRoot, "assets"), { recursive: true });
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(extensionRoot, "assets", "empty-sgconfig.yml"), "ruleDirs: []", "ascii");
  const packageJson = join(packageRoot, "package.json");
  await writeFile(packageJson, JSON.stringify({ name: "fake-native", version }), "utf8");
  await writeFile(binaryPath, `#!${process.execPath}\n${program ?? `process.stdout.write("ast-grep ${version}\\n");`}\n`, "utf8");
  await chmod(binaryPath, 0o755);
  return { extensionRoot, packageJson, binaryPath };
}

test("platform resolver accepts only the pinned supported tuples", () => {
  assert.equal(platformPackage("darwin", "arm64"), "@ast-grep/cli-darwin-arm64");
  assert.equal(platformPackage("darwin", "x64"), "@ast-grep/cli-darwin-x64");
  assert.equal(platformPackage("win32", "x64"), "@ast-grep/cli-win32-x64-msvc");
  assert.equal(platformPackage("linux", "arm64", glibcReport), "@ast-grep/cli-linux-arm64-gnu");
  assert.equal(platformPackage("linux", "x64", glibcReport), "@ast-grep/cli-linux-x64-gnu");
  assert.throws(() => platformPackage("linux", "x64", undefined), /glibc is required/u);
  assert.throws(() => platformPackage("freebsd", "x64"), /unsupported on freebsd\/x64/u);
  assert.throws(() => platformPackage("darwin", "ppc64"), /unsupported/u);
});

test("the current native runner matches its declared tuple and package-local binary", async () => {
  const packagesByTuple: Readonly<Record<string, string>> = {
    "darwin-arm64": "@ast-grep/cli-darwin-arm64",
    "darwin-x64": "@ast-grep/cli-darwin-x64",
    "linux-arm64-gnu": "@ast-grep/cli-linux-arm64-gnu",
    "linux-x64-gnu": "@ast-grep/cli-linux-x64-gnu",
    "win32-x64-msvc": "@ast-grep/cli-win32-x64-msvc",
  };
  const actualTuple = process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")
    ? `darwin-${process.arch}`
    : process.platform === "linux" && (process.arch === "arm64" || process.arch === "x64")
      ? `linux-${process.arch}-gnu`
      : process.platform === "win32" && process.arch === "x64"
        ? "win32-x64-msvc"
        : undefined;
  assert.ok(actualTuple !== undefined, `test runner ${process.platform}/${process.arch} is not a supported native tuple`);
  const declaredTuple = process.env.PI_AST_GREP_EXPECT_TUPLE ?? actualTuple;
  assert.equal(declaredTuple, actualTuple, "the hosted matrix declaration must match the actual runner");
  const expectedPackage = packagesByTuple[declaredTuple];
  assert.ok(expectedPackage !== undefined, `unknown hosted native tuple: ${declaredTuple}`);
  assert.equal(platformPackage(process.platform, process.arch), expectedPackage);

  const scheduler = new NativeScheduler(2);
  const manager = new BinaryManager(scheduler);
  try {
    const ready = await manager.ready(operationRecord());
    assert.equal(ready.version, "0.45.0");
    const normalizedBinary = ready.path.replaceAll("\\", "/");
    const executable = process.platform === "win32" ? "ast-grep.exe" : "ast-grep";
    assert.equal(
      normalizedBinary.endsWith(`/node_modules/${expectedPackage}/${executable}`),
      true,
      `resolved binary is not owned by ${expectedPackage}: ${normalizedBinary}`,
    );
  } finally {
    await manager.shutdown();
    scheduler.close();
  }
});

test("argv and environment builders enforce bounded allowlists", () => {
  const env = buildBoundedEnv({
    HOME: "/safe/home",
    LANG: "en_US.UTF-8",
    PATH: "/attacker/bin",
    SECRET_TOKEN: "do-not-copy",
  });
  assert.deepEqual(env, { NO_COLOR: "1", HOME: "/safe/home", LANG: "en_US.UTF-8" });
  assert.throws(() => buildBoundedEnv({ HOME: "x\0y" }), /HOME is not safe/u);
  assert.throws(() => buildBoundedEnv({ HOME: "x".repeat(4097) }), /4096-unit limit/u);
  assert.doesNotThrow(() => assertArgvBudget("/safe/ast-grep", ["--pattern=$A", "--stdin"]));
  assert.throws(() => assertArgvBudget("/safe/ast-grep", ["x".repeat(25 * 1024)]), /safety budget/u);
  assert.throws(() => assertArgvBudget("/safe/ast-grep", ["bad\0arg"]), /invalid Unicode or NUL/u);
});

test("BinaryManager performs one exact handshake and revalidates native identity", async (t) => {
  if (!requirePosixExecutableFixture(t)) return;
  const root = await temporaryWorkspace(t, "pi-ast-grep-binary-");
  const fixture = await binaryFixture(root);
  const scheduler = new NativeScheduler(2);
  let resolutions = 0;
  const manager = new BinaryManager(scheduler, {
    platform: "darwin",
    arch: "x64",
    extensionRoot: fixture.extensionRoot,
    env: { HOME: root },
    resolvePackage(specifier) {
      resolutions += 1;
      assert.equal(specifier, "@ast-grep/cli-darwin-x64/package.json");
      return fixture.packageJson;
    },
  });
  try {
    const [first, second] = await Promise.all([
      manager.ready(operationRecord()),
      manager.ready(operationRecord()),
    ]);
    assert.equal(first.path, await realpath(fixture.binaryPath));
    assert.equal(first.version, "0.45.0");
    assert.strictEqual(first, second);
    assert.equal(resolutions, 1);
    await writeFile(fixture.binaryPath, "#!/usr/bin/env node\nprocess.stdout.write('ast-grep 0.45.0\\n');\n// tampered\n", "utf8");
    await assert.rejects(manager.revalidate(first, operationRecord()), /changed after its version handshake/u);
  } finally {
    await manager.shutdown();
    scheduler.close();
  }
});

test("BinaryManager bounds trusted config reads during startup and revalidation", async (t) => {
  if (!requirePosixExecutableFixture(t)) return;
  const root = await temporaryWorkspace(t, "pi-ast-grep-binary-config-bounds-");
  const startupFixture = await binaryFixture(join(root, "startup"));
  await writeFile(join(startupFixture.extensionRoot, "assets", "empty-sgconfig.yml"), Buffer.alloc(1024 * 1024, 0x78));
  const startupScheduler = new NativeScheduler(2);
  const startupManager = new BinaryManager(startupScheduler, {
    platform: "darwin",
    arch: "x64",
    extensionRoot: startupFixture.extensionRoot,
    resolvePackage: () => startupFixture.packageJson,
  });
  await assert.rejects(startupManager.ready(operationRecord()), /canonical 12-byte file/u);
  await startupManager.shutdown();
  startupScheduler.close();

  const revalidationFixture = await binaryFixture(join(root, "revalidation"));
  const revalidationScheduler = new NativeScheduler(2);
  const revalidationManager = new BinaryManager(revalidationScheduler, {
    platform: "darwin",
    arch: "x64",
    extensionRoot: revalidationFixture.extensionRoot,
    resolvePackage: () => revalidationFixture.packageJson,
  });
  try {
    const ready = await revalidationManager.ready(operationRecord());
    await writeFile(join(revalidationFixture.extensionRoot, "assets", "empty-sgconfig.yml"), Buffer.alloc(1024 * 1024, 0x78));
    await assert.rejects(revalidationManager.revalidate(ready, operationRecord()), /canonical 12-byte file/u);
  } finally {
    await revalidationManager.shutdown();
    revalidationScheduler.close();
  }
});

test("BinaryManager fails closed for missing or incompatible native packages", async (t) => {
  if (!requirePosixExecutableFixture(t)) return;
  const root = await temporaryWorkspace(t, "pi-ast-grep-binary-failure-");
  const fixture = await binaryFixture(root, "0.46.0");
  const missingScheduler = new NativeScheduler(2);
  const missing = new BinaryManager(missingScheduler, {
    platform: "darwin",
    arch: "x64",
    extensionRoot: fixture.extensionRoot,
    resolvePackage() {
      throw new Error("missing");
    },
  });
  await assert.rejects(missing.ready(operationRecord()), /missing; reinstall without --omit=optional/u);
  await missing.shutdown();
  missingScheduler.close();

  const versionScheduler = new NativeScheduler(2);
  const wrongVersion = new BinaryManager(versionScheduler, {
    platform: "darwin",
    arch: "x64",
    extensionRoot: fixture.extensionRoot,
    resolvePackage: () => fixture.packageJson,
  });
  await assert.rejects(wrongVersion.ready(operationRecord()), /version is incompatible/u);
  await wrongVersion.shutdown();
  versionScheduler.close();
});

test("BinaryManager bounds version output and force-kills a handshake that ignores SIGTERM", async (t) => {
  if (!requirePosixExecutableFixture(t)) return;
  const root = await temporaryWorkspace(t, "pi-ast-grep-binary-bounds-");

  const floodFixture = await binaryFixture(join(root, "flood"), "0.45.0", [
    "process.stdout.write('x'.repeat(1024 * 1024));",
    "setInterval(() => undefined, 60_000);",
  ].join("\n"));
  const floodScheduler = new NativeScheduler(2);
  const flood = new BinaryManager(floodScheduler, {
    platform: "darwin",
    arch: "x64",
    extensionRoot: floodFixture.extensionRoot,
    resolvePackage: () => floodFixture.packageJson,
    versionTimeoutMs: 5_000,
    versionForceKillMs: 50,
  });
  await assert.rejects(flood.ready(operationRecord()), /bounded version handshake/u);
  await flood.shutdown();
  floodScheduler.close();

  const hangFixture = await binaryFixture(join(root, "hang"), "0.45.0", [
    "process.on('SIGTERM', () => undefined);",
    "setInterval(() => undefined, 60_000);",
  ].join("\n"));
  const hangScheduler = new NativeScheduler(2);
  const hang = new BinaryManager(hangScheduler, {
    platform: "darwin",
    arch: "x64",
    extensionRoot: hangFixture.extensionRoot,
    resolvePackage: () => hangFixture.packageJson,
    versionTimeoutMs: 50,
    versionForceKillMs: 50,
  });
  const startedAt = Date.now();
  await assert.rejects(hang.ready(operationRecord()), /timed out/u);
  assert.ok(Date.now() - startedAt < 2000, "an uncooperative version child must settle after force kill");
  await hang.shutdown();
  hangScheduler.close();
});

test("BinaryManager preserves a caller timeout while a shared startup remains owned", async (t) => {
  if (!requirePosixExecutableFixture(t)) return;
  const root = await temporaryWorkspace(t, "pi-ast-grep-binary-caller-timeout-");
  const fixture = await binaryFixture(root, "0.45.0", [
    "process.on('SIGTERM', () => undefined);",
    "setInterval(() => undefined, 60_000);",
  ].join("\n"));
  const scheduler = new NativeScheduler(2);
  const manager = new BinaryManager(scheduler, {
    platform: "darwin",
    arch: "x64",
    extensionRoot: fixture.extensionRoot,
    resolvePackage: () => fixture.packageJson,
    versionTimeoutMs: 500,
    versionForceKillMs: 50,
  });
  const caller = operationRecord();
  const pending = manager.ready(caller);
  markTerminalCause(caller, "timeout");
  await assert.rejects(pending, /operation timed out/u);
  await manager.shutdown();
  scheduler.close();
});
