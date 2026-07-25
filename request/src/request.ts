export const MAX_REQUEST_QUESTIONS = 10;
export const MAX_REQUEST_OPTIONS = 10;
export const MAX_REQUEST_ID_CHARS = 64;
export const MAX_REQUEST_HEADER_CHARS = 80;
export const MAX_REQUEST_QUESTION_CHARS = 1_000;
export const MAX_REQUEST_LABEL_CHARS = 160;
export const MAX_REQUEST_DESCRIPTION_CHARS = 500;
export const MAX_REQUEST_PREVIEW_CHARS = 4_000;
export const MAX_REQUEST_PLACEHOLDER_CHARS = 500;
export const MAX_REQUEST_ANSWER_CHARS = 1_000;
export const MAX_REQUEST_PAYLOAD_BYTES = 16 * 1024;

const UNSAFE_TERMINAL_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const UNSAFE_TERMINAL_TEXT_GLOBAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const SINGLE_LINE_SEPARATOR = /[\n\t]/u;

export function sanitizeTerminalText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(UNSAFE_TERMINAL_TEXT_GLOBAL, "�");
}

export interface RequestOption {
  label: string;
  description?: string;
  preview?: string;
}

interface RequestQuestionBase {
  id: string;
  header?: string;
  question: string;
}

export interface RequestChoiceQuestion extends RequestQuestionBase {
  kind?: "choice";
  multi?: boolean;
  options: RequestOption[];
  recommended?: number;
  allowOther?: boolean;
}

export interface RequestTextQuestion extends RequestQuestionBase {
  kind: "text";
  placeholder?: string;
}

export type RequestQuestion = RequestChoiceQuestion | RequestTextQuestion;

export interface NormalizedRequestChoiceQuestion extends RequestQuestionBase {
  kind: "choice";
  header: string;
  multi: boolean;
  options: RequestOption[];
  recommended: number;
  allowOther: boolean;
}

export interface NormalizedRequestTextQuestion extends RequestQuestionBase {
  kind: "text";
  header: string;
  placeholder?: string;
}

export type NormalizedRequestQuestion = NormalizedRequestChoiceQuestion | NormalizedRequestTextQuestion;

export interface RequestAnswer {
  id: string;
  question: string;
  options: string[];
  multi: boolean;
  selectedOptions: string[];
  customInput?: string;
}

export interface RequestDialogResult {
  cancelled: boolean;
  results: RequestAnswer[];
}

export interface RequestDialogOptions {
  signal?: AbortSignal;
  timeout?: number;
}

function requiredText(value: unknown, label: string, maximum: number, multiline = false): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalizedNewlines = value.replace(/\r\n?/g, "\n");
  if (UNSAFE_TERMINAL_TEXT.test(normalizedNewlines)) {
    throw new Error(`${label} must not contain terminal control or bidirectional formatting characters.`);
  }
  if (!multiline && SINGLE_LINE_SEPARATOR.test(normalizedNewlines)) {
    throw new Error(`${label} must be a single line.`);
  }
  const normalized = normalizedNewlines.trim();
  if (!normalized) throw new Error(`${label} must not be empty.`);
  if (normalized.length > maximum) throw new Error(`${label} must not exceed ${maximum} characters.`);
  return normalized;
}

function optionalText(value: unknown, label: string, maximum: number, multiline = false): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalizedNewlines = value.replace(/\r\n?/g, "\n");
  if (UNSAFE_TERMINAL_TEXT.test(normalizedNewlines)) {
    throw new Error(`${label} must not contain terminal control or bidirectional formatting characters.`);
  }
  if (!multiline && SINGLE_LINE_SEPARATOR.test(normalizedNewlines)) {
    throw new Error(`${label} must be a single line.`);
  }
  const normalized = normalizedNewlines.trim();
  if (!normalized) return undefined;
  if (normalized.length > maximum) throw new Error(`${label} must not exceed ${maximum} characters.`);
  return normalized;
}

function normalizeOption(value: RequestOption, questionIndex: number, optionIndex: number): RequestOption {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Question ${questionIndex + 1} option ${optionIndex + 1} must be an object.`);
  }
  return {
    label: requiredText(value.label, `Question ${questionIndex + 1} option ${optionIndex + 1} label`, MAX_REQUEST_LABEL_CHARS),
    description: optionalText(
      value.description,
      `Question ${questionIndex + 1} option ${optionIndex + 1} description`,
      MAX_REQUEST_DESCRIPTION_CHARS,
      true,
    ),
    preview: optionalText(
      value.preview,
      `Question ${questionIndex + 1} option ${optionIndex + 1} preview`,
      MAX_REQUEST_PREVIEW_CHARS,
      true,
    ),
  };
}

export function normalizeRequestQuestions(questions: readonly RequestQuestion[]): NormalizedRequestQuestion[] {
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error("At least one request question is required.");
  }
  if (questions.length > MAX_REQUEST_QUESTIONS) {
    throw new Error(`A request may contain at most ${MAX_REQUEST_QUESTIONS} questions.`);
  }

  const ids = new Set<string>();
  const normalized: NormalizedRequestQuestion[] = questions.map((question, questionIndex) => {
    if (!question || typeof question !== "object" || Array.isArray(question)) {
      throw new Error(`Question ${questionIndex + 1} must be an object.`);
    }
    const id = requiredText(question.id, `Question ${questionIndex + 1} id`, MAX_REQUEST_ID_CHARS);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      throw new Error(`Question ${questionIndex + 1} id contains unsupported characters.`);
    }
    if (ids.has(id)) throw new Error(`Request question id "${id}" is duplicated.`);
    ids.add(id);

    const header = question.header === undefined
      ? `Question ${questionIndex + 1}`
      : requiredText(question.header, `Question ${questionIndex + 1} header`, MAX_REQUEST_HEADER_CHARS);
    const prompt = requiredText(question.question, `Question ${questionIndex + 1} prompt`, MAX_REQUEST_QUESTION_CHARS, true);

    if (question.kind === "text") {
      return {
        id,
        header,
        question: prompt,
        kind: "text",
        placeholder: optionalText(
          question.placeholder,
          `Question ${questionIndex + 1} placeholder`,
          MAX_REQUEST_PLACEHOLDER_CHARS,
        ),
      } satisfies NormalizedRequestTextQuestion;
    }

    if (question.kind !== undefined && question.kind !== "choice") {
      throw new Error(`Question ${questionIndex + 1} kind is unsupported.`);
    }
    const choice = question as RequestChoiceQuestion;
    if (!Array.isArray(choice.options) || choice.options.length === 0) {
      throw new Error(`Question ${questionIndex + 1} must provide at least one option.`);
    }
    if (choice.options.length > MAX_REQUEST_OPTIONS) {
      throw new Error(`Question ${questionIndex + 1} may provide at most ${MAX_REQUEST_OPTIONS} options.`);
    }
    const options = choice.options.map((option, optionIndex) => normalizeOption(option, questionIndex, optionIndex));
    const labels = new Set<string>();
    for (const option of options) {
      if (labels.has(option.label)) throw new Error(`Question ${questionIndex + 1} option label "${option.label}" is duplicated.`);
      labels.add(option.label);
    }
    const recommended = choice.recommended ?? 0;
    if (!Number.isInteger(recommended) || recommended < 0 || recommended >= options.length) {
      throw new Error(`Question ${questionIndex + 1} recommended index is out of range.`);
    }
    return {
      id,
      header,
      question: prompt,
      kind: "choice",
      multi: choice.multi === true,
      options,
      recommended,
      allowOther: choice.allowOther !== false,
    } satisfies NormalizedRequestChoiceQuestion;
  });
  if (Buffer.byteLength(JSON.stringify(normalized), "utf8") > MAX_REQUEST_PAYLOAD_BYTES) {
    throw new Error(`Request payload exceeds the ${MAX_REQUEST_PAYLOAD_BYTES.toLocaleString()} byte limit.`);
  }
  return normalized;
}

export function unansweredRequestResult(questions: readonly NormalizedRequestQuestion[], cancelled: boolean): RequestDialogResult {
  return {
    cancelled,
    results: questions.map((question) => ({
      id: question.id,
      question: question.question,
      options: question.kind === "choice" ? question.options.map((option) => option.label) : [],
      multi: question.kind === "choice" && question.multi,
      selectedOptions: [],
    })),
  };
}
