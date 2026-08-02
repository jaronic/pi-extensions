import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { createChannels, escapeAppleScriptString, type ChannelDeps } from "../src/channels.ts";
import { DEFAULT_NOTIFY_CONFIG, mergeNotifyConfig, type NotifyConfig } from "../src/config.ts";
import type { LookupAddress } from "../src/ssrf.ts";

const MESSAGE = { title: "Pi", body: "project is idle — waiting for input" };

interface CapturedFetch {
  url: string;
  init: RequestInit | undefined;
}

function makeDeps(overrides: Partial<ChannelDeps> = {}) {
  const execCalls: Array<{ command: string; args: string[]; options?: ExecOptions }> = [];
  const fetchCalls: CapturedFetch[] = [];
  let bellCount = 0;
  const deps: ChannelDeps = {
    platform: "darwin",
    exec: async (command, args, options) => {
      execCalls.push({ command, args, options });
      return { stdout: "", stderr: "", code: 0, killed: false } satisfies ExecResult;
    },
    writeBell: () => {
      bellCount += 1;
    },
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      fetchCalls.push({ url: String(url), init });
      return new Response("ok", { status: 200 });
    }) as typeof fetch,
    lookup: async (): Promise<LookupAddress[]> => [{ address: "104.26.0.1", family: 4 }],
    ...overrides,
  };
  return { deps, execCalls, fetchCalls, bellCount: () => bellCount };
}

function configWith(overlay: Parameters<typeof mergeNotifyConfig>[1]): NotifyConfig {
  return mergeNotifyConfig(DEFAULT_NOTIFY_CONFIG, overlay);
}

function channel(deps: ChannelDeps, id: "osascript" | "bell" | "ntfy") {
  const adapter = createChannels(deps).find((candidate) => candidate.id === id);
  assert.ok(adapter, `channel ${id} exists`);
  return adapter;
}

describe("osascript channel", () => {
  test("is available on macOS and unavailable elsewhere", () => {
    assert.equal(channel(makeDeps({ platform: "darwin" }).deps, "osascript").availability(DEFAULT_NOTIFY_CONFIG).available, true);
    const linux = channel(makeDeps({ platform: "linux" }).deps, "osascript").availability(DEFAULT_NOTIFY_CONFIG);
    assert.equal(linux.available, false);
    assert.match(linux.reason ?? "", /macOS/);
  });

  test("invokes osascript with an args array, escaped content, signal, and timeout", async () => {
    const { deps, execCalls } = makeDeps();
    const signal = new AbortController().signal;
    const outcome = await channel(deps, "osascript").send(MESSAGE, DEFAULT_NOTIFY_CONFIG, signal);
    assert.equal(outcome.ok, true);
    assert.equal(execCalls.length, 1);
    assert.equal(execCalls[0].command, "osascript");
    assert.deepEqual(execCalls[0].args, [
      "-e",
      `display notification "project is idle — waiting for input" with title "Pi"`,
    ]);
    assert.equal(execCalls[0].options?.signal, signal);
    assert.equal(typeof execCalls[0].options?.timeout, "number");
  });

  test("escapes quotes, backslashes, and newlines inside the AppleScript string", async () => {
    const { deps, execCalls } = makeDeps();
    const hostile = { title: 'Pi "quoted"', body: 'line1\nline2 \\ path "end"' };
    const outcome = await channel(deps, "osascript").send(hostile, DEFAULT_NOTIFY_CONFIG, new AbortController().signal);
    assert.equal(outcome.ok, true);
    const script = execCalls[0].args[1];
    assert.equal(
      script,
      `display notification "line1 line2 \\\\ path \\"end\\"" with title "Pi \\"quoted\\""`,
    );
    assert.ok(!script.includes("\n"));
    assert.equal(escapeAppleScriptString('a"b\\c\nd'), 'a\\"b\\\\c d');
  });

  test("reports non-zero exit, killed processes, and exec errors as failed outcomes", async () => {
    const failing = makeDeps({
      exec: async () => ({ stdout: "", stderr: "osascript: unauthorized", code: 1, killed: false }),
    });
    const failed = await channel(failing.deps, "osascript").send(MESSAGE, DEFAULT_NOTIFY_CONFIG, new AbortController().signal);
    assert.equal(failed.ok, false);
    assert.match(failed.error ?? "", /code 1/);
    assert.match(failed.error ?? "", /unauthorized/);

    const killed = makeDeps({ exec: async () => ({ stdout: "", stderr: "", code: 0, killed: true }) });
    const killedOutcome = await channel(killed.deps, "osascript").send(MESSAGE, DEFAULT_NOTIFY_CONFIG, new AbortController().signal);
    assert.equal(killedOutcome.ok, false);
    assert.match(killedOutcome.error ?? "", /timed out|aborted/);

    const throwing = makeDeps({
      exec: async () => {
        throw new Error("spawn osascript ENOENT");
      },
    });
    const threwOutcome = await channel(throwing.deps, "osascript").send(MESSAGE, DEFAULT_NOTIFY_CONFIG, new AbortController().signal);
    assert.equal(threwOutcome.ok, false);
    assert.match(threwOutcome.error ?? "", /ENOENT/);
  });
});

describe("bell channel", () => {
  test("is always available and rings via the injected writer", async () => {
    const { deps, bellCount } = makeDeps();
    const adapter = channel(deps, "bell");
    assert.equal(adapter.availability(DEFAULT_NOTIFY_CONFIG).available, true);
    const outcome = await adapter.send(MESSAGE, DEFAULT_NOTIFY_CONFIG, new AbortController().signal);
    assert.equal(outcome.ok, true);
    assert.equal(bellCount(), 1);
  });
});

describe("ntfy channel", () => {
  const ntfyConfig = configWith({ channels: { ntfy: { enabled: true, topic: "alerts-1", token: "tk_secret" } } });

  test("is unavailable without a topic or with a rejected baseUrl", () => {
    const noTopic = channel(makeDeps().deps, "ntfy").availability(configWith({ channels: { ntfy: { enabled: true } } }));
    assert.equal(noTopic.available, false);
    assert.match(noTopic.reason ?? "", /topic/);

    const badUrl = channel(makeDeps().deps, "ntfy").availability(
      configWith({ channels: { ntfy: { enabled: true, topic: "t", baseUrl: "http://ntfy.sh" } } }),
    );
    assert.equal(badUrl.available, false);
    assert.match(badUrl.reason ?? "", /https/);
  });

  test("posts to baseUrl/topic with title header, body, bearer token, manual redirect, and a signal", async () => {
    const { deps, fetchCalls } = makeDeps();
    const outcome = await channel(deps, "ntfy").send(MESSAGE, ntfyConfig, new AbortController().signal);
    assert.equal(outcome.ok, true);
    assert.equal(fetchCalls.length, 1);
    const call = fetchCalls[0];
    assert.equal(call.url, "https://ntfy.sh/alerts-1");
    assert.equal(call.init?.method, "POST");
    assert.equal(call.init?.body, MESSAGE.body);
    assert.equal(call.init?.redirect, "manual");
    const headers = call.init?.headers as Record<string, string>;
    assert.equal(headers.Title, "Pi");
    assert.equal(headers.Authorization, "Bearer tk_secret");
    assert.ok(call.init?.signal instanceof AbortSignal);
  });

  test("rejects non-https and private targets before any fetch", async () => {
    for (const baseUrl of ["http://ntfy.sh", "https://127.0.0.1", "https://10.0.0.9"]) {
      const { deps, fetchCalls } = makeDeps();
      const config = configWith({ channels: { ntfy: { enabled: true, topic: "t", baseUrl } } });
      const outcome = await channel(deps, "ntfy").send(MESSAGE, config, new AbortController().signal);
      assert.equal(outcome.ok, false, baseUrl);
      assert.equal(fetchCalls.length, 0, baseUrl);
    }
  });

  test("rejects hostnames resolving to private addresses before any fetch", async () => {
    const { deps, fetchCalls } = makeDeps({ lookup: async () => [{ address: "192.168.1.10", family: 4 }] });
    const outcome = await channel(deps, "ntfy").send(MESSAGE, ntfyConfig, new AbortController().signal);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? "", /private\/reserved/);
    assert.equal(fetchCalls.length, 0);
  });

  test("a hanging DNS lookup is released by abort and by the fetch timeout", async () => {
    const { deps } = makeDeps({
      fetchTimeoutMs: 40,
      lookup: () => new Promise<LookupAddress[]>(() => {}),
    });
    const adapter = channel(deps, "ntfy");
    const controller = new AbortController();
    const aborted = adapter.send(MESSAGE, ntfyConfig, controller.signal);
    controller.abort();
    const abortedOutcome = await settledWithin(aborted, 500, "send was not released by abort");
    assert.equal(abortedOutcome.ok, false);
    assert.match(abortedOutcome.error ?? "", /aborted/);

    const timedOut = await settledWithin(
      adapter.send(MESSAGE, ntfyConfig, new AbortController().signal),
      500,
      "send was not released by the fetch timeout",
    );
    assert.equal(timedOut.ok, false);
    assert.match(timedOut.error ?? "", /timed out/);
  });

  test("refuses redirects and reports HTTP failures", async () => {
    const redirecting = makeDeps({
      fetchImpl: (async () => new Response(null, { status: 302 })) as typeof fetch,
    });
    const redirected = await channel(redirecting.deps, "ntfy").send(MESSAGE, ntfyConfig, new AbortController().signal);
    assert.equal(redirected.ok, false);
    assert.match(redirected.error ?? "", /redirect/);

    const failing = makeDeps({ fetchImpl: (async () => new Response("nope", { status: 500 })) as typeof fetch });
    const failed = await channel(failing.deps, "ntfy").send(MESSAGE, ntfyConfig, new AbortController().signal);
    assert.equal(failed.ok, false);
    assert.match(failed.error ?? "", /500/);
  });

  test("fetch errors become failed outcomes", async () => {
    const throwing = makeDeps({
      fetchImpl: (async () => {
        throw new Error("socket hang up");
      }) as typeof fetch,
    });
    const outcome = await channel(throwing.deps, "ntfy").send(MESSAGE, ntfyConfig, new AbortController().signal);
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? "", /socket hang up/);
  });

  test("the token never appears in availability reasons or error outcomes", async () => {
    const secret = "tk_extremely_secret";
    const config = configWith({ channels: { ntfy: { enabled: true, topic: "t", baseUrl: "https://127.0.0.1", token: secret } } });
    const adapter = channel(makeDeps().deps, "ntfy");
    assert.ok(!JSON.stringify(adapter.availability(config)).includes(secret));
    const outcome = await adapter.send(MESSAGE, config, new AbortController().signal);
    assert.ok(!JSON.stringify(outcome).includes(secret));
  });
});

/** Reject when the promise does not settle within the guard, so regressions fail fast instead of hanging. */
function settledWithin<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);
}
