import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { EnforceConfig } from "./types.ts";

export interface EnforceCommandRuntime {
  getConfig(): EnforceConfig | undefined;
  getNudgedRuleIds(): readonly string[];
  reload(ctx: ExtensionCommandContext): Promise<EnforceConfig>;
}

const MAX_STATUS_RULES = 30;

function describeConfig(config: EnforceConfig | undefined, nudgedRuleIds: readonly string[]): string {
  if (!config) return "Enforce: rules not loaded yet (they load on session start).";
  const gates = config.rules.filter((rule) => rule.action === "gate");
  const lines = [
    `Enforce: ${config.rules.length} rule(s) active (${gates.length} gate, ${config.rules.length - gates.length} nudge); ${nudgedRuleIds.length} nudge(s) sent this session.`,
    config.loadedFrom.length > 0 ? `Config files: ${config.loadedFrom.join(", ")}` : "Config files: none (built-in defaults only)",
  ];
  if (config.error) lines.push(`Error: ${config.error}`);
  return lines.join("\n");
}

export function registerEnforceCommand(pi: ExtensionAPI, runtime: EnforceCommandRuntime): void {
  pi.registerCommand("enforce", {
    description: "Inspect or reload the tool-usage enforcement rules (status, rules, reload)",
    getArgumentCompletions: (prefix) => {
      const values = ["status", "rules", "reload"];
      const filtered = values.filter((value) => value.startsWith(prefix.trim()));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim();
      if (action === "" || action === "status") {
        ctx.ui.notify(describeConfig(runtime.getConfig(), runtime.getNudgedRuleIds()), "info");
        return;
      }
      if (action === "rules") {
        const config = runtime.getConfig();
        if (!config) {
          ctx.ui.notify("Enforce: rules not loaded yet.", "info");
          return;
        }
        const lines = config.rules.slice(0, MAX_STATUS_RULES).map((rule) => {
          const gate = rule.action === "gate" ? "gate" : "nudge";
          const condition = rule.recommend ? `requires ${rule.recommend} active` : "always";
          return `${rule.id} [${gate}, ${rule.source}, ${condition}] → ${rule.tool}`;
        });
        if (config.rules.length > MAX_STATUS_RULES) lines.push(`… and ${config.rules.length - MAX_STATUS_RULES} more`);
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }
      if (action === "reload") {
        const config = await runtime.reload(ctx);
        ctx.ui.notify(
          config.error ? `Enforce reloaded with errors. ${config.error}` : `Enforce reloaded: ${config.rules.length} rule(s) active.`,
          config.error ? "warning" : "info",
        );
        return;
      }
      ctx.ui.notify(`Unknown /enforce action "${action}". Use: status, rules, reload.`, "error");
    },
  });
}
