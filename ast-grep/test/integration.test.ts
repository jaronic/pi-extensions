import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { BinaryManager } from "../src/binary.ts";
import { executeEdit } from "../src/edit.ts";
import { AstGrepRunner } from "../src/runner.ts";
import { NativeScheduler } from "../src/scheduler.ts";
import { executeSearch } from "../src/search.ts";
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "../src/languages.ts";
import { normalizedEdit, normalizedSearch, operationRecord, temporaryWorkspace } from "./helpers.ts";

test("pinned ast-grep 0.45.0 executes real search, preview, and apply contracts", async (t) => {
  const root = await temporaryWorkspace(t, "pi-ast-grep-real-");
  await mkdir(`${root}/src`);
  await writeFile(`${root}/src/sample.ts`, "const a = oldName(first);\nconst b = oldName(second);\n", "utf8");
  await writeFile(`${root}/src/other.ts`, "const c = oldName(third);\n", "utf8");
  await writeFile(`${root}/sgconfig.yml`, ": deliberately invalid workspace config\n", "utf8");

  const scheduler = new NativeScheduler(2);
  const binary = new BinaryManager(scheduler);
  const runner = new AstGrepRunner(scheduler, binary);
  t.after(async () => {
    await runner.shutdown();
    await binary.shutdown();
    scheduler.close();
  });

  const exact = await executeSearch(
    normalizedSearch({ path: "src/sample.ts", pattern: "oldName($A)", limit: 10 }),
    root,
    operationRecord(),
    runner,
    undefined,
  );
  assert.equal(exact.details.kind, "search");
  assert.equal(exact.details.totalMatches, 2);
  assert.deepEqual(exact.details.matches.map((match) => match.text), ["oldName(first)", "oldName(second)"]);

  const directory = await executeSearch(
    normalizedSearch({ path: "src", pattern: "oldName($A)", globs: ["*.ts"], limit: 10 }),
    root,
    operationRecord(),
    runner,
    undefined,
  );
  assert.equal(directory.details.totalMatches, 3);
  assert.deepEqual(directory.details.matches.map((match) => match.path), ["src/other.ts", "src/sample.ts", "src/sample.ts"]);

  const preview = await executeEdit(
    normalizedEdit({ path: "src/sample.ts", pattern: "oldName($A)", rewrite: "newName($A)" }),
    root,
    operationRecord(),
    runner,
    undefined,
  );
  assert.ok(preview.details.kind === "edit-preview" && preview.details.previewId);
  assert.equal(preview.details.replacements, 2);
  assert.equal(await readFile(`${root}/src/sample.ts`, "utf8"), "const a = oldName(first);\nconst b = oldName(second);\n");

  const applied = await executeEdit(
    normalizedEdit({
      action: "apply",
      path: "src/sample.ts",
      pattern: "oldName($A)",
      rewrite: "newName($A)",
      previewId: preview.details.previewId,
    }),
    root,
    operationRecord(),
    runner,
    undefined,
  );
  assert.equal(applied.details.kind, "edit-apply");
  assert.equal(applied.details.replacements, 2);
  assert.equal(await readFile(`${root}/src/sample.ts`, "utf8"), "const a = newName(first);\nconst b = newName(second);\n");
});

const LANGUAGE_FIXTURES: Readonly<Record<SupportedLanguage, { source: string; pattern: string; expected?: string }>> = {
  bash: { source: "echo hello\n", pattern: "echo hello" },
  c: { source: "int main() { return 0; }\n", pattern: "int main() { return 0; }" },
  cpp: { source: "int main() { return 0; }\n", pattern: "int main() { return 0; }" },
  csharp: { source: "class A { }\n", pattern: "class A { }" },
  css: { source: ".a { color: red; }\n", pattern: ".a { color: red; }" },
  dart: { source: "void main() { print('x'); }\n", pattern: "void main() { print('x'); }" },
  elixir: { source: "defmodule A do\n  def f, do: :ok\nend\n", pattern: "def f, do: :ok", expected: "def f, do: :ok" },
  go: { source: "package main\nfunc f() { println(\"x\") }\n", pattern: "func f() { println(\"x\") }", expected: "func f() { println(\"x\") }" },
  haskell: { source: "f x = x + 1\n", pattern: "f x = x + 1" },
  hcl: { source: "resource \"x\" \"y\" {}\n", pattern: "resource \"x\" \"y\" {}" },
  html: { source: "<div>hello</div>\n", pattern: "<div>hello</div>" },
  java: { source: "class A {}\n", pattern: "class A {}" },
  javascript: { source: "const x = 1;\n", pattern: "const x = 1" },
  json: { source: "{\"x\": 1}\n", pattern: "{\"x\": 1}" },
  kotlin: { source: "fun f() = 1\n", pattern: "fun f() = 1" },
  lua: { source: "local x = 1\n", pattern: "local x = 1" },
  markdown: { source: "# Heading\n", pattern: "# Heading", expected: "#" },
  nix: { source: "{ x = 1; }\n", pattern: "{ x = 1; }" },
  php: { source: "<?php echo \"x\"; ?>\n", pattern: "echo \"x\";", expected: "echo \"x\";" },
  python: { source: "def f():\n    return 1\n", pattern: "def f():\n    return 1" },
  ruby: { source: "def f\n  1\nend\n", pattern: "def f\n  1\nend" },
  rust: { source: "fn f() -> i32 { 1 }\n", pattern: "fn f() -> i32 { 1 }" },
  scala: { source: "object A { def f = 1 }\n", pattern: "object A { def f = 1 }" },
  solidity: { source: "contract A { function f() public {} }\n", pattern: "contract A { function f() public {} }" },
  swift: { source: "func f() -> Int { return 1 }\n", pattern: "func f() -> Int { return 1 }" },
  typescript: { source: "const x: number = 1;\n", pattern: "const x: number = 1" },
  tsx: { source: "const x = <div>hello</div>;\n", pattern: "const x = <div>hello</div>" },
  yaml: { source: "x: 1\n", pattern: "x: 1" },
};

test("every supported language compiles and matches through the pinned native runner", async (t) => {
  const root = await temporaryWorkspace(t, "pi-ast-grep-languages-");
  const scheduler = new NativeScheduler(2);
  const binary = new BinaryManager(scheduler);
  const runner = new AstGrepRunner(scheduler, binary);
  t.after(async () => {
    await runner.shutdown();
    await binary.shutdown();
    scheduler.close();
  });

  for (const language of SUPPORTED_LANGUAGES) {
    await t.test(language, async () => {
      const fixture = LANGUAGE_FIXTURES[language];
      const path = `sample-${language}.txt`;
      await writeFile(`${root}/${path}`, fixture.source, "utf8");
      const result = await executeSearch(
        normalizedSearch({ path, language, pattern: fixture.pattern, limit: 2 }),
        root,
        operationRecord(),
        runner,
        undefined,
      );
      assert.equal(result.details.totalMatches, 1);
      assert.equal(result.details.matches[0]?.text.trim(), fixture.expected ?? fixture.source.trim());
    });
  }
});
