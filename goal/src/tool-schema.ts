import { Type } from "typebox";
import { MAX_GOAL_OBJECTIVE_CHARS } from "./state.ts";

export const CreateGoalParams = Type.Object({
  objective: Type.String({ minLength: 1, maxLength: MAX_GOAL_OBJECTIVE_CHARS, description: "Concrete long-running objective explicitly requested by the user" }),
  tokenBudget: Type.Optional(
    Type.Integer({ minimum: 1, description: "Optional token budget, only when explicitly requested" }),
  ),
});
export const MAX_COMPLETION_EVIDENCE_ITEMS = 25;
export const MAX_BLOCKER_ATTEMPTS = 20;
export const MAX_EVIDENCE_REQUIREMENT_CHARS = 500;
export const MAX_EVIDENCE_DESCRIPTION_CHARS = 1_500;
export const MAX_BLOCKER_TEXT_CHARS = 2_000;
export const MAX_BLOCKER_ATTEMPT_CHARS = 1_000;

const CompletionEvidenceItem = Type.Object({
  requirement: Type.String({
    minLength: 1,
    maxLength: MAX_EVIDENCE_REQUIREMENT_CHARS,
    description: "One explicit objective requirement or acceptance criterion",
  }),
  evidence: Type.String({
    minLength: 1,
    maxLength: MAX_EVIDENCE_DESCRIPTION_CHARS,
    description: "Concrete current-state evidence that verifies this requirement",
  }),
}, { additionalProperties: false });


export const UpdateGoalParams = Type.Union([
  Type.Object({
    status: Type.Literal("complete"),
    evidence: Type.Array(CompletionEvidenceItem, {
      minItems: 1,
      maxItems: MAX_COMPLETION_EVIDENCE_ITEMS,
      description: "Prompt-to-artifact checklist mapping every objective requirement to current evidence",
    }),
  }, { additionalProperties: false }),
  Type.Object({
    status: Type.Literal("blocked"),
    reason: Type.String({
      minLength: 1,
      maxLength: MAX_BLOCKER_TEXT_CHARS,
      description: "Specific user input or external condition preventing further progress",
    }),
    attempted: Type.Array(Type.String({ minLength: 1, maxLength: MAX_BLOCKER_ATTEMPT_CHARS }), {
      minItems: 1,
      maxItems: MAX_BLOCKER_ATTEMPTS,
      description: "Concrete actions already attempted before declaring the impasse",
    }),
    unblocksWhen: Type.String({
      minLength: 1,
      maxLength: MAX_BLOCKER_TEXT_CHARS,
      description: "Exact input or external state change required to resume progress",
    }),
  }, { additionalProperties: false }),
], { description: "Evidence-bearing terminal transition for the active Goal" });
