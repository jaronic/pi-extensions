import type {
  ExtensionUIDialogOptions,
  ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import type { RequestCoordinator } from "./dialog.ts";
import { normalizeRequestQuestions, type RequestDialogOptions, type RequestQuestion } from "./request.ts";

export interface InstalledRequestUIAdapters {
  restore(): void;
}

type DialogOptionsFactory = (options?: ExtensionUIDialogOptions) => RequestDialogOptions;

function nativeQuestion(
  id: string,
  header: string,
  question: string,
  options: string[],
): RequestQuestion {
  return {
    id,
    header: header.trim() || "Request",
    question: question.trim() || header.trim() || "Choose an option.",
    options: options.map((label) => ({ label })),
    allowOther: false,
  };
}

function supportsUnifiedDialog(question: RequestQuestion): boolean {
  try {
    normalizeRequestQuestions([question]);
    return true;
  } catch {
    return false;
  }
}

export function installRequestUIAdapters(
  ui: ExtensionUIContext,
  coordinator: RequestCoordinator,
  dialogOptions: DialogOptionsFactory,
): InstalledRequestUIAdapters {
  const originalSelect = ui.select;
  const originalConfirm = ui.confirm;
  const originalInput = ui.input;

  const unifiedSelect: ExtensionUIContext["select"] = async (title, options, nativeOptions) => {
    if (options.length === 0 || options.some((option) => option.length === 0 || option !== option.trim())) {
      return originalSelect.call(ui, title, options, nativeOptions);
    }
    const question = nativeQuestion("select", title, title, options);
    if (!supportsUnifiedDialog(question)) return originalSelect.call(ui, title, options, nativeOptions);
    const result = await coordinator.request(ui, [question], dialogOptions(nativeOptions));
    if (result.cancelled) return undefined;
    return result.results[0]?.selectedOptions[0];
  };

  const unifiedConfirm: ExtensionUIContext["confirm"] = async (title, message, nativeOptions) => {
    const question = nativeQuestion("confirm", title, message, ["Yes", "No"]);
    if (!supportsUnifiedDialog(question)) return originalConfirm.call(ui, title, message, nativeOptions);
    const result = await coordinator.request(ui, [question], dialogOptions(nativeOptions));
    return !result.cancelled && result.results[0]?.selectedOptions[0] === "Yes";
  };

  const unifiedInput: ExtensionUIContext["input"] = async (title, placeholder, nativeOptions) => {
    const question: RequestQuestion = {
      id: "input",
      header: title.trim() || "Input",
      question: title.trim() || "Enter a value.",
      kind: "text",
      ...(placeholder ? { placeholder } : {}),
    };
    if (!supportsUnifiedDialog(question)) return originalInput.call(ui, title, placeholder, nativeOptions);
    const result = await coordinator.request(ui, [question], dialogOptions(nativeOptions));
    if (result.cancelled) return undefined;
    return result.results[0]?.customInput;
  };

  ui.select = unifiedSelect;
  ui.confirm = unifiedConfirm;
  ui.input = unifiedInput;

  return {
    restore: () => {
      if (ui.select === unifiedSelect) ui.select = originalSelect;
      if (ui.confirm === unifiedConfirm) ui.confirm = originalConfirm;
      if (ui.input === unifiedInput) ui.input = originalInput;
    },
  };
}
