import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import jaronEditor from "../src/index.ts";

test("does not register tools", () => {
  const registeredTools: unknown[] = [];
  const pi = {
    on: () => undefined,
    registerTool: (tool: unknown) => registeredTools.push(tool),
  } as unknown as ExtensionAPI;

  jaronEditor(pi);

  assert.deepEqual(registeredTools, []);
});
