import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

function baseMessage(model) {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function toolResultCount(context) {
  return context.messages.filter((message) => message.role === "toolResult").length;
}

function previewId(context) {
  const match = JSON.stringify(context.messages).match(/[a-f0-9]{64}/u);
  if (!match) throw new Error("packed smoke provider could not recover previewId from tool output");
  return match[0];
}

function scriptedStream(model, context) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    try {
      const output = baseMessage(model);
      const step = toolResultCount(context);
      const calls = [
        { name: "ast_grep_search", arguments: { path: "sample.ts", language: "typescript", pattern: "oldName($A)" } },
        { name: "ast_grep_edit", arguments: { action: "preview", path: "sample.ts", language: "typescript", pattern: "oldName($A)", rewrite: "newName($A)", previewId: null } },
        { name: "write", arguments: { path: "sample.ts", content: "// concurrent change\nconst value = oldName(first);\n" } },
        { name: "ast_grep_edit", arguments: { action: "apply", path: "sample.ts", language: "typescript", pattern: "oldName($A)", rewrite: "newName($A)", previewId: step >= 3 ? previewId(context) : "" } },
        { name: "write", arguments: { path: "sample.ts", content: "const value = oldName(first);\n" } },
        { name: "ast_grep_edit", arguments: { action: "apply", path: "sample.ts", language: "typescript", pattern: "oldName($A)", rewrite: "newName($A)", previewId: step >= 5 ? previewId(context) : "" } },
      ];
      stream.push({ type: "start", partial: output });
      const next = calls[step];
      if (next) {
        const call = { type: "toolCall", id: `packed-call-${step}`, name: next.name, arguments: next.arguments };
        output.content.push(call);
        output.stopReason = "toolUse";
        stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
        stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: output });
        stream.push({ type: "done", reason: "toolUse", message: output });
      } else {
        const text = { type: "text", text: "PACKED_PI_CLI_SMOKE_OK" };
        output.content.push(text);
        stream.push({ type: "text_start", contentIndex: 0, partial: output });
        stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial: output });
        stream.push({ type: "done", reason: "stop", message: output });
      }
      stream.end();
    } catch (error) {
      stream.end(error);
    }
  });
  return stream;
}

export default function packedSmokeProvider(pi) {
  pi.registerProvider("packed-smoke", {
    baseUrl: "http://127.0.0.1.invalid",
    apiKey: "$PACKED_SMOKE_API_KEY",
    api: "packed-smoke-api",
    models: [{
      id: "packed-smoke-model",
      name: "Packed Smoke Model",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 16_000,
      maxTokens: 1_000,
    }],
    streamSimple: scriptedStream,
  });
}
