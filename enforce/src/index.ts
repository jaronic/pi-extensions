import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerEnforceCommand } from "./command.ts";
import { loadConfig } from "./config.ts";
import { evaluateToolCall } from "./rules.ts";
import type { EnforceConfig } from "./types.ts";

export const ENFORCE_NUDGE_TYPE = "enforce-nudge-v1";

export interface EnforceExtensionDependencies {
  configLoader?: (cwd: string, includeProject: boolean) => Promise<EnforceConfig>;
}

interface ConfigHost {
  cwd: string;
  isProjectTrusted(): boolean;
}

/**
 * Tool-usage enforcement kit. Nudges steer the model toward high-value tools
 * without blocking; gates block a call only when a config file explicitly
 * upgrades a rule. Evaluation is deterministic and never depends on the lsp
 * or ast-grep packages being installed — rules fire only while their
 * recommended tool appears in pi.getActiveTools().
 */
export default function enforceExtension(
  pi: ExtensionAPI,
  dependencies: EnforceExtensionDependencies = {},
): void {
  const load = dependencies.configLoader ?? loadConfig;
  let config: EnforceConfig | undefined;
  let configPromise: Promise<EnforceConfig> | undefined;
  const nudgedRuleIds = new Set<string>();

  async function ensureConfig(host: ConfigHost): Promise<EnforceConfig> {
    if (config) return config;
    if (!configPromise) {
      configPromise = load(host.cwd, host.isProjectTrusted())
        .then((loaded) => {
          config = loaded;
          return loaded;
        })
        .finally(() => {
          configPromise = undefined;
        });
    }
    return await configPromise;
  }

  registerEnforceCommand(pi, {
    getConfig: () => config,
    getNudgedRuleIds: () => [...nudgedRuleIds],
    reload: async (ctx: ExtensionCommandContext) => {
      config = undefined;
      nudgedRuleIds.clear();
      return await ensureConfig(ctx);
    },
  });

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    nudgedRuleIds.clear();
    config = undefined;
    const loaded = await ensureConfig(ctx);
    if (loaded.error && ctx.hasUI) ctx.ui.notify(loaded.error, "warning");
  });

  pi.on("tool_call", async (event, ctx) => {
    const loaded = await ensureConfig(ctx);
    const input = event.input as Record<string, unknown>;
    const decision = evaluateToolCall(loaded.rules, pi.getActiveTools(), event.toolName, input);
    if (!decision) return undefined;
    if (decision.kind === "gate") {
      return { block: true, reason: decision.text };
    }
    const rule = loaded.rules.find((candidate) => candidate.id === decision.ruleId);
    if (rule?.once !== false && nudgedRuleIds.has(decision.ruleId)) return undefined;
    nudgedRuleIds.add(decision.ruleId);
    try {
      pi.sendMessage(
        {
          customType: ENFORCE_NUDGE_TYPE,
          content: decision.text,
          display: false,
          details: { ruleId: decision.ruleId, tool: event.toolName },
        },
        { deliverAs: "steer" },
      );
    } catch {
      // A failed nudge must never break the original tool call.
    }
    return undefined;
  });

  pi.on("session_shutdown", () => {
    // Idempotent: only in-memory state exists, no listeners, timers, or processes.
    config = undefined;
    nudgedRuleIds.clear();
  });
}
