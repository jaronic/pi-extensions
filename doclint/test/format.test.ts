import assert from "node:assert/strict";
import test from "node:test";
import type { LintReport } from "../src/checks.ts";
import { formatReport } from "../src/format.ts";

function report(findings: LintReport["findings"], omitted = 0): LintReport {
  return { root: "/repo", packagesScanned: ["demo"], findings, omitted };
}

test("a clean report states that the contract holds", () => {
  const text = formatReport(report([]));
  assert.match(text, /no findings; the documentation contract holds/);
  assert.match(text, /packages scanned \(1\): demo/);
});

test("findings are grouped by file with errors before warnings", () => {
  const text = formatReport(
    report([
      { file: "demo/README.md", check: "surface-names", severity: "warning", message: "later warning" },
      { file: "AGENTS.md", check: "agents-table", severity: "error", message: "table error" },
      { file: "demo/README.md", check: "surface-names", severity: "error", message: "first error" },
    ]),
  );
  const lines = text.split("\n");
  assert.match(lines[0], /2 error\(s\), 1 warning\(s\)/);
  const agentsIndex = lines.indexOf("AGENTS.md:");
  const readmeIndex = lines.indexOf("demo/README.md:");
  assert.ok(readmeIndex > 0 && agentsIndex > readmeIndex, "groups preserve first-appearance order");
  const firstError = lines.findIndex((line) => line.includes("first error"));
  const laterWarning = lines.findIndex((line) => line.includes("later warning"));
  assert.ok(firstError > readmeIndex && laterWarning > firstError, "errors sort before warnings within a file");
  assert.ok(lines.some((line) => line === "  [error] agents-table: table error"));
});

test("the omitted-finding cap is surfaced in the header", () => {
  const text = formatReport(
    report([{ file: "AGENTS.md", check: "agents-table", severity: "error", message: "x" }], 7),
  );
  assert.match(text, /omitted findings: 7/);
});

test("output is truncated to the configured line budget", () => {
  const findings = Array.from({ length: 20 }, (_, index) => ({
    file: `pkg${index}/README.md`,
    check: "surface-names" as const,
    severity: "error" as const,
    message: `finding ${index}`,
  }));
  const text = formatReport(report(findings), { maxLines: 6, maxBytes: 50 * 1024 });
  const lines = text.split("\n");
  assert.ok(lines.length <= 7, `expected at most 7 lines, got ${lines.length}`);
  assert.match(lines[lines.length - 1], /truncated: showing \d+ of \d+ lines/);
});
