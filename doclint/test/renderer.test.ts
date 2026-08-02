import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Text } from "@earendil-works/pi-tui";
import { renderDocLintCall, renderDocLintResult, type DocLintToolDetails } from "../src/renderer.ts";
import type { CheckId, Finding } from "../src/checks.ts";

// Records which theme token each span resolves to, so tests can assert the
// color shape instead of exact ANSI bytes.
const theme = {
  fg(token: string, text: string): string {
    return `«${token}:${text}»`;
  },
  bold(text: string): string {
    return `**${text}**`;
  },
} as unknown as Theme;

const collapsed = { expanded: false, isPartial: false };
const expanded = { expanded: true, isPartial: false };
const okContext = { isError: false };

function render(component: Text): string[] {
  return component.render(500).map((line) => line.trimEnd());
}

function finding(file: string, severity: "error" | "warning", message: string, check: CheckId = "surface-names"): Finding {
  return { file, check, severity, message };
}

function details(overrides: Partial<DocLintToolDetails> = {}): DocLintToolDetails {
  return {
    root: "/repo",
    packagesScanned: ["demo"],
    errors: 0,
    warnings: 0,
    omitted: 0,
    findings: [],
    ...overrides,
  };
}

function resultWith(detailsValue: unknown) {
  return { content: [{ type: "text" as const, text: "doc lint text output" }], details: detailsValue };
}

test("renderDocLintCall renders the shared title and reuses the streaming Text component", () => {
  const fresh = render(renderDocLintCall({ action: "check", root: "demo" }, theme, okContext));
  assert.deepEqual(fresh, ["«toolTitle:**Doclint**»«muted: · check »«accent:demo»"]);

  const withoutRoot = render(renderDocLintCall({ action: "check" }, theme, okContext));
  assert.deepEqual(withoutRoot, ["«toolTitle:**Doclint**»«muted: · check »"]);

  // Build the "previous" component through the renderer itself so it carries
  // the same Text class uikit sees (uikit resolves pi-tui from its own tree).
  const last = renderDocLintCall({ action: "check" }, theme, okContext);
  const reused = renderDocLintCall({ action: "check", root: "demo" }, theme, { isError: false, lastComponent: last });
  assert.equal(reused, last);
  assert.deepEqual(render(last), ["«toolTitle:**Doclint**»«muted: · check »«accent:demo»"]);
});

test("renderDocLintResult shows a success status row and kv rows for a clean report", () => {
  const lines = render(renderDocLintResult(resultWith(details()), collapsed, theme, okContext));
  assert.deepEqual(lines, [
    "«success:✓» «accent:doc lint»: «text:no findings; the documentation contract holds»",
    "«muted:root»: «text:/repo»",
    "«muted:packages scanned»: «text:1 (demo)»",
  ]);
});

test("renderDocLintResult groups findings by file, errors before warnings, toned by severity", () => {
  const report = details({
    errors: 2,
    warnings: 1,
    findings: [
      finding("demo/README.md", "warning", "extra row"),
      finding("AGENTS.md", "error", "missing package row"),
      finding("demo/README.md", "error", "demo_tool never appears", "surface-names"),
    ],
  });
  const lines = render(renderDocLintResult(resultWith(report), collapsed, theme, okContext));
  assert.deepEqual(lines, [
    "«error:✕» «accent:doc lint»: «text:2 error(s), 1 warning(s)»",
    "«muted:root»: «text:/repo»",
    "«muted:packages scanned»: «text:1 (demo)»",
    "",
    "«accent:demo/README.md:»",
    "«error:  [error] surface-names: demo_tool never appears»",
    "«warning:  [warning] surface-names: extra row»",
    "",
    "«accent:AGENTS.md:»",
    "«error:  [error] surface-names: missing package row»",
  ]);
});

test("renderDocLintResult collapses the finding body and expands it on request", () => {
  const findings = Array.from({ length: 20 }, (_, index) => finding("AGENTS.md", "error", `drift ${index + 1}`));
  const report = details({ errors: 20, findings });

  const collapsedLines = render(renderDocLintResult(resultWith(report), collapsed, theme, okContext));
  // header (3) + 15 body lines (blank, file header, 13 findings) + hint.
  assert.equal(collapsedLines.length, 19);
  assert.deepEqual(collapsedLines.at(-1), ["«muted:… (7 more lines; expand to show all)»"][0]);

  const expandedLines = render(renderDocLintResult(resultWith(report), expanded, theme, okContext));
  assert.equal(expandedLines.length, 25);
  assert.equal(expandedLines.some((line) => line.includes("more lines")), false);
});

test("renderDocLintResult surfaces omitted findings and findings beyond the details cap", () => {
  const findings = Array.from({ length: 5 }, (_, index) => finding("AGENTS.md", "error", `drift ${index + 1}`));
  const report = details({ errors: 8, omitted: 3, findings });
  const lines = render(renderDocLintResult(resultWith(report), expanded, theme, okContext));
  assert.deepEqual(lines[3], "«warning:omitted findings: 3 (raise maxFindings to see them)»");
  assert.deepEqual(lines.at(-1), "«muted:… (3 more findings in the tool text output)»");
});

test("renderDocLintResult falls back to plain text for errors and malformed details", () => {
  const failure = render(renderDocLintResult(
    { content: [{ type: "text" as const, text: "doc_lint root does not exist" }], details: undefined },
    collapsed,
    theme,
    { isError: true },
  ));
  assert.deepEqual(failure, ["«error:doc_lint root does not exist»"]);

  const forged = render(renderDocLintResult(resultWith({ root: 42 }), collapsed, theme, okContext));
  assert.deepEqual(forged, ["«toolOutput:doc lint text output»"]);
});
