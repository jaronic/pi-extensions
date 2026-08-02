import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type ReadonlyFooterDataProvider,
	SessionManager,
	VERSION,
	keyHint,
	keyText,
	rawKeyHint,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { tone } from "pi-uikit-dev";
import {
	buildHeaderLines,
	buildTerminalTitle,
	compactCwd,
	fitToWidth,
	formatSessionTime,
	stripAnsi,
	type HeaderOptions,
	type RecentSession,
} from "./banner.ts";
import { BranchMonitor } from "./branch.ts";

const SPINNER = ["◐", "◓", "◑", "◒"];

function isHorizontalBorderLine(line: string, width: number): boolean {
	const plain = stripAnsi(line);
	if (visibleWidth(plain) !== width) return false;
	return /^─+$/.test(plain) || /^─── [↑↓] \d+ more ─*$/.test(plain);
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

/**
 * Startup banner above the chat: brand in the top border, hint chips in
 * the body, path/branch in the bottom border, recent sessions as a list.
 * Implements `setExpanded` so the core `app.tools.expand` toggle drives
 * collapsed/expanded variants.
 */
class JaronHeader implements Component {
	private expanded = false;

	constructor(
		private readonly getOptions: () => HeaderOptions,
		private readonly tui: TUI,
	) {}

	render(width: number): string[] {
		const lines = buildHeaderLines(this.getOptions(), width);
		return this.expanded ? lines.expanded : lines.collapsed;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.tui.requestRender();
	}

	invalidate(): void {}
}

export default function jaronEditor(pi: ExtensionAPI): void {
	let activeTui: TUI | undefined;
	let working = false;
	let spinnerIndex = 0;
	let timer: NodeJS.Timeout | undefined;
	let branch: string | undefined;
	let branchMonitor: BranchMonitor | undefined;
	let footerData: ReadonlyFooterDataProvider | undefined;
	let loadRecentSessions: (() => void) | undefined;
	let recentSessions: RecentSession[] = [];
	let applyTitle: (() => void) | undefined;

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

	pi.on("session_info_changed", () => {
		applyTitle?.();
		loadRecentSessions?.();
		requestRender();
	});

	pi.on("session_shutdown", () => {
		branchMonitor?.stop();
		branchMonitor = undefined;
		branch = undefined;
		recentSessions = [];
		loadRecentSessions = undefined;
		applyTitle = undefined;
		stopTimer();
		activeTui = undefined;
		footerData = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setFooter((_tui, _theme, data) => {
			footerData = data;
			return new EmptyFooter();
		});

		ctx.ui.setHeader((tui, theme) =>
			new JaronHeader(
				() => ({
					brand: `${tone(theme, "accent", "pi", { bold: "outer" })}${tone(theme, "dim", ` v${VERSION}`)}`,
					cwd: compactCwd(ctx.cwd),
					branch,
					collapsedHints: [
						keyHint("tui.input.submit", "to send"),
						rawKeyHint("/", "for commands"),
						rawKeyHint("!", "to run bash"),
					],
					expandedHints: [
						keyHint("app.interrupt", "to interrupt"),
						keyHint("app.clear", "to clear"),
						keyHint("app.exit", "to exit (empty)"),
						keyHint("app.suspend", "to suspend"),
						keyHint("app.thinking.cycle", "to cycle thinking"),
						keyHint("app.model.cycleForward", "to cycle models"),
						keyHint("app.model.select", "to select model"),
						keyHint("app.tools.expand", "to expand tools"),
						keyHint("app.thinking.toggle", "to expand thinking"),
						keyHint("app.editor.external", "for external editor"),
						keyHint("app.message.followUp", "to queue follow-up"),
						keyHint("app.clipboard.pasteImage", "to paste image"),
					],
					expandHint: tone(
						theme,
						"dim",
						`press ${keyText("app.tools.expand")} to show full startup help`,
					),
					recentSessions,
					border: (value) => tone(theme, "warning", value),
					dim: (value) => tone(theme, "dim", value),
					muted: (value) => tone(theme, "muted", value),
					accent: (value) => tone(theme, "accent", value),
				}),
				tui,
			),
		);

		const thm = ctx.ui.theme;
		ctx.ui.setWorkingIndicator({
			frames: [
				tone(thm, "warning", "◐"),
				tone(thm, "warning", "◓"),
				tone(thm, "warning", "◑"),
				tone(thm, "warning", "◒"),
			],
			intervalMs: 120,
		});
		ctx.ui.setHiddenThinkingLabel("⋯ thinking (expand to view)");

		loadRecentSessions = () => {
			SessionManager.list(ctx.cwd)
				.then((sessions) => {
					const current = ctx.sessionManager.getSessionFile();
					recentSessions = sessions
						.filter((session) => session.path !== current)
						.slice(0, 5)
						.map((session) => ({
							time: formatSessionTime(session.modified),
							summary: session.firstMessage || session.name || "",
						}));
					requestRender();
				})
				.catch(() => {
					recentSessions = [];
				});
		};
		loadRecentSessions();

		applyTitle = () => {
			ctx.ui.setTitle(
				buildTerminalTitle({
					cwd: ctx.cwd,
					branch,
					sessionName: pi.getSessionName(),
				}),
			);
		};
		applyTitle();

		branchMonitor?.stop();
		branchMonitor = new BranchMonitor({
			runGit: async (args, cwd) => {
				const result = await pi.exec("git", args, { cwd, timeout: 2000 });
				return result.stdout;
			},
			onBranch: (value) => {
				branch = value;
				applyTitle?.();
				requestRender();
			},
		});
		void branchMonitor.start(ctx.cwd);

		class JaronEditor extends CustomEditor {
			constructor(
				tui: TUI,
				theme: EditorTheme,
				keybindings: KeybindingsManager,
			) {
				const thm = ctx.ui.theme;
				const jaronTheme: EditorTheme = {
					...theme,
					borderColor: (value: string) => tone(thm, "warning", value),
					selectList: {
						...theme.selectList,
						selectedPrefix: (value: string) =>
							tone(thm, "warning", value, { bold: true }),
						selectedText: (value: string) => tone(thm, "warning", value, { bold: true }),
						description: (value: string) => tone(thm, "muted", value, { bold: true }),
						scrollInfo: (value: string) => tone(thm, "accent", value),
						noMatch: (value: string) => tone(thm, "warning", value, { bold: true }),
					},
				};
				super(tui, jaronTheme, keybindings, { paddingX: 1 });
				this.borderColor = jaronTheme.borderColor;
				activeTui = tui;
			}

			render(width: number): string[] {
				if (width < 6) return super.render(width);

				const innerWidth = width - 2;
				const lines = super.render(innerWidth);
				if (lines.length < 2) return lines;

				const thm = ctx.ui.theme;
				const border = (value: string) => this.borderColor(value);
				const dim = (value: string) => tone(thm, "dim", value);
				const accent = (value: string) => tone(thm, "accent", value);
				const amber = (value: string) => tone(thm, "warning", value);

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
				const statusSeparator = dim(" · ");
				const sessionName = pi.getSessionName();
				const sessionLabel = sessionName
					? `${dim(`◈ ${sessionName}`)}${statusSeparator}`
					: "";
				const contextWindow = `${working ? amber(`${SPINNER[spinnerIndex]} `) : ""}${sessionLabel}${dim(`ctx ${formatContext(ctx)}`)}`;
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
				new JaronEditor(tui, theme, keybindings),
		);
	});
}
