import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGrepToolDefinition } from "@earendil-works/pi-coding-agent";

const grepDefinition = createGrepToolDefinition(process.cwd());

export function prioritizeRgOverGrep(toolNames: readonly string[]): string[] {
  const prioritized = [...new Set(toolNames)];
  const rgIndex = prioritized.indexOf("rg");
  const grepIndex = prioritized.indexOf("grep");
  if (rgIndex < 0 || grepIndex < 0 || rgIndex < grepIndex) return prioritized;

  prioritized.splice(rgIndex, 1);
  prioritized.splice(prioritized.indexOf("grep"), 0, "rg");
  return prioritized;
}

export default function rgExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "rg",
    label: "rg",
    description:
      "Primary file-content search powered by ripgrep. Returns matching lines with file paths and line numbers, respects .gitignore, and supports regex, literal, glob, case, context, and result-limit controls.",
    promptSnippet: "Primary ripgrep file-content search; use before grep",
    promptGuidelines: [
      "When both rg and grep are active, use rg first for file-content searches.",
      "Use grep only when rg is unavailable or an rg call fails.",
    ],
    parameters: grepDefinition.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const definition = createGrepToolDefinition(ctx.cwd);
      return definition.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });

  const applyPriority = (): void => {
    const current = pi.getActiveTools();
    const prioritized = prioritizeRgOverGrep(current);
    if (prioritized.some((name, index) => name !== current[index])) pi.setActiveTools(prioritized);
  };

  pi.on("session_start", applyPriority);
  pi.on("session_tree", applyPriority);
}
