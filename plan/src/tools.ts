import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { boundPlanText, renderPlan, renderPlanStepUpdate, summarizePlanState } from "./output.ts";
import {
  reportPlanBlocked,
  submitPlan,
  type PlanJournalEntry,
  type PlanState,
  type PlanStepProgress,
  type PlanStepStatus,
} from "./state.ts";
import {
  SubmitPlanParams,
  ReportPlanBlockedParams,
  UpdatePlanStepParams,
} from "./tool-schema.ts";

export interface PlanToolRuntime {
  getState(): PlanState | null;
  commitSubmittedPlan(
    current: PlanState,
    candidate: PlanState,
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<PlanState>;
  commitPlanBlocker(current: PlanState, candidate: PlanState, ctx: ExtensionContext): PlanState;
  persistActive(
    action: PlanJournalEntry["action"],
    ctx: ExtensionContext,
    willTriggerTurn: boolean,
    reason: string,
  ): void;
  updateStep(
    requestId: string,
    id: string,
    status: PlanStepStatus,
    signal: AbortSignal | undefined,
    ctx: ExtensionContext,
  ): Promise<{ state: PlanState; progress: readonly PlanStepProgress[]; complete: boolean }>;
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
    name: "report_plan_blocked",
    label: "Report Plan Blocked",
    description: "Record evidence that no approvable implementation plan can yet be formed and state the user prerequisites or viable alternatives.",
    promptSnippet: "Report that an approvable Plan cannot yet be formed",
    promptGuidelines: [
      "Call report_plan_blocked exactly once only when proportionate read-only investigation proves that an approvable implementation plan cannot yet be formed.",
      "Include verified blocking facts, the evidence sources consulted, and concrete prerequisite or alternative paths for the user.",
      "Do not submit an executable plan when the required preconditions remain unavailable.",
    ],
    parameters: ReportPlanBlockedParams,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const current = runtime.getState();
      if (!current || current.phase !== "planning") {
        throw new Error("Plan mode is not in its planning phase.");
      }
      const responseState = runtime.commitPlanBlocker(current, reportPlanBlocked(current, params), ctx);
      const bounded = boundPlanText(renderPlan(responseState));
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
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      const current = runtime.getState();
      if (!current || current.phase !== "executing") {
        throw new Error("No approved plan is currently executing.");
      }
      const updated = await runtime.updateStep(toolCallId, params.id, params.status, signal, ctx);
      return {
        content: [{ type: "text", text: renderPlanStepUpdate(updated.state, params.id, updated.progress) }],
        details: summarizePlanState(updated.state, updated.complete, undefined, updated.progress),
      };
    },
  });
}
