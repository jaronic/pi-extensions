import { readFile } from "node:fs/promises";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import type {
  LspConfig,
  RawLspConfig,
  ServerConfig,
  ServerConfigInput,
  ServerRole,
} from "./types.ts";

const ALL_ROLES: ServerRole[] = ["navigation", "diagnostics", "actions"];

const BUILTIN_SERVERS: Record<string, ServerConfigInput> = {
  "typescript-language-server": {
    command: "typescript-language-server",
    args: ["--stdio"],
    fileTypes: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
    roles: ALL_ROLES,
    priority: 100,
  },
  "vue-language-server": {
    command: "vue-language-server",
    args: ["--stdio"],
    fileTypes: [".vue"],
    rootMarkers: ["vue.config.js", "vite.config.ts", "package.json", ".git"],
    roles: ALL_ROLES,
    priority: 110,
  },
  svelteserver: {
    command: "svelteserver",
    args: ["--stdio"],
    fileTypes: [".svelte"],
    rootMarkers: ["svelte.config.js", "svelte.config.ts", "package.json", ".git"],
    roles: ALL_ROLES,
    priority: 110,
  },
  "pyright-langserver": {
    command: "pyright-langserver",
    args: ["--stdio"],
    fileTypes: [".py", ".pyi"],
    rootMarkers: ["pyrightconfig.json", "pyproject.toml", "setup.py", "requirements.txt", ".git"],
    roles: ALL_ROLES,
    priority: 100,
  },
  "rust-analyzer": {
    command: "rust-analyzer",
    args: [],
    fileTypes: [".rs"],
    rootMarkers: ["Cargo.toml", ".git"],
    roles: ALL_ROLES,
    priority: 100,
  },
  gopls: {
    command: "gopls",
    args: [],
    fileTypes: [".go"],
    rootMarkers: ["go.work", "go.mod", ".git"],
    roles: ALL_ROLES,
    priority: 100,
  },
  jdtls: {
    command: "jdtls",
    args: ["-data", "{workspaceStorage}"],
    fileTypes: [".java"],
    rootMarkers: [
      "settings.gradle",
      "settings.gradle.kts",
      "gradlew",
      "mvnw",
      "build.gradle",
      "build.gradle.kts",
      "pom.xml",
      ".classpath",
      ".project",
      ".git",
    ],
    roles: ALL_ROLES,
    priority: 100,
    requestTimeoutMs: 60_000,
    diagnosticsSettleMs: 1_000,
    initOptions: {
      extendedClientCapabilities: { classFileContentsSupport: true },
    },
    readyNotification: { method: "language/status", field: "type", value: "ServiceReady" },
  },
  clangd: {
    command: "clangd",
    args: ["--background-index"],
    fileTypes: [".c", ".h", ".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"],
    rootMarkers: ["compile_commands.json", "compile_flags.txt", "CMakeLists.txt", ".git"],
    roles: ALL_ROLES,
    priority: 100,
  },
  "sourcekit-lsp": {
    command: "sourcekit-lsp",
    args: [],
    fileTypes: [".swift", ".m", ".mm"],
    rootMarkers: ["Package.swift", "compile_commands.json", ".git"],
    roles: ALL_ROLES,
    priority: 100,
  },
};

const LANGUAGE_ID_BY_FILE_TYPE: Record<string, string> = {
  ".bash": "shellscript",
  ".c": "c",
  ".cjs": "javascript",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cts": "typescript",
  ".cxx": "cpp",
  ".go": "go",
  ".h": "c",
  ".hh": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
  ".java": "java",
  ".js": "javascript",
  ".jsx": "javascriptreact",
  ".lua": "lua",
  ".m": "objective-c",
  ".mjs": "javascript",
  ".mm": "objective-cpp",
  ".mts": "typescript",
  ".py": "python",
  ".pyi": "python",
  ".rs": "rust",
  ".svelte": "svelte",
  ".swift": "swift",
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".vue": "vue",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".zsh": "shellscript",
};

const VALID_ROLES: Record<ServerRole, true> = {
  navigation: true,
  diagnostics: true,
  actions: true,
};

export interface LspConfigPathOptions {
  agentDir?: string;
  projectConfigDirName?: string;
}

export function lspConfigPaths(
  cwd: string,
  includeProject: boolean,
  options: LspConfigPathOptions = {},
): string[] {
  const paths = [join(options.agentDir ?? getAgentDir(), "lsp.json")];
  if (includeProject) paths.push(join(cwd, options.projectConfigDirName ?? CONFIG_DIR_NAME, "lsp.json"));
  return paths;
}

export async function loadConfig(
  cwd: string,
  includeProject: boolean,
  options: LspConfigPathOptions = {},
): Promise<LspConfig> {
  const mergedServers = new Map<string, ServerConfigInput>(Object.entries(BUILTIN_SERVERS));
  const loadedFrom: string[] = [];
  let idleTimeoutMs = 300_000;
  let requestTimeoutMs = 15_000;
  let diagnosticsSettleMs = 500;
  let maxResults = 100;

  const paths = lspConfigPaths(cwd, includeProject, options);

  for (const path of paths) {
    const raw = await readConfig(path);
    if (!raw) continue;
    loadedFrom.push(path);
    if (raw.idleTimeoutMs !== undefined) idleTimeoutMs = nonNegativeInt(raw.idleTimeoutMs, `${path}: idleTimeoutMs`);
    if (raw.requestTimeoutMs !== undefined) requestTimeoutMs = positiveInt(raw.requestTimeoutMs, `${path}: requestTimeoutMs`);
    if (raw.diagnosticsSettleMs !== undefined) diagnosticsSettleMs = nonNegativeInt(raw.diagnosticsSettleMs, `${path}: diagnosticsSettleMs`);
    if (raw.maxResults !== undefined) maxResults = positiveInt(raw.maxResults, `${path}: maxResults`);
    for (const [id, patch] of Object.entries(raw.servers ?? {})) {
      if (!patch || typeof patch !== "object") throw new Error(`${path}: server ${id} must be an object`);
      if (patch.disabled) {
        mergedServers.delete(id);
        continue;
      }
      const existing = mergedServers.get(id);
      const initOptions = patch.initOptions === undefined
        ? existing?.initOptions
        : isRecord(existing?.initOptions) && isRecord(patch.initOptions)
          ? { ...existing.initOptions, ...patch.initOptions }
          : patch.initOptions;
      mergedServers.set(id, { ...existing, ...patch, initOptions });
    }
  }

  const servers = [...mergedServers.entries()].map(([id, value]) => normalizeServer(id, value));
  servers.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

  return { idleTimeoutMs, requestTimeoutMs, diagnosticsSettleMs, maxResults, servers, loadedFrom };
}

export function matchingServers(config: LspConfig, file: string, role: ServerRole, requestedId?: string): ServerConfig[] {
  const selectedId = requestedId ? serverIdForSelector(config, requestedId, role, file) : undefined;
  const candidates = config.servers.filter((server) => {
    if (selectedId && server.id !== selectedId) return false;
    return server.roles.includes(role) && languageIdForFile(server, file) !== undefined;
  });
  if (selectedId && candidates.length === 0) {
    const known = config.servers.find((server) => server.id === selectedId);
    if (!known) throw new Error(`Unknown LSP server: ${requestedId}`);
    throw new Error(`LSP server ${selectedId} does not handle ${file} for role ${role}`);
  }
  return candidates;
}

export function serverIdForSelector(config: LspConfig, selector: string, role: ServerRole, file?: string): string {
  if (config.servers.some((server) => server.id === selector)) return selector;
  const candidates = config.servers.filter((server) => {
    if (!server.roles.includes(role)) return false;
    return file
      ? languageIdForFile(server, file) === selector
      : Object.values(server.extensions).includes(selector);
  });
  if (candidates.length === 1) return candidates[0].id;
  if (candidates.length > 1) {
    throw new Error(`LSP language id ${selector} is ambiguous for role ${role}; use one of: ${candidates.map((server) => server.id).join(", ")}`);
  }
  return selector;
}

export function languageIdForFile(server: ServerConfig, file: string): string | undefined {
  const lower = file.toLowerCase();
  const extension = Object.keys(server.extensions)
    .sort((a, b) => b.length - a.length)
    .find((candidate) => lower.endsWith(candidate));
  return extension ? server.extensions[extension] : undefined;
}

async function readConfig(path: string): Promise<RawLspConfig | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("root must be an object");
    return parsed as RawLspConfig;
  } catch (error) {
    throw new Error(`Invalid LSP config ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function normalizeServer(id: string, value: ServerConfigInput): ServerConfig {
  if (typeof value.command !== "string" || value.command.length === 0) {
    throw new Error(`LSP server ${id}: command must be a non-empty string`);
  }
  const args = value.args ?? [];
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new Error(`LSP server ${id}: args must be strings`);
  }
  if (value.languageId !== undefined && (typeof value.languageId !== "string" || value.languageId.length === 0)) {
    throw new Error(`LSP server ${id}: languageId must be a non-empty string`);
  }
  const extensions: Record<string, string> = {};
  if (value.fileTypes !== undefined) {
    if (!Array.isArray(value.fileTypes) || value.fileTypes.some((fileType) => typeof fileType !== "string" || fileType.length === 0)) {
      throw new Error(`LSP server ${id}: fileTypes must be non-empty strings`);
    }
    for (const rawFileType of value.fileTypes) {
      const fileType = rawFileType.toLowerCase().startsWith(".") ? rawFileType.toLowerCase() : `.${rawFileType.toLowerCase()}`;
      const languageId = value.languageId ?? LANGUAGE_ID_BY_FILE_TYPE[fileType];
      if (!languageId) throw new Error(`LSP server ${id}: no language id is known for ${rawFileType}; set languageId or extensions`);
      extensions[fileType] = languageId;
    }
  }
  if (value.extensions !== undefined) {
    if (!value.extensions || typeof value.extensions !== "object" || Array.isArray(value.extensions)) {
      throw new Error(`LSP server ${id}: extensions must be an object`);
    }
    for (const [rawExtension, languageId] of Object.entries(value.extensions)) {
      if (typeof languageId !== "string" || languageId.length === 0) throw new Error(`LSP server ${id}: invalid language id for ${rawExtension}`);
      const extension = rawExtension.toLowerCase().startsWith(".") ? rawExtension.toLowerCase() : `.${rawExtension.toLowerCase()}`;
      extensions[extension] = languageId;
    }
  }
  if (Object.keys(extensions).length === 0) throw new Error(`LSP server ${id}: fileTypes or extensions must be configured`);
  const roles = value.roles ?? ALL_ROLES;
  if (!Array.isArray(roles) || roles.length === 0 || roles.some((role) => VALID_ROLES[role] !== true)) {
    throw new Error(`LSP server ${id}: roles must contain navigation, diagnostics, or actions`);
  }
  const rootMarkers = value.rootMarkers ?? [".git"];
  if (!Array.isArray(rootMarkers) || rootMarkers.some((marker) => typeof marker !== "string" || marker.length === 0)) {
    throw new Error(`LSP server ${id}: rootMarkers must be strings`);
  }
  if (value.workspaceStorage !== undefined && (typeof value.workspaceStorage !== "string" || value.workspaceStorage.length === 0)) {
    throw new Error(`LSP server ${id}: workspaceStorage must be a non-empty path template`);
  }
  const readyNotification = value.readyNotification;
  if (readyNotification !== undefined) {
    if (!readyNotification || typeof readyNotification !== "object" || Array.isArray(readyNotification)) {
      throw new Error(`LSP server ${id}: readyNotification must be an object`);
    }
    if (typeof readyNotification.method !== "string" || readyNotification.method.length === 0) {
      throw new Error(`LSP server ${id}: readyNotification.method must be a non-empty string`);
    }
    if (readyNotification.field !== undefined && (typeof readyNotification.field !== "string" || readyNotification.field.length === 0)) {
      throw new Error(`LSP server ${id}: readyNotification.field must be a non-empty string`);
    }
    const valueType = typeof readyNotification.value;
    if (readyNotification.value !== undefined && readyNotification.value !== null && valueType !== "string" && valueType !== "number" && valueType !== "boolean") {
      throw new Error(`LSP server ${id}: readyNotification.value must be a JSON scalar`);
    }
  }
  let settings = value.settings;
  if (settings === undefined && isRecord(value.initOptions) && isRecord(value.initOptions.settings)) settings = value.initOptions.settings;
  return {
    id,
    command: [value.command, ...args],
    workspaceStorage: value.workspaceStorage,
    extensions,
    rootMarkers: [...rootMarkers],
    roles: [...new Set(roles)],
    priority: Number.isFinite(value.priority) ? Number(value.priority) : 0,
    env: value.env ? { ...value.env } : undefined,
    initializationOptions: value.initOptions,
    settings,
    requestTimeoutMs: value.requestTimeoutMs === undefined ? undefined : positiveInt(value.requestTimeoutMs, `LSP server ${id}: requestTimeoutMs`),
    diagnosticsSettleMs: value.diagnosticsSettleMs === undefined ? undefined : nonNegativeInt(value.diagnosticsSettleMs, `LSP server ${id}: diagnosticsSettleMs`),
    readyNotification: readyNotification ? { ...readyNotification } : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInt(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}

function nonNegativeInt(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer`);
  return Number(value);
}
