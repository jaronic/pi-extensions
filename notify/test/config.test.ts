import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  applyNotifyEnv,
  DEFAULT_NOTIFY_CONFIG,
  loadNotifyConfig,
  mergeNotifyConfig,
  NTFY_TOKEN_ENV,
  NTFY_TOPIC_ENV,
  parseNotifyConfigFile,
} from "../src/config.ts";

const GLOBAL = "/home/test/.pi/agent/notify.json";
const PROJECT = "/work/project/.pi/notify.json";

function enoent(): Error & { code: string } {
  const error = new Error("no such file or directory") as Error & { code: string };
  error.code = "ENOENT";
  return error;
}

function readerWith(files: Record<string, string>) {
  return async (path: string): Promise<string> => {
    const text = files[path];
    if (text === undefined) throw enoent();
    return text;
  };
}

describe("parseNotifyConfigFile", () => {
  test("parses a complete valid file", () => {
    const parsed = parseNotifyConfigFile(JSON.stringify({
      version: 1,
      enabled: false,
      minIntervalSeconds: 120,
      minTurnSeconds: 45,
      title: "Pi done",
      channels: {
        osascript: { enabled: false },
        bell: { enabled: true },
        ntfy: { enabled: true, baseUrl: "https://ntfy.example.com", topic: "my-topic_1", token: "tk_secret" },
      },
    }));
    assert.ok(parsed.ok);
    assert.equal(parsed.value.enabled, false);
    assert.equal(parsed.value.minIntervalSeconds, 120);
    assert.equal(parsed.value.channels?.ntfy?.topic, "my-topic_1");
  });

  test("rejects invalid JSON", () => {
    const parsed = parseNotifyConfigFile("{not json");
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.reason, /invalid JSON/);
  });

  test("rejects non-object top level", () => {
    assert.equal(parseNotifyConfigFile("[1,2]").ok, false);
    assert.equal(parseNotifyConfigFile("\"text\"").ok, false);
  });

  test("rejects unsupported version", () => {
    const parsed = parseNotifyConfigFile(JSON.stringify({ version: 2 }));
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.reason, /unsupported version/);
  });

  test("rejects unknown fields at every level", () => {
    assert.equal(parseNotifyConfigFile(JSON.stringify({ bogus: true })).ok, false);
    assert.equal(parseNotifyConfigFile(JSON.stringify({ channels: { pager: { enabled: true } } })).ok, false);
    assert.equal(parseNotifyConfigFile(JSON.stringify({ channels: { ntfy: { password: "x" } } })).ok, false);
    assert.equal(parseNotifyConfigFile(JSON.stringify({ channels: { bell: { loud: true } } })).ok, false);
  });

  test("rejects wrong types and out-of-range values", () => {
    assert.equal(parseNotifyConfigFile(JSON.stringify({ enabled: "yes" })).ok, false);
    assert.equal(parseNotifyConfigFile(JSON.stringify({ minIntervalSeconds: -1 })).ok, false);
    assert.equal(parseNotifyConfigFile(JSON.stringify({ minIntervalSeconds: 86_401 })).ok, false);
    assert.equal(parseNotifyConfigFile(JSON.stringify({ minTurnSeconds: Number.NaN })).ok, false);
    assert.equal(parseNotifyConfigFile(JSON.stringify({ title: "" })).ok, false);
    assert.equal(parseNotifyConfigFile(JSON.stringify({ title: "x".repeat(81) })).ok, false);
  });

  test("rejects malformed ntfy topic", () => {
    const parsed = parseNotifyConfigFile(JSON.stringify({ channels: { ntfy: { topic: "bad topic!" } } }));
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.match(parsed.reason, /topic/);
  });
});

describe("mergeNotifyConfig", () => {
  test("overlay wins field-by-field and inputs stay untouched", () => {
    const base = mergeNotifyConfig(DEFAULT_NOTIFY_CONFIG, {});
    const merged = mergeNotifyConfig(base, {
      enabled: false,
      channels: { ntfy: { enabled: true, topic: "abc" } },
    });
    assert.equal(merged.enabled, false);
    assert.equal(merged.channels.ntfy.enabled, true);
    assert.equal(merged.channels.ntfy.topic, "abc");
    assert.equal(merged.channels.ntfy.baseUrl, "https://ntfy.sh");
    assert.equal(merged.channels.bell.enabled, true);
    assert.equal(base.enabled, true);
    assert.equal(DEFAULT_NOTIFY_CONFIG.channels.ntfy.topic, undefined);
  });
});

describe("applyNotifyEnv", () => {
  test("env overrides topic and token", () => {
    const base = mergeNotifyConfig(DEFAULT_NOTIFY_CONFIG, {
      channels: { ntfy: { topic: "file-topic", token: "file-token" } },
    });
    const result = applyNotifyEnv(base, { [NTFY_TOPIC_ENV]: "env-topic", [NTFY_TOKEN_ENV]: "env-token" });
    assert.equal(result.config.channels.ntfy.topic, "env-topic");
    assert.equal(result.config.channels.ntfy.token, "env-token");
    assert.deepEqual(result.applied, [NTFY_TOPIC_ENV, NTFY_TOKEN_ENV]);
  });

  test("invalid env topic is ignored with a warning and does not leak the value", () => {
    const result = applyNotifyEnv(DEFAULT_NOTIFY_CONFIG, { [NTFY_TOPIC_ENV]: "bad topic with spaces" });
    assert.equal(result.config.channels.ntfy.topic, undefined);
    assert.equal(result.warnings.length, 1);
    assert.ok(!result.warnings[0].includes("bad topic with spaces"));
  });

  test("empty env leaves config untouched", () => {
    const result = applyNotifyEnv(DEFAULT_NOTIFY_CONFIG, {});
    assert.equal(result.config, DEFAULT_NOTIFY_CONFIG);
    assert.deepEqual(result.applied, []);
  });
});

describe("loadNotifyConfig", () => {
  test("defaults apply when no files exist", async () => {
    const loaded = await loadNotifyConfig({
      globalPath: GLOBAL,
      projectPath: PROJECT,
      projectTrusted: true,
      readFile: readerWith({}),
    });
    assert.deepEqual(loaded.config, mergeNotifyConfig(DEFAULT_NOTIFY_CONFIG, {}));
    assert.deepEqual(
      loaded.layers.map((layer) => [layer.source, layer.applied]),
      [["defaults", true], ["global", false], ["project", false], ["env", false]],
    );
    assert.deepEqual(loaded.warnings, []);
  });

  test("project layer overrides global layer", async () => {
    const loaded = await loadNotifyConfig({
      globalPath: GLOBAL,
      projectPath: PROJECT,
      projectTrusted: true,
      readFile: readerWith({
        [GLOBAL]: JSON.stringify({ minIntervalSeconds: 60, title: "Global" }),
        [PROJECT]: JSON.stringify({ title: "Project" }),
      }),
    });
    assert.equal(loaded.config.minIntervalSeconds, 60);
    assert.equal(loaded.config.title, "Project");
    assert.ok(loaded.layers.every((layer) => layer.applied || layer.source === "env"));
  });

  test("untrusted project layer is skipped", async () => {
    const loaded = await loadNotifyConfig({
      globalPath: GLOBAL,
      projectPath: PROJECT,
      projectTrusted: false,
      readFile: readerWith({ [PROJECT]: JSON.stringify({ title: "Project" }) }),
    });
    assert.equal(loaded.config.title, "Pi");
    const project = loaded.layers.find((layer) => layer.source === "project");
    assert.equal(project?.applied, false);
    assert.match(project?.reason ?? "", /not trusted/);
  });

  test("malformed project file fails closed to lower layers with a warning", async () => {
    const loaded = await loadNotifyConfig({
      globalPath: GLOBAL,
      projectPath: PROJECT,
      projectTrusted: true,
      readFile: readerWith({
        [GLOBAL]: JSON.stringify({ minIntervalSeconds: 90 }),
        [PROJECT]: JSON.stringify({ enabled: "sometimes" }),
      }),
    });
    assert.equal(loaded.config.minIntervalSeconds, 90);
    assert.equal(loaded.config.enabled, true);
    assert.equal(loaded.warnings.length, 1);
    assert.match(loaded.warnings[0], /project/);
  });

  test("unreadable file (non-ENOENT) rejects that layer with a warning", async () => {
    const loaded = await loadNotifyConfig({
      globalPath: GLOBAL,
      projectPath: PROJECT,
      projectTrusted: true,
      readFile: async (path) => {
        if (path === GLOBAL) throw new Error("permission denied");
        throw enoent();
      },
    });
    assert.equal(loaded.warnings.length, 1);
    assert.match(loaded.warnings[0], /permission denied/);
    assert.deepEqual(loaded.config, mergeNotifyConfig(DEFAULT_NOTIFY_CONFIG, {}));
  });

  test("env layer is reported and token never appears in layers or warnings", async () => {
    const secret = "tk_super_secret_value";
    const loaded = await loadNotifyConfig({
      globalPath: GLOBAL,
      projectPath: PROJECT,
      projectTrusted: true,
      env: { [NTFY_TOKEN_ENV]: secret },
      readFile: readerWith({
        [GLOBAL]: JSON.stringify({ channels: { ntfy: { token: "file-token" } } }),
      }),
    });
    assert.equal(loaded.config.channels.ntfy.token, secret);
    const envLayer = loaded.layers.find((layer) => layer.source === "env");
    assert.equal(envLayer?.applied, true);
    assert.ok(!JSON.stringify(loaded.layers).includes(secret));
    assert.ok(!JSON.stringify(loaded.warnings).includes(secret));
  });
});
