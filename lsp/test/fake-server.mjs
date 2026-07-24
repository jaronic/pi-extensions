import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";

const mode = process.argv[2] ?? "normal";

if (mode === "stubborn-tree") {
  process.on("SIGTERM", () => {});
  const grandchild = spawn(process.execPath, [
    "-e",
    "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
  ], { stdio: "ignore" });
  const pidPath = process.argv[3];
  if (!pidPath) throw new Error("stubborn-tree mode requires a PID path");
  writeFileSync(pidPath, JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }));
  setInterval(() => {}, 1_000);
}
const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);
const documents = new Map();

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
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
  if (mode === "no-diagnostics") return;
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
  if (typeof replacement === "string") documents.set(textDocument.uri, replacement);
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
