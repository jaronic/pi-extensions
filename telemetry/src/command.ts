import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  buildTelemetryExport,
  formatTelemetryStatus,
  telemetryTotals,
  type TelemetryState,
} from "./state.ts";
import { resolveExportPath, writeExportFile } from "./export.ts";

export interface TelemetryCommandRuntime {
  getState(): TelemetryState;
  resetTelemetry(ctx: ExtensionCommandContext): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function registerTelemetryCommand(pi: ExtensionAPI, runtime: TelemetryCommandRuntime): void {
  pi.registerCommand("telemetry", {
    description: "Inspect, export, or reset tool-call telemetry (status by default)",
    getArgumentCompletions: (prefix) => {
      const values = ["status", "export", "reset"];
      const filtered = values.filter((value) => value.startsWith(prefix.trim()));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const [action, ...rest] = trimmed.split(/\s+/).filter(Boolean);

      if (!action || action === "status") {
        ctx.ui.notify(formatTelemetryStatus(runtime.getState()), "info");
        return;
      }

      if (action === "export") {
        const requested = rest.length ? rest.join(" ") : undefined;
        let targetPath: string;
        try {
          targetPath = await resolveExportPath(ctx.cwd, requested);
        } catch (error) {
          ctx.ui.notify(`Telemetry export rejected: ${errorMessage(error)}`, "error");
          return;
        }
        const payload = buildTelemetryExport(runtime.getState(), Date.now());
        try {
          await writeExportFile(targetPath, payload);
        } catch (error) {
          ctx.ui.notify(`Telemetry export failed: ${errorMessage(error)}`, "error");
          return;
        }
        const totals = telemetryTotals(runtime.getState().aggregates);
        ctx.ui.notify(`Telemetry exported (${totals.calls} calls) to ${targetPath}`, "info");
        return;
      }

      if (action === "reset") {
        const totals = telemetryTotals(runtime.getState().aggregates);
        if (totals.calls === 0) {
          ctx.ui.notify("Telemetry is already empty.", "info");
          return;
        }
        if (ctx.hasUI) {
          const confirmed = await ctx.ui.confirm(
            "Reset tool-call telemetry?",
            `${totals.calls} recorded call(s) across ${runtime.getState().aggregates.length} group(s) will be discarded. Export first with /telemetry export if you need the data.`,
          );
          if (!confirmed) return;
        }
        runtime.resetTelemetry(ctx);
        ctx.ui.notify("Telemetry reset.", "info");
        return;
      }

      ctx.ui.notify(`Unknown /telemetry action: ${action}. Usage: /telemetry [status] | export [file] | reset`, "warning");
    },
  });
}
