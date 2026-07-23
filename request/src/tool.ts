import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  MAX_REQUEST_DESCRIPTION_CHARS,
  MAX_REQUEST_HEADER_CHARS,
  MAX_REQUEST_ID_CHARS,
  MAX_REQUEST_LABEL_CHARS,
  MAX_REQUEST_OPTIONS,
  MAX_REQUEST_PREVIEW_CHARS,
  MAX_REQUEST_QUESTION_CHARS,
  MAX_REQUEST_QUESTIONS,
  type RequestAnswer,
  type RequestDialogResult,
  type RequestQuestion,
} from "./request.ts";

const AskOptionParams = Type.Object({
  label: Type.String({ minLength: 1, maxLength: MAX_REQUEST_LABEL_CHARS, description: "Short option label" }),
  description: Type.Optional(Type.String({ maxLength: MAX_REQUEST_DESCRIPTION_CHARS, description: "Tradeoff or consequence shown below the label" })),
  preview: Type.Optional(Type.String({ maxLength: MAX_REQUEST_PREVIEW_CHARS, description: "Optional expanded preview for this option" })),
});

const AskQuestionParams = Type.Object({
  header: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_REQUEST_HEADER_CHARS, description: "Short navigation label" })),
  id: Type.String({ minLength: 1, maxLength: MAX_REQUEST_ID_CHARS, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", description: "Unique result identifier" }),
  multi: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options" })),
  options: Type.Array(AskOptionParams, {
    minItems: 1,
    maxItems: MAX_REQUEST_OPTIONS,
    description: "Distinct options in display order; Other is added automatically",
  }),
  question: Type.String({ minLength: 1, maxLength: MAX_REQUEST_QUESTION_CHARS, description: "Question shown to the user" }),
  recommended: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_REQUEST_OPTIONS - 1, description: "Zero-based recommended option index" })),
});

export const AskParams = Type.Object({
  i: Type.Optional(Type.String({ minLength: 1, maxLength: 120, description: "Concise intent for the request" })),
  questions: Type.Array(AskQuestionParams, {
    minItems: 1,
    maxItems: MAX_REQUEST_QUESTIONS,
    description: "One or more related questions",
  }),
});

export interface AskToolRuntime {
  ask(
    questions: readonly RequestQuestion[],
    ctx: ExtensionContext,
    signal?: AbortSignal,
  ): Promise<RequestDialogResult>;
}

export type AskToolDetails = RequestAnswer | { results: RequestAnswer[] };

function answerText(answer: RequestAnswer): string {
  const parts: string[] = [];
  if (answer.selectedOptions.length > 0) parts.push(answer.selectedOptions.join(", "));
  if (answer.customInput) parts.push(answer.customInput);
  return parts.join("; ") || "unanswered";
}

function modelVisibleResult(result: RequestDialogResult): string {
  if (result.results.length === 1) {
    const answer = result.results[0];
    if (!answer) return "User submitted no answer.";
    if (answer.customInput && answer.selectedOptions.length === 0) {
      return `User provided custom input: ${answer.customInput}`;
    }
    if (answer.selectedOptions.length > 0 && !answer.customInput) {
      return `User selected: ${answer.selectedOptions.join(", ")}`;
    }
    return `User answered: ${answerText(answer)}`;
  }
  return result.results.map((answer) => `${answer.id}: ${answerText(answer)}`).join("\n");
}

function toolDetails(result: RequestDialogResult): AskToolDetails {
  return result.results.length === 1 ? result.results[0]! : { results: result.results };
}

export function registerAskTool(pi: ExtensionAPI, runtime: AskToolRuntime): void {
  pi.registerTool({
    name: "ask",
    label: "Ask",
    description:
      "Ask the user one or more related questions in an interactive request UI. Use only when a material choice changes the implementation; options should be concise and distinct. Other is added automatically.",
    promptSnippet: "Interactive single- or multi-question user request",
    promptGuidelines: [
      "Use ask only when repository context cannot resolve a material user choice.",
      "Keep option labels short; put tradeoffs in description and detailed examples in preview.",
      "Group related questions in one ask call instead of serial prompts.",
    ],
    parameters: AskParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (ctx.mode !== "tui" || !ctx.hasUI) throw new Error("Ask requires Pi's interactive TUI.");
      const questions: RequestQuestion[] = params.questions.map((question, index) => ({
        id: question.id,
        header: question.header ?? `Question ${index + 1}`,
        question: question.question,
        multi: question.multi ?? false,
        options: question.options,
        recommended: question.recommended ?? 0,
        allowOther: true,
      }));
      const result = await runtime.ask(questions, ctx, signal);
      signal?.throwIfAborted();
      if (result.cancelled) throw new Error("Ask tool was cancelled by the user.");
      return {
        content: [{ type: "text", text: modelVisibleResult(result) }],
        details: toolDetails(result),
      };
    },
    renderCall(args, theme, context) {
      const count = args.questions.length;
      const lines = [theme.fg("toolTitle", theme.bold(`Ask ${count} question${count === 1 ? "" : "s"}`))];
      if (context.expanded) {
        for (const question of args.questions) {
          lines.push(theme.fg("accent", `[${question.id}]`) + theme.fg("muted", ` · options:${question.options.length}`));
          lines.push(theme.fg("text", question.question));
          for (let index = 0; index < question.options.length; index++) {
            const option = question.options[index];
            const recommended = index === (question.recommended ?? 0) ? theme.fg("accent", " (Recommended)") : "";
            lines.push(`  ${theme.fg("muted", "○")} ${option.label}${recommended}`);
            if (option.description) lines.push(`    ${theme.fg("dim", option.description)}`);
          }
        }
      }
      return new Text(lines.join("\n"), 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as AskToolDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? first.text : "", 0, 0);
      }
      const answers = "results" in details ? details.results : [details];
      const lines = answers.map((answer) => {
        const value = answerText(answer);
        const glyph = value === "unanswered" ? theme.fg("warning", "○") : theme.fg("success", "✓");
        return `${glyph} ${theme.fg("accent", answer.id)}: ${theme.fg("text", value)}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
