import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  MAX_PLAN_CHOICE_DESCRIPTION_CHARS,
  MAX_PLAN_CHOICE_LABEL_CHARS,
  MAX_PLAN_CHOICE_OPTIONS,
  MAX_PLAN_CHOICE_QUESTION_CHARS,
  MAX_PLAN_STEP_CHARS,
  MAX_PLAN_STEP_ID_CHARS,
  MAX_PLAN_STEPS,
  MAX_PLAN_SUMMARY_CHARS,
  MAX_PLAN_TEXT_CHARS,
  MIN_PLAN_CHOICE_OPTIONS,
} from "./state.ts";

export const SubmitPlanParams = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: MAX_PLAN_SUMMARY_CHARS, description: "Concise outcome and scope summary" }),
  plan: Type.String({ minLength: 1, maxLength: MAX_PLAN_TEXT_CHARS, description: "Complete Markdown implementation plan" }),
  steps: Type.Array(Type.String({ minLength: 1, maxLength: MAX_PLAN_STEP_CHARS }), {
    minItems: 1,
    maxItems: MAX_PLAN_STEPS,
    description: "Ordered, independently trackable execution steps",
  }),
});

const PlanChoiceOptionParams = Type.Object({
  label: Type.String({ minLength: 1, maxLength: MAX_PLAN_CHOICE_LABEL_CHARS, description: "Short label shown in the Plan choice dialog" }),
  description: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_PLAN_CHOICE_DESCRIPTION_CHARS, description: "Decision tradeoff or consequence" })),
});

export const RequestPlanChoiceParams = Type.Object({
  question: Type.String({ minLength: 1, maxLength: MAX_PLAN_CHOICE_QUESTION_CHARS, description: "Material planning decision that requires the user's choice" }),
  options: Type.Array(PlanChoiceOptionParams, {
    minItems: MIN_PLAN_CHOICE_OPTIONS,
    maxItems: MAX_PLAN_CHOICE_OPTIONS,
    description: "Distinct, selectable options in display order",
  }),
});

export const AnswerPlanChoiceParams = Type.Object({
  selection: Type.Integer({ minimum: 1, maximum: MAX_PLAN_CHOICE_OPTIONS, description: "One-based option number selected by the user" }),
});

export const UpdatePlanStepParams = Type.Object({
  id: Type.String({ minLength: 1, maxLength: MAX_PLAN_STEP_ID_CHARS, description: "Stable step ID returned by submit_plan" }),
  status: StringEnum(["pending", "inProgress", "completed", "blocked"] as const),
});
