import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { BranchMonitor } from "./branch.ts";

const SPINNER = ["◐", "◓", "◑", "◒"];

function cwdDisplay(cwd: string): string {
	const home = process.env.HOME;
	if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

function compactCwd(cwd: string): string {
	const display = cwdDisplay(cwd);
	const parts = display.split("/").filter(Boolean);
	if (display.startsWith("~/") && parts.length > 3)
		return `~/${parts.slice(-3).join("/")}`;
	if (parts.length > 4) return `…/${parts.slice(-4).join("/")}`;
	return display;
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function isHorizontalBorderLine(line: string, width: number): boolean {
	const plain = stripAnsi(line);
	if (visibleWidth(plain) !== width) return false;
	return /^─+$/.test(plain) || /^─── [↑↓] \d+ more ─*$/.test(plain);
}

function fitToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	const fitted =
		visibleWidth(text) > width ? truncateToWidth(text, width, "") : text;
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

interface StatusLineLayout {
	left: string;
	middle: string;
	right: string;
	separator: string;
	width: number;
}

function fitStatusLine({
	left,
	middle,
	right,
	separator,
	width,
}: StatusLineLayout): string {
	if (width <= 0) return "";

	let leftText = left;
	let middleText = middle;
	let rightText = right;
	const buildLine = () =>
		` ${[leftText, middleText, rightText].filter((item) => visibleWidth(item) > 0).join(separator)}`;
	const shrink = (text: string, overflow: number) => {
		const targetWidth = Math.max(0, visibleWidth(text) - overflow);
		if (targetWidth === 0) return "";
		return truncateToWidth(text, targetWidth, targetWidth > 1 ? "…" : "");
	};

	let line = buildLine();
	let overflow = Math.max(0, visibleWidth(line) - width);
	if (overflow > 0) {
		middleText = shrink(middleText, overflow);
		line = buildLine();
		overflow = Math.max(0, visibleWidth(line) - width);
	}
	if (overflow > 0) {
		leftText = shrink(leftText, overflow);
		line = buildLine();
		overflow = Math.max(0, visibleWidth(line) - width);
	}
	if (overflow > 0) {
		rightText = shrink(rightText, overflow);
		line = buildLine();
	}
	return fitToWidth(line, width);
}

function formatTokenCount(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return String(tokens);
}

function formatContext(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
	if (!contextWindow) return "?";
	const window = formatTokenCount(contextWindow);
	if (!usage || usage.percent === null) return `?/${window}`;
	return `${usage.percent.toFixed(1)}%/${window}`;
}

function formatModel(ctx: ExtensionContext): string {
	if (!ctx.model) return "no-model";
	return ctx.model.id;
}
function getModeStatus(
	footerData: ReadonlyFooterDataProvider | undefined,
	key: "plan" | "goal",
): string | undefined {
	const text = footerData?.getExtensionStatuses().get(key)?.trim();
	return text || undefined;
}

function renderTopBorder(
	status: string | undefined,
	width: number,
	border: (value: string) => string,
): string {
	const requestedLabel = status ? `${border("─")} ${status} ` : "";
	const label = visibleWidth(requestedLabel) > width
		? truncateToWidth(requestedLabel, width, "")
		: requestedLabel;
	const fill = border("─".repeat(Math.max(0, width - visibleWidth(label))));
	return `${border("╭")}${label}${fill}${border("╮")}`;
}

class EmptyFooter implements Component {
	render(): string[] {
		return [];
	}

	invalidate(): void {}
}

export default function promptlineEditor(pi: ExtensionAPI): void {
	let activeTui: TUI | undefined;
	let working = false;
	let spinnerIndex = 0;
	let timer: NodeJS.Timeout | undefined;
	let branch: string | undefined;
	let branchMonitor: BranchMonitor | undefined;
	let footerData: ReadonlyFooterDataProvider | undefined;

	function stopTimer(): void {
		if (!timer) return;
		clearInterval(timer);
		timer = undefined;
	}

	function requestRender(): void {
		activeTui?.requestRender();
	}

	pi.on("agent_start", () => {
		working = true;
		stopTimer();
		timer = setInterval(() => {
			spinnerIndex = (spinnerIndex + 1) % SPINNER.length;
			requestRender();
		}, 120);
		requestRender();
	});

	pi.on("agent_end", () => {
		working = false;
		stopTimer();
		requestRender();
	});

	pi.on("model_select", () => requestRender());
	pi.on("thinking_level_select", () => requestRender());

	pi.on("session_shutdown", () => {
		branchMonitor?.stop();
		branchMonitor = undefined;
		branch = undefined;
		stopTimer();
		activeTui = undefined;
		footerData = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setFooter((_tui, _theme, data) => {
			footerData = data;
			return new EmptyFooter();
		});

		branchMonitor?.stop();
		branchMonitor = new BranchMonitor({
			runGit: async (args, cwd) => {
				const result = await pi.exec("git", args, { cwd, timeout: 2000 });
				return result.stdout;
			},
			onBranch: (value) => {
				branch = value;
				requestRender();
			},
		});
		void branchMonitor.start(ctx.cwd);

		class PromptlineEditor extends CustomEditor {
			constructor(
				tui: TUI,
				theme: EditorTheme,
				keybindings: KeybindingsManager,
			) {
				const thm = ctx.ui.theme;
				const promptlineTheme: EditorTheme = {
					...theme,
					borderColor: (value: string) => thm.fg("warning", value),
					selectList: {
						...theme.selectList,
						selectedPrefix: (value: string) =>
							thm.fg("warning", thm.bold(value)),
						selectedText: (value: string) => thm.fg("warning", thm.bold(value)),
						description: (value: string) => thm.fg("muted", thm.bold(value)),
						scrollInfo: (value: string) => thm.fg("accent", value),
						noMatch: (value: string) => thm.fg("warning", thm.bold(value)),
					},
				};
				super(tui, promptlineTheme, keybindings, { paddingX: 1 });
				this.borderColor = promptlineTheme.borderColor;
				activeTui = tui;
			}

			render(width: number): string[] {
				if (width < 6) return super.render(width);

				const innerWidth = width - 2;
				const lines = super.render(innerWidth);
				if (lines.length < 2) return lines;

				const thm = ctx.ui.theme;
				const border = (value: string) => this.borderColor(value);
				const dim = (value: string) => thm.fg("dim", value);
				const accent = (value: string) => thm.fg("accent", value);
				const amber = (value: string) => thm.fg("warning", value);

				const bottomBorderIndex = this.isShowingAutocomplete()
					? lines.findIndex(
							(line, index) =>
								index > 0 && isHorizontalBorderLine(line, innerWidth),
						)
					: lines.length - 1;
				if (bottomBorderIndex < 1) return lines;

				const planStatus = getModeStatus(footerData, "plan");
				const goalStatus = getModeStatus(footerData, "goal");
				lines[0] = renderTopBorder(goalStatus, innerWidth, border);
				for (let index = 1; index < bottomBorderIndex; index += 1) {
					lines[index] =
						`${border("│")}${fitToWidth(lines[index], innerWidth)}${border("│")}`;
				}
				lines[bottomBorderIndex] =
					`${border("╰")}${fitToWidth(lines[bottomBorderIndex], innerWidth)}${border("╯")}`;
				for (
					let index = bottomBorderIndex + 1;
					index < lines.length;
					index += 1
				) {
					lines[index] = ` ${fitToWidth(lines[index], innerWidth)} `;
				}

				const project = `${accent(compactCwd(ctx.cwd))}${branch ? dim(` (${branch})`) : ""}`;
				const contextWindow = `${working ? amber(`${SPINNER[spinnerIndex]} `) : ""}${dim(`▣ ctx ${formatContext(ctx)}`)}`;
				const statusSeparator = dim(" · ");
				const statusLeft = [
					amber(`⬢ ${formatModel(ctx)}`),
					amber(pi.getThinkingLevel()),
					...(planStatus ? [planStatus] : []),
				].join(statusSeparator);
				lines.splice(
					bottomBorderIndex + 1,
					0,
					fitStatusLine({
						left: statusLeft,
						middle: project,
						right: contextWindow,
						separator: statusSeparator,
						width,
					}),
				);
				return lines;
			}
		}

		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) =>
				new PromptlineEditor(tui, theme, keybindings),
		);
	});
}
