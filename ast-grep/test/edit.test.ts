import assert from "node:assert/strict";
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import test from "node:test";
import { commitEditSync, type CommitGuardPhase } from "../src/atomic-write.ts";
import { executeEdit } from "../src/edit.ts";
import { createEditPlan } from "../src/edits.ts";
import { formatPreviewResult } from "../src/output.ts";
import { resolveWorkspaceTarget } from "../src/paths.ts";
import type { DecodedMatch } from "../src/types.ts";
import {
  fakeRunner,
  normalizedEdit,
  operationRecord,
  rewriteMatch,
  searchMatch,
  temporaryWorkspace,
} from "./helpers.ts";

function structuralRewriteRunner(options: { guardError?: boolean } = {}) {
  return fakeRunner(async (request, onRecord) => {
    if (request.mode === "error-guard") {
      if (options.guardError) {
        await onRecord(searchMatch());
        return { records: 1 };
      }
      return { records: 0 };
    }
    assert.equal(request.mode, "rewrite");
    const source = request.stdin!.toString("utf8");
    const records: DecodedMatch[] = [];
    for (const match of source.matchAll(/foo\(([^)]*)\)/gu)) {
      const text = match[0];
      const start = Buffer.byteLength(source.slice(0, match.index), "utf8");
      const end = start + Buffer.byteLength(text, "utf8");
      records.push(rewriteMatch(start, end, text, `bar(${match[1]})`));
    }
    for (const record of records) await onRecord(record);
    return { records: records.length };
  });
}

test("edit plans sort, deduplicate, and fingerprint semantic inputs", () => {
  const source = Buffer.from("foo(a);foo(b);", "utf8");
  const records = [
    rewriteMatch(7, 13, "foo(b)", "bar(b)"),
    rewriteMatch(0, 6, "foo(a)", "bar(a)"),
    rewriteMatch(0, 6, "foo(a)", "bar(a)"),
  ];
  const previewInput = normalizedEdit({ timeoutMs: 1000 });
  const preview = createEditPlan(previewInput, "/workspace", "/workspace/sample.ts", "sample.ts", source, 0o644, records);
  assert.equal(preview.edits.length, 2);
  assert.equal(preview.output.toString("utf8"), "bar(a);bar(b);");
  const applyInput = normalizedEdit({
    action: "apply",
    previewId: "0".repeat(64),
    timeoutMs: 120_000,
  });
  const apply = createEditPlan(applyInput, "/workspace", "/workspace/sample.ts", "sample.ts", source, 0o644, records);
  assert.equal(apply.previewId, preview.previewId, "action, previewId, and timeout are non-semantic");
  const changedRewrite = createEditPlan(
    normalizedEdit({ rewrite: "qux($A)" }),
    "/workspace",
    "/workspace/sample.ts",
    "sample.ts",
    source,
    0o644,
    [rewriteMatch(0, 6, "foo(a)", "qux(a)"), rewriteMatch(7, 13, "foo(b)", "qux(b)")],
  );
  assert.notEqual(changedRewrite.previewId, preview.previewId);
  const changedPath = createEditPlan(previewInput, "/workspace", "/workspace/other.ts", "other.ts", source, 0o644, records);
  assert.notEqual(changedPath.previewId, preview.previewId);
});

test("edit plans collapse a net no-op across distinct replacements", () => {
  const source = Buffer.from("ab", "utf8");
  const plan = createEditPlan(
    normalizedEdit({ maxReplacements: 1 }),
    "/workspace",
    "/workspace/sample.ts",
    "sample.ts",
    source,
    0o644,
    [rewriteMatch(0, 1, "a", ""), rewriteMatch(1, 2, "b", "ab")],
  );
  assert.equal(plan.output.equals(source), true);
  assert.deepEqual(plan.edits, []);
  assert.deepEqual(plan.summaries, []);
  const preview = formatPreviewResult(plan);
  assert.equal(preview.details.replacements, 0);
  assert.equal(preview.details.previewId, undefined);
});

test("edit plans reject conflicting, overlapping, zero-width, and out-of-source records", () => {
  const source = Buffer.from("foo(a);foo(b);", "utf8");
  const input = normalizedEdit();
  assert.throws(() => createEditPlan(input, "/workspace", "/workspace/sample.ts", "sample.ts", source, 0o644, [
    rewriteMatch(0, 6, "foo(a)", "bar(a)"),
    rewriteMatch(0, 6, "foo(a)", "qux(a)"),
  ]), /conflicting replacements/u);
  assert.throws(() => createEditPlan(input, "/workspace", "/workspace/sample.ts", "sample.ts", source, 0o644, [
    rewriteMatch(0, 6, "foo(a)", "bar(a)"),
    rewriteMatch(4, 13, "a);foo(b)", "overlap"),
  ]), /nested or overlapping/u);
  assert.throws(() => createEditPlan(input, "/workspace", "/workspace/sample.ts", "sample.ts", source, 0o644, [
    rewriteMatch(0, 0, "", "x"),
  ]), /zero-width/u);
  assert.throws(() => createEditPlan(input, "/workspace", "/workspace/sample.ts", "sample.ts", source, 0o644, [
    rewriteMatch(50, 60, "outside", "x"),
  ]), /outside the source snapshot/u);
  const drift = rewriteMatch(0, 6, "foo(a)", "bar(a)", { replacementOffsets: { start: 0, end: 5 } });
  assert.throws(() => createEditPlan(input, "/workspace", "/workspace/sample.ts", "sample.ts", source, 0o644, [drift]), /replacementOffsets drifted/u);
});

test("preview and apply perform one atomic replacement with stable hashes and mode", async (t) => {
  const root = await temporaryWorkspace(t, "pi-ast-grep-edit-apply-");
  const path = `${root}/sample.ts`;
  await writeFile(path, "foo(a);\nfoo(b);\n", "utf8");
  if (process.platform !== "win32") await chmod(path, 0o751);
  const runner = structuralRewriteRunner();
  const preview = await executeEdit(normalizedEdit(), root, operationRecord(), runner, undefined);
  assert.equal(preview.details.kind, "edit-preview");
  assert.equal(preview.details.replacements, 2);
  assert.ok(preview.details.kind === "edit-preview" && preview.details.previewId);
  assert.equal(await readFile(path, "utf8"), "foo(a);\nfoo(b);\n");

  const applyRecord = operationRecord();
  const applied = await executeEdit(normalizedEdit({
    action: "apply",
    previewId: preview.details.previewId,
    timeoutMs: 1000,
  }), root, applyRecord, runner, undefined);
  assert.equal(applied.details.kind, "edit-apply");
  assert.equal(applied.details.replacements, 2);
  assert.equal(await readFile(path, "utf8"), "bar(a);\nbar(b);\n");
  assert.equal(applyRecord.committed, true);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o751);
  assert.equal((await readdir(root)).some((name) => name.includes(".pi-ast-grep-") && name.endsWith(".tmp")), false);
});

test("atomic commit verifies an expanded output beyond the source byte cap", async (t) => {
  const root = await temporaryWorkspace(t, "pi-ast-grep-edit-expanded-output-");
  const path = `${root}/sample.ts`;
  const source = Buffer.alloc(3_000_000, 0x61);
  await writeFile(path, source);
  const target = await resolveWorkspaceTarget("sample.ts", root, "file");
  const plan = createEditPlan(
    normalizedEdit(),
    target.canonicalWorkspace,
    target.canonicalPath,
    target.displayPath,
    source,
    Number(target.identity.mode),
    [rewriteMatch(source.length - 1, source.length, "a", "bb")],
  );
  assert.equal(plan.output.length, source.length + 1);

  const record = operationRecord();
  assert.doesNotThrow(() => commitEditSync(plan, target, record));
  const installed = await readFile(path);
  assert.equal(installed.length, source.length + 1);
  assert.equal(installed.subarray(-2).toString("utf8"), "bb");
  assert.equal(record.committed, true);
});

test("stale preview is zero-write, while restoring identical bytes makes the token valid", async (t) => {
  const root = await temporaryWorkspace(t, "pi-ast-grep-edit-stale-");
  const path = `${root}/sample.ts`;
  const original = "foo(a);\n";
  await writeFile(path, original, "utf8");
  const runner = structuralRewriteRunner();
  const preview = await executeEdit(normalizedEdit(), root, operationRecord(), runner, undefined);
  assert.ok(preview.details.kind === "edit-preview" && preview.details.previewId);
  const previewId = preview.details.previewId;

  const changed = "// changed\nfoo(a);\n";
  await writeFile(path, changed, "utf8");
  await assert.rejects(executeEdit(normalizedEdit({ action: "apply", previewId }), root, operationRecord(), runner, undefined), /previewId is stale/u);
  assert.equal(await readFile(path, "utf8"), changed);

  await writeFile(path, original, "utf8");
  await executeEdit(normalizedEdit({ action: "apply", previewId }), root, operationRecord(), runner, undefined);
  assert.equal(await readFile(path, "utf8"), "bar(a);\n");
});

test("ERROR guard, replacement cap, and no-op apply all fail before writing", async (t) => {
  const root = await temporaryWorkspace(t, "pi-ast-grep-edit-guard-");
  const path = `${root}/sample.ts`;
  await writeFile(path, "foo(a);\nfoo(b);\n", "utf8");
  await assert.rejects(executeEdit(normalizedEdit(), root, operationRecord(), structuralRewriteRunner({ guardError: true }), undefined), /explicit ERROR node/u);
  assert.equal(await readFile(path, "utf8"), "foo(a);\nfoo(b);\n");

  await assert.rejects(executeEdit(normalizedEdit({ maxReplacements: 1 }), root, operationRecord(), structuralRewriteRunner(), undefined), /more than maxReplacements=1/u);
  assert.equal(await readFile(path, "utf8"), "foo(a);\nfoo(b);\n");

  const rawFloodRunner = fakeRunner(async (request, onRecord) => {
    if (request.mode === "error-guard") return { records: 0 };
    for (let index = 0; index < 51; index += 1) {
      await onRecord(rewriteMatch(0, 6, "foo(a)", "bar(a)"));
    }
    return { records: 51 };
  });
  await assert.rejects(
    executeEdit(normalizedEdit({ maxReplacements: 50 }), root, operationRecord(), rawFloodRunner, undefined),
    /more than 50 rewrite records/u,
  );
  assert.equal(await readFile(path, "utf8"), "foo(a);\nfoo(b);\n");

  const noOpRunner = fakeRunner(async (request, onRecord) => {
    if (request.mode === "error-guard") return { records: 0 };
    await onRecord(rewriteMatch(0, 6, "foo(a)", "foo(a)"));
    return { records: 1 };
  });
  const noOp = await executeEdit(normalizedEdit(), root, operationRecord(), noOpRunner, undefined);
  assert.equal(noOp.details.kind, "edit-preview");
  assert.equal(noOp.details.replacements, 0);
  assert.equal(noOp.details.kind === "edit-preview" ? noOp.details.previewId : undefined, undefined);
  await assert.rejects(executeEdit(normalizedEdit({ action: "apply", previewId: "a".repeat(64) }), root, operationRecord(), noOpRunner, undefined), /cannot commit a no-op/u);
  assert.equal(await readFile(path, "utf8"), "foo(a);\nfoo(b);\n");
});

test("injected atomic rename failure preserves the target and removes the sibling temp", async (t) => {
  const root = await temporaryWorkspace(t, "pi-ast-grep-edit-rename-");
  const path = `${root}/sample.ts`;
  const source = Buffer.from("foo(a);\n", "utf8");
  await writeFile(path, source);
  const target = await resolveWorkspaceTarget("sample.ts", root, "file");
  const plan = createEditPlan(
    normalizedEdit(),
    target.canonicalWorkspace,
    target.canonicalPath,
    target.displayPath,
    source,
    Number(target.identity.mode),
    [rewriteMatch(0, 6, "foo(a)", "bar(a)")],
  );
  assert.throws(() => commitEditSync(plan, target, operationRecord(), () => {
    throw new Error("synthetic rename failure");
  }), /atomic rename failed.*still contains the previewed source bytes/u);
  assert.equal(await readFile(path, "utf8"), source.toString("utf8"));
  assert.equal((await readdir(root)).some((name) => name.endsWith(".tmp")), false);
});

test("rename that commits before throwing reports the verified result", async (t) => {
  const root = await temporaryWorkspace(t, "pi-ast-grep-edit-rename-throw-after-");
  const path = `${root}/sample.ts`;
  const source = Buffer.from("foo(a);\n", "utf8");
  await writeFile(path, source);
  const target = await resolveWorkspaceTarget("sample.ts", root, "file");
  const plan = createEditPlan(
    normalizedEdit(),
    target.canonicalWorkspace,
    target.canonicalPath,
    target.displayPath,
    source,
    Number(target.identity.mode),
    [rewriteMatch(0, 6, "foo(a)", "bar(a)")],
  );
  const record = operationRecord();
  assert.doesNotThrow(() => commitEditSync(plan, target, record, (from, to) => {
    renameSync(from, to);
    throw new Error("synthetic post-rename failure");
  }));
  assert.equal(record.committed, true);
  assert.equal(await readFile(path, "utf8"), "bar(a);\n");
  assert.equal((await readdir(root)).some((name) => name.endsWith(".tmp")), false);
});

test("atomic commit rejects replacement of the observed workspace root", async (t) => {
  const root = await temporaryWorkspace(t, "pi-ast-grep-edit-workspace-swap-");
  const movedRoot = `${root}-moved`;
  t.after(() => rm(movedRoot, { recursive: true, force: true }));
  await mkdir(`${root}/src`);
  const path = `${root}/src/sample.ts`;
  const source = Buffer.from("foo(a);\n", "utf8");
  await writeFile(path, source);
  const target = await resolveWorkspaceTarget("src/sample.ts", root, "file");
  const plan = createEditPlan(
    normalizedEdit({ path: "src/sample.ts" }),
    target.canonicalWorkspace,
    target.canonicalPath,
    target.displayPath,
    source,
    Number(target.identity.mode),
    [rewriteMatch(0, 6, "foo(a)", "bar(a)")],
  );

  await rename(root, movedRoot);
  await mkdir(root);
  await rename(`${movedRoot}/src`, `${root}/src`);
  assert.throws(() => commitEditSync(plan, target, operationRecord()), /identity changed/u);
  assert.equal(await readFile(path, "utf8"), source.toString("utf8"));
});

test("atomic commit detects substitution of its sibling temporary inode", async (t) => {
  const root = await temporaryWorkspace(t, "pi-ast-grep-edit-temp-swap-");
  const path = `${root}/sample.ts`;
  const source = Buffer.from("foo(a);\n", "utf8");
  await writeFile(path, source);
  const target = await resolveWorkspaceTarget("sample.ts", root, "file");
  const plan = createEditPlan(
    normalizedEdit(),
    target.canonicalWorkspace,
    target.canonicalPath,
    target.displayPath,
    source,
    Number(target.identity.mode),
    [rewriteMatch(0, 6, "foo(a)", "bar(a)")],
  );
  const record = operationRecord();
  assert.throws(() => commitEditSync(plan, target, record, (from, to) => {
    unlinkSync(from);
    writeFileSync(from, "substituted\n", { mode: 0o600 });
    renameSync(from, to);
  }), /installed inode could not be verified/u);
  assert.equal(record.committed, true, "a successful rename remains the irreversible commit boundary");
  assert.equal(await readFile(path, "utf8"), "substituted\n");
  assert.equal((await readdir(root)).some((name) => name.endsWith(".tmp")), false);
});

test("every synchronous commit guard expires before rename and cleans its temp", async (t) => {
  const phases: readonly CommitGuardPhase[] = [
    "entry",
    "after-source-read",
    "after-temp-fsync",
    "after-parent-check",
    "after-final-source-read",
    "before-rename",
  ];
  for (const phase of phases) {
    await t.test(phase, async (child) => {
      const root = await temporaryWorkspace(child, `pi-ast-grep-edit-deadline-${phase}-`);
      const path = `${root}/sample.ts`;
      const source = Buffer.from("foo(a);\n", "utf8");
      await writeFile(path, source);
      const target = await resolveWorkspaceTarget("sample.ts", root, "file");
      const plan = createEditPlan(
        normalizedEdit(),
        target.canonicalWorkspace,
        target.canonicalPath,
        target.displayPath,
        source,
        Number(target.identity.mode),
        [rewriteMatch(0, 6, "foo(a)", "bar(a)")],
      );
      let now = 0;
      const record = operationRecord(() => now, 10);
      assert.throws(() => commitEditSync(plan, target, record, renameSync, {
        beforeGuard(current) {
          if (current === phase) now = 10;
        },
      }), /operation timed out/u);
      assert.equal(record.committed, false);
      assert.equal(await readFile(path, "utf8"), source.toString("utf8"));
      assert.equal((await readdir(root)).some((name) => name.endsWith(".tmp")), false);
    });
  }
});

test("rename that starts before the deadline reports the real committed result", async (t) => {
  const root = await temporaryWorkspace(t, "pi-ast-grep-edit-rename-deadline-");
  const path = `${root}/sample.ts`;
  const source = Buffer.from("foo(a);\n", "utf8");
  await writeFile(path, source);
  const target = await resolveWorkspaceTarget("sample.ts", root, "file");
  const plan = createEditPlan(
    normalizedEdit(),
    target.canonicalWorkspace,
    target.canonicalPath,
    target.displayPath,
    source,
    Number(target.identity.mode),
    [rewriteMatch(0, 6, "foo(a)", "bar(a)")],
  );
  let now = 0;
  const record = operationRecord(() => now, 10);
  commitEditSync(plan, target, record, (from, to) => {
    now = 10;
    renameSync(from, to);
  });
  assert.equal(record.committed, true);
  assert.equal(await readFile(path, "utf8"), "bar(a);\n");
});
