import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createGrepToolDefinition } from "@earendil-works/pi-coding-agent";
import { reuseTextComponent, tone } from "pi-uikit-dev";
import { renderGrepOutput } from "./result-renderer.ts";

const grepDefinition = createGrepToolDefinition(process.cwd());
type GrepRenderResult = Parameters<NonNullable<typeof grepDefinition.renderResult>>[0];

export function replaceGrepWithRg(toolNames: readonly string[]): string[] {
  const unique = [...new Set(toolNames)];
  if (!unique.includes("rg") || !unique.includes("grep")) return unique;
  const replacement: string[] = [];
  let inserted = false;
  for (const name of unique) {
    if (name === "rg" || name === "grep") {
      if (!inserted) replacement.push("rg");
      inserted = true;
    } else {
      replacement.push(name);
    }
  }
  return replacement;
}

function displayValue(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  return JSON.stringify(value).slice(1, -1);
}

export default function rgExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "rg",
    label: "rg",
    description:
      "File-content search alias for Pi's ripgrep-backed grep engine. Returns matching lines with paths and line numbers, respects .gitignore, and supports regex, literal, glob, case, context, and result-limit controls.",
    promptSnippet: "Ripgrep-backed file-content search",
    promptGuidelines: [
      "Use rg for file-content searches. It shares Pi's grep execution path, so retrying the same request as grep is not a fallback.",
    ],
    parameters: grepDefinition.parameters,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const definition = createGrepToolDefinition(ctx.cwd);
      return definition.execute(toolCallId, params, signal, onUpdate, ctx);
    },
    renderCall(args, theme, context) {
      const pattern = displayValue(args.pattern, "?");
      const path = displayValue(args.path, ".");
      const glob = args.glob === undefined ? "" : ` (${displayValue(args.glob, "?")})`;
      const limit = args.limit === undefined ? "" : ` limit ${String(args.limit)}`;
      return reuseTextComponent(
        context.lastComponent,
        tone(theme, "title", "rg") +
        " " +
        tone(theme, "accent", `/${pattern}/`) +
        tone(theme, "output", ` in ${path}${glob}${limit}`),
      );
    },
    renderResult(result, options, theme, context) {
      // Grep execution remains byte-for-byte unchanged; only its text presentation is grouped.
      const grepResult = result as GrepRenderResult;
      const output = grepResult.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .trim();
      return renderGrepOutput(output, { expanded: options.expanded, isError: context.isError }, theme);
    },
  });

  let replacementActive = false;
  const applyReplacement = (): void => {
    const current = pi.getActiveTools();
    const replacement = replaceGrepWithRg(current);
    if (current.includes("rg") && current.includes("grep")) replacementActive = true;
    if (replacement.length !== current.length || replacement.some((name, index) => name !== current[index])) {
      pi.setActiveTools(replacement);
    }
  };
  const restoreGrep = (): void => {
    if (!replacementActive) return;
    replacementActive = false;
    const current = [...new Set(pi.getActiveTools())];
    const rgIndex = current.indexOf("rg");
    if (rgIndex < 0 || current.includes("grep")) return;
    current.splice(rgIndex, 1, "grep");
    pi.setActiveTools(current);
  };

  pi.on("session_start", applyReplacement);
  pi.on("session_tree", applyReplacement);
  pi.on("session_shutdown", restoreGrep);
}
