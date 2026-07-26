import assert from "node:assert/strict";
import { mkdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { LosslessDirectoryValidator } from "../src/filenames.ts";
import { resolveWorkspaceTarget } from "../src/paths.ts";
import { operationRecord, temporaryWorkspace } from "./helpers.ts";

test("directory result validation walks exact bounded components", async (t) => {
  const root = await temporaryWorkspace(t, "pi-ast-grep-filenames-");
  await mkdir(join(root, "src", "nested"), { recursive: true });
  await writeFile(join(root, "src", "nested", "sample.ts"), "foo(x)\n", "utf8");
  const scope = await resolveWorkspaceTarget("src", root, "directory");
  const validator = new LosslessDirectoryValidator(scope, operationRecord());
  const result = await validator.validate("src/nested/sample.ts");
  assert.equal(result.displayPath, "src/nested/sample.ts");
  assert.ok(validator.entriesScanned >= 2);
  const scanned = validator.entriesScanned;
  await validator.validate("src/nested/sample.ts");
  assert.equal(validator.entriesScanned, scanned, "stable exact components reuse the bounded validation cache");

  await assert.rejects(validator.validate("src/../sample.ts"), /invalid components/u);
  await assert.rejects(validator.validate("sample.ts"), /outside the requested directory scope/u);
  await assert.rejects(validator.validate("src/missing.ts"), /no exact filesystem entry/u);
  await assert.rejects(validator.validate(join(root, "src", "nested", "sample.ts")), /path is invalid/u);
});

test("directory result validation rejects symlink components before traversal", async (t) => {
  if (process.platform === "win32") {
    t.skip("unprivileged Windows symlink creation is not portable");
    return;
  }
  const root = await temporaryWorkspace(t, "pi-ast-grep-filename-symlink-");
  const outside = await temporaryWorkspace(t, "pi-ast-grep-filename-outside-");
  await mkdir(join(root, "src"));
  await writeFile(join(outside, "secret.ts"), "secret\n", "utf8");
  await symlink(outside, join(root, "src", "linked"));
  const scope = await resolveWorkspaceTarget("src", root, "directory");
  const validator = new LosslessDirectoryValidator(scope, operationRecord());
  await assert.rejects(validator.validate("src/linked/secret.ts"), /traverses a symlink or junction/u);
});

test("directory result validation does not re-baseline a replaced parent namespace", async (t) => {
  if (process.platform === "win32") {
    t.skip("unprivileged Windows symlink creation is not portable");
    return;
  }
  const root = await temporaryWorkspace(t, "pi-ast-grep-filename-parent-race-");
  const outside = await temporaryWorkspace(t, "pi-ast-grep-filename-parent-outside-");
  await mkdir(join(root, "src", "nested"), { recursive: true });
  await writeFile(join(root, "src", "nested", "sample.ts"), "foo(x)\n", "utf8");
  await writeFile(join(outside, "sample.ts"), "outside\n", "utf8");
  const scope = await resolveWorkspaceTarget("src", root, "directory");
  const validator = new LosslessDirectoryValidator(scope, operationRecord());
  await validator.validate("src/nested/sample.ts");
  const scannedBeforeReplacement = validator.entriesScanned;

  await rename(join(root, "src", "nested"), join(root, "src", "nested-original"));
  await symlink(outside, join(root, "src", "nested"));
  await assert.rejects(
    validator.validate("src/nested/sample.ts"),
    /identity changed|directory changed|real directory/u,
  );
  assert.equal(validator.entriesScanned, scannedBeforeReplacement, "replacement is rejected before another directory is enumerated");
});

test("POSIX directory validation rejects a non-UTF-8 and U+FFFD lossy twin", async (t) => {
  if (process.platform === "win32") {
    t.skip("raw POSIX filename bytes are not applicable on Windows");
    return;
  }
  const root = await temporaryWorkspace(t, "pi-ast-grep-filename-raw-");
  const src = join(root, "src");
  await mkdir(src);
  await writeFile(join(src, "collision-�.ts"), "foo(x)\n", "utf8");
  const invalidPath = Buffer.concat([Buffer.from(`${src}/collision-`), Buffer.from([0xff]), Buffer.from(".ts")]);
  try {
    await writeFile(invalidPath, "foo(x)\n", "utf8");
  } catch (error) {
    if (process.platform === "linux" && process.env.PI_AST_GREP_EXPECT_TUPLE?.startsWith("linux-")) {
      assert.fail(`hosted Linux runner could not create the required invalid-byte fixture: ${error instanceof Error ? error.message : String(error)}`);
    }
    t.skip(`filesystem rejected the invalid-byte fixture: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  try {
    const scope = await resolveWorkspaceTarget("src", root, "directory");
    const validator = new LosslessDirectoryValidator(scope, operationRecord());
    await assert.rejects(validator.validate("src/collision-�.ts"), /non-UTF-8 filename/u);
  } finally {
    await unlink(invalidPath);
  }
});

if (process.platform === "win32") {
  test("Windows directory validation rejects an unpaired-surrogate and U+FFFD lossy twin", async (t) => {
    const root = await temporaryWorkspace(t, "pi-ast-grep-filename-utf16-");
    const src = join(root, "src");
    await mkdir(src);
    const lossyName = "collision-\uFFFD.ts";
    const invalidName = "collision-\uD800.ts";
    assert.equal(invalidName.isWellFormed(), false);
    const invalidPath = Buffer.concat([
      Buffer.from(join(src, "collision-"), "utf8"),
      Buffer.from([0xed, 0xa0, 0x80]),
      Buffer.from(".ts", "utf8"),
    ]);
    await writeFile(join(src, lossyName), "foo(x)\n", "utf8");
    await writeFile(invalidPath, "foo(x)\n", "utf8");
    try {
      const scope = await resolveWorkspaceTarget("src", root, "directory");
      const validator = new LosslessDirectoryValidator(scope, operationRecord());
      await assert.rejects(validator.validate(`src/${lossyName}`), /unpaired UTF-16 surrogate/u);
    } finally {
      await unlink(invalidPath);
    }
  });
}
