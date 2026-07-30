import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BinaryManager } from "./binary.ts";
import { executeEdit } from "./edit.ts";
import { boundedToolError } from "./output.ts";
import { OperationTracker } from "./operations.ts";
import {
  EditParameters,
  normalizeEditInput,
  normalizeSearchInput,
  SearchParameters,
} from "./schema.ts";
import { AstGrepRunner } from "./runner.ts";
import { NativeScheduler } from "./scheduler.ts";
import { executeSearch } from "./search.ts";
import {
  renderEditCall,
  renderEditResult,
  renderSearchCall,
  renderSearchResult,
} from "./renderer.ts";
import type { AstGrepEditToolDetails, AstGrepSearchToolDetails } from "./types.ts";

const SHUTDOWN_BARRIER_MS = 5000;

export default function astGrepExtension(pi: ExtensionAPI): void {
  const tracker = new OperationTracker();
  const scheduler = new NativeScheduler();
  const binary = new BinaryManager(scheduler);
  const runner = new AstGrepRunner(scheduler, binary);

  pi.registerTool<typeof SearchParameters, AstGrepSearchToolDetails>({
    name: "ast_grep_search",
    label: "AST-Grep Search",
    description:
      "AST-aware structural search for one explicit language and one file or directory scope. Use $NAME for one captured node, $_ for an uncaptured node, $$VAR for an unnamed node, and $$$NAME for zero or more nodes. Repeated captures must be structurally equal. Use selector with enough parseable context for non-standalone fragments. This is not text grep: use rg for literal or regex text search. Prefer this over rg for structural questions — every call of a function, each class extending a base, all occurrences of a symbol before a rename — where text search misses shorthand, multiline, or aliased forms.",
    promptSnippet: "AST-aware structural search for one language",
    promptGuidelines: [
      "Use ast_grep_search for syntax shape; use rg for text. Narrow path first and query one language at a time.",
      "Before a rename or signature change, search structurally with ast_grep_search instead of rg to catch shorthand, multiline, and re-exported forms.",
      "Pattern and selector must parse in the requested language. Type annotations or wrappers may need explicit context.",
      "Pagination is deterministic only while the workspace is unchanged; restart at offset 0 after writes.",
    ],
    parameters: SearchParameters,
    executionMode: "parallel",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      try {
        if (typeof cwd !== "string" || !cwd.isWellFormed() || cwd.includes("\0")) {
          throw new Error("current working directory is not a safe filesystem path.");
        }
        const input = normalizeSearchInput(params);
        return await tracker.run(signal, input.timeoutMs, (record) =>
          executeSearch(input, cwd, record, runner, onUpdate));
      } catch (error) {
        throw boundedToolError(error, [cwd]);
      }
    },
    renderCall: renderSearchCall,
    renderResult: renderSearchResult,
  });

  pi.registerTool<typeof EditParameters, AstGrepEditToolDetails>({
    name: "ast_grep_edit",
    label: "AST-Grep Edit",
    description:
      "Structural rewrite of one file: rename a symbol, reshape call sites, or delete matches atomically instead of many manual edit calls. Workflow: call action=preview WITHOUT previewId, inspect the complete preview, then action=apply repeating the same path, language, pattern, rewrite, selector, strictness, and maxReplacements plus the returned previewId; timeout may differ. The ID binds the canonical workspace path, semantic query, current source bytes, and actual replacement ranges. It is not approval. After any failure or source change, preview again instead of retrying an old ID.",
    promptSnippet: "Atomic structural rewrite of one file via preview then apply",
    promptGuidelines: [
      "For renaming a symbol or rewriting a repeated call shape within one file, prefer ast_grep_edit over a sequence of manual edits.",
      "action=preview must omit previewId entirely; only action=apply sends the ID returned by that preview.",
      "Always inspect a complete ast_grep_edit preview before apply; previewId is a stale-write guard, not user authorization.",
      "An empty rewrite deletes matched non-empty ranges. v1 refuses zero-width, overlapping, hard-linked, non-UTF-8, or syntax-ERROR sources.",
      "After apply, use the committed result hashes or VCS diff to review the file; do not reuse the previewId.",
    ],
    parameters: EditParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      try {
        if (typeof cwd !== "string" || !cwd.isWellFormed() || cwd.includes("\0")) {
          throw new Error("current working directory is not a safe filesystem path.");
        }
        const input = normalizeEditInput(params);
        return await tracker.run(signal, input.timeoutMs, (record) =>
          executeEdit(input, cwd, record, runner, onUpdate));
      } catch (error) {
        throw boundedToolError(error, [cwd]);
      }
    },
    renderCall: renderEditCall,
    renderResult: renderEditResult,
  });

  pi.on("session_shutdown", async () => {
    const settlement = Promise.allSettled([
      tracker.shutdown(SHUTDOWN_BARRIER_MS),
      runner.shutdown(),
    ]);
    let barrier: NodeJS.Timeout | undefined;
    await Promise.race([
      settlement,
      new Promise<void>((resolve) => {
        barrier = setTimeout(resolve, SHUTDOWN_BARRIER_MS);
        barrier.unref();
      }),
    ]);
    clearTimeout(barrier);
  });
}
