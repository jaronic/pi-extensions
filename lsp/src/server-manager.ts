import { relative } from "node:path";
import { languageIdForFile, matchingServers, serverIdForSelector } from "./config.ts";
import { LspClient } from "./lsp-client.ts";
import type { Logger } from "./logger.ts";
import { findWorkspaceRoot, isWithin } from "./roots.ts";
import type { ClientStatus, LspAction, LspConfig, ServerConfig, ServerRole } from "./types.ts";

export interface RoutedClient {
  client: LspClient;
  server: ServerConfig;
  languageId: string;
}

export interface DiagnosticResult {
  server: string;
  root: string;
  diagnostics?: Awaited<ReturnType<LspClient["getDiagnostics"]>>;
  error?: string;
}

const NOOP_LOGGER: Logger = { error() {}, warn() {}, info() {}, debug() {} };

export class ServerManager {
  readonly cwd: string;
  readonly config: LspConfig;

  private readonly logger: Logger;
  private readonly clients = new Map<string, LspClient>();
  private readonly starting = new Map<string, Promise<LspClient>>();
  private readonly idleTimers = new Map<string, NodeJS.Timeout>();
  private shuttingDown = false;

  constructor(cwd: string, config: LspConfig, logger: Logger = NOOP_LOGGER) {
    this.cwd = cwd;
    this.config = config;
    this.logger = logger;
  }

  status(): { configured: Array<{ id: string; command: string; roles: ServerRole[] }>; active: ClientStatus[]; loadedFrom: string[] } {
    return {
      configured: this.config.servers.map((server) => ({
        id: server.id,
        command: server.command.join(" "),
        roles: server.roles,
      })),
      active: [...this.clients.values()].map((client) => client.status()),
      loadedFrom: this.config.loadedFrom,
    };
  }

  async clientForAction(file: string, action: LspAction, requestedServer?: string): Promise<RoutedClient> {
    const role = roleForAction(action);
    const servers = matchingServers(this.config, file, role, requestedServer);
    if (servers.length === 0) throw new Error(`No configured LSP server handles ${relative(this.cwd, file) || file}`);

    const failures: string[] = [];
    for (const server of servers) {
      try {
        const client = await this.getOrStart(server, await findWorkspaceRoot(file, server.rootMarkers, this.cwd));
        if (!client.supports(action)) {
          failures.push(`${server.id}: capability not advertised`);
          if (requestedServer) break;
          continue;
        }
        const languageId = languageIdForFile(server, file);
        if (!languageId) continue;
        return { client, server, languageId };
      } catch (error) {
        const detail = messageOf(error);
        failures.push(`${server.id}: ${detail}`);
        // The client-start failure carries the resolved command and captured
        // server stderr in its message; keep it for post-hoc diagnosis.
        this.logger.warn("client_start_failed", {
          server: server.id,
          action,
          file: relative(this.cwd, file) || file,
          command: server.command.join(" "),
          error,
        });
        if (requestedServer) break;
      }
    }
    throw new Error(`No usable LSP server for ${action}: ${failures.join("; ")}`);
  }

  async diagnostics(file: string, requestedServer: string | undefined, signal?: AbortSignal): Promise<DiagnosticResult[]> {
    const servers = matchingServers(this.config, file, "diagnostics", requestedServer);
    if (servers.length === 0) throw new Error(`No configured diagnostics server handles ${relative(this.cwd, file) || file}`);

    return await Promise.all(servers.map(async (server): Promise<DiagnosticResult> => {
      const root = await findWorkspaceRoot(file, server.rootMarkers, this.cwd);
      try {
        const client = await this.getOrStart(server, root);
        const languageId = languageIdForFile(server, file);
        if (!languageId) throw new Error("file extension no longer matches server route");
        const diagnostics = await client.getDiagnostics(
          file,
          languageId,
          server.diagnosticsSettleMs ?? this.config.diagnosticsSettleMs,
          server.requestTimeoutMs ?? this.config.requestTimeoutMs,
          signal,
        );
        return { server: server.id, root, diagnostics };
      } catch (error) {
        this.logger.warn("diagnostics_failed", {
          server: server.id,
          file: relative(this.cwd, file) || file,
          root,
          error,
        });
        return { server: server.id, root, error: messageOf(error) };
      }
    }));
  }

  async workspaceClients(requestedServer?: string): Promise<LspClient[]> {
    if (requestedServer) {
      const selectedId = serverIdForSelector(this.config, requestedServer, "navigation");
      const server = this.config.servers.find((candidate) => candidate.id === selectedId);
      if (!server) throw new Error(`Unknown LSP server: ${requestedServer}`);
      if (!server.roles.includes("navigation")) throw new Error(`LSP server ${server.id} is not configured for navigation`);
      const client = await this.getOrStart(server, this.cwd);
      if (!client.supports("workspace_symbols")) throw new Error(`LSP server ${server.id} does not advertise workspace symbols`);
      return [client];
    }
    const active = [...this.clients.entries()]
      .filter(([, client]) => client.state === "ready" && client.supports("workspace_symbols"));
    if (active.length === 0) throw new Error("workspace_symbols requires server when no compatible LSP client is active");
    for (const [key, client] of active) this.scheduleIdle(key, client);
    return active.map(([, client]) => client);
  }

  async syncActiveFile(file: string): Promise<void> {
    const work: Array<{ server: string; promise: Promise<unknown> }> = [];
    for (const [key, client] of this.clients) {
      if (client.state !== "ready" || !isWithin(file, client.root)) continue;
      const languageId = languageIdForFile(client.server, file);
      if (languageId) {
        this.scheduleIdle(key, client);
        work.push({ server: client.server.id, promise: client.syncFile(file, languageId) });
      }
    }
    if (work.length === 0) return;
    const settled = await Promise.allSettled(work.map((entry) => entry.promise));
    settled.forEach((outcome, index) => {
      if (outcome.status === "rejected") {
        this.logger.warn("sync_failed", { server: work[index]?.server, file: relative(this.cwd, file) || file, error: outcome.reason });
      }
    });
    this.logger.debug("file_synced", {
      file: relative(this.cwd, file) || file,
      servers: work.map((entry) => entry.server),
      failed: settled.filter((outcome) => outcome.status === "rejected").length,
    });
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
    const pending = [...this.starting.values()];
    if (pending.length > 0) await Promise.allSettled(pending);
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.logger.info("shutdown", { cwd: this.cwd, clients: clients.length, pending: pending.length });
    await Promise.allSettled(clients.map((client) => client.shutdown()));
    this.starting.clear();
  }

  private async getOrStart(server: ServerConfig, root: string): Promise<LspClient> {
    if (this.shuttingDown) throw new Error("LSP manager is shutting down");
    const key = `${server.id}\0${root}`;
    const existing = this.clients.get(key);
    if (existing?.state === "ready") {
      this.scheduleIdle(key, existing);
      return existing;
    }
    const pending = this.starting.get(key);
    if (pending) {
      const client = await pending;
      this.scheduleIdle(key, client);
      return client;
    }

    let instance: LspClient | undefined;
    const startup = LspClient.start(server, root, this.config.requestTimeoutMs, () => {
      this.clearIdle(key);
      // A close while the client is still registered is a crash, not a
      // deliberate idle/manager shutdown; those remove the client first.
      const unexpected = instance !== undefined && this.clients.get(key) === instance;
      if (!instance || this.clients.get(key) === instance) this.clients.delete(key);
      if (unexpected) {
        this.logger.warn("server_exited", { server: server.id, root, command: server.command.join(" ") });
      }
    }).then(async (client) => {
      instance = client;
      if (this.shuttingDown) {
        await client.shutdown();
        throw new Error("LSP manager shut down during server startup");
      }
      this.clients.set(key, client);
      this.scheduleIdle(key, client);
      this.logger.info("server_started", { server: server.id, root, command: server.command.join(" ") });
      return client;
    }).finally(() => {
      this.starting.delete(key);
    });
    this.starting.set(key, startup);
    return await startup;
  }
  private scheduleIdle(key: string, client: LspClient): void {
    this.clearIdle(key);
    if (this.config.idleTimeoutMs === 0) return;
    const timer = setTimeout(() => {
      this.idleTimers.delete(key);
      if (this.clients.get(key) !== client) return;
      this.clients.delete(key);
      this.logger.debug("server_idle_shutdown", { server: client.server.id, root: client.root });
      void client.shutdown();
    }, this.config.idleTimeoutMs);
    timer.unref();
    this.idleTimers.set(key, timer);
  }

  private clearIdle(key: string): void {
    const timer = this.idleTimers.get(key);
    clearTimeout(timer);
    this.idleTimers.delete(key);
  }
}

function roleForAction(action: LspAction): ServerRole {
  switch (action) {
    case "rename_preview":
    case "code_actions":
      return "actions";
    case "diagnostics":
      return "diagnostics";
    default:
      return "navigation";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
