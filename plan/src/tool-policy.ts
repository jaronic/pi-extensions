import type { PlanPhase } from "./state.ts";

const READ_ONLY_PLAN_TOOLS: Record<string, true> = {
  read: true,
  rg: true,
  grep: true,
  find: true,
  ls: true,
  lsp: true,
  ast_grep_search: true,
  questionnaire: true,
  ask: true,
  create_goal: true,
  get_goal: true,
};

function replaceGrepWithRg(toolNames: string[]): string[] {
  if (!toolNames.includes("rg") || !toolNames.includes("grep")) return toolNames;
  const replacement: string[] = [];
  let inserted = false;
  for (const name of toolNames) {
    if (name === "rg" || name === "grep") {
      if (!inserted) replacement.push("rg");
      inserted = true;
    } else {
      replacement.push(name);
    }
  }
  return replacement;
}

export function isPlanToolAllowed(toolName: string, phase: PlanPhase): boolean {
  if (phase === "off" || phase === "executing") return true;
  if (toolName === "submit_plan" || toolName === "report_plan_blocked") return phase === "planning";
  return Object.hasOwn(READ_ONLY_PLAN_TOOLS, toolName);
}

export function selectPlanTools(toolNames: string[], phase: PlanPhase): string[] {
  if (phase === "off" || phase === "executing") return [...new Set(toolNames)];
  const selected = toolNames.filter((toolName) => isPlanToolAllowed(toolName, phase));
  if (phase === "planning") selected.push("submit_plan", "report_plan_blocked");
  return replaceGrepWithRg([...new Set(selected)]);
}
