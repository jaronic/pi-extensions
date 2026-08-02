import { readFile } from "node:fs/promises";

export interface NtfyChannelConfig {
  enabled: boolean;
  baseUrl: string;
  topic: string | undefined;
  /** Secret. Read from config or PI_NOTIFY_NTFY_TOKEN; never logged, rendered, or persisted. */
  token: string | undefined;
}

export interface NotifyConfig {
  enabled: boolean;
  /** Minimum seconds between two automatic notifications. */
  minIntervalSeconds: number;
  /** Only notify when the settled agent run lasted at least this many seconds. */
  minTurnSeconds: number;
  /** Notification title shown by the osascript and ntfy channels. */
  title: string;
  channels: {
    osascript: { enabled: boolean };
    bell: { enabled: boolean };
    ntfy: NtfyChannelConfig;
  };
}

export const NTFY_TOPIC_ENV = "PI_NOTIFY_NTFY_TOPIC";
export const NTFY_TOKEN_ENV = "PI_NOTIFY_NTFY_TOKEN";

const MAX_SECONDS = 86_400;
const MAX_TITLE_LENGTH = 80;
const MAX_TOPIC_LENGTH = 128;
const MAX_TOKEN_LENGTH = 256;
const TOPIC_PATTERN = /^[A-Za-z0-9_-]+$/;

export const DEFAULT_NOTIFY_CONFIG: NotifyConfig = {
  enabled: true,
  minIntervalSeconds: 30,
  minTurnSeconds: 0,
  title: "Pi",
  channels: {
    osascript: { enabled: true },
    bell: { enabled: true },
    ntfy: { enabled: false, baseUrl: "https://ntfy.sh", topic: undefined, token: undefined },
  },
};

/** Validated partial overlay as parsed from one config file layer. */
export interface NotifyConfigOverlay {
  enabled?: boolean;
  minIntervalSeconds?: number;
  minTurnSeconds?: number;
  title?: string;
  channels?: {
    osascript?: { enabled?: boolean };
    bell?: { enabled?: boolean };
    ntfy?: {
      enabled?: boolean;
      baseUrl?: string;
      topic?: string;
      token?: string;
    };
  };
}

export interface ConfigLayerReport {
  source: "defaults" | "global" | "project" | "env";
  path?: string;
  applied: boolean;
  reason?: string;
}

export interface LoadedNotifyConfig {
  config: NotifyConfig;
  layers: ConfigLayerReport[];
  warnings: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownField(known: readonly string[], record: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) return key;
  }
  return undefined;
}

function parseBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new Error(`field "${key}" must be a boolean`);
  return value;
}

function parseSeconds(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > MAX_SECONDS) {
    throw new Error(`field "${key}" must be a number between 0 and ${MAX_SECONDS}`);
  }
  return value;
}

function parseString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
  pattern?: RegExp,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new Error(`field "${key}" must be a string of 1..${maxLength} characters`);
  }
  if (pattern && !pattern.test(value)) {
    throw new Error(`field "${key}" contains unsupported characters`);
  }
  return value;
}

function parseToggleSection(value: unknown, key: string): { enabled?: boolean } | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error(`field "${key}" must be an object`);
  const unknown = unknownField(["enabled"], value);
  if (unknown) throw new Error(`unknown field "${key}.${unknown}"`);
  return { enabled: parseBoolean(value, "enabled") };
}

export type ParsedConfigFile = { ok: true; value: NotifyConfigOverlay } | { ok: false; reason: string };

/** Strictly parse one config file layer. Any schema violation rejects the whole layer. */
export function parseNotifyConfigFile(text: string): ParsedConfigFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isRecord(raw)) return { ok: false, reason: "top level must be an object" };
  try {
    if (raw.version !== undefined && raw.version !== 1) {
      throw new Error(`unsupported version ${JSON.stringify(raw.version)} (expected 1)`);
    }
    const unknown = unknownField(["version", "enabled", "minIntervalSeconds", "minTurnSeconds", "title", "channels"], raw);
    if (unknown) throw new Error(`unknown field "${unknown}"`);
    const overlay: NotifyConfigOverlay = {
      enabled: parseBoolean(raw, "enabled"),
      minIntervalSeconds: parseSeconds(raw, "minIntervalSeconds"),
      minTurnSeconds: parseSeconds(raw, "minTurnSeconds"),
      title: parseString(raw, "title", MAX_TITLE_LENGTH),
    };
    if (raw.channels !== undefined) {
      if (!isRecord(raw.channels)) throw new Error(`field "channels" must be an object`);
      const unknownChannel = unknownField(["osascript", "bell", "ntfy"], raw.channels);
      if (unknownChannel) throw new Error(`unknown field "channels.${unknownChannel}"`);
      overlay.channels = {
        osascript: parseToggleSection(raw.channels.osascript, "channels.osascript"),
        bell: parseToggleSection(raw.channels.bell, "channels.bell"),
      };
      if (raw.channels.ntfy !== undefined) {
        if (!isRecord(raw.channels.ntfy)) throw new Error(`field "channels.ntfy" must be an object`);
        const ntfy = raw.channels.ntfy;
        const unknownNtfy = unknownField(["enabled", "baseUrl", "topic", "token"], ntfy);
        if (unknownNtfy) throw new Error(`unknown field "channels.ntfy.${unknownNtfy}"`);
        overlay.channels.ntfy = {
          enabled: parseBoolean(ntfy, "enabled"),
          baseUrl: parseString(ntfy, "baseUrl", 300),
          topic: parseString(ntfy, "topic", MAX_TOPIC_LENGTH, TOPIC_PATTERN),
          token: parseString(ntfy, "token", MAX_TOKEN_LENGTH),
        };
      }
    }
    return { ok: true, value: overlay };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Overlay wins field-by-field over base; returns a fresh object, inputs stay untouched. */
export function mergeNotifyConfig(base: NotifyConfig, overlay: NotifyConfigOverlay): NotifyConfig {
  return {
    enabled: overlay.enabled ?? base.enabled,
    minIntervalSeconds: overlay.minIntervalSeconds ?? base.minIntervalSeconds,
    minTurnSeconds: overlay.minTurnSeconds ?? base.minTurnSeconds,
    title: overlay.title ?? base.title,
    channels: {
      osascript: { enabled: overlay.channels?.osascript?.enabled ?? base.channels.osascript.enabled },
      bell: { enabled: overlay.channels?.bell?.enabled ?? base.channels.bell.enabled },
      ntfy: {
        enabled: overlay.channels?.ntfy?.enabled ?? base.channels.ntfy.enabled,
        baseUrl: overlay.channels?.ntfy?.baseUrl ?? base.channels.ntfy.baseUrl,
        topic: overlay.channels?.ntfy?.topic ?? base.channels.ntfy.topic,
        token: overlay.channels?.ntfy?.token ?? base.channels.ntfy.token,
      },
    },
  };
}

interface EnvApplication {
  config: NotifyConfig;
  applied: string[];
  warnings: string[];
}

/** Environment variables override file layers for the ntfy topic and token only. */
export function applyNotifyEnv(config: NotifyConfig, env: Record<string, string | undefined>): EnvApplication {
  const applied: string[] = [];
  const warnings: string[] = [];
  let { topic, token } = config.channels.ntfy;
  const envTopic = env[NTFY_TOPIC_ENV]?.trim();
  if (envTopic) {
    if (envTopic.length <= MAX_TOPIC_LENGTH && TOPIC_PATTERN.test(envTopic)) {
      topic = envTopic;
      applied.push(NTFY_TOPIC_ENV);
    } else {
      warnings.push(`Ignored ${NTFY_TOPIC_ENV}: unsupported topic format`);
    }
  }
  const envToken = env[NTFY_TOKEN_ENV]?.trim();
  if (envToken) {
    if (envToken.length <= MAX_TOKEN_LENGTH) {
      token = envToken;
      applied.push(NTFY_TOKEN_ENV);
    } else {
      warnings.push(`Ignored ${NTFY_TOKEN_ENV}: value exceeds ${MAX_TOKEN_LENGTH} characters`);
    }
  }
  if (applied.length === 0 && warnings.length === 0) return { config, applied, warnings };
  return {
    config: { ...config, channels: { ...config.channels, ntfy: { ...config.channels.ntfy, topic, token } } },
    applied,
    warnings,
  };
}

export type ReadTextFile = (path: string) => Promise<string>;

export interface LoadNotifyConfigOptions {
  globalPath: string;
  projectPath: string;
  projectTrusted: boolean;
  env?: Record<string, string | undefined>;
  readFile?: ReadTextFile;
}

function isEnoent(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

/**
 * Layered configuration: built-in defaults < global file < project file (trusted
 * projects only) < environment. A malformed layer is rejected whole (fail closed)
 * without discarding the layers below it.
 */
export async function loadNotifyConfig(options: LoadNotifyConfigOptions): Promise<LoadedNotifyConfig> {
  const readText = options.readFile ?? ((path: string) => readFile(path, "utf8"));
  const warnings: string[] = [];
  const layers: ConfigLayerReport[] = [{ source: "defaults", applied: true }];
  let config = mergeNotifyConfig(DEFAULT_NOTIFY_CONFIG, {});

  const fileLayers: Array<{ source: "global" | "project"; path: string }> = [
    { source: "global", path: options.globalPath },
    { source: "project", path: options.projectPath },
  ];
  for (const layer of fileLayers) {
    if (layer.source === "project" && !options.projectTrusted) {
      layers.push({ source: "project", path: layer.path, applied: false, reason: "project is not trusted" });
      continue;
    }
    let text: string;
    try {
      text = await readText(layer.path);
    } catch (error) {
      if (isEnoent(error)) {
        layers.push({ source: layer.source, path: layer.path, applied: false, reason: "not found" });
        continue;
      }
      const reason = `unreadable: ${error instanceof Error ? error.message : String(error)}`;
      layers.push({ source: layer.source, path: layer.path, applied: false, reason });
      warnings.push(`Ignored ${layer.source} notify config ${layer.path}: ${reason}`);
      continue;
    }
    const parsed = parseNotifyConfigFile(text);
    if (!parsed.ok) {
      layers.push({ source: layer.source, path: layer.path, applied: false, reason: parsed.reason });
      warnings.push(`Ignored ${layer.source} notify config ${layer.path}: ${parsed.reason}`);
      continue;
    }
    config = mergeNotifyConfig(config, parsed.value);
    layers.push({ source: layer.source, path: layer.path, applied: true });
  }

  const envResult = applyNotifyEnv(config, options.env ?? {});
  config = envResult.config;
  warnings.push(...envResult.warnings);
  layers.push({
    source: "env",
    applied: envResult.applied.length > 0,
    reason: envResult.applied.length > 0 ? envResult.applied.join(", ") : "not set",
  });

  return { config, layers, warnings };
}
