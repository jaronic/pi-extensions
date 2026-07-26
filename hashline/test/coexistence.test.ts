import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import lspExtension from "../../lsp/src/index.ts";
import planExtension from "../../plan/src/index.ts";
import { ExtensionHarness, InMemoryPlanArtifactStore } from "../../plan/test/harness.ts";
import rgExtension from "../../rg/src/index.ts";
import hashlineExtension from "../src/index.ts";

function registerPlan(harness: ExtensionHarness): void {
  planExtension(harness.api, { artifactStore: new InMemoryPlanArtifactStore() });
}

for (const hashlineFirst of [true, false]) {
  test(`Hashline definitions survive Plan, LSP, and RG lifecycle (${hashlineFirst ? "Hashline first" : "Hashline last"})`, async () => {
    const harness = new ExtensionHarness();
    if (hashlineFirst) hashlineExtension(harness.api);
    registerPlan(harness);
    lspExtension(harness.api as never);
    rgExtension(harness.api);
    if (!hashlineFirst) hashlineExtension(harness.api);

    const readDefinition = harness.toolDefinition("read");
    const editDefinition = harness.toolDefinition("edit");
    assert.ok(readDefinition && typeof readDefinition === "object" && "description" in readDefinition);
    assert.ok(editDefinition && typeof editDefinition === "object" && "description" in editDefinition);
    assert.match(String(readDefinition.description), /branch-local SHA-256 snapshot/);
    assert.match(String(editDefinition.description), /previously read lines/);
    assert.equal("label" in readDefinition && readDefinition.label, "Hashline read");
    assert.equal("label" in editDefinition && editDefinition.label, "Hashline edit");
    const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as never;
    const context = { lastComponent: undefined } as never;
    const readCall = (readDefinition as ToolDefinition).renderCall?.({ path: "fixture.txt" } as never, theme, context).render(120).join("\n");
    const editCall = (editDefinition as ToolDefinition).renderCall?.({ path: "fixture.txt" } as never, theme, context).render(120).join("\n");
    assert.match(readCall ?? "", /Hashline.*read.*fixture\.txt/);
    assert.match(editCall ?? "", /Hashline.*edit.*fixture\.txt/);
    assert.ok("renderCall" in editDefinition && typeof editDefinition.renderCall === "function");
    assert.ok("renderResult" in editDefinition && typeof editDefinition.renderResult === "function");

    await harness.emit("session_start", { type: "session_start", reason: "startup" });
    assert.equal(harness.toolDefinition("read"), readDefinition);
    assert.equal(harness.toolDefinition("edit"), editDefinition);
    assert.ok(harness.getActiveTools().includes("rg"));
    assert.ok(harness.getActiveTools().includes("lsp"));

    await harness.command("plan");
    assert.ok(harness.getActiveTools().includes("read"));
    assert.equal(harness.getActiveTools().includes("edit"), false);
    assert.equal(harness.toolDefinition("read"), readDefinition);
    assert.equal(harness.toolDefinition("edit"), editDefinition);

    await harness.command("plan", "cancel");
    assert.ok(harness.getActiveTools().includes("edit"));
    assert.equal(harness.toolDefinition("read"), readDefinition);
    assert.equal(harness.toolDefinition("edit"), editDefinition);
    await harness.emit("session_shutdown", { type: "session_shutdown" });
  });
}

test("same-name overrides obey observable last-loaded ownership", () => {
  const replacementRead = {
    name: "read",
    label: "replacement read",
    description: "replacement read owner",
    parameters: Type.Object({ path: Type.String() }),
    async execute() {
      return { content: [{ type: "text" as const, text: "replacement" }], details: undefined };
    },
  };
  const replacementEdit = {
    name: "edit",
    label: "replacement edit",
    description: "replacement edit owner",
    parameters: Type.Object({ path: Type.String() }),
    async execute() {
      return { content: [{ type: "text" as const, text: "replacement" }], details: undefined };
    },
  };

  const replacementLast = new ExtensionHarness();
  hashlineExtension(replacementLast.api);
  replacementLast.api.registerTool(replacementRead);
  replacementLast.api.registerTool(replacementEdit);
  assert.equal(replacementLast.toolDefinition("read"), replacementRead);
  assert.equal(replacementLast.toolDefinition("edit"), replacementEdit);

  const hashlineLast = new ExtensionHarness();
  hashlineLast.api.registerTool(replacementRead);
  hashlineLast.api.registerTool(replacementEdit);
  hashlineExtension(hashlineLast.api);
  assert.notEqual(hashlineLast.toolDefinition("read"), replacementRead);
  assert.notEqual(hashlineLast.toolDefinition("edit"), replacementEdit);
  const read = hashlineLast.toolDefinition("read");
  assert.ok(read && typeof read === "object" && "description" in read);
  assert.match(String(read.description), /branch-local SHA-256 snapshot/);
});
