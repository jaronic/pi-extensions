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
  sanitizeTerminalText,
  type RequestAnswer,
  type RequestDialogResult,
  type RequestQuestion,
} from "./request.ts";

const SAFE_MULTILINE_PATTERN = "^[^\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]*$";
const SAFE_SINGLE_LINE_PATTERN = "^[^\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]*$";
export const MAX_ASK_DETAILS_BYTES = 50 * 1024;

const AskOptionParams = Type.Object({
  label: Type.String({ minLength: 1, maxLength: MAX_REQUEST_LABEL_CHARS, pattern: SAFE_SINGLE_LINE_PATTERN, description: "Short option label" }),
  description: Type.Optional(Type.String({ maxLength: MAX_REQUEST_DESCRIPTION_CHARS, pattern: SAFE_MULTILINE_PATTERN, description: "Tradeoff or consequence shown below the label" })),
  preview: Type.Optional(Type.String({ maxLength: MAX_REQUEST_PREVIEW_CHARS, pattern: SAFE_MULTILINE_PATTERN, description: "Optional expanded preview for this option" })),
});

const AskQuestionParams = Type.Object({
  header: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_REQUEST_HEADER_CHARS, pattern: SAFE_SINGLE_LINE_PATTERN, description: "Short navigation label" })),
  id: Type.String({ minLength: 1, maxLength: MAX_REQUEST_ID_CHARS, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", description: "Unique result identifier" }),
  multi: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options" })),
  options: Type.Array(AskOptionParams, {
    minItems: 1,
    maxItems: MAX_REQUEST_OPTIONS,
    description: "Distinct options in display order; Other is added automatically",
  }),
  question: Type.String({ minLength: 1, maxLength: MAX_REQUEST_QUESTION_CHARS, pattern: SAFE_MULTILINE_PATTERN, description: "Question shown to the user" }),
  recommended: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_REQUEST_OPTIONS - 1, description: "Zero-based recommended option index" })),
});

export const AskParams = Type.Object({
  i: Type.Optional(Type.String({ minLength: 1, maxLength: 120, pattern: SAFE_SINGLE_LINE_PATTERN, description: "Concise intent for the request" })),
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

export interface AskAnswerDetails {
  id: string;
  multi: boolean;
  selectedOptions: string[];
  customInput?: string;
}

export type AskToolDetails = AskAnswerDetails | { results: AskAnswerDetails[] };

function answerText(answer: AskAnswerDetails): string {
  const parts: string[] = [];
  if (answer.selectedOptions.length > 0) parts.push(answer.selectedOptions.map(sanitizeTerminalText).join(", "));
  if (answer.customInput) parts.push(sanitizeTerminalText(answer.customInput));
  return parts.join("; ") || "unanswered";
}

function modelVisibleResult(result: RequestDialogResult): string {
  if (result.results.length === 1) {
    const answer = result.results[0];
    if (!answer) return "User submitted no answer.";
    const customInput = answer.customInput === undefined ? undefined : sanitizeTerminalText(answer.customInput);
    const selectedOptions = answer.selectedOptions.map(sanitizeTerminalText);
    if (customInput && selectedOptions.length === 0) return `User provided custom input: ${customInput}`;
    if (selectedOptions.length > 0 && !customInput) return `User selected: ${selectedOptions.join(", ")}`;
    return `User answered: ${answerText({ ...answer, selectedOptions, customInput })}`;
  }
  return result.results.map((answer) => `${sanitizeTerminalText(answer.id)}: ${answerText(answer)}`).join("\n");
}

function compactAnswer(answer: RequestAnswer): AskAnswerDetails {
  return {
    id: sanitizeTerminalText(answer.id),
    multi: answer.multi,
    selectedOptions: answer.selectedOptions.map(sanitizeTerminalText),
    ...(answer.customInput === undefined ? {} : { customInput: sanitizeTerminalText(answer.customInput) }),
  };
}

function toolDetails(result: RequestDialogResult): AskToolDetails {
  const answers = result.results.map(compactAnswer);
  const details: AskToolDetails = answers.length === 1 ? answers[0]! : { results: answers };
  if (Buffer.byteLength(JSON.stringify(details), "utf8") > MAX_ASK_DETAILS_BYTES) {
    throw new Error(`Ask result details exceed the ${MAX_ASK_DETAILS_BYTES.toLocaleString()} byte limit.`);
  }
  return details;
}

export function registerAskTool(pi: ExtensionAPI, runtime: AskToolRuntime): void {
  pi.registerTool({
    name: "ask",
    label: "Ask",
    description:
      "Ask the user one or more related questions in an interactive request UI. When a requirement is ambiguous and the answer would change what you build, ask instead of assuming. Use only when a material choice changes the implementation; options should be concise and distinct. Other is added automatically.",
    promptSnippet: "Interactive single- or multi-question user request",
    promptGuidelines: [
      "Use ask only when repository context cannot resolve a material user choice.",
      "Prefer calling ask when a requirement is genuinely ambiguous and the answer changes the implementation, rather than guessing and reworking.",
      "Keep ask option labels short; put tradeoffs in description and detailed examples in preview.",
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
          lines.push(theme.fg("accent", `[${sanitizeTerminalText(question.id)}]`) + theme.fg("muted", ` · options:${question.options.length}`));
          lines.push(theme.fg("text", sanitizeTerminalText(question.question)));
          for (let index = 0; index < question.options.length; index++) {
            const option = question.options[index];
            const recommended = index === (question.recommended ?? 0) ? theme.fg("accent", " (Recommended)") : "";
            lines.push(`  ${theme.fg("muted", "○")} ${sanitizeTerminalText(option.label)}${recommended}`);
            if (option.description) lines.push(`    ${theme.fg("dim", sanitizeTerminalText(option.description))}`);
          }
        }
      }
      return new Text(lines.join("\n"), 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as AskToolDetails | undefined;
      if (!details) {
        const first = result.content[0];
        return new Text(first?.type === "text" ? sanitizeTerminalText(first.text) : "", 0, 0);
      }
      const answers = "results" in details ? details.results : [details];
      const lines = answers.map((answer) => {
        const value = answerText(answer);
        const glyph = value === "unanswered" ? theme.fg("warning", "○") : theme.fg("success", "✓");
        return `${glyph} ${theme.fg("accent", sanitizeTerminalText(answer.id))}: ${theme.fg("text", value)}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
