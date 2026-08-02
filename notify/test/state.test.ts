import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DEFAULT_NOTIFY_CONFIG, mergeNotifyConfig } from "../src/config.ts";
import { buildMessage, decideSettledNotification } from "../src/state.ts";

const T0 = 1_700_000_000_000;

function configWith(overlay: Parameters<typeof mergeNotifyConfig>[1]) {
  return mergeNotifyConfig(DEFAULT_NOTIFY_CONFIG, overlay);
}

describe("decideSettledNotification", () => {
  test("notifies on the first settle with no timing constraints", () => {
    const decision = decideSettledNotification(DEFAULT_NOTIFY_CONFIG, {
      now: T0,
      lastNotifiedAt: null,
      runStartedAt: T0 - 5_000,
      enabled: true,
    });
    assert.equal(decision.notify, true);
  });

  test("suppresses when disabled by config or runtime", () => {
    const configOff = decideSettledNotification(configWith({ enabled: false }), {
      now: T0, lastNotifiedAt: null, runStartedAt: null, enabled: true,
    });
    assert.equal(configOff.notify, false);
    const runtimeOff = decideSettledNotification(DEFAULT_NOTIFY_CONFIG, {
      now: T0, lastNotifiedAt: null, runStartedAt: null, enabled: false,
    });
    assert.equal(runtimeOff.notify, false);
  });

  test("suppresses settles inside the minimum interval", () => {
    const config = configWith({ minIntervalSeconds: 30 });
    const inside = decideSettledNotification(config, {
      now: T0, lastNotifiedAt: T0 - 29_000, runStartedAt: T0 - 60_000, enabled: true,
    });
    assert.equal(inside.notify, false);
    assert.match(inside.reason, /interval/);
    const boundary = decideSettledNotification(config, {
      now: T0, lastNotifiedAt: T0 - 30_000, runStartedAt: T0 - 60_000, enabled: true,
    });
    assert.equal(boundary.notify, true);
  });

  test("suppresses runs shorter than the minimum run-length threshold", () => {
    const config = configWith({ minTurnSeconds: 60 });
    const short = decideSettledNotification(config, {
      now: T0, lastNotifiedAt: null, runStartedAt: T0 - 10_000, enabled: true,
    });
    assert.equal(short.notify, false);
    assert.match(short.reason, /threshold/);
    const long = decideSettledNotification(config, {
      now: T0, lastNotifiedAt: null, runStartedAt: T0 - 61_000, enabled: true,
    });
    assert.equal(long.notify, true);
    const missingStart = decideSettledNotification(config, {
      now: T0, lastNotifiedAt: null, runStartedAt: null, enabled: true,
    });
    assert.equal(missingStart.notify, false);
  });

  test("interval is measured from the last notification, not the run start", () => {
    const config = configWith({ minIntervalSeconds: 30, minTurnSeconds: 0 });
    const decision = decideSettledNotification(config, {
      now: T0, lastNotifiedAt: T0 - 10_000, runStartedAt: T0 - 9_000, enabled: true,
    });
    assert.equal(decision.notify, false);
  });
});

describe("buildMessage", () => {
  test("uses the configured title and the cwd basename", () => {
    const message = buildMessage(configWith({ title: "Pi done" }), "/work/pi-extensions/notify");
    assert.equal(message.title, "Pi done");
    assert.equal(message.body, "notify is idle — waiting for input");
  });

  test("handles trailing slashes and the filesystem root", () => {
    assert.equal(buildMessage(DEFAULT_NOTIFY_CONFIG, "/work/project/").body.startsWith("project"), true);
    assert.equal(buildMessage(DEFAULT_NOTIFY_CONFIG, "/").body, "/ is idle — waiting for input");
  });
});
