import assert from "node:assert/strict";
import test from "node:test";
import { digestBytes, parseSnapshotToken, snapshotTokenForBytes } from "../src/digest.ts";
import {
  decodeEditableBytes,
  scanPhysicalLines,
  serializePhysicalLines,
} from "../src/lines.ts";
import { MAX_EDITABLE_LINES } from "../src/schemas.ts";

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

test("snapshot tokens cover every raw byte distinction", () => {
  const variants = [
    Buffer.from("a\n"),
    Buffer.from("a\r\n"),
    Buffer.from("a"),
    Buffer.from("a \n"),
    Buffer.concat([BOM, Buffer.from("a\n")]),
    Buffer.from("A\n"),
  ];
  const tokens = variants.map(snapshotTokenForBytes);
  assert.equal(new Set(tokens).size, variants.length);
  assert.equal(tokens[0], snapshotTokenForBytes(Buffer.from("a\n")));
  assert.equal(parseSnapshotToken(tokens[0])?.digest, digestBytes(variants[0]));
  assert.equal(parseSnapshotToken("h1_short"), undefined);
  assert.equal(parseSnapshotToken(`h2_${"a".repeat(43)}`), undefined);
  assert.equal(parseSnapshotToken(`h1_${"a".repeat(43)}`), undefined);
});

test("physical line scanner has no synthetic final sentinel", () => {
  assert.deepEqual(scanPhysicalLines(""), []);
  assert.deepEqual(scanPhysicalLines("\n"), [{ body: "", eol: "\n" }]);
  assert.deepEqual(scanPhysicalLines("a\n"), [{ body: "a", eol: "\n" }]);
  assert.deepEqual(scanPhysicalLines("a\r\nb\rc\n"), [
    { body: "a", eol: "\r\n" },
    { body: "b", eol: "\r" },
    { body: "c", eol: "\n" },
  ]);
  assert.deepEqual(scanPhysicalLines("a\n\nlast"), [
    { body: "a", eol: "\n" },
    { body: "", eol: "\n" },
    { body: "last", eol: "" },
  ]);
});
test("physical line scanner rejects newline storms at the editable line limit", () => {
  assert.throws(
    () => scanPhysicalLines("\n".repeat(MAX_EDITABLE_LINES + 1)),
    /\[E_TOO_LARGE\].*physical-line editable limit/,
  );
});


test("strict decode and serialization preserve BOM, mixed EOL, whitespace, and Unicode", () => {
  const original = Buffer.concat([BOM, Buffer.from("\talpha \r\nβ\r👩‍💻é\nlast", "utf8")]);
  const editable = decodeEditableBytes(original);
  assert.equal(editable.hasBom, true);
  assert.deepEqual(editable.lines.map(({ body, eol }) => [body, eol]), [
    ["\talpha ", "\r\n"],
    ["β", "\r"],
    ["👩‍💻é", "\n"],
    ["last", ""],
  ]);
  assert.equal(serializePhysicalLines(editable).equals(original), true);

  const repeatedBom = Buffer.concat([BOM, BOM, Buffer.from("content\n")]);
  assert.equal(serializePhysicalLines(decodeEditableBytes(repeatedBom)).equals(repeatedBom), true);
});

test("invalid UTF-8 and NUL content are never editable snapshots", () => {
  assert.throws(() => decodeEditableBytes(Buffer.from([0xc3, 0x28])), /\[E_NOT_EDITABLE\]/);
  assert.throws(() => decodeEditableBytes(Buffer.from("a\0b")), /\[E_NOT_EDITABLE\]/);
});
