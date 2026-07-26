import assert from "node:assert/strict";
import { appendFile, link, mkdir, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { readBoundedFile, resolveWorkspaceTarget } from "../src/paths.ts";
import { operationRecord, temporaryWorkspace } from "./helpers.ts";

test("workspace targets canonicalize inside paths and reject lexical escapes", async (t) => {
  const root = await temporaryWorkspace(t, "pi-ast-grep-paths-");
  const sibling = await temporaryWorkspace(t, "pi-ast-grep-paths-other-");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "sample.ts"), "foo(x)\n", "utf8");
  await writeFile(join(sibling, "secret.ts"), "secret\n", "utf8");

  const relative = await resolveWorkspaceTarget("src/sample.ts", root, "file");
  const absolute = await resolveWorkspaceTarget(join(root, "src", "sample.ts"), root, "file");
  assert.equal(relative.displayPath, "src/sample.ts");
  assert.equal(relative.canonicalPath, absolute.canonicalPath);
  await assert.rejects(resolveWorkspaceTarget("../secret.ts", root, "file"), /outside the current workspace/u);
  await assert.rejects(resolveWorkspaceTarget(join(sibling, "secret.ts"), root, "file"), /outside the current workspace/u);
  await assert.rejects(resolveWorkspaceTarget("file://src/sample.ts", root, "file"), /literal workspace filesystem path/u);
  await assert.rejects(resolveWorkspaceTarget("~/sample.ts", root, "file"), /literal workspace filesystem path/u);
  await assert.rejects(resolveWorkspaceTarget("src", root, "file"), /existing file/u);
});

test("workspace targets reject symlink escape and hard-linked edit targets", async (t) => {
  const root = await temporaryWorkspace(t, "pi-ast-grep-links-");
  const outside = await temporaryWorkspace(t, "pi-ast-grep-links-outside-");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "target.ts"), "foo(x)\n", "utf8");
  await writeFile(join(outside, "secret.ts"), "secret\n", "utf8");
  if (process.platform !== "win32") {
    await symlink(join(outside, "secret.ts"), join(root, "src", "escape.ts"));
    await assert.rejects(resolveWorkspaceTarget("src/escape.ts", root, "file"), /resolves outside/u);
  }
  await link(join(root, "src", "target.ts"), join(root, "src", "alias.ts"));
  await assert.rejects(resolveWorkspaceTarget("src/target.ts", root, "file"), /refuses hard-linked files/u);
  const searchable = await resolveWorkspaceTarget("src/target.ts", root, "file-or-directory");
  assert.equal(searchable.kind, "file");
});

test("bounded file reads reject invalid UTF-8, oversize, and changed identities", async (t) => {
  const root = await temporaryWorkspace(t, "pi-ast-grep-read-");
  const sample = join(root, "sample.ts");
  await writeFile(sample, "foo(x)\n", "utf8");
  const target = await resolveWorkspaceTarget("sample.ts", root, "file");
  assert.equal((await readBoundedFile(target, 100, operationRecord())).toString("utf8"), "foo(x)\n");

  await writeFile(sample, Buffer.from([0xff, 0xfe]));
  const invalid = await resolveWorkspaceTarget("sample.ts", root, "file");
  await assert.rejects(readBoundedFile(invalid, 100, operationRecord()), /not valid UTF-8/u);

  await writeFile(sample, "x".repeat(101), "utf8");
  const oversized = await resolveWorkspaceTarget("sample.ts", root, "file");
  await assert.rejects(readBoundedFile(oversized, 100, operationRecord()), /exceeds the 100-byte file limit/u);

  await writeFile(sample, "changed\n", "utf8");
  await assert.rejects(readBoundedFile(oversized, 100, operationRecord()), /identity changed|changed before/u);
});

test("bounded file reads detect truncate, append, and same-size mutation after fstat", async (t) => {
  const root = await temporaryWorkspace(t, "pi-ast-grep-read-races-");
  const sample = join(root, "sample.ts");
  const cases: ReadonlyArray<{ name: string; mutate: () => Promise<void>; message: RegExp }> = [
    { name: "truncate", mutate: () => truncate(sample, 2), message: /became shorter|changed during/u },
    { name: "append", mutate: () => appendFile(sample, "more", "utf8"), message: /grew|changed during/u },
    { name: "same-size rewrite", mutate: () => writeFile(sample, "bar(y)\n", "utf8"), message: /changed during/u },
  ];
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      await writeFile(sample, "foo(x)\n", "utf8");
      const target = await resolveWorkspaceTarget("sample.ts", root, "file");
      await assert.rejects(
        readBoundedFile(target, 100, operationRecord(), { afterInitialStat: fixture.mutate }),
        fixture.message,
      );
    });
  }
});
