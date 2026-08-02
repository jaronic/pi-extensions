import assert from "node:assert/strict";
import test from "node:test";
import { runDocLint, type Finding } from "../src/checks.ts";
import { createMemoryFs, validRepoFiles } from "./mock-fs.ts";

function lint(files: Record<string, string>, maxFindings?: number): Finding[] {
  return runDocLint(createMemoryFs(files), "/repo", maxFindings === undefined ? undefined : { maxFindings }).findings;
}

function byCheck(findings: Finding[], check: string): Finding[] {
  return findings.filter((finding) => finding.check === check);
}

test("a fully consistent repository produces zero findings", () => {
  const report = runDocLint(createMemoryFs(validRepoFiles()), "/repo");
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.packagesScanned, ["demo"]);
  assert.equal(report.omitted, 0);
});

test("missing root AGENTS.md is a single agents-table error", () => {
  const files = validRepoFiles();
  delete files["/repo/AGENTS.md"];
  const findings = lint(files);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].check, "agents-table");
  assert.equal(findings[0].severity, "error");
  assert.equal(findings[0].file, "AGENTS.md");
});

test("AGENTS.md without a Package table is an error", () => {
  const files = { ...validRepoFiles(), "/repo/AGENTS.md": "# no table here\n" };
  const findings = byCheck(lint(files), "agents-table");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "error");
  assert.match(findings[0].message, /no package table/);
});

test("package table coverage is checked in both directions", () => {
  const files = validRepoFiles();
  // Missing coverage: demo not listed.
  files["/repo/AGENTS.md"] = "| Package | Purpose |\n| --- | --- |\n| `themes/` | palettes |\n";
  let findings = byCheck(lint(files), "agents-table");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "error");
  assert.match(findings[0].message, /"demo" .* missing from the AGENTS.md package table/);

  // Extra entry: ghost listed but has no package.json; themes/ resource row stays exempt.
  files["/repo/AGENTS.md"] =
    "| Package | Purpose |\n| --- | --- |\n| `demo` | ok |\n| `ghost` | stale |\n| `themes/` | palettes |\n";
  findings = byCheck(lint(files), "agents-table");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "warning");
  assert.match(findings[0].message, /"ghost" has no package\.json/);
});

test("library packages without a pi manifest may appear in the package table", () => {
  const files = {
    ...validRepoFiles(),
    "/repo/AGENTS.md":
      "| Package | Purpose |\n| --- | --- |\n| `demo` | ok |\n| `uikit` | shared render primitives |\n",
    "/repo/uikit/package.json": JSON.stringify({ name: "pi-uikit-dev", type: "module" }),
  };
  const findings = byCheck(lint(files), "agents-table");
  assert.deepEqual(findings, []);
});

test("registered tools and commands must appear backticked in the README", () => {
  const files = { ...validRepoFiles(), "/repo/demo/README.md": "# Demo\n\nnpm run check\nnpm test\n" };
  const findings = byCheck(lint(files), "surface-names");
  const errors = findings.filter((finding) => finding.severity === "error");
  assert.equal(errors.length, 2);
  assert.match(errors[0].message, /tool "demo_tool" is registered in src but never appears/);
  assert.match(errors[1].message, /command "\/demo" is registered in src but never appears/);
});

test("README surface mentions that code does not register are warnings, with allowlists", () => {
  const files = {
    ...validRepoFiles(),
    "/repo/demo/README.md": [
      "# Demo",
      "",
      "`demo` 注册 `demo_tool` 工具与 `/demo` 命令。",
      "`ghost_tool` 工具不存在。",
      "内建 `grep` tool 不算漂移。",
      "使用 `/nosuchcmd` 与内建 `/reload`。",
      "",
      "npm run check",
      "npm test",
    ].join("\n"),
  };
  const findings = byCheck(lint(files), "surface-names");
  const warnings = findings.filter((finding) => finding.severity === "warning");
  assert.equal(warnings.length, 2);
  assert.match(warnings[0].message, /command "\/nosuchcmd"/);
  assert.match(warnings[1].message, /"ghost_tool"/);
});

test("README references to sibling packages' tools are exempt from the heuristic direction", () => {
  const siblingManifest = JSON.stringify({
    name: "pi-sibling-dev",
    pi: { extensions: ["./src/index.ts"] },
    scripts: { check: "tsc --noEmit", test: "node --test" },
  });
  const files = {
    ...validRepoFiles(),
    "/repo/AGENTS.md": "| Package | Purpose |\n| --- | --- |\n| `demo` | a |\n| `sibling` | b |\n",
    "/repo/demo/README.md": [
      "# Demo",
      "",
      "`demo` 注册 `demo_tool` 工具与 `/demo` 命令，并调用 `sibling_tool` 工具。",
      "",
      "npm run check",
      "npm test",
    ].join("\n"),
    "/repo/sibling/package.json": siblingManifest,
    "/repo/sibling/src/index.ts": 'export default function (pi) { pi.registerTool({ name: "sibling_tool" }); }',
    "/repo/sibling/README.md": "# Sibling\n\n`sibling_tool` 工具。\n\nnpm run check\nnpm test\n",
  };
  assert.deepEqual(lint(files), []);
});

test("npm script documentation is checked in both directions", () => {
  const files = {
    ...validRepoFiles(),
    "/repo/demo/README.md": "# Demo\n\n`demo_tool` `/demo`\n\nnpm run check\nnpm run missing\n",
  };
  const findings = byCheck(lint(files), "npm-scripts");
  assert.equal(findings.length, 2);
  const error = findings.find((finding) => finding.severity === "error");
  const warning = findings.find((finding) => finding.severity === "warning");
  assert.match(error?.message ?? "", /"npm run missing" but package\.json has no "missing" script/);
  assert.equal(error?.file, "demo/README.md");
  assert.match(warning?.message ?? "", /script "test" is not documented/);
  assert.equal(warning?.file, "demo/package.json");
});

test("pi.extensions entries must be relative paths that exist", () => {
  const manifest = JSON.stringify({ pi: { extensions: ["./src/index.ts", "./src/gone.ts", "../escape.ts", "/abs.ts"] } });
  const files = { ...validRepoFiles(), "/repo/demo/package.json": manifest };
  const findings = byCheck(lint(files), "manifest-paths");
  assert.equal(findings.length, 3);
  assert.match(findings[0].message, /"\.\/src\/gone\.ts" does not exist/);
  assert.match(findings[1].message, /"\.\.\/escape\.ts" must be a relative path/);
  assert.match(findings[2].message, /"\/abs\.ts" must be a relative path/);
  assert.ok(findings.every((finding) => finding.severity === "error" && finding.file === "demo/package.json"));
});

test("malformed package.json input is reported, not trusted", () => {
  const files = validRepoFiles();
  files["/repo/demo/package.json"] = "{ not json";
  let findings = lint(files);
  const jsonErrors = findings.filter((finding) => /not valid JSON/.test(finding.message));
  assert.equal(jsonErrors.length, 1);
  assert.equal(jsonErrors[0].severity, "error");
  assert.equal(jsonErrors[0].file, "demo/package.json");

  files["/repo/demo/package.json"] = JSON.stringify({ pi: { extensions: "src/index.ts" } });
  findings = byCheck(lint(files), "manifest-paths");
  assert.equal(findings.length, 1);
  assert.match(findings[0].message, /pi\.extensions must be a non-empty array of strings/);

  files["/repo/demo/package.json"] = JSON.stringify({
    pi: { extensions: ["./src/index.ts"] },
    scripts: { check: 42 },
  });
  findings = byCheck(lint(files), "npm-scripts");
  const shapeError = findings.filter((finding) => /scripts must be an object/.test(finding.message));
  assert.equal(shapeError.length, 1);
  assert.equal(shapeError[0].severity, "error");
  // Malformed scripts are not trusted as documentation, so documented script names still report.
  assert.ok(findings.some((finding) => /no "check" script/.test(finding.message)));
});

test("an extension package without README.md violates the documentation contract", () => {
  const files = validRepoFiles();
  delete files["/repo/demo/README.md"];
  const findings = lint(files);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "error");
  assert.equal(findings[0].file, "demo/README.md");
  assert.match(findings[0].message, /has no README\.md/);
});

test("directories without pi.extensions are not extension packages", () => {
  const files = {
    ...validRepoFiles(),
    "/repo/docs/README.md": "# docs\n",
    "/repo/plain/package.json": JSON.stringify({ name: "not-a-pi-package" }),
  };
  const report = runDocLint(createMemoryFs(files), "/repo");
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.packagesScanned, ["demo"]);
});

test("findings are capped at maxFindings and the cap is reported", () => {
  const files = validRepoFiles();
  files["/repo/AGENTS.md"] = "| Package | Purpose |\n| --- | --- |\n";
  delete files["/repo/demo/README.md"];
  const report = runDocLint(createMemoryFs(files), "/repo", { maxFindings: 1 });
  assert.equal(report.findings.length, 1);
  assert.equal(report.omitted, 1);
});
