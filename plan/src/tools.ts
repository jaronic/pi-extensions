import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { boundPlanText, renderPlan, summarizePlanState } from "./output.ts";
import {
  allPlanStepsComplete,
  requestPlanChoice,
  submitPlan,
  updatePlanStep,
  type PlanJournalEntry,
  type PlanState,
} from "./state.ts";
import {
  AnswerPlanChoiceParams,
  RequestPlanChoiceParams,
  SubmitPlanParams,
  UpdatePlanStepParams,
} from "./tool-schema.ts";

export interface PlanToolRuntime {
  getState(): PlanState | null;
  setState(next: PlanState): void;
  commitSubmittedPlan(
    current: PlanState,
    candidate: PlanState,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<PlanState>;
  persistActive(
    action: PlanJournalEntry["action"],
    ctx: ExtensionContext,
    willTriggerTurn: boolean,
    reason: string,
  ): void;
  answerChoiceAndQueue(selection: number, ctx: ExtensionContext): PlanState;
  approveAndQueue(ctx: ExtensionContext): void;
  refineAndQueue(ctx: ExtensionContext): void;
  transitionOff(action: "cancel" | "complete", ctx: ExtensionContext, reason: string): void;
}

export function registerPlanTools(pi: ExtensionAPI, runtime: PlanToolRuntime): void {
  pi.registerTool({
    name: "submit_plan",
    label: "Submit Plan",
    description:
      "Submit the complete read-only implementation plan for explicit user approval. This ends the planning turn without executing it.",
    promptSnippet: "Submit a complete read-only plan for explicit approval",
    promptGuidelines: [
      "Call submit_plan exactly once when research is complete; do not execute the plan in the same turn.",
      "Use ordered steps that can be tracked independently during execution.",
    ],
    parameters: SubmitPlanParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const current = runtime.getState();
      if (!current || current.phase !== "planning") {
        throw new Error("Plan mode is not in its planning phase.");
      }
      const responseState = await runtime.commitSubmittedPlan(current, submitPlan(current, params), ctx, signal);
      const text = `Plan submitted: ${responseState.summary ?? "draft"}. Review opens automatically after this turn settles. Use /plan review to reopen it, or /plan approve, /plan refine, or /plan cancel directly.`;
      const bounded = boundPlanText(text);
      return {
        content: [{ type: "text", text: bounded.text }],
        details: summarizePlanState(responseState, false, bounded.truncation),
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "request_plan_choice",
    label: "Request Plan Choice",
    description: "Pause read-only planning for a material user decision with 2 to 5 selectable options.",
    promptSnippet: "Request a material planning choice from the user",
    promptGuidelines: [
      "Resolve questions from repository evidence before asking the user.",
      "Use only for a material decision with distinct options that would change the submitted plan.",
      "Provide 2 to 5 concise options with tradeoffs in their descriptions.",
    ],
    parameters: RequestPlanChoiceParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const current = runtime.getState();
      if (!current || current.phase !== "planning") {
        throw new Error("Plan mode is not in its planning phase.");
      }
      const responseState = requestPlanChoice(current, params);
      runtime.setState(responseState);
      runtime.persistActive("clarify", ctx, false, "clarification-requested");
      const choiceText = ctx.mode === "tui"
        ? "Plan needs a user decision. The choice dialog opens after this turn settles."
        : `${renderPlan(responseState)}\n\nReply with one option number, then call answer_plan_choice.`;
      const bounded = boundPlanText(choiceText);
      return {
        content: [{ type: "text", text: bounded.text }],
        details: summarizePlanState(responseState, false, bounded.truncation),
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "answer_plan_choice",
    label: "Answer Plan Choice",
    description: "Record the user's one-based answer to a pending Plan choice and resume read-only planning.",
    promptSnippet: "Record the user's pending Plan choice",
    promptGuidelines: [
      "Use only after the user explicitly identifies one pending option number.",
      "Do not infer a choice from ambiguous text; ask the user to choose a number instead.",
    ],
    parameters: AnswerPlanChoiceParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const current = runtime.getState();
      if (!current || current.phase !== "awaitingClarification") {
        throw new Error("No Plan choice is awaiting an answer.");
      }
      const responseState = runtime.answerChoiceAndQueue(params.selection - 1, ctx);
      const selected = responseState.clarification?.options[params.selection - 1];
      if (!selected) throw new Error("Selected Plan choice was unexpectedly unavailable.");
      const bounded = boundPlanText(
        `Plan choice ${params.selection} recorded: ${selected.label}. Read-only planning resumes after this turn settles.`,
      );
      return {
        content: [{ type: "text", text: bounded.text }],
        details: summarizePlanState(responseState, false, bounded.truncation),
        terminate: true,
      };
    },
  });

  pi.registerTool({
    name: "update_plan_step",
    label: "Update Plan Step",
    description: "Update a tracked step while executing an approved plan.",
    promptSnippet: "Update approved plan-step progress",
    parameters: UpdatePlanStepParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const current = runtime.getState();
      if (!current || current.phase !== "executing") {
        throw new Error("No approved plan is currently executing.");
      }
      const next = updatePlanStep(current, params.id, params.status);
      runtime.setState(next);
      if (allPlanStepsComplete(next)) {
        runtime.transitionOff("complete", ctx, "completed-tools-restored");
        return {
          content: [{ type: "text", text: "All approved plan steps are complete; Plan mode exited." }],
          details: summarizePlanState(next, true),
        };
      }
      runtime.persistActive("step", ctx, false, "step-updated");
      const bounded = boundPlanText(renderPlan(next));
      return {
        content: [{ type: "text", text: bounded.text }],
        details: summarizePlanState(next, false, bounded.truncation),
      };
    },
  });
}
