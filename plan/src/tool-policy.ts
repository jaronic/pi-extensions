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

function prioritizeRgOverGrep(toolNames: string[]): string[] {
  const rgIndex = toolNames.indexOf("rg");
  const grepIndex = toolNames.indexOf("grep");
  if (rgIndex < 0 || grepIndex < 0 || rgIndex < grepIndex) return toolNames;
  toolNames.splice(rgIndex, 1);
  toolNames.splice(toolNames.indexOf("grep"), 0, "rg");
  return toolNames;
}

export function isPlanToolAllowed(toolName: string, phase: PlanPhase): boolean {
  if (phase === "off" || phase === "executing") return true;
  if (toolName === "submit_plan" || toolName === "request_plan_choice") return phase === "planning";
  if (toolName === "answer_plan_choice") return phase === "awaitingClarification";
  return Object.hasOwn(READ_ONLY_PLAN_TOOLS, toolName);
}

export function selectPlanTools(toolNames: string[], phase: PlanPhase): string[] {
  if (phase === "off" || phase === "executing") return [...new Set(toolNames)];
  const selected = toolNames.filter((toolName) => isPlanToolAllowed(toolName, phase));
  if (phase === "planning") selected.push("submit_plan", "request_plan_choice");
  if (phase === "awaitingClarification") selected.push("answer_plan_choice");
  return prioritizeRgOverGrep([...new Set(selected)]);
}
