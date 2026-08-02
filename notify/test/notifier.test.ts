import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_NOTIFY_CONFIG, mergeNotifyConfig } from "../src/config.ts";
import { createChannels, type ChannelAdapter } from "../src/channels.ts";
import { createNotifier } from "../src/notifier.ts";
import type { LookupAddress } from "../src/ssrf.ts";
import { fakeChannel } from "./harness.ts";

const T0 = 1_700_000_000_000;
const CWD = "/work/project";

function configWith(overlay: Parameters<typeof mergeNotifyConfig>[1]) {
  return mergeNotifyConfig(DEFAULT_NOTIFY_CONFIG, overlay);
}

describe("createNotifier", () => {
  test("dispatches to enabled, available channels and skips the rest", async () => {
    const osascript = fakeChannel("osascript");
    const bell = fakeChannel("bell");
    const ntfy = fakeChannel("ntfy", { available: false, reason: "no topic configured" });
    const notifier = createNotifier({ channels: [osascript, bell, ntfy], now: () => T0 });
    notifier.agentStarted();
    const report = await notifier.settled(
      configWith({ channels: { bell: { enabled: false }, ntfy: { enabled: true } } }),
      true,
      CWD,
    );
    assert.equal(report.decision.notify, true);
    assert.equal(osascript.sends.length, 1);
    assert.equal(bell.sends.length, 0);
    assert.equal(ntfy.sends.length, 0);
    assert.deepEqual(
      report.outcomes.map((outcome) => [outcome.channel, outcome.ok, outcome.skipped]),
      [["osascript", true, undefined], ["bell", false, "disabled in config"], ["ntfy", false, "no topic configured"]],
    );
    assert.equal(osascript.sends[0].body, "project is idle — waiting for input");
  });

  test("marks the debounce clock only on gated settle dispatches, not on test dispatches", async () => {
    let now = T0;
    const channel = fakeChannel("osascript");
    const notifier = createNotifier({ channels: [channel], now: () => now });
    const config = configWith({ minIntervalSeconds: 30 });
    await notifier.test(config, CWD);
    assert.equal(notifier.lastNotifiedAt(), null);
    assert.equal(channel.sends.length, 1);

    notifier.agentStarted();
    const first = await notifier.settled(config, true, CWD);
    assert.equal(first.decision.notify, true);
    assert.equal(notifier.lastNotifiedAt(), T0);

    const second = await notifier.settled(config, true, CWD);
    assert.equal(second.decision.notify, false);
    assert.equal(channel.sends.length, 2);

    now = T0 + 31_000;
    const third = await notifier.settled(config, true, CWD);
    assert.equal(third.decision.notify, true);
    assert.equal(channel.sends.length, 3);
  });

  test("suppresses settle dispatches while disabled", async () => {
    const channel = fakeChannel("osascript");
    const notifier = createNotifier({ channels: [channel], now: () => T0 });
    const report = await notifier.settled(DEFAULT_NOTIFY_CONFIG, false, CWD);
    assert.equal(report.decision.notify, false);
    assert.equal(channel.sends.length, 0);
  });

  test("a second dispatch during an in-flight dispatch is skipped", async () => {
    const hanging = fakeChannel("osascript", { hang: true });
    const notifier = createNotifier({
      channels: [hanging],
      now: () => T0,
    });
    const config = configWith({ minIntervalSeconds: 0 });
    notifier.agentStarted();
    const pending = notifier.settled(config, true, CWD);
    const skipped = await notifier.test(config, CWD);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0].skipped ?? "", /in flight/);
    notifier.shutdown();
    const report = await pending;
    assert.equal(report.outcomes[0].ok, false);
  });

  test("shutdown aborts in-flight dispatches and is idempotent", async () => {
    const hanging = fakeChannel("osascript", { hang: true });
    const notifier = createNotifier({ channels: [hanging], now: () => T0 });
    notifier.agentStarted();
    const pending = notifier.settled(configWith({}), true, CWD);
    notifier.shutdown();
    notifier.shutdown();
    const report = await pending;
    assert.equal(report.outcomes[0].error, "aborted");
    assert.equal(hanging.signals[0].aborted, true);
  });

  test("a throwing adapter becomes a failed outcome instead of a rejection", async () => {
    const throwing: ChannelAdapter = {
      id: "osascript",
      availability: () => ({ available: true }),
      async send() {
        throw new Error("adapter exploded");
      },
    };
    const notifier = createNotifier({ channels: [throwing], now: () => T0 });
    const report = await notifier.settled(DEFAULT_NOTIFY_CONFIG, true, CWD);
    assert.equal(report.outcomes.length, 1);
    assert.equal(report.outcomes[0].ok, false);
    assert.match(report.outcomes[0].error ?? "", /adapter exploded/);
  });

  test("shutdown releases a dispatch stuck in a hanging DNS lookup", async () => {
    const notifier = createNotifier({ channels: [hangingLookupNtfyChannel()], now: () => T0 });
    notifier.agentStarted();
    const pending = notifier.settled(configWith({ channels: { ntfy: { enabled: true, topic: "t" } } }), true, CWD);
    notifier.shutdown();
    const report = await settledWithin(pending, 500, "dispatch was not released by shutdown");
    const ntfyOutcome = report.outcomes.find((outcome) => outcome.channel === "ntfy");
    assert.equal(ntfyOutcome?.ok, false);
    assert.match(ntfyOutcome?.error ?? "", /aborted/);
  });

  test("the dispatch timeout releases a dispatch stuck in a hanging DNS lookup", async () => {
    const notifier = createNotifier({ channels: [hangingLookupNtfyChannel()], dispatchTimeoutMs: 30, now: () => T0 });
    notifier.agentStarted();
    const report = await settledWithin(
      notifier.settled(configWith({ channels: { ntfy: { enabled: true, topic: "t" } } }), true, CWD),
      500,
      "dispatch was not released by the dispatch timeout",
    );
    const ntfyOutcome = report.outcomes.find((outcome) => outcome.channel === "ntfy");
    assert.equal(ntfyOutcome?.ok, false);
    assert.match(ntfyOutcome?.error ?? "", /abort/);
  });
});

/** The real ntfy adapter wired to a lookup that never settles. */
function hangingLookupNtfyChannel(): ChannelAdapter {
  const adapter = createChannels({
    platform: "linux",
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    writeBell: () => {},
    fetchImpl: (async () => new Response("ok", { status: 200 })) as typeof fetch,
    lookup: () => new Promise<LookupAddress[]>(() => {}),
  }).find((candidate) => candidate.id === "ntfy");
  assert.ok(adapter, "ntfy channel exists");
  return adapter;
}

/** Reject when the promise does not settle within the guard, so regressions fail fast instead of hanging. */
function settledWithin<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}
