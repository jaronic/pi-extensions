import assert from "node:assert/strict";
import test from "node:test";
import { assessReportQuality } from "../src/report-quality.ts";

test("accepts a contract-compliant report", () => {
  const markdown = [
    "# Report",
    "",
    "Business behavior with [E1] inline.",
    "",
    "```mermaid",
    "flowchart TD",
    "  A --> B",
    "```",
    "",
    "## Evidence index",
    "",
    "| ID | Type | Revision | Location | Establishes | Confidence |",
  ].join("\n");
  assert.deepEqual(assessReportQuality(markdown), []);
});

test("flags a truncated file, missing evidence IDs, and a missing evidence index", () => {
  const issues = assessReportQuality("# Report\n\n```mermaid\nflowchart TD\n");
  assert.ok(issues.some((issue) => issue.includes("unbalanced code fences")));
  assert.ok(issues.some((issue) => issue.includes("no inline evidence IDs")));
  assert.ok(issues.some((issue) => issue.includes("no evidence index")));
});

test("accepts a Chinese evidence index heading", () => {
  const markdown = "# 报告\n\n含 [E1] 内联证据。\n\n## 证据索引\n\n| ID | 类型 |\n";
  assert.deepEqual(assessReportQuality(markdown), []);
});
