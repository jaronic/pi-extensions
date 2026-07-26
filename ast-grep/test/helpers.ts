import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import type { NormalizedEditInput, NormalizedSearchInput } from "../src/schema.ts";
import { normalizeEditInput, normalizeSearchInput } from "../src/schema.ts";
import type { NativeExecution, NativeRunRequest, NativeRunResult } from "../src/runner.ts";
import type { AstGrepRunner } from "../src/runner.ts";
import type { OperationRecord } from "../src/operations.ts";
import type { DecodedMatch, SourceRange } from "../src/types.ts";

export async function temporaryWorkspace(t: TestContext, prefix = "pi-ast-grep-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

export async function materializeFakeAstGrep(root: string): Promise<string> {
  const template = await readFile(new URL("./fake-ast-grep.mjs", import.meta.url), "utf8");
  const script = join(root, "run");
  const source = template.replace(/^#![^\n]*\n?/u, "");
  await Promise.all([
    writeFile(script, source, "utf8"),
    writeFile(join(root, "package.json"), JSON.stringify({ private: true, type: "module" }), "utf8"),
  ]);
  return process.execPath;
}

export function operationRecord(now: () => number = () => 0, deadline = Number.POSITIVE_INFINITY): OperationRecord {
  return {
    id: "test-operation",
    startedAt: now(),
    deadline,
    now,
    controller: new AbortController(),
    committed: false,
  };
}

export function sourceRange(start: number, end: number, line = 0, startColumn = start, endColumn = end): SourceRange {
  return {
    byteOffset: { start, end },
    start: { line, column: startColumn },
    end: { line, column: endColumn },
  };
}

export function searchMatch(overrides: Partial<DecodedMatch> = {}): DecodedMatch {
  return {
    text: "foo(x)",
    file: "STDIN",
    lines: "foo(x)",
    charCount: { leading: 0, trailing: 0 },
    language: "TypeScript",
    range: sourceRange(0, 6),
    metaVariables: [],
    ...overrides,
  };
}

export function rewriteMatch(
  start: number,
  end: number,
  text: string,
  replacement: string,
  overrides: Partial<DecodedMatch> = {},
): DecodedMatch {
  return searchMatch({
    text,
    file: "STDIN",
    lines: text,
    range: sourceRange(start, end),
    replacement,
    replacementOffsets: { start, end },
    ...overrides,
  });
}

export function normalizedSearch(overrides: Partial<NormalizedSearchInput> = {}): NormalizedSearchInput {
  return {
    ...normalizeSearchInput({ pattern: "foo($A)", language: "typescript" }),
    ...overrides,
  };
}

export function normalizedEdit(overrides: Partial<NormalizedEditInput> = {}): NormalizedEditInput {
  return {
    ...normalizeEditInput({
      action: "preview",
      path: "sample.ts",
      language: "typescript",
      pattern: "foo($A)",
      rewrite: "bar($A)",
    }),
    ...overrides,
  };
}

export type FakeRunHandler = (
  request: NativeRunRequest,
  onRecord: Parameters<NativeExecution["run"]>[1],
) => Promise<NativeRunResult>;

export function fakeRunner(handler: FakeRunHandler): AstGrepRunner {
  return {
    async withSession<T>(_record: OperationRecord, work: (execution: NativeExecution) => Promise<T>): Promise<T> {
      return work({ run: handler });
    },
    async shutdown(): Promise<void> {},
  } as unknown as AstGrepRunner;
}
