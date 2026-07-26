import { withFileMutationQueue, type AgentToolResult, type AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import type { NormalizedEditInput } from "./schema.ts";
import type {
  AstEditApplyDetailsV1,
  AstEditPreviewDetailsV1,
  AstGrepEditToolDetails,
  DecodedMatch,
} from "./types.ts";
import type { OperationRecord } from "./operations.ts";
import { throwIfCancelledOrExpired } from "./operations.ts";
import type { AstGrepRunner } from "./runner.ts";
import { readBoundedFile, resolveWorkspaceTarget } from "./paths.ts";
import { createEditPlan } from "./edits.ts";
import { commitEditSync } from "./atomic-write.ts";
import { formatApplyResult, formatPreviewResult, ProgressReporter } from "./output.ts";

const EDIT_SOURCE_BYTES = 3_000_000;
const MAX_EDIT_RECORDS = 50;

export async function executeEdit(
  input: NormalizedEditInput,
  cwd: string,
  record: OperationRecord,
  runner: AstGrepRunner,
  onUpdate: AgentToolUpdateCallback<AstGrepEditToolDetails> | undefined,
): Promise<AgentToolResult<AstEditPreviewDetailsV1 | AstEditApplyDetailsV1>> {
  throwIfCancelledOrExpired(record);
  const target = await resolveWorkspaceTarget(input.path, cwd, "file");
  throwIfCancelledOrExpired(record);
  const operation = input.action === "preview" ? "edit-preview" : "edit-apply";
  const progress = new ProgressReporter(onUpdate, record, operation, target.displayPath);
  progress.update("waiting-file", 0);

  return withFileMutationQueue(target.canonicalPath, async () => {
    throwIfCancelledOrExpired(record);
    const source = await readBoundedFile(target, EDIT_SOURCE_BYTES, record);
    throwIfCancelledOrExpired(record);
    progress.update("waiting-native", 0);
    return runner.withSession(record, async (execution) => {
      progress.update("guard", 0);
      await execution.run({
        mode: "error-guard",
        cwd: target.canonicalWorkspace,
        language: input.language,
        stdin: source,
      }, async () => {
        throw new Error(`ast-grep edit refused ${target.displayPath}: source contains an explicit ERROR node. Fix syntax errors before rewriting.`);
      });
      throwIfCancelledOrExpired(record);

      const records: DecodedMatch[] = [];
      progress.update("query", 0);
      await execution.run({
        mode: "rewrite",
        cwd: target.canonicalWorkspace,
        language: input.language,
        pattern: input.pattern,
        strictness: input.strictness,
        rewrite: input.rewrite,
        stdin: source,
        ...(input.selector === undefined ? {} : { selector: input.selector }),
      }, async (match) => {
        if (records.length >= MAX_EDIT_RECORDS) {
          throw new Error(`ast-grep produced more than ${MAX_EDIT_RECORDS} rewrite records; narrow the pattern. No changes were written.`);
        }
        records.push(match);
        progress.update("query", records.length);
      });
      throwIfCancelledOrExpired(record);
      const plan = createEditPlan(
        input,
        target.canonicalWorkspace,
        target.canonicalPath,
        target.displayPath,
        source,
        Number(target.identity.mode),
        records,
      );
      progress.update("formatting", records.length);
      if (input.action === "preview") {
        const result = formatPreviewResult(plan);
        throwIfCancelledOrExpired(record);
        return result;
      }
      if (plan.edits.length === 0) {
        throw new Error("apply cannot commit a no-op because no previewId is issued for zero effective replacements.");
      }
      if (input.previewId !== plan.previewId) {
        throw new Error("previewId is stale or does not match the current path, query, source, or replacements; run preview again.");
      }
      const result = formatApplyResult(plan, input.previewId);
      commitEditSync(plan, target, record);
      return result;
    });
  });
}
