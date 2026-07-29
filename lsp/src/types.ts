export type ServerRole = "navigation" | "diagnostics" | "actions";

export interface ReadyNotificationConfig {
  method: string;
  field?: string;
  value?: string | number | boolean | null;
}

export interface ServerConfigInput {
  command?: string;
  args?: string[];
  fileTypes?: string[];
  languageId?: string;
  extensions?: Record<string, string>;
  workspaceStorage?: string;
  rootMarkers?: string[];
  roles?: ServerRole[];
  priority?: number;
  env?: Record<string, string>;
  initOptions?: unknown;
  settings?: Record<string, unknown>;
  requestTimeoutMs?: number;
  diagnosticsSettleMs?: number;
  readyNotification?: ReadyNotificationConfig;
  disabled?: boolean;
}

export interface ServerConfig {
  id: string;
  command: string[];
  workspaceStorage?: string;
  extensions: Record<string, string>;
  rootMarkers: string[];
  roles: ServerRole[];
  priority: number;
  env?: Record<string, string>;
  initializationOptions?: unknown;
  settings?: Record<string, unknown>;
  requestTimeoutMs?: number;
  diagnosticsSettleMs?: number;
  readyNotification?: ReadyNotificationConfig;
}

export interface RawLspConfig {
  idleTimeoutMs?: number;
  requestTimeoutMs?: number;
  diagnosticsSettleMs?: number;
  maxResults?: number;
  logLevel?: "error" | "warn" | "info" | "debug";
  servers?: Record<string, ServerConfigInput>;
}

export interface LspConfig {
  idleTimeoutMs: number;
  requestTimeoutMs: number;
  diagnosticsSettleMs: number;
  maxResults: number;
  servers: ServerConfig[];
  loadedFrom: string[];
}

export type LspAction =
  | "status"
  | "diagnostics"
  | "hover"
  | "definition"
  | "type_definition"
  | "implementation"
  | "references"
  | "symbols"
  | "workspace_symbols"
  | "rename_preview"
  | "code_actions";

export interface ClientStatus {
  server: string;
  root: string;
  state: "starting" | "ready" | "closed";
  openDocuments: number;
  stderr: string[];
}
