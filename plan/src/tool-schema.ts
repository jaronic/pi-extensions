import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  MAX_PLAN_CHOICE_DESCRIPTION_CHARS,
  MAX_PLAN_CHOICE_LABEL_CHARS,
  MAX_PLAN_CHOICE_OPTIONS,
  MAX_PLAN_CHOICE_QUESTION_CHARS,
  MAX_PLAN_STEP_CHARS,
  MAX_PLAN_STEPS,
  MAX_PLAN_SUMMARY_CHARS,
  MAX_PLAN_TEXT_CHARS,
  MIN_PLAN_CHOICE_OPTIONS,
  MAX_PLAN_BLOCKER_DESCRIPTION_CHARS,
  MAX_PLAN_BLOCKER_LABEL_CHARS,
  MAX_PLAN_BLOCKER_RESOLUTIONS,
  MAX_PLAN_BLOCKER_SUMMARY_CHARS,
  MAX_PLAN_BLOCKING_FACT_CHARS,
  MAX_PLAN_BLOCKING_FACTS,
  MAX_PLAN_EVIDENCE_SOURCE_CHARS,
  MAX_PLAN_EVIDENCE_SOURCES,
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

const PlanBlockerResolutionParams = Type.Object({
  kind: StringEnum(["prerequisite", "alternative"] as const),
  label: Type.String({ minLength: 1, maxLength: MAX_PLAN_BLOCKER_LABEL_CHARS, description: "Short prerequisite or alternative label" }),
  description: Type.String({ minLength: 1, maxLength: MAX_PLAN_BLOCKER_DESCRIPTION_CHARS, description: "What the user must provide or what the alternative changes" }),
});

export const ReportPlanBlockedParams = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: MAX_PLAN_BLOCKER_SUMMARY_CHARS, description: "Concise reason an approvable implementation plan cannot yet be formed" }),
  blockingFacts: Type.Array(Type.String({ minLength: 1, maxLength: MAX_PLAN_BLOCKING_FACT_CHARS }), {
    minItems: 1,
    maxItems: MAX_PLAN_BLOCKING_FACTS,
    description: "Verified facts that block an approvable implementation plan",
  }),
  evidenceSources: Type.Array(Type.String({ minLength: 1, maxLength: MAX_PLAN_EVIDENCE_SOURCE_CHARS }), {
    minItems: 1,
    maxItems: MAX_PLAN_EVIDENCE_SOURCES,
    description: "Repository, configuration, test, tool, or user-context sources consulted",
  }),
  resolutions: Type.Array(PlanBlockerResolutionParams, {
    minItems: 1,
    maxItems: MAX_PLAN_BLOCKER_RESOLUTIONS,
    description: "Required user prerequisites or viable alternative directions",
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

