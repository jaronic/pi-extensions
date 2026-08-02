import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Pure rendering helpers for the jaron terminal banner, hint bar and
 * window title. Color functions are injected so these stay free of any
 * global theme/keybinding state and can be unit-tested directly.
 */

export function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

export function fitToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	const fitted =
		visibleWidth(text) > width ? truncateToWidth(text, width, "") : text;
	return `${fitted}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}`;
}

export function cwdDisplay(cwd: string): string {
	const home = process.env.HOME;
	if (home && cwd.startsWith(home)) return `~${cwd.slice(home.length)}`;
	return cwd;
}

export function compactCwd(cwd: string): string {
	const display = cwdDisplay(cwd);
	const parts = display.split("/").filter(Boolean);
	if (display.startsWith("~/") && parts.length > 3)
		return `~/${parts.slice(-3).join("/")}`;
	if (parts.length > 4) return `…/${parts.slice(-4).join("/")}`;
	return display;
}

/**
 * Join hint chips with a separator, dropping trailing chips when the joined
 * line exceeds `width` and truncating the remainder with an ellipsis.
 * Leading chips are preserved because they carry the most important hints.
 */
export function fitChips(
	chips: string[],
	width: number,
	separator: string,
	dim: (value: string) => string,
): string {
	if (width <= 0 || chips.length === 0) return "";
	const sep = dim(separator);
	const joined = chips.join(sep);
	if (visibleWidth(joined) <= width) return joined;
	for (let keep = chips.length - 1; keep >= 1; keep -= 1) {
		const candidate = `${chips.slice(0, keep).join(sep)}${sep}`;
		if (visibleWidth(candidate) <= width) {
			return `${truncateToWidth(candidate, width - 1, "")}${dim("…")}`;
		}
	}
	return truncateToWidth(chips[0] ?? "", width, "…");
}

/**
 * Greedy-wrap chips into multiple lines, each no wider than `width`.
 * A single chip wider than `width` is truncated in place.
 */
export function wrapChips(
	chips: string[],
	width: number,
	separator: string,
	dim: (value: string) => string,
): string[] {
	if (width <= 0 || chips.length === 0) return [""];
	const sep = dim(separator);
	const lines: string[] = [];
	let current: string[] = [];
	const flush = (): void => {
		if (current.length > 0) lines.push(current.join(sep));
		current = [];
	};
	for (const raw of chips) {
		const chip =
			visibleWidth(raw) > width ? truncateToWidth(raw, width, "…") : raw;
		if (current.length === 0) {
			current.push(chip);
		} else if (visibleWidth(`${current.join(sep)}${sep}${chip}`) <= width) {
			current.push(chip);
		} else {
			flush();
			current.push(chip);
		}
	}
	flush();
	return lines.length > 0 ? lines : [""];
}

export interface RecentSession {
	/** Pre-formatted local time, e.g. `08-02 08:23`. */
	time: string;
	/** Plain session summary (first message or name); may be empty. */
	summary: string;
}

export interface HeaderOptions {
	/** Pre-colored brand text shown in the top border, e.g. `pi v0.83.0`. */
	brand: string;
	/** Display path shown in the bottom border (compactCwd applied by caller). */
	cwd: string;
	/** Optional git branch shown in the bottom border. */
	branch?: string;
	/** Pre-colored hint chips for the collapsed banner. */
	collapsedHints: string[];
	/** Pre-colored hint chips for the expanded banner. */
	expandedHints: string[];
	/** Pre-colored hint text shown on its own line in the collapsed banner. */
	expandHint: string;
	/** Recent sessions rendered as one list row each; omitted when empty. */
	recentSessions: RecentSession[];
	border: (value: string) => string;
	dim: (value: string) => string;
	muted: (value: string) => string;
	accent: (value: string) => string;
}

export interface HeaderLines {
	collapsed: string[];
	expanded: string[];
}

function borderLine(
	left: string,
	label: string,
	right: string,
	width: number,
	border: (value: string) => string,
): string {
	const inner = Math.max(0, width - 2);
	const fitted =
		visibleWidth(label) > inner ? truncateToWidth(label, inner, "") : label;
	const fill = border("─".repeat(Math.max(0, inner - visibleWidth(fitted))));
	return `${border(left)}${fitted}${fill}${border(right)}`;
}

export function formatSessionTime(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Row budget for the recent-sessions list: wider terminals get more rows,
 * the expanded banner one more than the collapsed form.
 */
export function recentRowBudget(width: number, expanded: boolean): number {
	if (width < 40) return 0;
	const base = width >= 100 ? 3 : width >= 70 ? 2 : 1;
	return expanded ? base + 1 : base;
}

/**
 * Build the terminal-style banner lines: brand in the top border, hint
 * chips in the body, path/branch in the bottom border. Every returned
 * line is at most `width` columns.
 */
export function buildHeaderLines(
	options: HeaderOptions,
	width: number,
): HeaderLines {
	if (width < 4) return { collapsed: [], expanded: [] };
	const { brand, cwd, branch, collapsedHints, expandedHints, expandHint, recentSessions, border, dim, muted, accent } =
		options;
	const inner = width - 2;
	const chipsWidth = Math.max(0, inner - 2);
	const bodyLine = (content: string): string =>
		`${border("│")}${fitToWidth(` ${content} `, inner)}${border("│")}`;
	const top = borderLine("╭", `${border("─")} ${brand} `, "╮", width, border);
	const bottomLabel = `${border("─")} ${accent(cwd)}${
		branch ? ` ${dim("·")} ${dim(branch)}` : ""
	} `;
	const bottom = borderLine("╰", bottomLabel, "╯", width, border);

	const recentRows = (expanded: boolean): string[] => {
		const budget = recentRowBudget(width, expanded);
		const rows: string[] = [];
		for (const entry of recentSessions.slice(0, budget)) {
			const prefix = `${dim("◷")} ${dim(entry.time)}`;
			const summaryWidth = Math.max(0, chipsWidth - visibleWidth(prefix) - 1);
			const summary = entry.summary.trim()
				? muted(
						truncateToWidth(
							entry.summary.replace(/\s+/g, " ").trim(),
							summaryWidth,
							"…",
						),
					)
				: dim("(empty session)");
			rows.push(bodyLine(`${prefix} ${summary}`));
		}
		return rows;
	};

	const collapsedBody: string[] = [];
	const collapsedChips = fitChips(collapsedHints, chipsWidth, " · ", dim);
	if (collapsedChips) collapsedBody.push(bodyLine(collapsedChips));
	collapsedBody.push(...recentRows(false));
	collapsedBody.push(bodyLine(expandHint));

	const expandedBody =
		expandedHints.length === 0
			? []
			: wrapChips(expandedHints, chipsWidth, " · ", dim).map(bodyLine);
	expandedBody.push(...recentRows(true));

	return {
		collapsed: [top, ...collapsedBody, bottom],
		expanded: [top, ...expandedBody, bottom],
	};
}
export interface TerminalTitleOptions {
	cwd: string;
	branch?: string;
	sessionName?: string;
}

/**
 * Window title in the form `pi — <branch> — <session> — <cwd basename>`.
 * Optional segments are omitted when absent.
 */
export function buildTerminalTitle({
	cwd,
	branch,
	sessionName,
}: TerminalTitleOptions): string {
	const parts: string[] = [];
	if (branch) parts.push(branch);
	if (sessionName) parts.push(sessionName);
	const basename = cwd.split(/[\\/]/).filter(Boolean).at(-1);
	parts.push(basename ?? cwd);
	return `pi — ${parts.join(" — ")}`;
}
