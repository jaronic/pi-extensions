import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_NOTIFY_CONFIG, mergeNotifyConfig, type LoadedNotifyConfig, type NotifyConfigOverlay } from "../src/config.ts";
import { createNotifyExtension } from "../src/index.ts";
import type { FakeChannel } from "./harness.ts";
import { fakeChannel, NotifyHarness } from "./harness.ts";

const T0 = 1_700_000_000_000;

interface SetupOptions {
  overlay?: NotifyConfigOverlay;
  warnings?: string[];
  channels?: FakeChannel[];
  loadError?: string;
}

function setup(options: SetupOptions = {}) {
  const harness = new NotifyHarness();
  let now = T0;
  const channels = options.channels ?? [fakeChannel("osascript"), fakeChannel("bell"), fakeChannel("ntfy", { available: false, reason: "no topic configured" })];
  const loaded: LoadedNotifyConfig = {
    config: mergeNotifyConfig(DEFAULT_NOTIFY_CONFIG, options.overlay ?? {}),
    layers: [{ source: "defaults", applied: true }],
    warnings: options.warnings ?? [],
  };
  createNotifyExtension(harness.api, {
    channels,
    loadConfig: async () => {
      if (options.loadError) throw new Error(options.loadError);
      return loaded;
    },
    now: () => now,
  });
  return { harness, channels, loaded, advance: (ms: number) => { now += ms; } };
}

async function startAndSettle(harness: NotifyHarness): Promise<void> {
  await harness.emit("agent_start");
  await harness.emit("agent_settled");
}

describe("notify extension registration", () => {
  test("registers the /notify command, lifecycle handlers, and no model tools", () => {
    const { harness } = setup();
    assert.deepEqual(harness.commandNames(), ["notify"]);
    assert.deepEqual(harness.toolNames, []);
    for (const event of ["session_start", "agent_start", "agent_settled", "session_shutdown"]) {
      assert.ok(harness.registeredEvents().includes(event), `handler for ${event}`);
    }
  });
});

describe("agent_settled trigger", () => {
  test("notifies enabled and available channels after the agent settles", async () => {
    const { harness, channels } = setup();
    await harness.emit("session_start", { reason: "startup" });
    await startAndSettle(harness);
    assert.equal(channels[0].sends.length, 1);
    assert.equal(channels[1].sends.length, 1);
    assert.equal(channels[2].sends.length, 0);
    assert.deepEqual(harness.notifications, []);
  });

  test("debounces consecutive settles with the configured minimum interval", async () => {
    const { harness, channels, advance } = setup();
    await harness.emit("session_start", { reason: "startup" });
    await startAndSettle(harness);
    await startAndSettle(harness);
    assert.equal(channels[0].sends.length, 1);
    advance(31_000);
    await startAndSettle(harness);
    assert.equal(channels[0].sends.length, 2);
  });

  test("honours the minimum run-length threshold", async () => {
    const { harness, channels, advance } = setup({ overlay: { minTurnSeconds: 60, minIntervalSeconds: 0 } });
    await harness.emit("session_start", { reason: "startup" });
    await harness.emit("agent_start");
    advance(5_000);
    await harness.emit("agent_settled");
    assert.equal(channels[0].sends.length, 0);
    await harness.emit("agent_start");
    advance(61_000);
    await harness.emit("agent_settled");
    assert.equal(channels[0].sends.length, 1);
  });

  test("stays silent when disabled in config", async () => {
    const { harness, channels } = setup({ overlay: { enabled: false } });
    await harness.emit("session_start", { reason: "startup" });
    await startAndSettle(harness);
    assert.equal(channels[0].sends.length, 0);
  });

  test("still notifies out-of-band in print mode without UI, and never touches ctx.ui", async () => {
    const { harness, channels } = setup();
    harness.mode = "print";
    harness.hasUI = false;
    await harness.emit("session_start", { reason: "startup" });
    await startAndSettle(harness);
    assert.equal(channels[0].sends.length, 1);
    assert.deepEqual(harness.notifications, []);
  });

  test("warns in the UI when every attempted channel fails", async () => {
    const failing = [fakeChannel("osascript", { error: "no display" }), fakeChannel("bell", { error: "closed stdout" })];
    const { harness } = setup({ channels: failing });
    await harness.emit("session_start", { reason: "startup" });
    await startAndSettle(harness);
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].type, "warning");
    assert.match(harness.notifications[0].message, /osascript/);
    assert.match(harness.notifications[0].message, /bell/);
  });

  test("does not warn about all-channel failure when there is no UI", async () => {
    const failing = [fakeChannel("osascript", { error: "no display" })];
    const { harness } = setup({ channels: failing });
    harness.mode = "print";
    harness.hasUI = false;
    await harness.emit("session_start", { reason: "startup" });
    await startAndSettle(harness);
    assert.deepEqual(harness.notifications, []);
  });

  test("surfaces config warnings on session_start", async () => {
    const { harness } = setup({ warnings: ["Ignored project notify config /x/.pi/notify.json: unknown field \"bogus\""] });
    await harness.emit("session_start", { reason: "startup" });
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].type, "warning");
    assert.match(harness.notifications[0].message, /unknown field/);
  });

  test("a failing config load pauses notifications without throwing", async () => {
    const { harness, channels } = setup({ loadError: "disk on fire" });
    await harness.emit("session_start", { reason: "startup" });
    await startAndSettle(harness);
    assert.equal(channels[0].sends.length, 0);
    assert.equal(harness.notifications.length, 1);
    assert.equal(harness.notifications[0].type, "error");
    assert.match(harness.notifications[0].message, /disk on fire/);
  });

  test("session_shutdown is idempotent and aborts in-flight dispatches", async () => {
    const hanging = [fakeChannel("osascript", { hang: true })];
    const { harness } = setup({ channels: hanging, overlay: { minIntervalSeconds: 0 } });
    await harness.emit("session_start", { reason: "startup" });
    await harness.emit("agent_start");
    const pending = harness.emit("agent_settled");
    await harness.emit("session_shutdown", { reason: "quit" });
    await harness.emit("session_shutdown", { reason: "reload" });
    await pending;
    assert.equal(hanging[0].signals[0].aborted, true);
  });
});

describe("/notify command", () => {
  test("off/on toggles settle notifications for the session", async () => {
    const { harness, channels, advance } = setup({ overlay: { minIntervalSeconds: 0 } });
    await harness.emit("session_start", { reason: "startup" });
    await harness.runCommand("notify", "off");
    await startAndSettle(harness);
    assert.equal(channels[0].sends.length, 0);
    advance(1_000);
    await harness.runCommand("notify", "on");
    await startAndSettle(harness);
    assert.equal(channels[0].sends.length, 1);
  });

  test("status reports layers, channels, and cadence without leaking the token", async () => {
    const { harness } = setup({
      overlay: { channels: { ntfy: { enabled: true, topic: "alerts", token: "tk_status_secret" } } },
    });
    await harness.emit("session_start", { reason: "startup" });
    await harness.runCommand("notify", "status");
    assert.equal(harness.notifications.length, 1);
    const text = harness.notifications[0].message;
    assert.match(text, /Config layers/);
    assert.match(text, /Channels/);
    assert.match(text, /min interval 30s/);
    assert.match(text, /token configured/);
    assert.ok(!text.includes("tk_status_secret"));
  });

  test("test dispatches immediately and reports each channel outcome", async () => {
    const channels = [
      fakeChannel("osascript", { error: "no display" }),
      fakeChannel("bell"),
      fakeChannel("ntfy", { available: false, reason: "no topic configured" }),
    ];
    const { harness } = setup({ channels, overlay: { channels: { ntfy: { enabled: true } } } });
    await harness.emit("session_start", { reason: "startup" });
    await harness.runCommand("notify", "test");
    assert.equal(channels[0].sends.length, 1);
    assert.equal(channels[1].sends.length, 1);
    assert.equal(channels[2].sends.length, 0);
    const text = harness.notifications[0].message;
    assert.match(text, /osascript: failed \(no display\)/);
    assert.match(text, /bell: delivered/);
    assert.match(text, /ntfy: skipped \(no topic configured\)/);
    assert.equal(harness.notifications[0].type, "warning");
  });

  test("test before session_start reports the missing config", async () => {
    const { harness } = setup();
    await harness.runCommand("notify", "test");
    assert.match(harness.notifications[0].message, /not loaded/);
  });

  test("unknown subcommand prints usage", async () => {
    const { harness } = setup();
    await harness.emit("session_start", { reason: "startup" });
    await harness.runCommand("notify", "explode");
    assert.equal(harness.notifications[0].type, "warning");
    assert.match(harness.notifications[0].message, /Usage: \/notify/);
  });

  test("empty args default to status", async () => {
    const { harness } = setup();
    await harness.emit("session_start", { reason: "startup" });
    await harness.runCommand("notify", "");
    assert.match(harness.notifications[0].message, /Notify: active/);
  });
});
