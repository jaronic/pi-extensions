import assert from "node:assert/strict";
import test from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderLspCall, renderLspResult } from "../src/renderer.ts";

const theme = {
  fg: (color: string, text: string) => `[${color}]${text}[/]`,
  bold: (text: string) => `*${text}*`,
} as unknown as Theme;

function rendered(component: { render(width: number): string[] }): string[] {
  return component.render(200).map((line) => line.trimEnd());
}

test("renderCall builds the shared title and reuses the streaming Text component", () => {
  const first = renderLspCall({ action: "diagnostics", file: "src/a.ts" }, theme, undefined);
  assert.deepEqual(rendered(first), ["[toolTitle]*LSP*[/][muted] · diagnostics [/][accent]src/a.ts[/]"]);

  // Streaming re-renders mutate the previous component instead of allocating.
  const second = renderLspCall({ action: "diagnostics", file: "src/a.ts" }, theme, first);
  assert.equal(second, first);

  const rename = renderLspCall({ action: "rename_preview", file: "src/a.ts", newName: "renamed" }, theme, undefined);
  assert.deepEqual(rendered(rename), ["[toolTitle]*LSP*[/][muted] · rename_preview [/][accent]src/a.ts → renamed[/]"]);

  const queryOnly = renderLspCall({ action: "workspace_symbols", query: "load" }, theme, undefined);
  assert.deepEqual(rendered(queryOnly), ["[toolTitle]*LSP*[/][muted] · workspace_symbols [/][accent]load[/]"]);
});

test("renderResult prefixes a status row and styles diagnostic severities", () => {
  const result = {
    content: [{
      type: "text",
      text: [
        "[ts] src/a.ts:2:5 error TS2322: Type 'string' is not assignable",
        "[ts] src/a.ts:4:1 warning ts(6133): 'x' is declared but never read",
        "[ts] src/a.ts:9:3 info: ok",
        "… 2 more diagnostic(s) omitted",
      ].join("\n"),
    }],
    details: { action: "diagnostics", servers: ["ts"], resultCount: 5, errorCount: 0 },
  };
  assert.deepEqual(rendered(renderLspResult(result as never, { expanded: true, isError: false }, theme)), [
    "[success]✓[/] [accent]diagnostics[/]: [text]5 result(s)[/]",
    "[error][ts] src/a.ts:2:5 error TS2322: Type 'string' is not assignable[/]",
    "[warning][ts] src/a.ts:4:1 warning ts(6133): 'x' is declared but never read[/]",
    "[toolOutput][ts] src/a.ts:9:3 info: ok[/]",
    "[muted]… 2 more diagnostic(s) omitted[/]",
  ]);
});

test("renderResult warns when a server errored and styles server error lines", () => {
  const result = {
    content: [{ type: "text", text: "[jdtls] ERROR request timed out" }],
    details: { action: "diagnostics", servers: ["jdtls"], resultCount: 0, errorCount: 1 },
  };
  assert.deepEqual(rendered(renderLspResult(result as never, { expanded: false, isError: false }, theme)), [
    "[warning]![/] [accent]diagnostics[/]: [text]0 result(s)[/]",
    "[error][jdtls] ERROR request timed out[/]",
  ]);
});

test("renderResult collapses body lines at the limit and expands every line", () => {
  const body = Array.from({ length: 20 }, (_, index) => `src/a.ts:${index + 1}:1`).join("\n");
  const result = {
    content: [{ type: "text", text: body }],
    details: { action: "references", servers: ["ts"], resultCount: 20, errorCount: 0 },
  };
  const collapsed = rendered(renderLspResult(result as never, { expanded: false, isError: false }, theme));
  assert.equal(collapsed.length, 1 + 15 + 1);
  assert.equal(collapsed.at(-1), "[muted]… (5 more lines; expand to show all)[/]");
  const expanded = rendered(renderLspResult(result as never, { expanded: true, isError: false }, theme));
  assert.equal(expanded.length, 1 + 20);
});

test("renderResult surfaces truncation artifacts and status counts", () => {
  const truncated = {
    content: [{ type: "text", text: "src/a.ts:1:1" }],
    details: {
      action: "rename_preview",
      servers: ["ts"],
      resultCount: 300,
      errorCount: 0,
      truncated: true,
      fullOutputPath: "/tmp/pi-lsp-full.txt",
    },
  };
  assert.deepEqual(rendered(renderLspResult(truncated as never, { expanded: false, isError: false }, theme)), [
    "[success]✓[/] [accent]rename_preview[/]: [text]300 result(s)[/]",
    "[toolOutput]src/a.ts:1:1[/]",
    "[muted]full output[/]: [text]/tmp/pi-lsp-full.txt[/]",
  ]);

  const status = {
    content: [{ type: "text", text: "Configured servers: 9\nActive clients: 1" }],
    details: {
      action: "status",
      servers: ["ts"],
      resultCount: 1,
      errorCount: 0,
      configuredCount: 9,
      activeCount: 1,
    },
  };
  assert.equal(
    rendered(renderLspResult(status as never, { expanded: false, isError: false }, theme))[0],
    "[success]✓[/] [accent]status[/]: [text]1 active / 9 configured[/]",
  );
});

test("renderResult renders errors verbatim and tolerates malformed details", () => {
  const failure = {
    content: [{ type: "text", text: "ts: server exited" }],
    details: { action: "hover", servers: ["ts"], resultCount: 0, errorCount: 0 },
  };
  assert.deepEqual(rendered(renderLspResult(failure as never, { expanded: false, isError: true }, theme)), [
    "[error]ts: server exited[/]",
  ]);

  const malformed = {
    content: [{ type: "text", text: "No locations." }],
    details: { action: "definition", resultCount: "zero" },
  };
  assert.deepEqual(rendered(renderLspResult(malformed as never, { expanded: false, isError: false }, theme)), [
    "[toolOutput]No locations.[/]",
  ]);
});
