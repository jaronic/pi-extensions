import assert from "node:assert/strict";
import test from "node:test";
import { snapshotTokenForBytes } from "../src/digest.ts";
import { decodeEditableBytes, serializePhysicalLines } from "../src/lines.ts";
import {
  applyOperations,
  decodeHashlineEditInput,
  planOperations,
} from "../src/operations.ts";
import type { SeenRange } from "../src/snapshots.ts";
import { MAX_EDITABLE_LINES, MAX_EDIT_PAYLOAD_LINES } from "../src/schemas.ts";

function apply(source: string, edits: unknown[], seen?: readonly SeenRange[]): string {
  const bytes = Buffer.from(source, "utf8");
  const editable = decodeEditableBytes(bytes);
  const input = decodeHashlineEditInput({
    path: "fixture.txt",
    snapshot: snapshotTokenForBytes(bytes),
    edits,
  });
  const visible = seen ?? (editable.lines.length > 0 ? [{ start: 1, end: editable.lines.length }] : []);
  const plan = planOperations(input.edits, editable.lines, visible, "fixture.txt");
  const result = applyOperations(editable.lines, plan);
  return serializePhysicalLines({ hasBom: editable.hasBom, lines: result.lines }).toString("utf8");
}

test("replace, delete, and insert preserve local and final line endings", () => {
  assert.equal(apply("a\r\nb\nc\r", [{ op: "replace", start: 2, lines: ["B1", "B2"] }]), "a\r\nB1\nB2\nc\r");
  assert.equal(apply("a\nb", [{ op: "insert_after", start: 2, lines: ["c", "d"] }]), "a\nb\nc\nd");
  assert.equal(apply("a\r\n", [{ op: "insert_after", start: 1, lines: ["b"] }]), "a\r\nb\r\n");
  assert.equal(apply("a\nb", [{ op: "insert_before", start: 1, lines: ["head"] }]), "head\na\nb");
  assert.equal(apply("a\nb\nc", [{ op: "delete", start: 2 }]), "a\nc");
  assert.equal(apply("a\nb", [{ op: "delete", start: 2 }]), "a\n");
});

test("disjoint operations always use original coordinates and ignore array order", () => {
  const source = "one\ntwo\nthree\nfour\nfive\n";
  const edits = [
    { op: "replace", start: 2, lines: ["TWO"] },
    { op: "insert_after", start: 4, lines: ["four-half"] },
    { op: "delete", start: 5 },
  ];
  const expected = "one\nTWO\nthree\nfour\nfour-half\n";
  assert.equal(apply(source, edits), expected);
  assert.equal(apply(source, [...edits].reverse()), expected);

  let state = 0x12345678;
  for (let run = 0; run < 40; run += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const shuffled = [...edits].sort(() => ((state = (state * 1664525 + 1013904223) >>> 0) & 1) ? 1 : -1);
    assert.equal(apply(source, shuffled), expected);
  }
});

test("overlapping ranges, duplicate gaps, and insertion inside a consume range fail closed", () => {
  const conflicts = [
    [
      { op: "replace", start: 1, end: 2, lines: ["x"] },
      { op: "delete", start: 2, end: 3 },
    ],
    [
      { op: "insert_after", start: 1, lines: ["x"] },
      { op: "insert_before", start: 2, lines: ["y"] },
    ],
    [
      { op: "replace", start: 1, end: 3, lines: ["x"] },
      { op: "insert_after", start: 1, lines: ["y"] },
    ],
  ];
  for (const edits of conflicts) assert.throws(() => apply("a\nb\nc\n", edits), /\[E_EDIT_CONFLICT\]/);
});

test("seen coverage includes range interiors and both existing sides of insertion gaps", () => {
  assert.throws(
    () => apply("a\nb\nc\n", [{ op: "replace", start: 1, end: 3, lines: ["x"] }], [{ start: 1, end: 1 }, { start: 3, end: 3 }]),
    /\[E_UNSEEN_LINE\].*offset=1 limit=3/,
  );
  assert.throws(
    () => apply("a\nb\nc\n", [{ op: "insert_after", start: 1, lines: ["x"] }], [{ start: 1, end: 1 }]),
    /\[E_UNSEEN_LINE\].*offset=1 limit=2/,
  );
  assert.equal(apply("a\nb\nc\n", [{ op: "insert_after", start: 3, lines: ["x"] }], [{ start: 3, end: 3 }]), "a\nb\nc\nx\n");
});

test("edits cannot create files beyond the physical-line snapshot limit", () => {
  const source = "\n".repeat(MAX_EDITABLE_LINES);
  assert.throws(
    () => apply(source, [{ op: "insert_after", start: MAX_EDITABLE_LINES, lines: [""] }]),
    /\[E_TOO_LARGE\].*physical-line limit/,
  );
});

test("runtime validation rejects field-matrix, line, payload, and changed-byte violations", () => {
  const token = snapshotTokenForBytes(Buffer.from("a\n"));
  assert.throws(
    () => decodeHashlineEditInput({ path: "x", snapshot: token, edits: [{ op: "delete", start: 1, lines: ["x"] }] }),
    /\[E_BAD_REQUEST\].*Omit the lines key entirely.*use replace/,
  );
  assert.throws(
    () => decodeHashlineEditInput({ path: "x", snapshot: token, edits: [{ op: "insert_before", start: 1, end: 1, lines: ["x"] }] }),
    /\[E_BAD_REQUEST\]/,
  );
  assert.throws(
    () => decodeHashlineEditInput({ path: "x", snapshot: token, edits: [{ op: "replace", start: 1, lines: ["bad\nline"] }] }),
    /\[E_BAD_REQUEST\]/,
  );
  assert.throws(
    () => decodeHashlineEditInput({ path: "x", snapshot: token, edits: [{ op: "replace", start: 1, lines: ["\ud800"] }] }),
    /unpaired UTF-16 surrogate/,
  );
  assert.throws(
    () => decodeHashlineEditInput({ path: "x", snapshot: token, edits: [{ op: "replace", start: 1, lines: ["x".repeat(65_537)] }] }),
    /\[E_TOO_LARGE\]/,
  );
  const emptyPayload = Array.from({ length: MAX_EDIT_PAYLOAD_LINES + 1 }, () => "");
  assert.throws(
    () => decodeHashlineEditInput({ path: "x", snapshot: token, edits: [{ op: "replace", start: 1, lines: emptyPayload }] }),
    /\[E_TOO_LARGE\].*logical lines/,
  );
  let inspectedPastBudget = false;
  const failFastPayload = ["a".repeat(65_536), "b".repeat(65_536), "c".repeat(65_536), "unreachable"];
  Object.defineProperty(failFastPayload, 3, {
    get() {
      inspectedPastBudget = true;
      throw new Error("payload decoder read past its byte budget");
    },
  });
  assert.throws(
    () => decodeHashlineEditInput({ path: "x", snapshot: token, edits: [{ op: "replace", start: 1, lines: failFastPayload }] }),
    /\[E_TOO_LARGE\].*payload/,
  );
  assert.equal(inspectedPastBudget, false);
  assert.throws(
    () => decodeHashlineEditInput({ path: "x".repeat(4097), snapshot: token, edits: [{ op: "delete", start: 1 }] }),
    /\[E_TOO_LARGE\].*path/,
  );
  assert.throws(
    () => decodeHashlineEditInput({ path: "\ud800", snapshot: token, edits: [{ op: "delete", start: 1 }] }),
    /\[E_BAD_REQUEST\].*path/,
  );
  const wide = `${"a".repeat(65_536)}\n${"b".repeat(65_536)}\n`;
  assert.throws(
    () => apply(wide, [{ op: "replace", start: 1, end: 2, lines: ["c".repeat(65_536), "d".repeat(65_536)] }]),
    /\[E_TOO_LARGE\].*changes/,
  );
});
