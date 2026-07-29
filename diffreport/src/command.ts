import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RequestService } from "pi-request-ui-dev";
import {
  buildExplorationKickoff,
  collectAnalysisBrief,
  COMMAND_USAGE,
  parseCommandArgs,
} from "./workflow.ts";

const TURN_START_TIMEOUT_MS = 30_000;

async function waitForTurnStart(ctx: ExtensionCommandContext): Promise<void> {
  const deadline = Date.now() + TURN_START_TIMEOUT_MS;
  while (ctx.isIdle()) {
    ctx.signal?.throwIfAborted();
    if (Date.now() >= deadline) {
      throw new Error("Exploration turn did not start within 30 seconds.");
    }
    await delay(10);
  }
}

export function registerDiffReportCommand(
  pi: ExtensionAPI,
  requestService: RequestService,
  now: () => Date = () => new Date(),
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
        const startsNewTurn = ctx.isIdle();
        if (startsNewTurn) pi.sendUserMessage(kickoff);
        else pi.sendUserMessage(kickoff, { deliverAs: "followUp" });
        ctx.ui.notify(`Business-logic exploration started. Report target: ${brief.outputPath}`, "info");
        if (startsNewTurn) await waitForTurnStart(ctx);
        await ctx.waitForIdle();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`diff_report failed: ${message}`, "error");
      }
    },
  });
}
