import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  matchesKey,
  truncateToWidth,
  type Component,
  type TUI,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { tone } from "pi-uikit-dev";
import {
  MAX_REQUEST_ANSWER_CHARS,
  type NormalizedRequestChoiceQuestion,
  type NormalizedRequestQuestion,
  type RequestAnswer,
  type RequestDialogResult,
  sanitizeTerminalText,
  unansweredRequestResult,
} from "./request.ts";

interface RequestComponentOptions {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  questions: readonly NormalizedRequestQuestion[];
  done(result: RequestDialogResult): void;
  signal?: AbortSignal;
  timeout?: number;
}

interface StoredAnswer {
  selectedOptions: Set<string>;
  customInput?: string;
}

function hasCustomInput(answer: StoredAnswer | undefined): answer is StoredAnswer & { customInput: string } {
  return answer?.customInput !== undefined;
}

interface BodyRender {
  lines: string[];
  focusLine: number;
}

interface DisplayOption {
  option?: NormalizedRequestChoiceQuestion["options"][number];
  isOther: boolean;
}

function padToWidth(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(0, width), "");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function wrapPrefixed(text: string, width: number, firstPrefix = "", continuationPrefix = firstPrefix): string[] {
  if (width <= 0) return [];
  const firstWidth = visibleWidth(firstPrefix);
  const continuationWidth = visibleWidth(continuationPrefix);
  const contentWidth = Math.max(1, width - Math.max(firstWidth, continuationWidth));
  const wrapped = wrapTextWithAnsi(text, contentWidth);
  if (wrapped.length === 0) return [truncateToWidth(firstPrefix, width, "")];
  return wrapped.map((line, index) => truncateToWidth(`${index === 0 ? firstPrefix : continuationPrefix}${line}`, width, ""));
}

function dialogResult(
  questions: readonly NormalizedRequestQuestion[],
  answers: ReadonlyMap<string, StoredAnswer>,
  cancelled: boolean,
): RequestDialogResult {
  if (cancelled) return unansweredRequestResult(questions, true);
  return {
    cancelled: false,
    results: questions.map((question): RequestAnswer => {
      const answer = answers.get(question.id);
      return {
        id: question.id,
        question: question.question,
        options: question.kind === "choice" ? question.options.map((option) => option.label) : [],
        multi: question.kind === "choice" && question.multi,
        selectedOptions: answer ? [...answer.selectedOptions] : [],
        ...(hasCustomInput(answer) ? { customInput: answer.customInput } : {}),
      };
    }),
  };
}

export function createRequestComponent({
  tui,
  theme,
  keybindings,
  questions,
  done,
  signal,
  timeout,
}: RequestComponentOptions): Component & { dispose(): void } {
  let questionIndex = 0;
  let optionIndex = questions[0]?.kind === "choice" ? questions[0].recommended : 0;
  let stage: "question" | "review" = "question";
  let reviewIndex = questions.length;
  let editing: "other" | "text" | null = questions[0]?.kind === "text" ? "text" : null;
  let bodyScrollOffset = 0;
  let cachedWidth: number | undefined;
  let cachedLines: string[] | undefined;
  let settled = false;
  const timeoutMilliseconds = timeout !== undefined && Number.isFinite(timeout) && timeout > 0
    ? Math.min(timeout, 2_147_483_647)
    : undefined;
  let deadline = timeoutMilliseconds === undefined ? undefined : Date.now() + timeoutMilliseconds;
  const answers = new Map<string, StoredAnswer>();

  const editorTheme: EditorTheme = {
    borderColor: (text) => tone(theme, "borderAccent", text),
    selectList: {
      selectedPrefix: (text) => tone(theme, "accent", text),
      selectedText: (text) => tone(theme, "accent", text),
      description: (text) => tone(theme, "muted", text),
      scrollInfo: (text) => tone(theme, "dim", text),
      noMatch: (text) => tone(theme, "warning", text),
    },
  };
  const editor = new Editor(tui, editorTheme);

  function currentQuestion(): NormalizedRequestQuestion {
    const question = questions[questionIndex];
    if (!question) throw new Error("Request dialog has no current question.");
    return question;
  }

  function currentAnswer(): StoredAnswer {
    const question = currentQuestion();
    let answer = answers.get(question.id);
    if (!answer) {
      answer = { selectedOptions: new Set<string>() };
      answers.set(question.id, answer);
    }
    return answer;
  }

  function displayOptions(question: NormalizedRequestChoiceQuestion): DisplayOption[] {
    const options: DisplayOption[] = question.options.map((option) => ({ option, isOther: false }));
    if (question.allowOther) options.push({ isOther: true });
    return options;
  }

  function refresh(): void {
    cachedLines = undefined;
    cachedWidth = undefined;
    tui.requestRender();
  }

  function complete(cancelled: boolean): void {
    if (settled) return;
    settled = true;
    done(dialogResult(questions, answers, cancelled));
  }

  function selectQuestion(index: number): void {
    questionIndex = Math.max(0, Math.min(questions.length - 1, index));
    stage = "question";
    const question = currentQuestion();
    editing = question.kind === "text" ? "text" : null;
    if (question.kind === "choice") {
      const answer = answers.get(question.id);
      const selected = answer?.selectedOptions.values().next().value as string | undefined;
      const selectedIndex = selected === undefined
        ? -1
        : question.options.findIndex((option) => option.label === selected);
      optionIndex = selectedIndex >= 0 ? selectedIndex : question.recommended;
    } else {
      editor.setText(answers.get(question.id)?.customInput ?? "");
    }
    bodyScrollOffset = 0;
    refresh();
  }

  function advance(): void {
    if (questions.length === 1) {
      complete(false);
      return;
    }
    if (questionIndex < questions.length - 1) selectQuestion(questionIndex + 1);
    else {
      stage = "review";
      editing = null;
      reviewIndex = questions.length;
      bodyScrollOffset = 0;
      refresh();
    }
  }

  function beginOtherInput(): void {
    const answer = currentAnswer();
    editing = "other";
    editor.setText(answer.customInput ?? "");
    refresh();
  }

  editor.onSubmit = (value) => {
    const answer = currentAnswer();
    if (editing === "text") {
      answer.customInput = sanitizeTerminalText(value).slice(0, MAX_REQUEST_ANSWER_CHARS);
      editor.setText("");
      editing = null;
      advance();
      return;
    }
    const trimmed = sanitizeTerminalText(value).trim();
    if (!trimmed) return;
    const question = currentQuestion();
    if (question.kind === "choice" && !question.multi) answer.selectedOptions.clear();
    answer.customInput = trimmed.slice(0, MAX_REQUEST_ANSWER_CHARS);
    editor.setText("");
    if (question.kind === "choice" && !question.multi) {
      editing = null;
      advance();
    } else {
      editing = null;
      refresh();
    }
  };

  function cancelKey(data: string): boolean {
    return keybindings.matches(data, "tui.select.cancel") ||
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.ctrl("c"));
  }

  function handleQuestionInput(data: string): void {
    const question = currentQuestion();
    if (editing) {
      if (cancelKey(data)) {
        if (editing === "other") {
          editing = null;
          editor.setText("");
          refresh();
        } else {
          complete(true);
        }
        return;
      }
      if (
        editing === "text" &&
        (keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter))
      ) {
        const answer = currentAnswer();
        answer.customInput = sanitizeTerminalText(editor.getText()).slice(0, MAX_REQUEST_ANSWER_CHARS);
        editor.setText("");
        editing = null;
        advance();
        return;
      }
      editor.handleInput(data);
      const rawEditorText = editor.getText();
      const editorText = sanitizeTerminalText(rawEditorText).slice(0, MAX_REQUEST_ANSWER_CHARS);
      if (editorText !== rawEditorText) editor.setText(editorText);
      refresh();
      return;
    }

    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      if (questionIndex < questions.length - 1) selectQuestion(questionIndex + 1);
      else {
        stage = "review";
        reviewIndex = questions.length;
        bodyScrollOffset = 0;
        refresh();
      }
      return;
    }
    if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
      if (questionIndex > 0) selectQuestion(questionIndex - 1);
      else {
        stage = "review";
        reviewIndex = questions.length;
        bodyScrollOffset = 0;
        refresh();
      }
      return;
    }
    if (cancelKey(data)) {
      complete(true);
      return;
    }
    if (question.kind === "text") return;

    const options = displayOptions(question);
    if (keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up)) {
      optionIndex = Math.max(0, optionIndex - 1);
      refresh();
      return;
    }
    if (keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.down)) {
      optionIndex = Math.min(options.length - 1, optionIndex + 1);
      refresh();
      return;
    }
    if (matchesKey(data, Key.home)) {
      optionIndex = 0;
      refresh();
      return;
    }
    if (matchesKey(data, Key.end)) {
      optionIndex = Math.max(0, options.length - 1);
      refresh();
      return;
    }

    const displayOption = options[optionIndex];
    if (matchesKey(data, Key.space) && question.multi && displayOption && !displayOption.isOther) {
      const answer = currentAnswer();
      const label = displayOption.option?.label;
      if (!label) return;
      if (answer.selectedOptions.has(label)) answer.selectedOptions.delete(label);
      else answer.selectedOptions.add(label);
      refresh();
      return;
    }
    if (!(keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter))) return;
    if (!displayOption) return;
    if (displayOption.isOther) {
      beginOtherInput();
      return;
    }
    if (question.multi) {
      advance();
      return;
    }
    const label = displayOption.option?.label;
    if (!label) return;
    const answer = currentAnswer();
    answer.selectedOptions.clear();
    answer.selectedOptions.add(label);
    answer.customInput = undefined;
    advance();
  }

  function handleReviewInput(data: string): void {
    if (cancelKey(data)) {
      complete(true);
      return;
    }
    if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
      selectQuestion(Math.max(0, questions.length - 1));
      return;
    }
    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      selectQuestion(0);
      return;
    }
    if (keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up)) {
      reviewIndex = Math.max(0, reviewIndex - 1);
      refresh();
      return;
    }
    if (keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.down)) {
      reviewIndex = Math.min(questions.length, reviewIndex + 1);
      refresh();
      return;
    }
    if (matchesKey(data, Key.home)) {
      reviewIndex = 0;
      refresh();
      return;
    }
    if (matchesKey(data, Key.end)) {
      reviewIndex = questions.length;
      refresh();
      return;
    }
    if (!(keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter))) return;
    if (reviewIndex === questions.length) complete(false);
    else selectQuestion(reviewIndex);
  }

  function handleInput(data: string): void {
    if (settled) return;
    if (stage === "review") handleReviewInput(data);
    else handleQuestionInput(data);
  }

  function navLine(width: number): string {
    const parts = questions.map((question, index) => {
      const answer = answers.get(question.id);
      const answered = (answer?.selectedOptions.size ?? 0) > 0 || hasCustomInput(answer);
      const active = stage === "question" && index === questionIndex;
      const glyph = active ? "▶" : answered ? "✓" : "○";
      const text = `${glyph} ${index + 1} ${question.header}`;
      if (active) return tone(theme, "accent", text, { bold: true });
      return tone(theme, answered ? "success" : "muted", text);
    });
    const reviewActive = stage === "review";
    const review = reviewActive
      ? tone(theme, "accent", "▶ Review", { bold: true })
      : tone(theme, "muted", "◇ Review");
    return truncateToWidth([...parts, review].join(tone(theme, "dim", "  ·  ")), width, "…");
  }

  function renderChoiceBody(question: NormalizedRequestChoiceQuestion, width: number): BodyRender {
    const lines: string[] = [];
    lines.push(...wrapPrefixed(tone(theme, "text", question.question, { bold: true }), width));
    lines.push("");
    const answer = answers.get(question.id);
    const options = displayOptions(question);
    let focusLine = 0;
    for (let index = 0; index < options.length; index++) {
      const displayOption = options[index];
      const label = displayOption.isOther ? "Other (type your own)" : displayOption.option?.label ?? "";
      const selected = displayOption.isOther
        ? Boolean(answer?.customInput)
        : answer?.selectedOptions.has(label) === true;
      const focused = index === optionIndex;
      const radio = question.multi ? (selected ? "■" : "□") : (selected ? "●" : "○");
      const cursor = focused ? "›" : " ";
      const recommended = !displayOption.isOther && index === question.recommended
        ? tone(theme, "accent", " (Recommended)")
        : "";
      const styledLabel = focused
        ? tone(theme, "selected", ` ${radio} ${label} `)
        : tone(theme, selected ? "success" : "text", `${radio} ${label}`);
      if (focused) focusLine = lines.length;
      lines.push(...wrapPrefixed(`${styledLabel}${recommended}`, width, `${tone(theme, "accent", cursor)} `, "  "));
      const description = displayOption.isOther
        ? answer?.customInput
        : displayOption.option?.description;
      if (description) {
        lines.push(...wrapPrefixed(tone(theme, "muted", description), width, "    ", "    "));
      }
      if (focused && displayOption.option?.preview) {
        lines.push(...wrapPrefixed(tone(theme, "dim", displayOption.option.preview), width, tone(theme, "accent", "    │ "), "      "));
      }
      if (index < options.length - 1) lines.push("");
    }
    if (editing === "other") {
      lines.push("");
      lines.push(tone(theme, "accent", "Your answer", { bold: true }));
      const editorWidth = Math.max(1, width - 2);
      const editorStart = lines.length;
      for (const line of editor.render(editorWidth)) lines.push(`  ${truncateToWidth(line, editorWidth, "")}`);
      focusLine = Math.max(editorStart, lines.length - 1);
    }
    return { lines, focusLine };
  }

  function renderTextBody(question: Extract<NormalizedRequestQuestion, { kind: "text" }>, width: number): BodyRender {
    const lines = [
      ...wrapPrefixed(tone(theme, "text", question.question, { bold: true }), width),
      "",
      tone(theme, "accent", "Your answer", { bold: true }),
    ];
    if (question.placeholder && !editor.getText()) {
      lines.push(...wrapPrefixed(tone(theme, "dim", question.placeholder), width, "  ", "  "));
    }
    const editorWidth = Math.max(1, width - 2);
    const editorStart = lines.length;
    for (const line of editor.render(editorWidth)) lines.push(`  ${truncateToWidth(line, editorWidth, "")}`);
    return { lines, focusLine: Math.max(editorStart, lines.length - 1) };
  }

  function answerSummary(question: NormalizedRequestQuestion): string {
    const answer = answers.get(question.id);
    const values = answer ? [...answer.selectedOptions] : [];
    if (hasCustomInput(answer)) values.push(answer.customInput || "(empty input)");
    return values.length > 0 ? values.join(", ") : "unanswered";
  }

  function renderReviewBody(width: number): BodyRender {
    const lines: string[] = [tone(theme, "text", "Review answers", { bold: true }), ""];
    const unanswered = questions.filter((question) => answerSummary(question) === "unanswered").length;
    lines.push(tone(theme, unanswered > 0 ? "warning" : "success", unanswered > 0
      ? `${unanswered} unanswered question${unanswered === 1 ? "" : "s"}; Enter still submits.`
      : "All questions answered."));
    lines.push("");
    let focusLine = 0;
    for (let index = 0; index < questions.length; index++) {
      const question = questions[index];
      const focused = reviewIndex === index;
      if (focused) focusLine = lines.length;
      const glyph = answerSummary(question) === "unanswered" ? "○" : "✓";
      const prefix = focused ? tone(theme, "accent", "› ") : "  ";
      const header = `${glyph} ${index + 1}. ${question.header}`;
      const styledHeader = focused
        ? tone(theme, "selected", ` ${header} `)
        : tone(theme, answerSummary(question) === "unanswered" ? "muted" : "success", header);
      lines.push(...wrapPrefixed(styledHeader, width, prefix, "  "));
      lines.push(...wrapPrefixed(tone(theme, "muted", answerSummary(question)), width, "     ", "     "));
      lines.push("");
    }
    const submitFocused = reviewIndex === questions.length;
    if (submitFocused) focusLine = lines.length;
    const submit = submitFocused
      ? tone(theme, "selected", " ✓ Submit ")
      : tone(theme, "accent", "✓ Submit");
    lines.push(`${submitFocused ? tone(theme, "accent", "› ") : "  "}${submit}`);
    return { lines, focusLine };
  }

  function timeoutText(): string {
    if (deadline === undefined) return "";
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1_000));
    return ` · closes in ${remaining}s`;
  }

  function render(width: number): string[] {
    const renderWidth = Math.max(1, width);
    if (cachedLines && cachedWidth === renderWidth) return cachedLines;
    const terminalRows = Math.max(4, tui.terminal.rows || 24);
    const framed = renderWidth >= 24 && terminalRows >= 9;
    const innerWidth = framed ? Math.max(1, renderWidth - 4) : renderWidth;
    const question = stage === "question" ? currentQuestion() : undefined;
    const body = question === undefined
      ? renderReviewBody(innerWidth)
      : question.kind === "choice"
        ? renderChoiceBody(question, innerWidth)
        : renderTextBody(question, innerWidth);
    const chromeRows = framed ? 6 : 3;
    const minimumRows = framed ? 7 : 4;
    const maximumRows = Math.max(minimumRows, Math.min(28, terminalRows - 2));
    const viewportRows = Math.max(1, maximumRows - chromeRows);
    if (body.focusLine < bodyScrollOffset) bodyScrollOffset = body.focusLine;
    if (body.focusLine >= bodyScrollOffset + viewportRows) {
      bodyScrollOffset = body.focusLine - viewportRows + 1;
    }
    const maxScroll = Math.max(0, body.lines.length - viewportRows);
    bodyScrollOffset = Math.max(0, Math.min(bodyScrollOffset, maxScroll));
    const visibleBody = body.lines.slice(bodyScrollOffset, bodyScrollOffset + viewportRows);
    const moreAbove = bodyScrollOffset > 0;
    const moreBelow = bodyScrollOffset + visibleBody.length < body.lines.length;
    const mode = stage === "review"
      ? "REVIEW"
      : question?.kind === "text"
        ? "TEXT"
        : question?.multi
          ? "MULTI-SELECT"
          : "SELECT ONE";
    const help = editing
      ? "Enter submit · Esc back"
      : stage === "review"
        ? "↑↓ choose · Enter edit/submit · Tab questions · Esc cancel"
        : question?.kind === "choice" && question.multi
          ? "↑↓ move · Space toggle · Enter next · Tab questions · Esc cancel"
          : "↑↓ move · Enter select · Tab questions · Esc cancel";
    const scrollStatus = `${moreAbove ? "↑" : ""}${moreBelow ? "↓" : ""}`;

    if (!framed) {
      const compact = [
        tone(theme, "accent", `Ask · ${mode}`, { bold: true }),
        navLine(innerWidth),
        ...visibleBody,
        tone(theme, "dim", `${scrollStatus} ${help}${timeoutText()}`.trim()),
      ].map((line) => truncateToWidth(line, renderWidth, ""));
      cachedWidth = renderWidth;
      cachedLines = compact;
      return compact;
    }

    const frame = (line = "") => `${tone(theme, "borderMuted", "│")} ${padToWidth(line, innerWidth)} ${tone(theme, "borderMuted", "│")}`;
    const title = ` Ask · ${mode} `;
    const titleWidth = visibleWidth(title);
    const top = `╭─${title}${"─".repeat(Math.max(0, renderWidth - titleWidth - 3))}╮`;
    const bottom = `╰${"─".repeat(Math.max(0, renderWidth - 2))}╯`;
    const lines = [
      tone(theme, "borderAccent", truncateToWidth(top, renderWidth, "")),
      frame(navLine(innerWidth)),
      frame(tone(theme, "borderMuted", "─".repeat(innerWidth))),
      ...visibleBody.map(frame),
      frame(),
      frame(tone(theme, "dim", `${scrollStatus ? `${scrollStatus} ` : ""}${help}${timeoutText()}`)),
      tone(theme, "borderAccent", truncateToWidth(bottom, renderWidth, "")),
    ];
    cachedWidth = renderWidth;
    cachedLines = lines;
    return lines;
  }

  const abort = () => complete(true);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) queueMicrotask(abort);
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let countdownHandle: ReturnType<typeof setInterval> | undefined;
  if (deadline !== undefined) {
    const delay = Math.max(0, deadline - Date.now());
    timeoutHandle = setTimeout(() => complete(true), delay);
    countdownHandle = setInterval(refresh, 1_000);
    countdownHandle.unref?.();
  }

  return {
    render,
    handleInput,
    invalidate: () => {
      cachedLines = undefined;
      cachedWidth = undefined;
      editor.invalidate();
    },
    dispose: () => {
      signal?.removeEventListener("abort", abort);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (countdownHandle) clearInterval(countdownHandle);
      deadline = undefined;
    },
  };
}
