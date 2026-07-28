import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createGoal,
  formatElapsed,
  normalizeTokenBudget,
  setGoalStatus,
  type GoalJournalEntry,
  type GoalState,
} from "./state.ts";
import {
  CreateGoalParams,
  MAX_BLOCKER_ATTEMPT_CHARS,
  MAX_BLOCKER_ATTEMPTS,
  MAX_BLOCKER_TEXT_CHARS,
  MAX_COMPLETION_EVIDENCE_ITEMS,
  MAX_EVIDENCE_DESCRIPTION_CHARS,
  MAX_EVIDENCE_REQUIREMENT_CHARS,
  UpdateGoalParams,
} from "./tool-schema.ts";

export interface GoalToolRuntime {
  getGoal(): GoalState | null;
  isPlanActive(ctx: ExtensionContext): boolean;
  setGoal(next: GoalState | null, action: GoalJournalEntry["action"], ctx: ExtensionContext): GoalState | null;
  queueContinuation(ctx: ExtensionContext): void;
}
interface CompletionEvidenceItem {
  requirement: string;
  evidence: string;
}

type ValidatedGoalUpdate =
  | { status: "complete"; evidence: CompletionEvidenceItem[] }
  | { status: "blocked"; reason: string; attempted: string[]; unblocksWhen: string };

function requiredText(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must not be empty.`);
  const text = value.trim();
  if ([...text].length > maxChars) throw new Error(`${label} exceeds the ${maxChars} character limit.`);
  return text;
}

function validateGoalUpdate(value: unknown): ValidatedGoalUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("status" in value)) {
    throw new Error("Goal update must be a complete or blocked transition.");
  }
  if (value.status === "complete") {
    const evidence = "evidence" in value ? value.evidence : undefined;
    if (!Array.isArray(evidence) || evidence.length === 0 || evidence.length > MAX_COMPLETION_EVIDENCE_ITEMS) {
      throw new Error(`Goal completion requires 1 to ${MAX_COMPLETION_EVIDENCE_ITEMS} requirement-to-evidence entries.`);
    }
    return {
      status: "complete",
      evidence: evidence.map((item, index) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw new Error(`Completion evidence ${index + 1} must be an object.`);
        }
        return {
          requirement: requiredText(
            "requirement" in item ? item.requirement : undefined,
            `Completion evidence ${index + 1} requirement`,
            MAX_EVIDENCE_REQUIREMENT_CHARS,
          ),
          evidence: requiredText(
            "evidence" in item ? item.evidence : undefined,
            `Completion evidence ${index + 1} evidence`,
            MAX_EVIDENCE_DESCRIPTION_CHARS,
          ),
        };
      }),
    };
  }
  if (value.status === "blocked") {
    const attempted = "attempted" in value ? value.attempted : undefined;
    if (!Array.isArray(attempted) || attempted.length === 0 || attempted.length > MAX_BLOCKER_ATTEMPTS) {
      throw new Error(`A blocked Goal requires 1 to ${MAX_BLOCKER_ATTEMPTS} attempted actions.`);
    }
    return {
      status: "blocked",
      reason: requiredText("reason" in value ? value.reason : undefined, "Blocker reason", MAX_BLOCKER_TEXT_CHARS),
      attempted: attempted.map((attempt, index) => requiredText(
        attempt,
        `Blocked attempt ${index + 1}`,
        MAX_BLOCKER_ATTEMPT_CHARS,
      )),
      unblocksWhen: requiredText(
        "unblocksWhen" in value ? value.unblocksWhen : undefined,
        "Unblocking condition",
        MAX_BLOCKER_TEXT_CHARS,
      ),
    };
  }
  throw new Error("Goal update status must be complete or blocked.");
}

export function registerGoalTools(pi: ExtensionAPI, runtime: GoalToolRuntime): void {
  pi.registerTool({
    name: "create_goal",
    label: "Create Goal",
    description:
      "Create a long-running goal only when the user explicitly requests goal mode. Never infer a goal from an ordinary task.",
    promptSnippet: "Create an explicitly requested long-running thread goal",
    promptGuidelines: [
      "Use create_goal only when the user explicitly asks to create or replace a long-running goal.",
      "Write a durable objective with concrete outcomes, constraints, verification evidence, and a blocked stop condition.",
    ],
    parameters: CreateGoalParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (runtime.isPlanActive(ctx)) {
        throw new Error("Goal cannot start while Plan mode is active. Approve or cancel Plan first.");
      }
      const current = runtime.getGoal();
      if (current && current.status !== "complete") {
        throw new Error("An unfinished goal already exists. Ask the user to clear or replace it.");
      }
      const next = createGoal(params.objective, normalizeTokenBudget(params.tokenBudget));
      const applied = runtime.setGoal(next, "set", ctx);
      runtime.queueContinuation(ctx);
      return { content: [{ type: "text", text: JSON.stringify({ goal: applied }, null, 2) }], details: { goal: applied } };
    },
  });

  pi.registerTool({
    name: "get_goal",
    label: "Get Goal",
    description: "Read the active thread goal and usage state only when it is absent from current context.",
    promptSnippet: "Read goal state only when current context does not already include it",
    promptGuidelines: ["Do not call get_goal at the start of a turn when the injected Goal state is already present."],
    parameters: Type.Object({}),
    async execute() {
      const goal = runtime.getGoal();
      return { content: [{ type: "text", text: JSON.stringify({ goal }, null, 2) }], details: { goal } };
    },
  });

  pi.registerTool({
    name: "update_goal",
    label: "Update Goal",
    description:
      "Mark the active goal complete with requirement-to-evidence proof, or blocked with a concrete impasse report requiring user input or external change.",
    promptSnippet: "Finish a verified goal or report a genuine external impasse",
    promptGuidelines: [
      "Use complete only after a prompt-to-artifact audit verifies every objective requirement; provide concise evidence entries for all requirements.",
      "Use blocked only when progress requires specific user input or an external state change; provide the reason, attempted actions, and exact unblocking condition.",
      "Never use either terminal status because work is difficult, slow, uncertain, incomplete, or near its budget.",
    ],
    parameters: UpdateGoalParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const current = runtime.getGoal();
      if (!current || current.status !== "active") {
        throw new Error("No active goal is available to update.");
      }
      const update = validateGoalUpdate(params);
      const next = setGoalStatus(current, update.status);
      const applied = runtime.setGoal(next, "status", ctx);
      const transitionDetails = update.status === "complete"
        ? { completionEvidence: update.evidence }
        : { blocker: { reason: update.reason, attempted: update.attempted, unblocksWhen: update.unblocksWhen } };
      const details = { goal: applied, ...transitionDetails };
      const serialized = JSON.stringify(details, null, 2);
      const report = update.status === "complete" && applied
        ? `Goal completed in ${formatElapsed(applied.timeUsedSeconds)}.\n\n${serialized}`
        : serialized;
      return { content: [{ type: "text", text: report }], details };

    },
  });
}
