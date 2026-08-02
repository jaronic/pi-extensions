import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Text } from "@earendil-works/pi-tui";
import { badge, collapseLines, kvRow, linesToText, markdownThemeStyles, moreLinesHint, reuseTextComponent, statusRow, tone, toolCallTitle } from "../src/index.ts";
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

  test("maps structural tones to their tokens", () => {
    assert.equal(tone(stubTheme, "strong", "t"), "**t**");
    assert.equal(tone(stubTheme, "selected", "t"), "<bg:selectedBg><text>t</></>");
    assert.equal(tone(stubTheme, "borderMuted", "t"), "<borderMuted>t</>");
    assert.equal(tone(stubTheme, "borderAccent", "t"), "<borderAccent>t</>");
    assert.equal(tone(stubTheme, "diffAdded", "t"), "<toolDiffAdded>t</>");
    assert.equal(tone(stubTheme, "diffRemoved", "t"), "<toolDiffRemoved>t</>");
    assert.equal(tone(stubTheme, "mdHeading", "t"), "<mdHeading>t</>");
    assert.equal(tone(stubTheme, "mdLink", "t"), "<mdLink>t</>");
    assert.equal(tone(stubTheme, "mdLinkUrl", "t"), "<mdLinkUrl>t</>");
    assert.equal(tone(stubTheme, "mdCode", "t"), "<mdCode>t</>");
    assert.equal(tone(stubTheme, "mdCodeBlock", "t"), "<mdCodeBlock>t</>");
    assert.equal(tone(stubTheme, "mdCodeBlockBorder", "t"), "<mdCodeBlockBorder>t</>");
    assert.equal(tone(stubTheme, "mdQuote", "t"), "<mdQuote>t</>");
    assert.equal(tone(stubTheme, "mdQuoteBorder", "t"), "<mdQuoteBorder>t</>");
    assert.equal(tone(stubTheme, "mdHr", "t"), "<mdHr>t</>");
    assert.equal(tone(stubTheme, "mdListBullet", "t"), "<mdListBullet>t</>");
  });

  test("bold option wraps inside the fg call", () => {
    assert.equal(tone(stubTheme, "mdHeading", "t", { bold: true }), "<mdHeading>**t**</>");
    assert.equal(tone(stubTheme, "accent", "t", { bold: true }), "<accent>**t**</>");
    assert.equal(tone(stubTheme, "strong", "t", { bold: true }), "**t**");
  });

  test("bold outer wraps the colored string, and title can opt out of bold", () => {
    assert.equal(tone(stubTheme, "accent", "t", { bold: "outer" }), "**<accent>t</>**");
    assert.equal(tone(stubTheme, "title", "t", { bold: false }), "<toolTitle>t</>");
    assert.equal(tone(stubTheme, "title", "t"), "<toolTitle>**t**</>");
  });
});

describe("markdownThemeStyles", () => {
  test("every markdown construct resolves through the shared tones", () => {
    const styles = markdownThemeStyles(stubTheme);
    assert.equal(styles.heading("h"), "<mdHeading>h</>");
    assert.equal(styles.link("l"), "<mdLink>l</>");
    assert.equal(styles.linkUrl("u"), "<mdLinkUrl>u</>");
    assert.equal(styles.code("c"), "<mdCode>c</>");
    assert.equal(styles.codeBlock("cb"), "<mdCodeBlock>cb</>");
    assert.equal(styles.codeBlockBorder("|"), "<mdCodeBlockBorder>|</>");
    assert.equal(styles.quote("q"), "<mdQuote>q</>");
    assert.equal(styles.quoteBorder(">"), "<mdQuoteBorder>></>");
    assert.equal(styles.hr("-"), "<mdHr>-</>");
    assert.equal(styles.listBullet("*"), "<mdListBullet>*</>");
    assert.equal(styles.bold("b"), "**b**");
    assert.equal(styles.italic("i"), "_i_");
    assert.equal(styles.strikethrough("s"), "~s~s~/s~");
    assert.equal(styles.underline("u"), "~u~u~/u~");
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

  test("leaves control-free input byte-for-byte unchanged", () => {
    assert.equal(
      toolCallTitle(stubTheme, { brand: "目标", action: "读", target: "中文文件.ts" }),
      "<toolTitle>**目标**</><muted> · 读 </><accent>中文文件.ts</>",
    );
  });

  test("folds line breaks and tabs to a single space so the title stays one line", () => {
    assert.equal(
      toolCallTitle(stubTheme, { brand: "Hashline", action: "read", target: "a.ts\nb.ts\r\nc.ts" }),
      "<toolTitle>**Hashline**</><muted> · read </><accent>a.ts b.ts c.ts</>",
    );
    assert.equal(toolCallTitle(stubTheme, { brand: "a\tb" }), "<toolTitle>**a b**</>");
  });

  test("drops ESC/OSC/BEL so control sequences cannot leak into the TUI", () => {
    assert.equal(
      toolCallTitle(stubTheme, { brand: "Hashline\u001b]0;x\u0007", action: "read\u0007", target: "src/a.ts\u001b[31m" }),
      "<toolTitle>**Hashline]0;x**</><muted> · read </><accent>src/a.ts[31m</>",
    );
    assert.equal(
      toolCallTitle(stubTheme, { brand: "\u001b", target: "\u009b" }),
      "<toolTitle>****</><accent></>",
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
