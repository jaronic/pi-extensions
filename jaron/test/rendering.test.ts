import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	buildHeaderLines,
	buildTerminalTitle,
	compactCwd,
	fitChips,
	formatSessionTime,
	recentRowBudget,
	stripAnsi,
} from "../src/banner.ts";

const amber = (value: string) => `\x1b[33m${value}\x1b[0m`;
const dim = (value: string) => `\x1b[2m${value}\x1b[0m`;
const accent = (value: string) => `\x1b[36m${value}\x1b[0m`;
const muted = (value: string) => `\x1b[90m${value}\x1b[0m`;

function headerOptions() {
	return {
		brand: "pi v1.0.0",
		cwd: "~/proj",
		branch: "main",
		collapsedHints: [amber("enter to send"), amber("/ commands")],
		expandedHints: [
			amber("esc to interrupt"),
			amber("ctrl+c to clear"),
			amber("tab to complete"),
			amber("? to search"),
		],
		expandHint: dim("press ? to show full startup help"),
		recentSessions: [
			{ time: "11-20 13:42", summary: "fix jaron rendering" },
			{ time: "11-19 09:15", summary: "add header banner" },
		],
		border: amber,
		dim,
		muted,
		accent,
	};
}

test("buildTerminalTitle omits absent segments", () => {
	assert.equal(
		buildTerminalTitle({ cwd: "/Users/jy/dev/pi-extensions", branch: "main" }),
		"pi — main — pi-extensions",
	);
	assert.equal(
		buildTerminalTitle({ cwd: "/Users/jy/dev/pi-extensions" }),
		"pi — pi-extensions",
	);
	assert.equal(
		buildTerminalTitle({
			cwd: "/Users/jy/dev/pi-extensions",
			branch: "main",
			sessionName: "feat-x",
		}),
		"pi — main — feat-x — pi-extensions",
	);
	assert.equal(buildTerminalTitle({ cwd: "/" }), "pi — /");
	assert.equal(buildTerminalTitle({ cwd: "/a/b/" }), "pi — b");
});


test("fitChips drops trailing chips and truncates with an ellipsis", () => {
	assert.equal(fitChips([], 20, " · ", dim), "");
	const chips = ["aaaa", "bbbb", "cccc"];
	assert.equal(stripAnsi(fitChips(chips, 40, " · ", dim)), "aaaa · bbbb · cccc");

	const narrow = stripAnsi(fitChips(chips, 8, " · ", dim));
	assert.ok(visibleWidth(narrow) <= 8, `overflow: ${narrow}`);
	assert.ok(narrow.startsWith("aaaa"), `leading chip lost: ${narrow}`);
	assert.ok(narrow.endsWith("…"), `ellipsis missing: ${narrow}`);
});

test("buildHeaderLines embeds brand, hints and branch in bordered lines", () => {
	const { collapsed, expanded } = buildHeaderLines(headerOptions(), 60);

	assert.ok(stripAnsi(collapsed[0]).startsWith("╭"), "top border missing");
	assert.ok(stripAnsi(collapsed[0]).includes("pi v1.0.0"), "brand missing");
	assert.ok(stripAnsi(collapsed.at(-1)!).startsWith("╰"), "bottom border missing");
	assert.ok(stripAnsi(collapsed.at(-1)!).includes("main"), "branch missing");
	assert.ok(stripAnsi(collapsed.at(-1)!).includes("~/proj"), "cwd missing");
	assert.ok(
		collapsed.some((line) => stripAnsi(line).includes("enter to send")),
		"collapsed hint missing",
	);
	assert.ok(
		collapsed.some((line) => stripAnsi(line).includes("press ? to show full startup help")),
		"expand hint missing",
	);
	assert.ok(
		expanded.some((line) => stripAnsi(line).includes("esc to interrupt")),
		"expanded hint missing",
	);
	assert.ok(
		expanded.some((line) => stripAnsi(line).includes("tab to complete")),
		"expanded hint missing",
	);
	assert.equal(stripAnsi(collapsed[0]), stripAnsi(expanded[0]), "top border must match");
	assert.ok(
		collapsed.some((line) => stripAnsi(line).includes("fix jaron rendering")),
		"recent summary missing in collapsed",
	);
	assert.ok(
		collapsed.some((line) => stripAnsi(line).includes("11-20 13:42")),
		"recent time missing in collapsed",
	);
	assert.ok(
		expanded.some((line) => stripAnsi(line).includes("add header banner")),
		"recent summary missing in expanded",
	);
	assert.ok(
		!collapsed.some((line) => stripAnsi(line).includes("recent:")),
		"session ids must not leak into the banner",
	);
});

test("buildHeaderLines never overflows at any width", () => {
	for (const width of [8, 12, 20, 40, 80, 120]) {
		const { collapsed, expanded } = buildHeaderLines(headerOptions(), width);
		for (const line of [...collapsed, ...expanded]) {
			assert.ok(
				visibleWidth(line) <= width,
				`overflow at width ${width}: ${JSON.stringify(stripAnsi(line))}`,
			);
		}
	}
});

test("buildHeaderLines handles empty expanded hints, missing branch and no recent sessions", () => {
	const options = {
		...headerOptions(),
		branch: undefined,
		expandedHints: [],
		recentSessions: [],
	};
	const { collapsed, expanded } = buildHeaderLines(options, 40);
	assert.equal(expanded.length, 2, "expanded banner should be top+bottom only");
	assert.ok(!stripAnsi(collapsed.at(-1)!).includes("main"), "branch must be omitted");
	assert.ok(
		!collapsed.some((line) => stripAnsi(line).includes("11-20")),
		"recent rows must be omitted when no sessions",
	);
});

test("compactCwd replaces home and compacts long paths", () => {
	const previous = process.env.HOME;
	process.env.HOME = "/home/user";
	try {
		assert.equal(compactCwd("/home/user/proj"), "~/proj");
		assert.equal(compactCwd("/home/user/a/b/c/d"), "~/b/c/d");
		assert.equal(compactCwd("/opt/a/b/c/d/e"), "…/b/c/d/e");
		assert.equal(compactCwd("/opt/short"), "/opt/short");
	} finally {
		if (previous === undefined) delete process.env.HOME;
		else process.env.HOME = previous;
	}
});

test("recentRowBudget scales with width and expansion", () => {
	assert.equal(recentRowBudget(30, false), 0);
	assert.equal(recentRowBudget(40, false), 1);
	assert.equal(recentRowBudget(70, false), 2);
	assert.equal(recentRowBudget(100, false), 3);
	assert.equal(recentRowBudget(120, true), 4);
	assert.equal(recentRowBudget(80, true), 3);
});

test("formatSessionTime pads local date and time", () => {
	assert.equal(formatSessionTime(new Date(2026, 7, 2, 8, 23)), "08-02 08:23");
	assert.equal(formatSessionTime(new Date(2026, 0, 5, 23, 5)), "01-05 23:05");
});

test("buildHeaderLines caps recent rows by width and falls back for empty summaries", () => {
	const options = {
		...headerOptions(),
		recentSessions: [
			{ time: "08-02 08:23", summary: "first" },
			{ time: "07-31 06:19", summary: "second" },
			{ time: "07-30 09:00", summary: "third" },
			{ time: "07-29 10:00", summary: "fourth" },
		],
	};
	// Narrow terminal: single recent row.
	const narrow = buildHeaderLines(options, 60).collapsed;
	assert.ok(narrow.some((line) => stripAnsi(line).includes("first")));
	assert.ok(!narrow.some((line) => stripAnsi(line).includes("third")));
	// Wide terminal: three recent rows.
	const wide = buildHeaderLines(options, 120).collapsed;
	assert.ok(wide.some((line) => stripAnsi(line).includes("third")));
	assert.ok(!wide.some((line) => stripAnsi(line).includes("fourth")));
	// Empty summary falls back to a placeholder.
	const empty = buildHeaderLines(
		{ ...headerOptions(), recentSessions: [{ time: "08-02 08:23", summary: "  " }] },
		120,
	).collapsed;
	assert.ok(empty.some((line) => stripAnsi(line).includes("(empty session)")));
	// Long summaries are flattened and truncated, never overflowing.
	const longSummary = buildHeaderLines(
		{
			...headerOptions(),
			recentSessions: [{ time: "08-02 08:23", summary: `line1\nline2 ${'x'.repeat(300)}` }],
		},
		80,
	).collapsed;
	for (const line of longSummary) {
		assert.ok(visibleWidth(line) <= 80, `overflow: ${JSON.stringify(stripAnsi(line))}`);
	}
	assert.ok(!longSummary.some((line) => stripAnsi(line).includes("line1\nline2")));
});
