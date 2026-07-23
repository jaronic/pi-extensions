import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findWorkspaceRoot, resolveWorkspaceFile } from "../src/roots.ts";

test("higher-priority root marker wins over a nearer module marker", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-lsp-root-"));
  context.after(async () => await rm(temporaryRoot, { recursive: true, force: true }));
  const root = await realpath(temporaryRoot);
  const moduleRoot = join(root, "java-module");
  const sourceDirectory = join(moduleRoot, "src", "main", "java");
  await mkdir(sourceDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(root, "settings.gradle"), "include 'java-module'\n", "utf8"),
    writeFile(join(moduleRoot, "build.gradle"), "plugins { id 'java' }\n", "utf8"),
  ]);
  const file = join(sourceDirectory, "Main.java");
  await writeFile(file, "class Main {}\n", "utf8");

  const selected = await findWorkspaceRoot(file, ["settings.gradle", "build.gradle", ".git"], root);

  assert.equal(selected, root);
});

test("resolveWorkspaceFile rejects traversal, directories, and escaping symlinks", async (context) => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-lsp-security-"));
  const externalRoot = await mkdtemp(join(tmpdir(), "pi-lsp-external-"));
  context.after(async () => {
    await Promise.all([
      rm(temporaryRoot, { recursive: true, force: true }),
      rm(externalRoot, { recursive: true, force: true }),
    ]);
  });
  const root = await realpath(temporaryRoot);
  const file = join(root, "sample.ts");
  const externalFile = join(externalRoot, "secret.ts");
  await Promise.all([
    writeFile(file, "const safe = true;\n", "utf8"),
    writeFile(externalFile, "const secret = true;\n", "utf8"),
  ]);
  const escapingLink = join(root, "escaping.ts");
  await symlink(externalFile, escapingLink);

  assert.equal(await resolveWorkspaceFile("@sample.ts", root), file);
  await assert.rejects(resolveWorkspaceFile(externalFile, root), /stay inside the workspace/);
  await assert.rejects(resolveWorkspaceFile(escapingLink, root), /stay inside the workspace/);
  await assert.rejects(resolveWorkspaceFile(root, root), /not a file/);
});

test("findWorkspaceRoot rejects files outside the trusted cwd", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pi-lsp-cwd-"));
  const outside = await mkdtemp(join(tmpdir(), "pi-lsp-outside-"));
  context.after(async () => {
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  });
  const file = join(outside, "sample.ts");
  await writeFile(file, "const outside = true;\n", "utf8");
  await assert.rejects(findWorkspaceRoot(file, ["package.json"], root), /outside workspace/);
});
