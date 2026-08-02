import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";

const mode = process.argv[2] ?? "normal";
const notificationLogPath = mode === "document-content" ? process.argv[3] : undefined;

if (mode === "stubborn-tree") {
  const pidPath = process.argv[3];
  const heartbeatPath = process.argv[4];
  if (!pidPath || !heartbeatPath) throw new Error("stubborn-tree mode requires PID and heartbeat paths");
  const heartbeat = () => appendFileSync(heartbeatPath, `${process.pid}\n`);
  process.on("SIGTERM", () => {});
  const grandchild = spawn(process.execPath, [
    "-e",
    "const { appendFileSync } = require('node:fs'); const heartbeatPath = process.argv[1]; const heartbeat = () => appendFileSync(heartbeatPath, `${process.pid}\\n`); heartbeat(); setInterval(heartbeat, 10); process.on('SIGTERM', () => {});",
    heartbeatPath,
  ], { stdio: "ignore" });
  heartbeat();
  writeFileSync(pidPath, JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }));
  setInterval(heartbeat, 10);
}
const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);
const documents = new Map();

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const recordDocumentNotification = (method, text) => {
  if (notificationLogPath) appendFileSync(notificationLogPath, `${JSON.stringify({ method, text })}\n`);
};
const diagnostic = (message) => ({
  range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } },
  severity: 2,
  source: "fake-lsp",
  message,
});

connection.onRequest("initialize", async () => {
  if (mode === "crash-initialize") {
    process.stderr.write("synthetic initialize crash\n");
    process.exit(17);
  }
  if (mode === "delay-initialize") await delay(150);
  if (mode === "stderr-spam") {
    for (let index = 0; index < 60; index += 1) {
      process.stderr.write(`stderr-${index} ${"x".repeat(1_100)}\n`);
    }
  }
  const capabilities = {
    positionEncoding: "utf-8",
    textDocumentSync: { openClose: true, change: 1 },
    definitionProvider: true,
    typeDefinitionProvider: true,
    implementationProvider: true,
    referencesProvider: true,
    hoverProvider: mode !== "unsupported",
    documentSymbolProvider: true,
    workspaceSymbolProvider: true,
    renameProvider: true,
    codeActionProvider: true,
  };
  return { capabilities };
});

connection.onNotification("textDocument/didOpen", async ({ textDocument }) => {
  documents.set(textDocument.uri, textDocument.text);
  recordDocumentNotification("didOpen", textDocument.text);
  if (mode === "no-diagnostics") return;
  if (mode === "stale-diagnostics") {
    // Publish the current version first, then a late notification for an
    // older version: the client must keep the newer diagnostics cached.
    await connection.sendNotification("textDocument/publishDiagnostics", {
      uri: textDocument.uri,
      version: textDocument.version + 1,
      diagnostics: [diagnostic("current diagnostic")],
    });
    setTimeout(() => {
      void connection.sendNotification("textDocument/publishDiagnostics", {
        uri: textDocument.uri,
        version: textDocument.version,
        diagnostics: [diagnostic("stale diagnostic")],
      });
    }, 50);
    return;
  }
  if (mode === "stale-only-diagnostics") {
    // Publish only a version older than the client's document version; the
    // client must treat it as stale and never expose it as diagnostics.
    await connection.sendNotification("textDocument/publishDiagnostics", {
      uri: textDocument.uri,
      version: textDocument.version - 1,
      diagnostics: [diagnostic("stale diagnostic")],
    });
    return;
  }
  await connection.sendNotification("textDocument/publishDiagnostics", {
    uri: textDocument.uri,
    version: textDocument.version,
    diagnostics: [diagnostic("synthetic diagnostic")],
  });
  if (mode === "multi-diagnostics") {
    setTimeout(() => {
      void connection.sendNotification("textDocument/publishDiagnostics", {
        uri: textDocument.uri,
        version: textDocument.version,
        diagnostics: [diagnostic("settled diagnostic")],
      });
    }, 10);
  }
});

connection.onNotification("textDocument/didChange", ({ textDocument, contentChanges }) => {
  const replacement = contentChanges.at(-1)?.text;
  if (typeof replacement === "string") {
    documents.set(textDocument.uri, replacement);
    recordDocumentNotification("didChange", replacement);
  }
});

connection.onRequest("textDocument/definition", ({ textDocument }) => ({
  uri: textDocument.uri,
  range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } },
}));
connection.onRequest("textDocument/typeDefinition", ({ textDocument }) => ({
  uri: textDocument.uri,
  range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } },
}));
connection.onRequest("textDocument/implementation", ({ textDocument }) => ({
  uri: textDocument.uri,
  range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } },
}));
connection.onRequest("textDocument/references", ({ textDocument }) => [
  { uri: textDocument.uri, range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } } },
  { uri: textDocument.uri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } },
]);
connection.onRequest("textDocument/hover", async (_params, token) => {
  if (mode === "document-content") {
    return { contents: { kind: "plaintext", value: documents.get(_params.textDocument.uri) ?? "<missing>" } };
  }
  if (mode === "crash-hover") {
    process.stderr.write("synthetic hover crash\n");
    process.exit(19);
  }
  if (mode === "hang-hover" || mode === "never-hover") {
    return await new Promise((resolve) => {
      if (mode === "hang-hover") {
        token.onCancellationRequested(() => {
          process.stderr.write("hover request cancelled\n");
          resolve({ contents: { kind: "plaintext", value: "cancelled" } });
        });
      }
    });
  }
  if (mode === "oversized-hover") {
    return { contents: { kind: "markdown", value: "x".repeat(80_000) } };
  }
  return { contents: { kind: "markdown", value: "`alpha: string`" } };
});
connection.onRequest("textDocument/documentSymbol", ({ textDocument }) => [{
  name: "alpha",
  kind: 13,
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 9 } },
  selectionRange: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } },
  uri: textDocument.uri,
}]);
connection.onRequest("workspace/symbol", () => []);
connection.onRequest("textDocument/codeAction", () => [{ title: "Synthetic action", kind: "quickfix" }]);
connection.onRequest("textDocument/rename", ({ textDocument, newName }) => {
  if (mode === "many-rename") {
    return {
      documentChanges: [{
        textDocument: { uri: textDocument.uri, version: 1 },
        edits: Array.from({ length: 300 }, (_, index) => ({
          range: { start: { line: index, character: 0 }, end: { line: index, character: 1 } },
          newText: `${newName}${"x".repeat(220)}__TAIL_MARKER_${index}`,
        })),
      }],
    };
  }
  return {
    changes: {
      [textDocument.uri]: [
        { range: { start: { line: 0, character: 4 }, end: { line: 0, character: 9 } }, newText: newName },
        { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } }, newText: newName },
      ],
    },
  };
});
connection.onRequest("shutdown", () => mode === "ignore-shutdown" || mode === "stubborn-tree" ? new Promise(() => {}) : null);
connection.onNotification("exit", () => {
  if (mode !== "stubborn-tree") setImmediate(() => process.exit(0));
});
connection.listen();
