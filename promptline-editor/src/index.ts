import {
	createReadToolDefinition,
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
	type ReadToolDetails,
	type ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth, Text } from "@earendil-works/pi-tui";
import { relative, resolve } from "node:path";
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
const readToolCache = new Map<
	string,
	ReturnType<typeof createReadToolDefinition>
>();

function getReadTool(cwd: string) {
	let tool = readToolCache.get(cwd);
	if (!tool) {
		tool = createReadToolDefinition(cwd);
		readToolCache.set(cwd, tool);
	}
	return tool;
}
function shortenReadPath(path: string, cwd?: string): string {
	const absolutePath = cwd ? resolve(cwd, path) : resolve(path);
	let display = path;
	let relativeMatched = false;
	if (cwd) {
		const relativePath = relative(cwd, absolutePath);
		if (
			relativePath &&
			!relativePath.startsWith("..") &&
			relativePath !== "."
		) {
			display = relativePath;
			relativeMatched = true;
		}
	}
	const home = process.env.HOME;
	if (!relativeMatched && home && absolutePath.startsWith(home))
		display = `~${absolutePath.slice(home.length)}`;
	const normalized = display.replace(/\\/g, "/");
	const parts = normalized.split("/").filter(Boolean);
	const prefix = normalized.startsWith("~/")
		? "~/"
		: normalized.startsWith("/")
			? "/"
			: "";
	if (parts.length > 4) display = `…/${parts.slice(-4).join("/")}`;
	else display = `${prefix}${parts.join("/")}` || normalized;
	if (visibleWidth(display) <= 56) return display;
	return `…${display.slice(-55).replace(/^\//, "")}`;
}

function formatReadLineRange(args: Record<string, unknown>): string {
	const offset = typeof args.offset === "number" ? args.offset : undefined;
	const limit = typeof args.limit === "number" ? args.limit : undefined;
	if (offset === undefined && limit === undefined) return "";
	const start = offset ?? 1;
	if (limit === undefined) return `:${start}`;
	return `:${start}-${start + limit - 1}`;
}

function getReadTargets(args: Record<string, unknown>, cwd?: string): string[] {
	const lineRange = formatReadLineRange(args);
	const rawPaths = Array.isArray(args.path)
		? args.path.filter((value): value is string => typeof value === "string")
		: typeof args.path === "string"
			? [args.path]
			: typeof args.file_path === "string"
				? [args.file_path]
				: [];
	if (rawPaths.length === 0) return ["..."];
	return rawPaths.map(
		(rawPath) => `${shortenReadPath(rawPath, cwd)}${lineRange}`,
	);
}

function registerCompactReadTool(pi: ExtensionAPI): void {
	const baseTool = getReadTool(process.cwd());
	pi.registerTool({
		name: "read",
		label: "read",
		description: baseTool.description,
		promptSnippet: baseTool.promptSnippet,
		promptGuidelines: baseTool.promptGuidelines,
		parameters: baseTool.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getReadTool(ctx.cwd).execute(
				toolCallId,
				params,
				signal,
				onUpdate,
				ctx,
			);
		},
		renderCall(_args, _theme, context) {
			return (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			const text =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const args = (context.args ?? {}) as Record<string, unknown>;
			const targets = getReadTargets(args, context.cwd);
			const content = result.content.find((item) => item.type === "text");
			const body = content?.type === "text" ? content.text : "";
			const hasImage = result.content.some((item) => item.type === "image");
			const details = result.details as ReadToolDetails | undefined;
			const header =
				targets.length === 1
					? `${theme.fg("dim", "read")} ${theme.fg("accent", targets[0])}`
					: `${theme.fg("dim", "read")} ${theme.fg("accent", `${targets.length} paths`)}`;
			let summary = header;

			if (isPartial) {
				text.setText(`${summary}${theme.fg("muted", " …")}`);
				return text;
			}

			if (hasImage) summary += theme.fg("muted", " · image");
			if (body)
				summary += theme.fg("muted", ` · ${body.split("\n").length} lines`);
			if (details?.truncation?.truncated)
				summary += theme.fg("warning", " · truncated");
			if (context.isError) summary += theme.fg("error", " · error");
			if (targets.length > 1) {
				const listedTargets = targets
					.slice(0, expanded ? targets.length : 4)
					.map(
						(target) =>
							`${theme.fg("dim", "  · ")}${theme.fg("accent", target)}`,
					);
				summary += `\n${listedTargets.join("\n")}`;
				if (!expanded && targets.length > 4)
					summary += `\n${theme.fg("muted", `  … ${targets.length - 4} more`)}`;
			}
			if (!expanded || !body) {
				text.setText(summary);
				return text;
			}

			const preview = body
				.split("\n")
				.slice(0, 8)
				.map((line) => theme.fg(context.isError ? "error" : "dim", line))
				.join("\n");
			text.setText(`${summary}\n${preview}`);
			return text;
		},
	});
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
	registerCompactReadTool(pi);

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
