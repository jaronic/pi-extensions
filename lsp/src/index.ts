import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import {
  CodeActionRequest,
  DefinitionRequest,
  DocumentSymbolRequest,
  HoverRequest,
  ImplementationRequest,
  ReferencesRequest,
  RenameRequest,
  TypeDefinitionRequest,
  WorkspaceSymbolRequest,
  type CodeAction,
  type Command,
  type Hover,
  type WorkspaceEdit,
} from "vscode-languageserver-protocol";
import { loadConfig } from "./config.ts";
import {
  formatCodeActions,
  formatDiagnostics,
  formatDocumentSymbols,
  formatHover,
  formatLocations,
  formatWorkspaceEdit,
  workspaceEditCount,
  formatWorkspaceSymbols,
  type SeverityFilter,
} from "./format.ts";
import { resolvePosition } from "./positions.ts";
import { resolveWorkspaceFile } from "./roots.ts";
import { ServerManager } from "./server-manager.ts";
import { LspOutputStore, type LspTruncationSummary } from "./output.ts";
import type { LspAction } from "./types.ts";

const ACTIONS = [
  "status",
  "diagnostics",
  "hover",
  "definition",
  "type_definition",
  "implementation",
  "references",
  "symbols",
  "workspace_symbols",
  "rename_preview",
  "code_actions",
] as const;

const SEVERITIES = ["all", "error", "warning", "info", "hint"] as const;

const Parameters = Type.Object({
  action: StringEnum(ACTIONS),
  file: Type.Optional(Type.String({ description: "Workspace-relative or absolute file path" })),
  line: Type.Optional(Type.Integer({ minimum: 1, description: "1-based line" })),
  column: Type.Optional(Type.Integer({ minimum: 1, description: "1-based Unicode column; defaults to 1" })),
  endLine: Type.Optional(Type.Integer({ minimum: 1, description: "Code-action range end line" })),
  endColumn: Type.Optional(Type.Integer({ minimum: 1, description: "Code-action range end column" })),
  symbol: Type.Optional(Type.String({ minLength: 1, description: "Exact symbol used to resolve a position when line is omitted" })),
  query: Type.Optional(Type.String({ description: "Workspace symbol query" })),
  newName: Type.Optional(Type.String({ minLength: 1, description: "New symbol name for rename_preview" })),
  server: Type.Optional(Type.String({ minLength: 1, description: "Configured server ID or unique language ID (for example, java selects jdtls)" })),
  severity: Type.Optional(StringEnum(SEVERITIES)),
  includeDeclaration: Type.Optional(Type.Boolean({ description: "Include declarations in references; defaults to true" })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Maximum formatted results" })),
});

type Parameters = Static<typeof Parameters>;

interface LspResultDetails {
  action: LspAction;
  servers: string[];
  resultCount: number;
  errorCount: number;
  configuredCount?: number;
  activeCount?: number;
  truncated?: boolean;
  truncation?: LspTruncationSummary;
  fullOutputPath?: string;
}

export default function lspExtension(pi: ExtensionAPI): void {
  let manager: ServerManager | undefined;
  let managerPromise: Promise<ServerManager> | undefined;
  const outputStore = new LspOutputStore();

  const getManager = async (ctx: ExtensionContext): Promise<ServerManager> => {
    if (manager && manager.cwd === ctx.cwd) return manager;
    if (managerPromise) return await managerPromise;
    managerPromise = (async () => {
      const previous = manager;
      manager = undefined;
      if (previous) await previous.shutdown();
      const config = await loadConfig(ctx.cwd, ctx.isProjectTrusted());
      manager = new ServerManager(ctx.cwd, config);
      return manager;
    })().finally(() => {
      managerPromise = undefined;
    });
    return await managerPromise;
  };

  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: "Language-server diagnostics and semantic navigation. Rename and code actions are preview-only and never modify files. Output is limited to 2,000 lines or 50KB; truncated output is saved to a temporary artifact.",
    promptSnippet: "LSP diagnostics, hover, definitions, references, symbols, and safe refactor previews",
    promptGuidelines: [
      "Use lsp for semantic definitions, references, type information, diagnostics, and symbol-aware rename previews.",
      "Use lsp action=diagnostics after meaningful edits when a matching language server is installed.",
      "Usually omit server. When selecting one, use its configured ID or a unique language ID such as java for jdtls.",
      "lsp line and column inputs are 1-based; use symbol only when it has one unambiguous occurrence in the file.",
    ],
    parameters: Parameters,
    async execute(_toolCallId, params: Parameters, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const activeManager = await getManager(ctx);
      const limit = Math.min(params.limit ?? activeManager.config.maxResults, 500);
      ctx.ui.setStatus("lsp", `LSP: ${params.action}`);
      try {
        const result = await executeAction(activeManager, params, limit, signal);
        signal?.throwIfAborted();
        const bounded = await outputStore.bound(result.text);
        return {
          content: [{ type: "text", text: bounded.text }],
          details: {
            ...result.details,
            truncated: bounded.truncation !== undefined,
            truncation: bounded.truncation,
            fullOutputPath: bounded.fullOutputPath,
          },
        };
      } finally {
        ctx.ui.setStatus("lsp", undefined);
      }
    },
  });

  pi.registerCommand("lsp", {
    description: "Show configured and active language servers",
    handler: async (_args, ctx) => {
      try {
        const activeManager = await getManager(ctx);
        const bounded = await outputStore.bound(formatStatus(activeManager.status()));
        ctx.ui.notify(bounded.text, "info");
      } catch (error) {
        ctx.ui.notify(messageOf(error), "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    await outputStore.cleanup();
    await getManager(ctx);
  });

  pi.on("tool_result", async (event, ctx) => {
    if (!manager || manager.cwd !== ctx.cwd || event.isError) return;
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const rawPath = event.input.path;
    if (typeof rawPath !== "string") return;
    try {
      const file = await resolveWorkspaceFile(rawPath, ctx.cwd);
      await manager.syncActiveFile(file);
    } catch {
      // The next explicit LSP request performs a full disk sync and reports errors.
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const current = manager;
    manager = undefined;
    managerPromise = undefined;
    ctx.ui.setStatus("lsp", undefined);
    await Promise.allSettled([
      current?.shutdown() ?? Promise.resolve(),
      outputStore.cleanup(),
    ]);
  });
}

async function executeAction(
  manager: ServerManager,
  params: Parameters,
  limit: number,
  signal?: AbortSignal,
): Promise<{ text: string; details: LspResultDetails }> {
  if (params.action === "status") {
    const status = manager.status();
    return {
      text: formatStatus(status),
      details: {
        action: "status",
        servers: status.configured.map(({ id }) => id),
        resultCount: status.active.length,
        errorCount: 0,
        configuredCount: status.configured.length,
        activeCount: status.active.length,
      },
    };
  }

  if (params.action === "workspace_symbols") {
    const query = params.query ?? "";
    const clients = await manager.workspaceClients(params.server);
    const settled = await Promise.allSettled(clients.map(async (client) => ({
      server: client.server.id,
      result: await client.request<unknown>(WorkspaceSymbolRequest.method, { query }, signal),
    })));
    const errors = settled.flatMap((entry, index) => entry.status === "rejected"
      ? [`[${clients[index].server.id}] ERROR ${messageOf(entry.reason)}`]
      : []);
    const values = settled.flatMap((entry) => entry.status === "fulfilled" && Array.isArray(entry.value.result)
      ? entry.value.result
      : []);
    const formatted = formatWorkspaceSymbols(values, manager.cwd, limit);
    return {
      text: [...errors, formatted].filter(Boolean).join("\n"),
      details: {
        action: "workspace_symbols",
        servers: clients.map((client) => client.server.id),
        resultCount: values.length,
        errorCount: errors.length,
      },
    };
  }

  const rawFile = requiredString(params.file, "file", params.action);
  const file = await resolveWorkspaceFile(rawFile, manager.cwd);

  if (params.action === "diagnostics") {
    const results = await manager.diagnostics(file, params.server, signal);
    if (results.every((result) => result.error)) {
      throw new Error(results.map((result) => `${result.server}: ${result.error}`).join("; "));
    }
    return {
      text: formatDiagnostics(file, results, manager.cwd, limit, (params.severity ?? "all") as SeverityFilter),
      details: {
        action: "diagnostics",
        servers: results.map(({ server }) => server),
        resultCount: results.reduce((count, result) => count + (result.diagnostics?.length ?? 0), 0),
        errorCount: results.filter(({ error }) => error !== undefined).length,
      },
    };
  }

  const routed = await manager.clientForAction(file, params.action as LspAction, params.server);
  const document = await routed.client.syncFile(file, routed.languageId);
  const textDocument = { uri: document.uri };
  const servers = [routed.server.id];

  if (params.action === "symbols") {
    const result = await routed.client.request<unknown>(DocumentSymbolRequest.method, { textDocument }, signal);
    return {
      text: formatDocumentSymbols(result, manager.cwd, limit),
      details: { action: "symbols", servers, resultCount: resultCount(result), errorCount: 0 },
    };
  }

  const position = resolvePosition(routed.client, document, params);
  switch (params.action) {
    case "hover": {
      const result = await routed.client.request<Hover | null>(HoverRequest.method, { textDocument, position }, signal);
      return {
        text: formatHover(result),
        details: { action: "hover", servers, resultCount: result === null ? 0 : 1, errorCount: 0 },
      };
    }
    case "definition":
    case "type_definition":
    case "implementation": {
      const method = params.action === "definition"
        ? DefinitionRequest.method
        : params.action === "type_definition"
          ? TypeDefinitionRequest.method
          : ImplementationRequest.method;
      const result = await routed.client.request<unknown>(method, { textDocument, position }, signal);
      return {
        text: formatLocations(result, manager.cwd, limit),
        details: { action: params.action, servers, resultCount: resultCount(result), errorCount: 0 },
      };
    }
    case "references": {
      const result = await routed.client.request<unknown>(ReferencesRequest.method, {
        textDocument,
        position,
        context: { includeDeclaration: params.includeDeclaration ?? true },
      }, signal);
      return {
        text: formatLocations(result, manager.cwd, limit),
        details: { action: "references", servers, resultCount: resultCount(result), errorCount: 0 },
      };
    }
    case "rename_preview": {
      const newName = requiredString(params.newName, "newName", params.action);
      const result = await routed.client.request<WorkspaceEdit | null>(RenameRequest.method, {
        textDocument,
        position,
        newName,
      }, signal);
      return {
        text: formatWorkspaceEdit(result, manager.cwd, limit),
        details: { action: "rename_preview", servers, resultCount: workspaceEditCount(result), errorCount: 0 },
      };
    }
    case "code_actions": {
      const end = params.endLine === undefined
        ? position
        : routed.client.toPosition(document, params.endLine, params.endColumn ?? 1);
      const result = await routed.client.request<Array<Command | CodeAction> | null>(CodeActionRequest.method, {
        textDocument,
        range: { start: position, end },
        context: { diagnostics: [] },
      }, signal);
      return {
        text: formatCodeActions(result, manager.cwd, limit),
        details: { action: "code_actions", servers, resultCount: result?.length ?? 0, errorCount: 0 },
      };
    }
    default:
      throw new Error(`Unsupported LSP action: ${params.action}`);
  }
}

function resultCount(value: unknown): number {
  if (value === null || value === undefined) return 0;
  return Array.isArray(value) ? value.length : 1;
}


function formatStatus(status: ReturnType<ServerManager["status"]>): string {
  const lines = [
    `Configured servers: ${status.configured.length}`,
    ...status.configured.map((server) => `- ${server.id}: ${server.command} [${server.roles.join(", ")}]`),
    `Active clients: ${status.active.length}`,
    ...status.active.map((client) => `- ${client.server} @ ${client.root} (${client.state}, ${client.openDocuments} document(s))`),
  ];
  if (status.loadedFrom.length > 0) lines.push(`Config: ${status.loadedFrom.join(", ")}`);
  return lines.join("\n");
}

function requiredString(value: string | undefined, name: string, action: string): string {
  if (!value) throw new Error(`${action} requires ${name}`);
  return value;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
