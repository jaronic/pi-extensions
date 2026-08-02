import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LoadedNotifyConfig } from "./config.ts";
import type { ChannelAdapter, ChannelAvailability, ChannelOutcome } from "./channels.ts";

export interface NotifyCommandRuntime {
  getLoaded(): LoadedNotifyConfig | null;
  isRuntimeEnabled(): boolean;
  setRuntimeEnabled(enabled: boolean): void;
  lastNotifiedAt(): number | null;
  channels(): ChannelAdapter[];
  test(cwd: string): Promise<ChannelOutcome[]>;
}

export interface ChannelStatus {
  id: string;
  enabled: boolean;
  availability: ChannelAvailability;
}

export interface NotifyStatusInfo {
  loaded: LoadedNotifyConfig | null;
  runtimeEnabled: boolean;
  lastNotifiedAt: number | null;
  channelStatuses: ChannelStatus[];
}

/** Human-readable status. Secrets (ntfy token) are reported only as configured/not configured. */
export function formatStatus(info: NotifyStatusInfo): string {
  if (!info.loaded) return "Notify: configuration not loaded yet.";
  const { config, layers } = info.loaded;
  const lines: string[] = [];
  const active = config.enabled && info.runtimeEnabled;
  lines.push(`Notify: ${active ? "active" : "inactive"} (config ${config.enabled ? "enabled" : "disabled"}, runtime ${info.runtimeEnabled ? "on" : "off"})`);
  lines.push(`Debounce: min interval ${config.minIntervalSeconds}s, min run length ${config.minTurnSeconds}s`);
  lines.push(`Last notification: ${info.lastNotifiedAt === null ? "never" : new Date(info.lastNotifiedAt).toISOString()}`);
  lines.push("Config layers (defaults < global < project < env):");
  for (const layer of layers) {
    const target = layer.path ? ` ${layer.path}` : "";
    const state = layer.applied ? "applied" : `skipped${layer.reason ? ` (${layer.reason})` : ""}`;
    lines.push(`  ${layer.source}${target}: ${state}`);
  }
  lines.push("Channels:");
  for (const status of info.channelStatuses) {
    const toggle = status.enabled ? "enabled" : "disabled";
    const availability = status.availability.available ? "available" : `unavailable (${status.availability.reason ?? "unknown"})`;
    lines.push(`  ${status.id}: ${toggle}, ${availability}`);
  }
  const ntfy = config.channels.ntfy;
  if (ntfy.enabled) {
    lines.push(`  ntfy target: ${ntfy.baseUrl}, topic ${ntfy.topic ?? "(none)"}, token ${ntfy.token ? "configured" : "not configured"}`);
  }
  return lines.join("\n");
}

function formatOutcome(outcome: ChannelOutcome): string {
  if (outcome.ok) return `${outcome.channel}: delivered`;
  if (outcome.skipped) return `${outcome.channel}: skipped (${outcome.skipped})`;
  return `${outcome.channel}: failed (${outcome.error ?? "unknown error"})`;
}

export function registerNotifyCommand(pi: ExtensionAPI, runtime: NotifyCommandRuntime): void {
  pi.registerCommand("notify", {
    description: "Show, test, enable, or disable out-of-band agent-idle notifications",
    getArgumentCompletions: (prefix) => {
      const values = ["status", "test", "on", "off"];
      const filtered = values.filter((value) => value.startsWith(prefix.trim()));
      return filtered.length ? filtered.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const action = args.trim() || "status";

      if (action === "on" || action === "off") {
        runtime.setRuntimeEnabled(action === "on");
        ctx.ui.notify(`Idle notifications turned ${action} for this session. Edit notify.json to change it persistently.`, "info");
        return;
      }

      if (action === "status") {
        const loaded = runtime.getLoaded();
        const channelStatuses: ChannelStatus[] = loaded
          ? runtime.channels().map((adapter) => ({
              id: adapter.id,
              enabled: loaded.config.channels[adapter.id].enabled,
              availability: adapter.availability(loaded.config),
            }))
          : [];
        ctx.ui.notify(
          formatStatus({
            loaded,
            runtimeEnabled: runtime.isRuntimeEnabled(),
            lastNotifiedAt: runtime.lastNotifiedAt(),
            channelStatuses,
          }),
          "info",
        );
        return;
      }

      if (action === "test") {
        const loaded = runtime.getLoaded();
        if (!loaded) {
          ctx.ui.notify("Notify configuration is not loaded yet; cannot send a test notification.", "warning");
          return;
        }
        let outcomes: ChannelOutcome[];
        try {
          outcomes = await runtime.test(ctx.cwd);
        } catch (error) {
          ctx.ui.notify(`Test notification failed: ${error instanceof Error ? error.message : String(error)}`, "error");
          return;
        }
        const failed = outcomes.some((outcome) => !outcome.ok && outcome.error);
        const delivered = outcomes.some((outcome) => outcome.ok);
        const summary = outcomes.map(formatOutcome).join("\n");
        ctx.ui.notify(`Test notification:\n${summary}`, failed && !delivered ? "error" : failed ? "warning" : "info");
        return;
      }

      ctx.ui.notify("Usage: /notify [status|test|on|off]", "warning");
    },
  });
}
