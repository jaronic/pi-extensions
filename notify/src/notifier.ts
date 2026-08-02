import type { NotifyConfig } from "./config.ts";
import type { ChannelAdapter, ChannelOutcome } from "./channels.ts";
import { buildMessage, decideSettledNotification, type SettleDecision } from "./state.ts";

export interface NotifierDeps {
  channels: ChannelAdapter[];
  now?: () => number;
  /** Hard cap for one dispatch across all channels; the channel adapters add their own timeouts. */
  dispatchTimeoutMs?: number;
}

export interface DispatchReport {
  decision: SettleDecision;
  outcomes: ChannelOutcome[];
}

export interface Notifier {
  /** Record the start of an agent run (agent_start). */
  agentStarted(at?: number): void;
  /** agent_settled trigger: applies the debounce/threshold gate before dispatching. */
  settled(config: NotifyConfig, enabled: boolean, cwd: string): Promise<DispatchReport>;
  /** /notify test: dispatches immediately, bypassing the gate and the debounce clock. */
  test(config: NotifyConfig, cwd: string): Promise<ChannelOutcome[]>;
  lastNotifiedAt(): number | null;
  /** Idempotent: aborts any in-flight dispatch and clears run timing. */
  shutdown(): void;
}

const DEFAULT_DISPATCH_TIMEOUT_MS = 15_000;

function failureOutcome(channel: ChannelOutcome["channel"], error: unknown): ChannelOutcome {
  return { channel, ok: false, error: error instanceof Error ? error.message : String(error) };
}

export function createNotifier(deps: NotifierDeps): Notifier {
  const now = deps.now ?? (() => Date.now());
  const dispatchTimeoutMs = deps.dispatchTimeoutMs ?? DEFAULT_DISPATCH_TIMEOUT_MS;
  let runStartedAt: number | null = null;
  let notifiedAt: number | null = null;
  let controller: AbortController | null = null;
  let inFlight: Promise<ChannelOutcome[]> | null = null;

  function channelEnabled(config: NotifyConfig, id: ChannelAdapter["id"]): boolean {
    return config.channels[id].enabled;
  }

  async function dispatch(config: NotifyConfig, cwd: string): Promise<ChannelOutcome[]> {
    if (inFlight) {
      return deps.channels.map((adapter) => ({ channel: adapter.id, ok: false, skipped: "dispatch already in flight" }));
    }
    controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(dispatchTimeoutMs)]);
    const message = buildMessage(config, cwd);
    const attempt = (async () => {
      const attempts = deps.channels.map(async (adapter): Promise<ChannelOutcome> => {
        if (!channelEnabled(config, adapter.id)) {
          return { channel: adapter.id, ok: false, skipped: "disabled in config" };
        }
        const availability = adapter.availability(config);
        if (!availability.available) {
          return { channel: adapter.id, ok: false, skipped: availability.reason ?? "unavailable" };
        }
        return adapter.send(message, config, signal);
      });
      return Promise.all(
        attempts.map((attemptPromise, index) =>
          attemptPromise.catch((error: unknown) => failureOutcome(deps.channels[index].id, error)),
        ),
      );
    })();
    inFlight = attempt;
    try {
      return await attempt;
    } finally {
      inFlight = null;
      controller = null;
    }
  }

  return {
    agentStarted(at) {
      runStartedAt = at ?? now();
    },
    async settled(config, enabled, cwd) {
      const decision = decideSettledNotification(config, {
        now: now(),
        lastNotifiedAt: notifiedAt,
        runStartedAt,
        enabled,
      });
      if (!decision.notify) return { decision, outcomes: [] };
      notifiedAt = now();
      return { decision, outcomes: await dispatch(config, cwd) };
    },
    async test(config, cwd) {
      return dispatch(config, cwd);
    },
    lastNotifiedAt() {
      return notifiedAt;
    },
    shutdown() {
      controller?.abort();
      controller = null;
      runStartedAt = null;
    },
  };
}
