import type {
  ExtensionContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import type { PlanClarification } from "./state.ts";

interface ChoiceComponentOptions {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  clarification: PlanClarification;
  done(selection: number | undefined): void;
}

function padToWidth(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function createChoiceComponent({
  tui,
  theme,
  keybindings,
  clarification,
  done,
}: ChoiceComponentOptions): Component {
  let selectedIndex = 0;
  let settled = false;

  const finish = (selection: number | undefined): void => {
    if (settled) return;
    settled = true;
    done(selection);
  };

  const selectBy = (amount: number): void => {
    selectedIndex = (selectedIndex + amount + clarification.options.length) % clarification.options.length;
    tui.requestRender();
  };

  return {
    render(width: number): string[] {
      const contentWidth = Math.max(1, width - 2);
      if (width < 8) {
        return [
          truncateToWidth("PLAN CHOICE", width, ""),
          ...clarification.options.map((option, index) => truncateToWidth(`${index === selectedIndex ? ">" : " "}${index + 1}. ${option.label}`, width, "")),
        ];
      }
      const questionLines = wrapTextWithAnsi(clarification.question, contentWidth);
      const option = clarification.options[selectedIndex];
      const descriptionLines = option.description
        ? wrapTextWithAnsi(option.description, contentWidth)
        : ["No additional details."];
      const bodyRows = Math.max(4, tui.terminal.rows - clarification.options.length - 6);
      const visibleQuestion = questionLines.slice(0, Math.max(1, Math.floor(bodyRows / 2)));
      const remainingRows = Math.max(1, bodyRows - visibleQuestion.length - clarification.options.length - 2);
      const visibleDescription = descriptionLines.slice(0, remainingRows);
      const divider = theme.fg("borderMuted", "─".repeat(width));
      const lines = [
        padToWidth(` ${theme.fg("accent", theme.bold("Plan choice"))} ${theme.fg("borderMuted", "·")} Awaiting your decision`, width),
        padToWidth(theme.fg("borderMuted", " Choose one option to continue read-only planning."), width),
        divider,
      ];
      for (const line of visibleQuestion) lines.push(padToWidth(` ${line}`, width));
      if (visibleQuestion.length < questionLines.length) {
        lines.push(padToWidth(theme.fg("borderMuted", " … question truncated"), width));
      }
      lines.push(divider);
      for (let index = 0; index < clarification.options.length; index += 1) {
        const choice = clarification.options[index];
        const label = `${index === selectedIndex ? theme.fg("accent", "›") : " "} ${index + 1}. ${choice.label}`;
        lines.push(padToWidth(index === selectedIndex ? theme.bold(label) : label, width));
      }
      lines.push(divider);
      for (const [index, line] of visibleDescription.entries()) {
        const prefix = index === 0 ? `${theme.fg("borderMuted", " Details ·")} ` : "           ";
        lines.push(padToWidth(`${prefix}${line}`, width));
      }
      if (visibleDescription.length < descriptionLines.length) {
        lines.push(padToWidth(theme.fg("borderMuted", " … description truncated"), width));
      }
      const hint = ` ${selectedIndex + 1}/${clarification.options.length} · ↑↓ choose · Enter confirm · Esc stay`;
      lines.push(padToWidth(theme.fg("borderMuted", hint), width));
      return lines;
    },
    handleInput(data: string): void {
      if (keybindings.matches(data, "tui.select.cancel")) {
        finish(undefined);
        return;
      }
      if (keybindings.matches(data, "tui.select.up")) {
        selectBy(-1);
        return;
      }
      if (keybindings.matches(data, "tui.select.down")) {
        selectBy(1);
        return;
      }
      if (matchesKey(data, "home")) {
        selectedIndex = 0;
        tui.requestRender();
        return;
      }
      if (matchesKey(data, "end")) {
        selectedIndex = clarification.options.length - 1;
        tui.requestRender();
        return;
      }
      if (keybindings.matches(data, "tui.select.confirm")) finish(selectedIndex);
    },
    invalidate(): void {},
  };
}

export function requestPlanChoiceDialog(
  ctx: ExtensionContext,
  clarification: PlanClarification,
): Promise<number | undefined> {
  return ctx.ui.custom<number | undefined>((tui, theme, keybindings, done) =>
    createChoiceComponent({ tui, theme, keybindings, clarification, done })
  );
}
