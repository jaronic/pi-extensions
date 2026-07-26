import type { RequestService } from "pi-request-ui-dev";
import type { PlanClarification } from "./state.ts";

export async function requestPlanChoice(
  requestService: RequestService,
  clarification: PlanClarification,
): Promise<number | undefined> {
  const labels = new Map<string, number>();
  for (const [index, option] of clarification.options.entries()) {
    if (labels.has(option.label)) throw new Error("Plan choice option labels must be unique.");
    labels.set(option.label, index);
  }
  const result = await requestService.request([{
    id: "plan-choice",
    header: "Plan decision",
    question: clarification.question,
    multi: false,
    allowOther: false,
    options: clarification.options.map((option) => ({ label: option.label, description: option.description })),
    recommended: 0,
  }]);
  if (result.cancelled) return undefined;
  const selected = result.results[0]?.selectedOptions;
  if (!selected || selected.length !== 1) throw new Error("Plan choice returned an invalid selection.");
  const selection = labels.get(selected[0]!);
  if (selection === undefined) throw new Error("Plan choice returned an unknown option.");
  return selection;
}
