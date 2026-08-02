import type { NotifyConfig } from "./config.ts";

export interface NotifyMessage {
  title: string;
  body: string;
}

export interface SettleInput {
  now: number;
  lastNotifiedAt: number | null;
  runStartedAt: number | null;
  enabled: boolean;
}

export interface SettleDecision {
  notify: boolean;
  reason: string;
}

/** Pure debounce/threshold gate for the agent_settled trigger. */
export function decideSettledNotification(config: NotifyConfig, input: SettleInput): SettleDecision {
  if (!input.enabled || !config.enabled) {
    return { notify: false, reason: "notifications are disabled" };
  }
  if (config.minTurnSeconds > 0) {
    const durationMs = input.runStartedAt === null ? 0 : Math.max(0, input.now - input.runStartedAt);
    if (durationMs < config.minTurnSeconds * 1_000) {
      const elapsed = Math.floor(durationMs / 1_000);
      return { notify: false, reason: `run lasted ${elapsed}s, below the ${config.minTurnSeconds}s threshold` };
    }
  }
  if (input.lastNotifiedAt !== null && input.now - input.lastNotifiedAt < config.minIntervalSeconds * 1_000) {
    return { notify: false, reason: `minimum interval of ${config.minIntervalSeconds}s not elapsed` };
  }
  return { notify: true, reason: "agent settled" };
}

function cwdBasename(cwd: string): string {
  const trimmed = cwd.replace(/[/\\]+$/, "");
  const segments = trimmed.split(/[/\\]/);
  return segments[segments.length - 1] || cwd;
}

/** Out-of-band message content. Never includes config secrets or session payloads. */
export function buildMessage(config: NotifyConfig, cwd: string): NotifyMessage {
  return {
    title: config.title,
    body: `${cwdBasename(cwd)} is idle — waiting for input`,
  };
}
