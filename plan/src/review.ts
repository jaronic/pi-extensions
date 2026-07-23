import {
  copyToClipboard,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type MarkdownTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { renderPlan } from "./output.ts";
import type { PlanState } from "./state.ts";
import { clearPlanOutlineMarkers, createPlanOutline, type PlanOutlineEntry } from "./outline.ts";

export const PLAN_REVIEW_ACTIONS = [
  "Execute plan",
  "Refine plan",
  "Copy plan",
  "Stay in plan mode",
  "Cancel plan",
] as const;

const PLAN_REVIEW_ACTION_STYLES = [
  { marker: "✓", color: "success" },
  { marker: "↻", color: "accent" },
  { marker: "⧉", color: "mdLink" },
  { marker: "◆", color: "warning" },
  { marker: "✕", color: "error" },
] as const;

export type PlanReviewAction = (typeof PLAN_REVIEW_ACTIONS)[number];
export type PlanReviewDecision = Exclude<PlanReviewAction, "Copy plan">;

interface ReviewComponentOptions {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  plan: PlanState;
  copyText(text: string): Promise<void>;
  done(action: PlanReviewDecision | undefined): void;
}

function createMarkdownTheme(theme: Theme): MarkdownTheme {
  return {
    heading: (text) => theme.fg("mdHeading", text),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    strikethrough: (text) => theme.strikethrough(text),
    underline: (text) => theme.underline(text),
  };
}

function padToWidth(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function scrollbarGlyph(
  row: number,
  visibleRows: number,
  totalRows: number,
  scrollOffset: number,
  theme: Theme,
): string {
  if (totalRows <= visibleRows) return theme.fg("accent", "█");
  const thumbSize = Math.max(1, Math.round(visibleRows * visibleRows / totalRows));
  const maxOffset = totalRows - visibleRows;
  const thumbTravel = visibleRows - thumbSize;
  const thumbStart = maxOffset === 0 ? 0 : Math.round(scrollOffset / maxOffset * thumbTravel);
  return row >= thumbStart && row < thumbStart + thumbSize
    ? theme.fg("accent", "█")
    : theme.fg("borderMuted", "░");
}

function createReviewComponent({
  tui,
  theme,
  keybindings,
  plan,
  done,
  copyText,
}: ReviewComponentOptions): Component & { dispose(): void } {
  const planText = renderPlan(plan);
  const outline = createPlanOutline(plan.plan ?? "");
  const markdown = new Markdown(
    renderPlan({ ...plan, plan: outline.decoratedBody }),
    0,
    0,
    createMarkdownTheme(theme),
    { color: (text) => theme.fg("text", text) },
  );
  let selectedIndex = 0;
  let focus: "preview" | "outline" | "actions" = "preview";
  let selectedHeadingIndex = 0;
  let outlineScrollOffset = 0;
  let scrollOffset = 0;
  let pageSize = 1;
  let outlinePageSize = 1;
  let maxScrollOffset = 0;
  let headingTargets: Array<number | undefined> = outline.entries.map(() => undefined);
  let settled = false;
  let disposed = false;
  let copyInFlight = false;
  let copyNotice: { text: string; color: "success" | "error" | "warning" } | undefined;

  const finish = (action: PlanReviewDecision | undefined): void => {
    if (settled) return;
    settled = true;
    done(action);
  };
  const copyPlan = (): void => {
    if (copyInFlight) return;
    copyInFlight = true;
    copyNotice = { text: " Copying complete Plan…", color: "warning" };
    requestRender();
    void copyText(planText).then(
      () => {
        if (disposed) return;
        copyInFlight = false;
        copyNotice = { text: " Complete Plan copied to clipboard.", color: "success" };
        requestRender();
      },
      (error: unknown) => {
        if (disposed) return;
        copyInFlight = false;
        const message = error instanceof Error ? error.message : String(error);
        copyNotice = { text: ` Copy failed: ${message}`, color: "error" };
        requestRender();
      },
    );
  };
  const requestRender = (): void => tui.requestRender();
  const currentHeadingIndex = (): number | undefined => {
    let current: number | undefined;
    for (let index = 0; index < headingTargets.length; index += 1) {
      const target = headingTargets[index];
      if (target !== undefined && target <= scrollOffset) current = index;
    }
    return current;
  };
  const scrollBy = (amount: number): void => {
    scrollOffset = Math.max(0, Math.min(maxScrollOffset, scrollOffset + amount));
    requestRender();
  };
  const selectBy = (amount: number): void => {
    selectedIndex = (selectedIndex + amount + PLAN_REVIEW_ACTIONS.length) % PLAN_REVIEW_ACTIONS.length;
    requestRender();
  };
  const ensureOutlineSelectionVisible = (): void => {
    if (outline.entries.length === 0) return;
    if (selectedHeadingIndex < outlineScrollOffset) outlineScrollOffset = selectedHeadingIndex;
    const lastVisible = outlineScrollOffset + Math.max(1, outlinePageSize) - 1;
    if (selectedHeadingIndex > lastVisible) {
      outlineScrollOffset = selectedHeadingIndex - Math.max(1, outlinePageSize) + 1;
    }
    outlineScrollOffset = Math.max(
      0,
      Math.min(outlineScrollOffset, Math.max(0, outline.entries.length - Math.max(1, outlinePageSize))),
    );
  };
  const selectHeading = (next: number): void => {
    if (outline.entries.length === 0) return;
    selectedHeadingIndex = Math.max(0, Math.min(outline.entries.length - 1, next));
    ensureOutlineSelectionVisible();
    requestRender();
  };
  const enterOutline = (): void => {
    const current = currentHeadingIndex();
    selectedHeadingIndex = current ?? 0;
    ensureOutlineSelectionVisible();
  };
  const cycleFocus = (direction: 1 | -1): void => {
    const focusOrder: Array<typeof focus> = outline.entries.length > 0
      ? ["preview", "outline", "actions"]
      : ["preview", "actions"];
    const currentIndex = focusOrder.indexOf(focus);
    focus = focusOrder[(currentIndex + direction + focusOrder.length) % focusOrder.length];
    if (focus === "outline") enterOutline();
    requestRender();
  };
  const outlineRow = (entry: PlanOutlineEntry, current: number | undefined, width: number): string => {
    const selectedGlyph = entry.index === selectedHeadingIndex ? theme.fg("accent", "▶") : " ";
    const currentGlyph = entry.index === current ? theme.fg("muted", "•") : " ";
    const indent = " ".repeat((entry.depth - 1) * 2);
    return padToWidth(`${selectedGlyph}${currentGlyph} ${indent}${theme.fg("text", entry.text)}`, width);
  };
  const compact = (width: number): string[] => {
    const compactWidth = Math.max(1, width);
    const rendered = markdown.render(compactWidth).map((line) => clearPlanOutlineMarkers(line, outline.entries));
    const current = currentHeadingIndex();
    const body = focus === "outline" && outline.entries.length > 0
      ? outline.entries.map((entry) => outlineRow(entry, current, compactWidth))
      : rendered;
    const action = PLAN_REVIEW_ACTIONS[selectedIndex];
    const actionStyle = PLAN_REVIEW_ACTION_STYLES[selectedIndex];
    return [
      theme.fg("mdHeading", truncateToWidth(`PLAN REVIEW · ${focus.toUpperCase()}`, compactWidth)),
      ...body.slice(0, Math.max(1, tui.terminal.rows - 3)).map((line) => truncateToWidth(line, compactWidth)),
      truncateToWidth(
        `${focus === "actions" ? theme.fg("accent", "▶") : theme.fg("muted", "▷")} ${theme.fg(actionStyle.color, action)}`,
        compactWidth,
      ),
      theme.fg("muted", truncateToWidth("Tab focus · Enter execute · c copy · Esc stay", compactWidth)),
    ];
  };

  return {
    render(width: number): string[] {
      if (width < 20) return compact(width);
      const innerWidth = width;
      const split = width >= 72 && outline.entries.length > 0;
      const outlineWidth = split ? Math.max(22, Math.min(30, Math.floor(innerWidth * 0.28))) : 0;
      const previewWidth = split ? innerWidth - outlineWidth - 1 : innerWidth;
      const contentWidth = Math.max(1, previewWidth - 3);
      const markedLines = markdown.render(contentWidth);
      headingTargets = outline.entries.map((entry) => {
        const target = markedLines.findIndex((line) => line.includes(entry.marker));
        return target >= 0 ? target : undefined;
      });
      const previewLines = markedLines.map((line) => clearPlanOutlineMarkers(line, outline.entries));
      const narrowOutline = !split && focus === "outline" && outline.entries.length > 0;
      const reservedRows = PLAN_REVIEW_ACTIONS.length + 7;
      pageSize = Math.max(0, tui.terminal.rows - reservedRows);
      outlinePageSize = Math.max(1, pageSize - (split ? 1 : 0));
      maxScrollOffset = Math.max(0, previewLines.length - pageSize);
      scrollOffset = Math.min(scrollOffset, maxScrollOffset);
      ensureOutlineSelectionVisible();
      const current = currentHeadingIndex();
      const visible = narrowOutline
        ? outline.entries
            .slice(outlineScrollOffset, outlineScrollOffset + pageSize)
            .map((entry) => outlineRow(entry, current, contentWidth))
        : previewLines.slice(scrollOffset, scrollOffset + pageSize);
      const viewportTotal = narrowOutline ? outline.entries.length : previewLines.length;
      const viewportOffset = narrowOutline ? outlineScrollOffset : scrollOffset;
      const firstLine = previewLines.length === 0 ? 0 : scrollOffset + 1;
      const lastLine = scrollOffset + Math.min(pageSize, Math.max(0, previewLines.length - scrollOffset));
      const divider = theme.fg("borderMuted", "─".repeat(width));
      const title = padToWidth(
        ` ${theme.fg("mdHeading", theme.bold("Plan review"))} ${theme.fg("muted", "·")} ${theme.fg("warning", "Awaiting approval")} ${theme.fg("muted", "·")} ${focus}`,
        width,
      );
      const subtitle = padToWidth(
        ` ${theme.fg("muted", `Review the complete plan · Outline ${outline.entries.length} heading${outline.entries.length === 1 ? "" : "s"} · Nothing runs until you confirm Execute.`)}`,
        width,
      );
      const lines = [title, subtitle, divider];
      const splitDivider = theme.fg("borderMuted", focus === "outline" ? "┊" : "│");

      for (let row = 0; row < pageSize; row += 1) {
        const preview = padToWidth(visible[row] ?? "", contentWidth);
        const previewCell = ` ${preview} ${scrollbarGlyph(row, pageSize, viewportTotal, viewportOffset, theme)}`;
        if (!split) {
          lines.push(previewCell);
          continue;
        }
        const outlineCell = row === 0
          ? padToWidth(
              `${focus === "outline" ? theme.fg("accent", "›") : " "} ${theme.bold("Outline")}`,
              outlineWidth,
            )
          : (() => {
              const entry = outline.entries[outlineScrollOffset + row - 1];
              return entry ? outlineRow(entry, current, outlineWidth) : " ".repeat(outlineWidth);
            })();
        lines.push(`${outlineCell}${splitDivider}${previewCell}`);
      }

      const breadcrumb = current === undefined ? "No heading at viewport" : outline.entries[current].text;
      const positionStatus = focus === "outline"
        ? ` Outline · ${outline.entries.length === 0 ? "no headings" : `${selectedHeadingIndex + 1}/${outline.entries.length}`} · ↑↓ select · Enter jump`
        : previewLines.length > pageSize
          ? ` ${focus[0].toUpperCase()}${focus.slice(1)} · ${breadcrumb} · Lines ${firstLine}–${lastLine} of ${previewLines.length}`
          : ` ${focus[0].toUpperCase()}${focus.slice(1)} · ${breadcrumb}`;
      const status = copyNotice?.text ?? positionStatus;
      const statusColor = copyNotice?.color ?? "accent";
      lines.push(padToWidth(theme.fg(statusColor, status), width), divider);
      lines.push(padToWidth(theme.fg("muted", " Actions"), width));

      for (let index = 0; index < PLAN_REVIEW_ACTIONS.length; index += 1) {
        const selected = index === selectedIndex;
        const style = PLAN_REVIEW_ACTION_STYLES[index];
        const label = `${selected ? theme.fg("accent", "›") : " "} ${theme.fg(style.color, style.marker)} ${index + 1}. ${PLAN_REVIEW_ACTIONS[index]}`;
        lines.push(padToWidth(selected ? theme.bold(label) : label, width));
      }

      const hint = focus === "preview"
        ? " Preview · ↑↓ scroll · Tab focus · ←→ actions · c copy · Enter execute · Esc stay"
        : focus === "outline"
          ? " Outline · ↑↓ select · PgUp/PgDn/Home/End · Enter jump · Tab focus · Esc stay"
          : " Actions · ↑↓ choose · ←→ actions · Tab focus · c copy · Enter confirm · Esc stay";
      lines.push(padToWidth(theme.fg("muted", hint), width));
      return lines;
    },
    handleInput(data: string): void {
      if (keybindings.matches(data, "tui.select.cancel")) {
        finish(undefined);
        return;
      }
      if (matchesKey(data, "c")) {
        copyPlan();
        return;
      }
      if (matchesKey(data, "shift+tab")) {
        cycleFocus(-1);
        return;
      }
      if (matchesKey(data, "tab")) {
        cycleFocus(1);
        return;
      }
      if (matchesKey(data, "left") || matchesKey(data, "right")) {
        focus = "actions";
        selectBy(matchesKey(data, "left") ? -1 : 1);
        return;
      }
      if (focus === "outline") {
        if (keybindings.matches(data, "tui.select.up")) {
          selectHeading(selectedHeadingIndex - 1);
          return;
        }
        if (keybindings.matches(data, "tui.select.down")) {
          selectHeading(selectedHeadingIndex + 1);
          return;
        }
        if (keybindings.matches(data, "tui.select.pageUp")) {
          selectHeading(selectedHeadingIndex - outlinePageSize);
          return;
        }
        if (keybindings.matches(data, "tui.select.pageDown")) {
          selectHeading(selectedHeadingIndex + outlinePageSize);
          return;
        }
        if (matchesKey(data, "home")) {
          selectHeading(0);
          return;
        }
        if (matchesKey(data, "end")) {
          selectHeading(outline.entries.length - 1);
          return;
        }
        if (keybindings.matches(data, "tui.select.confirm")) {
          const target = headingTargets[selectedHeadingIndex];
          if (target !== undefined) {
            scrollOffset = Math.min(target, maxScrollOffset);
            focus = "preview";
          }
          requestRender();
          return;
        }
        return;
      }
      if (focus === "actions") {
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
          requestRender();
          return;
        }
        if (matchesKey(data, "end")) {
          selectedIndex = PLAN_REVIEW_ACTIONS.length - 1;
          requestRender();
          return;
        }
      } else {
        if (keybindings.matches(data, "tui.select.up")) {
          scrollBy(-1);
          return;
        }
        if (keybindings.matches(data, "tui.select.down")) {
          scrollBy(1);
          return;
        }
        if (matchesKey(data, "home")) {
          scrollBy(-maxScrollOffset);
          return;
        }
        if (matchesKey(data, "end")) {
          scrollBy(maxScrollOffset);
          return;
        }
        if (keybindings.matches(data, "tui.select.pageUp")) {
          scrollBy(-pageSize);
          return;
        }
        if (keybindings.matches(data, "tui.select.pageDown")) {
          scrollBy(pageSize);
          return;
        }
      }
      if (keybindings.matches(data, "tui.select.confirm")) {
        const action = PLAN_REVIEW_ACTIONS[selectedIndex];
        if (action === "Copy plan") copyPlan();
        else finish(action);
      }
    },
    invalidate(): void {
      markdown.invalidate();
    },
    dispose(): void {
      disposed = true;
    },
  };
}

export function requestPlanReview(
  ctx: ExtensionContext,
  plan: PlanState,
  copyText: (text: string) => Promise<void> = copyToClipboard,
): Promise<PlanReviewDecision | undefined> {
  return ctx.ui.custom<PlanReviewDecision | undefined>((tui, theme, keybindings, done) =>
    createReviewComponent({ tui, theme, keybindings, plan, copyText, done })
  );
}
