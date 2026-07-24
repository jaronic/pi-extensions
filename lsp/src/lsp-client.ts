import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  CancellationTokenSource,
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from "vscode-jsonrpc/node";
import {
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DidSaveTextDocumentNotification,
  DocumentDiagnosticRequest,
  ExitNotification,
  InitializedNotification,
  PublishDiagnosticsNotification,
  TextDocumentSyncKind,
  type Diagnostic,
  type InitializeResult,
  type Position,
  type PublishDiagnosticsParams,
  type ServerCapabilities,
} from "vscode-languageserver-protocol";
import type { ClientStatus, LspAction, ServerConfig } from "./types.ts";

interface DocumentState {
  uri: string;
  version: number;
  text: string;
  languageId: string;
  opened: boolean;
}

export interface SyncedDocument extends DocumentState {
  changed: boolean;
}

interface DiagnosticState {
  items: Diagnostic[];
  revision: number;
  version?: number;
}

interface SyncOptions {
  openClose: boolean;
  change: TextDocumentSyncKind;
  save: boolean;
  includeTextOnSave: boolean;
}

const STDERR_LINES = 40;
const SHUTDOWN_TIMEOUT_MS = 1_000;

const EXIT_GRACE_MS = 250;
const TERMINATE_GRACE_MS = 250;
const KILL_GRACE_MS = 500;
export class LspClient {
  readonly server: ServerConfig;
  readonly root: string;

  private readonly child: ChildProcessWithoutNullStreams;
  private readonly connection: MessageConnection;
  private readonly documents = new Map<string, DocumentState>();
  private readonly diagnosticsByUri = new Map<string, DiagnosticState>();
  private readonly diagnosticListeners = new Map<string, Set<() => void>>();
  private readonly stderrLines: string[] = [];
  private readonly readyListeners = new Set<() => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly exited: Promise<void>;
  private readonly onClosed: () => void;
  private capabilities: ServerCapabilities = {};
  private syncOptions: SyncOptions = {
    openClose: false,
    change: TextDocumentSyncKind.None,
    save: false,
    includeTextOnSave: false,
  };
  private positionEncoding = "utf-16";
  private serviceReady = false;
  private stateValue: "starting" | "ready" | "closed" = "starting";
  private closing?: Promise<void>;
  private exitDescription?: string;

  private constructor(server: ServerConfig, root: string, child: ChildProcessWithoutNullStreams, onClosed: () => void) {
    this.server = server;
    this.root = root;
    this.child = child;
    this.onClosed = onClosed;
    this.connection = createMessageConnection(
      new StreamMessageReader(child.stdout),
      new StreamMessageWriter(child.stdin),
    );
    const { promise: exited, resolve: markExited } = Promise.withResolvers<void>();
    this.exited = exited;
    child.once("error", (error) => {
      this.exitDescription = error.message;
      markExited();
      this.beginUnexpectedCleanup();
      this.markClosed();
    });
    child.once("exit", (code, signal) => {
      this.exitDescription = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      markExited();
      this.beginUnexpectedCleanup();
      this.markClosed();
    });
    child.stderr.on("data", (chunk: Buffer | string) => this.captureStderr(String(chunk)));
    this.registerServerHandlers();
    this.connection.onClose(() => {
      this.beginUnexpectedCleanup();
      this.markClosed();
    });
    this.connection.onError(([error]) => {
      this.captureStderr(`JSON-RPC: ${error.message}`);
    });
    this.connection.listen();
  }

  static async start(server: ServerConfig, root: string, defaultTimeoutMs: number, onClosed: () => void): Promise<LspClient> {
    const resolvedCommand = await resolveServerCommand(server, root);
    const [command, ...args] = resolvedCommand;
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...server.env },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const client = new LspClient(server, root, child, onClosed);
    try {
      await client.initialize(server.requestTimeoutMs ?? defaultTimeoutMs);
      return client;
    } catch (error) {
      await client.forceClose();
      const stderr = client.stderrLines.length > 0 ? `\n${client.stderrLines.join("\n")}` : "";
      throw new Error(`Failed to start LSP server ${server.id} (${resolvedCommand.join(" ")}): ${messageOf(error)}${stderr}`);
    }
  }

  get state(): "starting" | "ready" | "closed" {
    return this.stateValue;
  }

  get openDocumentCount(): number {
    let count = 0;
    for (const document of this.documents.values()) if (document.opened) count += 1;
    return count;
  }

  status(): ClientStatus {
    return {
      server: this.server.id,
      root: this.root,
      state: this.stateValue,
      openDocuments: this.openDocumentCount,
      stderr: [...this.stderrLines],
    };
  }

  supports(action: LspAction): boolean {
    switch (action) {
      case "hover": return Boolean(this.capabilities.hoverProvider);
      case "definition": return Boolean(this.capabilities.definitionProvider);
      case "type_definition": return Boolean(this.capabilities.typeDefinitionProvider);
      case "implementation": return Boolean(this.capabilities.implementationProvider);
      case "references": return Boolean(this.capabilities.referencesProvider);
      case "symbols": return Boolean(this.capabilities.documentSymbolProvider);
      case "workspace_symbols": return Boolean(this.capabilities.workspaceSymbolProvider);
      case "rename_preview": return Boolean(this.capabilities.renameProvider);
      case "code_actions": return Boolean(this.capabilities.codeActionProvider);
      case "diagnostics":
      case "status":
        return true;
    }
  }

  async syncFile(file: string, languageId: string): Promise<SyncedDocument> {
    this.ensureAlive();
    const text = await readFile(file, "utf8");
    const uri = pathToFileURL(file).href;
    const current = this.documents.get(uri);
    if (!current) {
      const document: DocumentState = { uri, version: 1, text, languageId, opened: false };
      this.documents.set(uri, document);
      if (this.syncOptions.openClose || this.syncOptions.change !== TextDocumentSyncKind.None) {
        await this.connection.sendNotification(DidOpenTextDocumentNotification.type, {
          textDocument: { uri, languageId, version: document.version, text },
        });
        document.opened = true;
      }
      await this.sendSaveIfRequested(document);
      return { ...document, changed: true };
    }

    if (current.text === text && current.languageId === languageId) {
      return { ...current, changed: false };
    }

    current.version += 1;
    current.text = text;
    current.languageId = languageId;
    if (!current.opened && (this.syncOptions.openClose || this.syncOptions.change !== TextDocumentSyncKind.None)) {
      await this.connection.sendNotification(DidOpenTextDocumentNotification.type, {
        textDocument: { uri, languageId, version: current.version, text },
      });
      current.opened = true;
    } else if (current.opened && this.syncOptions.change !== TextDocumentSyncKind.None) {
      await this.connection.sendNotification(DidChangeTextDocumentNotification.type, {
        textDocument: { uri, version: current.version },
        contentChanges: [{ text }],
      });
    }
    await this.sendSaveIfRequested(current);
    return { ...current, changed: true };
  }

  toPosition(document: SyncedDocument, oneBasedLine: number, oneBasedColumn: number): Position {
    if (!Number.isInteger(oneBasedLine) || oneBasedLine < 1) throw new Error("line must be a positive integer");
    if (!Number.isInteger(oneBasedColumn) || oneBasedColumn < 1) throw new Error("column must be a positive integer");
    const lines = document.text.split(/\r?\n/);
    const lineText = lines[oneBasedLine - 1];
    if (lineText === undefined) throw new Error(`line ${oneBasedLine} is outside ${document.uri}`);
    const codePoints = Array.from(lineText);
    if (oneBasedColumn - 1 > codePoints.length) throw new Error(`column ${oneBasedColumn} is outside line ${oneBasedLine}`);
    const prefix = codePoints.slice(0, oneBasedColumn - 1).join("");
    let character: number;
    switch (this.positionEncoding) {
      case "utf-8": character = Buffer.byteLength(prefix, "utf8"); break;
      case "utf-32": character = codePoints.slice(0, oneBasedColumn - 1).length; break;
      default: character = prefix.length;
    }
    return { line: oneBasedLine - 1, character };
  }

  async request<R>(method: string, params: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<R> {
    this.ensureAlive();
    if (signal?.aborted) throw abortError();
    const cancellation = new CancellationTokenSource();
    const effectiveTimeout = timeoutMs ?? this.server.requestTimeoutMs ?? 15_000;
    const { promise, resolve, reject } = Promise.withResolvers<R>();
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let onClose: () => void;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      cancellation.dispose();
      this.closeListeners.delete(onClose);
      callback();
    };
    const onAbort = () => {
      cancellation.cancel();
      finish(() => reject(abortError()));
    };
    timer = setTimeout(() => {
      cancellation.cancel();
      finish(() => reject(new Error(`LSP request timed out after ${effectiveTimeout}ms: ${method}`)));
    }, effectiveTimeout);
    timer.unref();
    signal?.addEventListener("abort", onAbort, { once: true });
    onClose = () => {
      const reason = this.exitDescription ? ` (${this.exitDescription})` : "";
      finish(() => reject(new Error(`LSP server ${this.server.id} closed during ${method}${reason}`)));
    };
    this.closeListeners.add(onClose);
    if (this.stateValue === "closed") {
      onClose();
    } else {
      this.connection.sendRequest<R>(method, params, cancellation.token).then(
        (result) => finish(() => resolve(result)),
        (error: unknown) => finish(() => reject(error)),
      );
    }
    return await promise;
  }

  async getDiagnostics(
    file: string,
    languageId: string,
    settleMs: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Diagnostic[]> {
    const uri = pathToFileURL(file).href;
    const before = this.diagnosticsByUri.get(uri)?.revision ?? 0;
    const document = await this.syncFile(file, languageId);
    const cached = this.diagnosticsByUri.get(uri);

    if (this.capabilities.diagnosticProvider) {
      const report = await this.request<{ kind?: string; items?: Diagnostic[] }>(
        DocumentDiagnosticRequest.method,
        { textDocument: { uri } },
        signal,
        timeoutMs,
      );
      if (report?.kind === "full" && Array.isArray(report.items)) {
        this.storeDiagnostics(uri, report.items, document.version);
        return report.items;
      }
    }

    if (!document.changed && cached) return cached.items;
    return await this.waitForDiagnostics(uri, before, settleMs, timeoutMs, signal);
  }

  async shutdown(): Promise<void> {
    if (this.closing) return await this.closing;
    this.closing = this.shutdownInternal();
    return await this.closing;
  }

  private async initialize(timeoutMs: number): Promise<void> {
    const rootUri = pathToFileURL(this.root).href;
    const result = await this.request<InitializeResult>("initialize", {
      processId: this.child.pid ?? null,
      clientInfo: { name: "pi-lsp", version: "0.1.0" },
      rootPath: this.root,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: basename(this.root) }],
      capabilities: {
        general: { positionEncodings: ["utf-16", "utf-8", "utf-32"] },
        workspace: {
          applyEdit: false,
          configuration: true,
          workspaceFolders: true,
          symbol: { dynamicRegistration: false },
        },
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: true },
          publishDiagnostics: { relatedInformation: true, versionSupport: true },
          hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
          definition: { dynamicRegistration: false, linkSupport: true },
          typeDefinition: { dynamicRegistration: false, linkSupport: true },
          implementation: { dynamicRegistration: false, linkSupport: true },
          references: { dynamicRegistration: false },
          documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
          rename: { dynamicRegistration: false, prepareSupport: false },
          codeAction: { dynamicRegistration: false },
          diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
        },
      },
      initializationOptions: this.server.initializationOptions,
      trace: "off",
    }, undefined, timeoutMs);
    this.capabilities = result.capabilities;
    this.positionEncoding = String(result.capabilities.positionEncoding ?? "utf-16").toLowerCase();
    this.syncOptions = normalizeSyncOptions(result.capabilities.textDocumentSync);
    await this.connection.sendNotification(InitializedNotification.type, {});
    if (this.server.settings) {
      await this.connection.sendNotification("workspace/didChangeConfiguration", { settings: this.server.settings });
    }
    await this.waitForServiceReady(timeoutMs);
    this.stateValue = "ready";
  }

  private registerServerHandlers(): void {
    this.connection.onNotification(PublishDiagnosticsNotification.type, (params: PublishDiagnosticsParams) => {
      this.storeDiagnostics(params.uri, params.diagnostics, params.version);
    });
    const readyNotification = this.server.readyNotification;
    if (readyNotification) {
      this.connection.onNotification(readyNotification.method, (params: unknown) => {
        const actual = valueAt(params, readyNotification.field);
        if (readyNotification.value !== undefined && actual !== readyNotification.value) return;
        this.serviceReady = true;
        for (const listener of this.readyListeners) listener();
      });
    }
    this.connection.onRequest("workspace/configuration", (params: { items?: Array<{ section?: string }> }) => {
      return (params.items ?? []).map((item) => settingAt(this.server.settings ?? {}, item.section));
    });
    this.connection.onRequest("workspace/workspaceFolders", () => {
      const uri = pathToFileURL(this.root).href;
      return [{ uri, name: basename(this.root) }];
    });
    this.connection.onRequest("workspace/applyEdit", () => ({
      applied: false,
      failureReason: "pi-lsp only previews workspace edits",
    }));
    this.connection.onRequest("client/registerCapability", () => null);
    this.connection.onRequest("client/unregisterCapability", () => null);
    this.connection.onRequest("window/workDoneProgress/create", () => null);
    this.connection.onRequest("window/showMessageRequest", () => null);
  }

  private async waitForServiceReady(timeoutMs: number): Promise<void> {
    if (!this.server.readyNotification || this.serviceReady) return;
    const { promise, resolve: resolveReady, reject } = Promise.withResolvers<void>();
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.readyListeners.delete(onStatus);
      callback();
    };
    const onStatus = () => {
      if (this.serviceReady) finish(resolveReady);
      else if (this.stateValue === "closed") finish(() => reject(new Error(`LSP server ${this.server.id} closed before becoming ready`)));
    };
    timer = setTimeout(() => {
      finish(() => reject(new Error(`Timed out waiting for ${this.server.readyNotification?.method} from ${this.server.id} after ${timeoutMs}ms`)));
    }, timeoutMs);
    timer.unref();
    this.readyListeners.add(onStatus);
    onStatus();
    await promise;
  }

  private async sendSaveIfRequested(document: DocumentState): Promise<void> {
    if (!this.syncOptions.save) return;
    await this.connection.sendNotification(DidSaveTextDocumentNotification.type, {
      textDocument: { uri: document.uri },
      text: this.syncOptions.includeTextOnSave ? document.text : undefined,
    });
  }

  private storeDiagnostics(uri: string, items: Diagnostic[], version?: number): void {
    const revision = (this.diagnosticsByUri.get(uri)?.revision ?? 0) + 1;
    this.diagnosticsByUri.set(uri, { items, revision, version });
    for (const listener of this.diagnosticListeners.get(uri) ?? []) listener();
  }

  private async waitForDiagnostics(
    uri: string,
    afterRevision: number,
    settleMs: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Diagnostic[]> {
    if (signal?.aborted) throw abortError();
    const { promise, resolve, reject } = Promise.withResolvers<Diagnostic[]>();
    let settled = false;
    let settleTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    const listeners = this.diagnosticListeners.get(uri) ?? new Set<() => void>();
    this.diagnosticListeners.set(uri, listeners);
    const cleanup = () => {
      listeners.delete(onUpdate);
      if (listeners.size === 0) this.diagnosticListeners.delete(uri);
      clearTimeout(settleTimer);
      clearTimeout(timeoutTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const scheduleSettle = () => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        const latest = this.diagnosticsByUri.get(uri);
        if (latest && latest.revision > afterRevision) finish(() => resolve(latest.items));
      }, settleMs);
      settleTimer.unref();
    };
    const onUpdate = () => {
      if (this.stateValue === "closed") {
        finish(() => reject(new Error(`LSP server ${this.server.id} closed while waiting for diagnostics`)));
        return;
      }
      const latest = this.diagnosticsByUri.get(uri);
      if (latest && latest.revision > afterRevision) scheduleSettle();
    };
    const onAbort = () => finish(() => reject(abortError()));
    timeoutTimer = setTimeout(() => {
      finish(() => reject(new Error(`Timed out waiting for diagnostics from ${this.server.id} after ${timeoutMs}ms`)));
    }, timeoutMs);
    timeoutTimer.unref();
    listeners.add(onUpdate);
    signal?.addEventListener("abort", onAbort, { once: true });
    onUpdate();
    return await promise;
  }

  private async shutdownInternal(): Promise<void> {
    try {
      if (this.stateValue !== "closed") {
        for (const document of this.documents.values()) {
          if (!document.opened) continue;
          try {
            await this.connection.sendNotification(DidCloseTextDocumentNotification.type, {
              textDocument: { uri: document.uri },
            });
          } catch {
            break;
          }
        }
        try {
          await this.request<void>("shutdown", undefined, undefined, SHUTDOWN_TIMEOUT_MS);
        } catch {
          // The process may already be exiting.
        }
        try {
          await this.connection.sendNotification(ExitNotification.type);
        } catch {
          // The connection may already be closed.
        }
      }
      try { this.connection.end(); } catch {}
      await Promise.race([this.exited, delay(EXIT_GRACE_MS)]);
      await this.terminateProcessTree();
    } finally {
      this.markClosed();
    }
  }

  private async forceClose(): Promise<void> {
    if (this.closing) return await this.closing;
    this.closing = this.forceCloseInternal();
    return await this.closing;
  }

  private async forceCloseInternal(): Promise<void> {
    try {
      try { this.connection.end(); } catch {}
      await this.terminateProcessTree();
    } finally {
      this.markClosed();
    }
  }

  private beginUnexpectedCleanup(): void {
    if (this.closing || !processTreeIsRunning(this.child)) return;
    this.closing = this.terminateProcessTree();
    void this.closing.catch((error: unknown) => this.captureStderr(`Process cleanup: ${messageOf(error)}`));
  }

  private async terminateProcessTree(): Promise<void> {
    const pid = this.child.pid;
    if (pid === undefined) {
      await Promise.race([this.exited, delay(TERMINATE_GRACE_MS)]);
      return;
    }
    if (process.platform === "win32") {
      if (childIsRunning(this.child)) {
        try { this.child.kill(); } catch {}
        await Promise.race([this.exited, delay(TERMINATE_GRACE_MS)]);
      }
      if (childIsRunning(this.child)) await killWindowsProcessTree(pid);
      await Promise.race([this.exited, delay(KILL_GRACE_MS)]);
      if (childIsRunning(this.child)) throw new Error(`LSP server ${this.server.id} did not terminate`);
      return;
    }

    signalUnixProcessGroup(pid, "SIGTERM");
    await Promise.race([this.exited, delay(TERMINATE_GRACE_MS)]);
    if (!unixProcessGroupExists(pid)) return;
    signalUnixProcessGroup(pid, "SIGKILL");
    const deadline = Date.now() + KILL_GRACE_MS;
    while (unixProcessGroupExists(pid) && Date.now() < deadline) await delay(25);
    if (unixProcessGroupExists(pid)) throw new Error(`LSP server ${this.server.id} process group did not terminate`);
  }

  private markClosed(): void {
    if (this.stateValue === "closed") return;
    this.stateValue = "closed";
    for (const listeners of this.diagnosticListeners.values()) for (const listener of listeners) listener();
    for (const listener of this.readyListeners) listener();
    for (const listener of this.closeListeners) listener();
    this.closeListeners.clear();
    this.onClosed();
  }

  private ensureAlive(): void {
    if (this.stateValue === "closed") {
      const reason = this.exitDescription ? ` (${this.exitDescription})` : "";
      throw new Error(`LSP server ${this.server.id} is closed${reason}`);
    }
  }

  private captureStderr(text: string): void {
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;
      this.stderrLines.push(trimmed.slice(0, 1_000));
    }
    if (this.stderrLines.length > STDERR_LINES) this.stderrLines.splice(0, this.stderrLines.length - STDERR_LINES);
  }
}

export async function resolveServerCommand(server: ServerConfig, root: string, cacheDirectory = defaultCacheDirectory()): Promise<string[]> {
  const usesWorkspaceStorage = server.command.some((part) => part.includes("{workspaceStorage}"));
  const workspaceHash = createHash("sha256").update(root).digest("hex").slice(0, 20);
  const safeServerId = server.id.replace(/[^A-Za-z0-9_.-]/g, "_");
  const baseReplacements: Record<string, string> = {
    cacheDir: cacheDirectory,
    serverId: safeServerId,
    workspaceHash,
    workspaceRoot: root,
  };
  let storageTemplate = server.workspaceStorage ?? "{cacheDir}/{serverId}/{workspaceHash}";
  if (storageTemplate.includes("{workspaceStorage}")) throw new Error(`LSP server ${server.id}: workspaceStorage cannot reference itself`);
  if (storageTemplate === "~") storageTemplate = homedir();
  else if (storageTemplate.startsWith("~/") || storageTemplate.startsWith("~\\")) storageTemplate = join(homedir(), storageTemplate.slice(2));
  const expandedStorage = expandTemplate(storageTemplate, baseReplacements);
  const workspaceStorage = isAbsolute(expandedStorage) ? expandedStorage : resolve(root, expandedStorage);
  if (usesWorkspaceStorage) await mkdir(workspaceStorage, { recursive: true });
  return server.command.map((part) => expandTemplate(part, { ...baseReplacements, workspaceStorage }));
}

function expandTemplate(value: string, replacements: Record<string, string>): string {
  let expanded = value;
  for (const [name, replacement] of Object.entries(replacements)) expanded = expanded.replaceAll(`{${name}}`, replacement);
  return expanded;
}

function defaultCacheDirectory(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg && isAbsolute(xdg)) return join(xdg, "pi-lsp");
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "pi-lsp");
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "pi-lsp");
  return join(homedir(), ".cache", "pi-lsp");
}

function normalizeSyncOptions(value: ServerCapabilities["textDocumentSync"]): SyncOptions {
  if (typeof value === "number") {
    return { openClose: true, change: value, save: false, includeTextOnSave: false };
  }
  if (!value) {
    return { openClose: false, change: TextDocumentSyncKind.None, save: false, includeTextOnSave: false };
  }
  const save = value.save;
  return {
    openClose: Boolean(value.openClose),
    change: value.change ?? TextDocumentSyncKind.None,
    save: Boolean(save),
    includeTextOnSave: typeof save === "object" && Boolean(save.includeText),
  };
}

function valueAt(value: unknown, field?: string): unknown {
  if (!field) return value;
  let current = value;
  for (const key of field.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function settingAt(settings: Record<string, unknown>, section?: string): unknown {
  if (!section) return settings;
  let current: unknown = settings;
  for (const key of section.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[key];
  }
  return current ?? null;
}

function abortError(): Error {
  const error = new Error("LSP request aborted");
  error.name = "AbortError";
  return error;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function childIsRunning(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function processTreeIsRunning(child: ChildProcessWithoutNullStreams): boolean {
  const pid = child.pid;
  if (process.platform === "win32" || pid === undefined) return childIsRunning(child);
  return unixProcessGroupExists(pid);
}

function unixProcessGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalUnixProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}

async function killWindowsProcessTree(pid: number): Promise<void> {
  const killer = spawn("taskkill", ["/pid", String(pid), "/t", "/f"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const { promise, resolve } = Promise.withResolvers<void>();
  killer.once("error", () => resolve());
  killer.once("exit", () => resolve());
  await Promise.race([promise, delay(KILL_GRACE_MS)]);
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
