import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import type { NotifyConfig } from "./config.ts";
import type { NotifyMessage } from "./state.ts";
import { assertPublicHostname, validatePublicHttpsUrl, type DnsLookup } from "./ssrf.ts";

export type ChannelId = "osascript" | "bell" | "ntfy";

export interface ChannelOutcome {
  channel: ChannelId;
  ok: boolean;
  /** Present when the channel was not attempted (disabled or unavailable). */
  skipped?: string;
  /** Present when the channel was attempted and failed. Never contains secrets. */
  error?: string;
}

export interface ChannelAvailability {
  available: boolean;
  reason?: string;
}

export interface ChannelAdapter {
  id: ChannelId;
  /** Platform/config availability, independent of the enabled toggle. */
  availability(config: NotifyConfig): ChannelAvailability;
  send(message: NotifyMessage, config: NotifyConfig, signal: AbortSignal): Promise<ChannelOutcome>;
}

export type ExecFn = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export interface ChannelDeps {
  platform: string;
  exec: ExecFn;
  writeBell: () => void;
  fetchImpl: typeof fetch;
  lookup: DnsLookup;
  execTimeoutMs?: number;
  fetchTimeoutMs?: number;
}

const DEFAULT_EXEC_TIMEOUT_MS = 10_000;
const DEFAULT_FETCH_TIMEOUT_MS = 8_000;
const MAX_ERROR_TEXT = 200;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Escape a value embedded in a double-quoted AppleScript string. Args stay an array — no shell. */
export function escapeAppleScriptString(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").slice(0, 200);
}

export function createChannels(deps: ChannelDeps): ChannelAdapter[] {
  const execTimeoutMs = deps.execTimeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const fetchTimeoutMs = deps.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;

  const osascript: ChannelAdapter = {
    id: "osascript",
    availability() {
      if (deps.platform !== "darwin") {
        return { available: false, reason: "requires macOS" };
      }
      return { available: true };
    },
    async send(message, _config, signal) {
      const script = `display notification "${escapeAppleScriptString(message.body)}" with title "${escapeAppleScriptString(message.title)}"`;
      let result: ExecResult;
      try {
        result = await deps.exec("osascript", ["-e", script], { signal, timeout: execTimeoutMs });
      } catch (error) {
        return { channel: "osascript", ok: false, error: truncate(errorMessage(error), MAX_ERROR_TEXT) };
      }
      if (result.killed) {
        return { channel: "osascript", ok: false, error: "osascript timed out or was aborted" };
      }
      if (result.code !== 0) {
        const detail = result.stderr.trim() || result.stdout.trim();
        return {
          channel: "osascript",
          ok: false,
          error: truncate(`osascript exited with code ${result.code}${detail ? `: ${detail}` : ""}`, MAX_ERROR_TEXT),
        };
      }
      return { channel: "osascript", ok: true };
    },
  };

  const bell: ChannelAdapter = {
    id: "bell",
    availability() {
      return { available: true };
    },
    async send() {
      try {
        deps.writeBell();
        return { channel: "bell", ok: true };
      } catch (error) {
        return { channel: "bell", ok: false, error: truncate(errorMessage(error), MAX_ERROR_TEXT) };
      }
    },
  };

  const ntfy: ChannelAdapter = {
    id: "ntfy",
    availability(config) {
      if (!config.channels.ntfy.topic) {
        return { available: false, reason: "no topic configured" };
      }
      const validated = validatePublicHttpsUrl(config.channels.ntfy.baseUrl);
      if (!validated.ok) {
        return { available: false, reason: `baseUrl rejected: ${validated.reason}` };
      }
      return { available: true };
    },
    async send(message, config, signal) {
      const settings = config.channels.ntfy;
      const validated = validatePublicHttpsUrl(settings.baseUrl);
      if (!validated.ok) {
        return { channel: "ntfy", ok: false, error: `baseUrl rejected: ${validated.reason}` };
      }
      try {
        await assertPublicHostname(validated.url, deps.lookup);
      } catch (error) {
        return { channel: "ntfy", ok: false, error: truncate(errorMessage(error), MAX_ERROR_TEXT) };
      }
      if (!settings.topic) {
        return { channel: "ntfy", ok: false, error: "no topic configured" };
      }
      const basePath = validated.url.pathname.replace(/\/+$/, "");
      const url = `${validated.url.origin}${basePath}/${encodeURIComponent(settings.topic)}`;
      const headers: Record<string, string> = {
        Title: sanitizeHeaderValue(message.title),
      };
      if (settings.token) headers.Authorization = `Bearer ${settings.token}`;
      let response: Response;
      try {
        response = await deps.fetchImpl(url, {
          method: "POST",
          headers,
          body: message.body,
          redirect: "manual",
          signal: AbortSignal.any([signal, AbortSignal.timeout(fetchTimeoutMs)]),
        });
      } catch (error) {
        return { channel: "ntfy", ok: false, error: truncate(errorMessage(error), MAX_ERROR_TEXT) };
      }
      if (response.status >= 300 && response.status < 400) {
        return { channel: "ntfy", ok: false, error: `refused redirect (HTTP ${response.status})` };
      }
      if (!response.ok) {
        return { channel: "ntfy", ok: false, error: `server responded HTTP ${response.status}` };
      }
      return { channel: "ntfy", ok: true };
    },
  };

  return [osascript, bell, ntfy];
}
