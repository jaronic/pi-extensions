import { setTimeout as delay } from "node:timers/promises";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RequestService } from "pi-request-ui-dev";
import { DiffReportCallLedger } from "./call-ledger.ts";
import { assessReportQuality } from "./report-quality.ts";
import {
  buildExplorationKickoff,
  collectAnalysisBrief,
  COMMAND_USAGE,
  parseCommandArgs,
} from "./workflow.ts";

const TURN_START_TIMEOUT_MS = 30_000;

async function waitForTurnStart(ctx: ExtensionCommandContext, required = true): Promise<void> {
  const deadline = Date.now() + TURN_START_TIMEOUT_MS;
  while (ctx.isIdle()) {
    ctx.signal?.throwIfAborted();
    if (Date.now() >= deadline) {
      if (required) {
        throw new Error("Exploration turn did not start within 30 seconds.");
      }
      return;
    }
    await delay(10);
  }
}

async function verifyReportArtifact(
  ctx: ExtensionCommandContext,
  outputPath: string,
  callLedger: DiffReportCallLedger,
  explorationStartedAt: number,
): Promise<void> {
  const absolutePath = resolve(ctx.cwd, outputPath);
  const stats = await stat(absolutePath).catch(() => undefined);
  if (!stats?.isFile() || stats.size === 0) {
    ctx.ui.notify(
      `diff_report finished but no report exists at ${outputPath}. The exploration may have been aborted or is still queued.`,
      "error",
    );
    return;
  }
  const markdown = await readFile(absolutePath, "utf8").catch(() => "");
  const issues = assessReportQuality(markdown);
  const calls = callLedger.since(explorationStartedAt);
  // The kickoff mandates an inventory pass plus at least one targeted pass;
  // without them the report was drafted from thin air, not from evidence.
  if (!calls.some((call) => call.view === "overview")) {
    issues.push("no diff_report overview pass was recorded during the exploration");
  }
  if (!calls.some((call) => call.view === "patch" || call.view === "history")) {
    issues.push("no targeted diff_report patch/history pass was recorded during the exploration");
  }
  if (issues.length > 0) {
    ctx.ui.notify(`Diff report written: ${outputPath} — contract warnings: ${issues.join("; ")}`, "warning");
    return;
  }
  ctx.ui.notify(`Diff report written: ${outputPath}`, "info");
}

export function registerDiffReportCommand(
  pi: ExtensionAPI,
  requestService: RequestService,
  now: () => Date = () => new Date(),
  callLedger: DiffReportCallLedger = new DiffReportCallLedger(),
): void {
  pi.registerCommand("diff_report", {
    description: "Explore business logic from a branch, uncommitted changes, or commit history and write a Markdown report",
    handler: async (args, ctx) => {
      const parsed = parseCommandArgs(args);
      if (parsed.error) {
        ctx.ui.notify(`${parsed.error}\n${COMMAND_USAGE}`, "warning");
        return;
      }

      try {
        const brief = await collectAnalysisBrief(
          pi,
          requestService,
          ctx.cwd,
          parsed,
          ctx.mode === "tui" && ctx.hasUI,
          now(),
          ctx.signal,
        );
        if (!brief) {
          ctx.ui.notify("Diff report exploration cancelled.", "info");
          return;
        }

        const kickoff = buildExplorationKickoff(brief);
        const explorationStartedAt = now().getTime();
        if (ctx.isIdle()) {
          pi.sendUserMessage(kickoff);
          ctx.ui.notify(`Business-logic exploration started. Report target: ${brief.outputPath}`, "info");
          await waitForTurnStart(ctx);
        } else {
          // The kickoff is queued as a followUp, so waiting only for the current
          // turn would return before the exploration even starts. Drain the
          // current turn, then wait for the queued turn as well. The followUp
          // turn may already be underway (or even finished) by the time the
          // first wait resolves, so a missing new turn is tolerated here.
          pi.sendUserMessage(kickoff, { deliverAs: "followUp" });
          ctx.ui.notify(`Business-logic exploration queued behind the current turn. Report target: ${brief.outputPath}`, "info");
          await ctx.waitForIdle();
          await waitForTurnStart(ctx, false);
        }
        await ctx.waitForIdle();
        // The report artifact is the only reliable completion signal: the agent
        // turn can end without writing it (aborted, model failure), and "idle"
        // alone must never be reported as success.
        await verifyReportArtifact(ctx, brief.outputPath, callLedger, explorationStartedAt);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`diff_report failed: ${message}`, "error");
      }
    },
  });
}
