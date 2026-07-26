import { fail } from "./errors.ts";
import { MAX_EDITABLE_FILE_BYTES, MAX_EDITABLE_LINES, MAX_EDIT_LINE_BYTES } from "./schemas.ts";

export type LineEnding = "\n" | "\r\n" | "\r" | "";

export interface PhysicalLine {
  readonly body: string;
  readonly eol: LineEnding;
}

export interface EditableText {
  readonly hasBom: boolean;
  readonly lines: readonly PhysicalLine[];
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function scanPhysicalLines(text: string): readonly PhysicalLine[] {
  if (text.length === 0) return Object.freeze([]);
  const lines: PhysicalLine[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const char = text.charCodeAt(index);
    if (char === 10) {
      if (lines.length >= MAX_EDITABLE_LINES) fail("E_TOO_LARGE", `File exceeds the ${MAX_EDITABLE_LINES} physical-line editable limit.`);
      lines.push(Object.freeze({ body: text.slice(start, index), eol: "\n" }));
      index += 1;
      start = index;
      continue;
    }
    if (char === 13) {
      const isCrLf = index + 1 < text.length && text.charCodeAt(index + 1) === 10;
      if (lines.length >= MAX_EDITABLE_LINES) fail("E_TOO_LARGE", `File exceeds the ${MAX_EDITABLE_LINES} physical-line editable limit.`);
      lines.push(Object.freeze({ body: text.slice(start, index), eol: isCrLf ? "\r\n" : "\r" }));
      index += isCrLf ? 2 : 1;
      start = index;
      continue;
    }
    index += 1;
  }
  if (start < text.length) {
    if (lines.length >= MAX_EDITABLE_LINES) fail("E_TOO_LARGE", `File exceeds the ${MAX_EDITABLE_LINES} physical-line editable limit.`);
    lines.push(Object.freeze({ body: text.slice(start), eol: "" }));
  }
  return Object.freeze(lines);
}

export function decodeEditableBytes(bytes: Buffer): EditableText {
  if (bytes.byteLength > MAX_EDITABLE_FILE_BYTES) {
    fail("E_TOO_LARGE", `File exceeds the ${MAX_EDITABLE_FILE_BYTES} byte editable limit.`);
  }
  const hasBom = bytes.length >= UTF8_BOM.length && bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM);
  let text: string;
  try {
    text = FATAL_UTF8_DECODER.decode(hasBom ? bytes.subarray(UTF8_BOM.length) : bytes);
  } catch {
    fail("E_NOT_EDITABLE", "File is not valid UTF-8.");
  }
  if (text.includes("\0")) fail("E_NOT_EDITABLE", "File contains NUL bytes and is treated as binary.");
  return Object.freeze({ hasBom, lines: scanPhysicalLines(text) });
}

export function serializePhysicalLines(value: EditableText | { hasBom: boolean; lines: readonly PhysicalLine[] }): Buffer {
  const text = value.lines.map((line) => `${line.body}${line.eol}`).join("");
  const body = Buffer.from(text, "utf8");
  return value.hasBom ? Buffer.concat([UTF8_BOM, body]) : body;
}

export function lineByteLength(line: PhysicalLine): number {
  return Buffer.byteLength(line.body, "utf8") + Buffer.byteLength(line.eol, "utf8");
}

export function assertEditableLineSizes(lines: readonly PhysicalLine[]): void {
  for (let index = 0; index < lines.length; index += 1) {
    const bytes = Buffer.byteLength(lines[index].body, "utf8");
    if (bytes > MAX_EDIT_LINE_BYTES) {
      fail("E_TOO_LARGE", `Line ${index + 1} is ${bytes} bytes and exceeds the ${MAX_EDIT_LINE_BYTES} byte edit limit.`);
    }
  }
}

export function preferredLineEnding(lines: readonly PhysicalLine[], anchorLine: number): Exclude<LineEnding, ""> {
  const anchor = lines[anchorLine - 1]?.eol;
  if (anchor) return anchor;
  return lines.find((line) => line.eol !== "")?.eol || "\n";
}
