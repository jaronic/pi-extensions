import type { PlanPhase } from "./state.ts";

const READ_ONLY_PLAN_TOOLS: Record<string, true> = {
  read: true,
  rg: true,
  grep: true,
  find: true,
  ls: true,
  lsp: true,
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
  if (toolName === "submit_plan" || toolName === "report_plan_blocked" || toolName === "request_plan_choice") return phase === "planning";
  if (toolName === "answer_plan_choice") return phase === "awaitingClarification";
  return Object.hasOwn(READ_ONLY_PLAN_TOOLS, toolName);
}

export function selectPlanTools(toolNames: string[], phase: PlanPhase): string[] {
  if (phase === "off" || phase === "executing") return [...new Set(toolNames)];
  const selected = toolNames.filter((toolName) => isPlanToolAllowed(toolName, phase));
  if (phase === "planning") selected.push("submit_plan", "report_plan_blocked", "request_plan_choice");
  if (phase === "awaitingClarification") selected.push("answer_plan_choice");
  return replaceGrepWithRg([...new Set(selected)]);
}
