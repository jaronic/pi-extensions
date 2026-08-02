import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Text } from "@earendil-works/pi-tui";
import { badge, collapseLines, kvRow, linesToText, moreLinesHint, reuseTextComponent, statusRow, tone, toolCallTitle } from "../src/index.ts";
import { stubTheme } from "./stub-theme.ts";

describe("tone", () => {
  test("maps every tone to exactly one semantic token", () => {
    assert.equal(tone(stubTheme, "title", "t"), "<toolTitle>**t**</>");
    assert.equal(tone(stubTheme, "accent", "t"), "<accent>t</>");
    assert.equal(tone(stubTheme, "muted", "t"), "<muted>t</>");
    assert.equal(tone(stubTheme, "dim", "t"), "<dim>t</>");
    assert.equal(tone(stubTheme, "text", "t"), "<text>t</>");
    assert.equal(tone(stubTheme, "output", "t"), "<toolOutput>t</>");
    assert.equal(tone(stubTheme, "success", "t"), "<success>t</>");
    assert.equal(tone(stubTheme, "warning", "t"), "<warning>t</>");
    assert.equal(tone(stubTheme, "error", "t"), "<error>t</>");
  });
});

describe("toolCallTitle", () => {
  test("brand only", () => {
    assert.equal(toolCallTitle(stubTheme, { brand: "Ask 2 questions" }), "<toolTitle>**Ask 2 questions**</>");
  });

  test("brand with action and target follows the card pattern", () => {
    assert.equal(
      toolCallTitle(stubTheme, { brand: "Hashline", action: "edit", target: "src/a.ts" }),
      "<toolTitle>**Hashline**</><muted> · edit </><accent>src/a.ts</>",
    );
  });

  test("action without target keeps the muted separator", () => {
    assert.equal(
      toolCallTitle(stubTheme, { brand: "Hashline", action: "read" }),
      "<toolTitle>**Hashline**</><muted> · read </>",
    );
  });
});

describe("reuseTextComponent", () => {
  test("creates a Text when there is no previous component", () => {
    const text = reuseTextComponent(undefined, "hello");
    assert.ok(text instanceof Text);
  });

  test("mutates and returns the previous Text component", () => {
    const previous = new Text("old", 0, 0);
    const reused = reuseTextComponent(previous, "new");
    assert.equal(reused, previous);
  });

  test("replaces non-Text previous components", () => {
    const text = reuseTextComponent({ not: "text" }, "fresh");
    assert.ok(text instanceof Text);
  });
});

describe("statusRow", () => {
  test("success row with value", () => {
    assert.equal(
      statusRow(stubTheme, "success", "q1", "yes"),
      "<success>✓</> <accent>q1</>: <text>yes</>",
    );
  });

  test("pending rows use the pending glyph in warning tone", () => {
    assert.equal(statusRow(stubTheme, "pending", "q2", "unanswered"), "<warning>○</> <accent>q2</>: <text>unanswered</>");
  });

  test("omits the value segment when no value is given", () => {
    assert.equal(statusRow(stubTheme, "error", "build"), "<error>✕</> <accent>build</>");
  });
});

describe("kvRow and badge", () => {
  test("kvRow renders a muted key and text value", () => {
    assert.equal(kvRow(stubTheme, "branch", "main"), "<muted>branch</>: <text>main</>");
  });

  test("badge wraps the label in brackets with the given tone", () => {
    assert.equal(badge(stubTheme, "beta", "dim"), "<dim>[beta]</>");
  });
});

describe("collapseLines and moreLinesHint", () => {
  const lines = ["a", "b", "c", "d"];

  test("collapsed view keeps the head and counts the rest", () => {
    const { visible, hiddenCount } = collapseLines(lines, { expanded: false, collapsedLimit: 3 });
    assert.deepEqual(visible, ["a", "b", "c"]);
    assert.equal(hiddenCount, 1);
  });

  test("expanded view shows everything", () => {
    const { visible, hiddenCount } = collapseLines(lines, { expanded: true, collapsedLimit: 3 });
    assert.deepEqual(visible, lines);
    assert.equal(hiddenCount, 0);
  });

  test("hint reports the hidden count in muted tone", () => {
    assert.equal(moreLinesHint(stubTheme, 2), "<muted>… (2 more lines; expand to show all)</>");
  });
});

describe("linesToText", () => {
  test("joins lines into a Text component", () => {
    const text = linesToText(["one", "two"]);
    assert.ok(text instanceof Text);
  });
});
