import { lookup } from "node:dns/promises";
import { join } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadNotifyConfig, type LoadedNotifyConfig } from "./config.ts";
import { createChannels, type ChannelAdapter } from "./channels.ts";
import { createNotifier, type Notifier } from "./notifier.ts";
import { registerNotifyCommand } from "./command.ts";

type ExtensionMode = ExtensionContext["mode"];

export interface NotifyExtensionDeps {
  /** Override channel adapters (tests). Defaults to the real osascript/bell/ntfy adapters. */
  channels?: ChannelAdapter[];
  /** Override config loading (tests). Defaults to the layered file loader. */
  loadConfig?: (ctx: ExtensionContext) => Promise<LoadedNotifyConfig>;
  now?: () => number;
  dispatchTimeoutMs?: number;
}

export function createNotifyExtension(pi: ExtensionAPI, deps: NotifyExtensionDeps = {}): void {
  let loaded: LoadedNotifyConfig | null = null;
  let runtimeEnabled = true;
  let mode: ExtensionMode = "print";

  const channels = deps.channels ?? createChannels({
    platform: process.platform,
    exec: (command, args, options) => pi.exec(command, args, options),
    // TUI owns stdout; in rpc/json/print modes stdout is a machine-readable stream.
    writeBell: () => {
      (mode === "tui" ? process.stdout : process.stderr).write("\x07");
    },
    fetchImpl: fetch,
    lookup,
  });
  const notifier: Notifier = createNotifier({
    channels,
    now: deps.now,
    dispatchTimeoutMs: deps.dispatchTimeoutMs,
  });

  const loadConfig = deps.loadConfig ?? ((ctx: ExtensionContext) => loadNotifyConfig({
    globalPath: join(getAgentDir(), "notify.json"),
    projectPath: join(ctx.cwd, CONFIG_DIR_NAME, "notify.json"),
    projectTrusted: ctx.isProjectTrusted(),
    env: process.env,
  }));

  pi.on("session_start", async (_event, ctx) => {
    mode = ctx.mode;
    runtimeEnabled = true;
    try {
      loaded = await loadConfig(ctx);
    } catch (error) {
      loaded = null;
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Notify config failed to load; idle notifications paused. ${error instanceof Error ? error.message : String(error)}`,
          "error",
        );
      }
      return;
    }
    if (ctx.hasUI) {
      for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
    }
  });

  pi.on("agent_start", () => {
    notifier.agentStarted();
  });

  // agent_settled — not agent_end — is the stable "completely idle" point:
  // retries, compaction retries, and queued continuations have all finished.
  pi.on("agent_settled", async (_event, ctx) => {
    const current = loaded;
    if (!current) return;
    const report = await notifier.settled(current.config, runtimeEnabled, ctx.cwd);
    if (!report.decision.notify || report.outcomes.length === 0) return;
    const delivered = report.outcomes.some((outcome) => outcome.ok);
    if (!delivered && ctx.hasUI) {
      const failures = report.outcomes
        .map((outcome) => (outcome.error ? `${outcome.channel} (${outcome.error})` : undefined))
        .filter((entry): entry is string => entry !== undefined);
      if (failures.length > 0) {
        ctx.ui.notify(`Idle notification failed on every channel: ${failures.join(", ")}`, "warning");
      }
    }
  });

  pi.on("session_shutdown", () => {
    notifier.shutdown();
  });

  registerNotifyCommand(pi, {
    getLoaded: () => loaded,
    isRuntimeEnabled: () => runtimeEnabled,
    setRuntimeEnabled: (enabled) => {
      runtimeEnabled = enabled;
    },
    lastNotifiedAt: () => notifier.lastNotifiedAt(),
    channels: () => channels,
    test: (cwd) => {
      if (!loaded) throw new Error("Notify configuration is not loaded yet");
      return notifier.test(loaded.config, cwd);
    },
  });
}

export default function notifyExtension(pi: ExtensionAPI): void {
  createNotifyExtension(pi);
}
