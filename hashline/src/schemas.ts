import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

export const MAX_EDITABLE_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_EDITABLE_LINES = 250_000;
export const MAX_SNAPSHOT_PATHS = 128;
export const MAX_VERSIONS_PER_PATH = 8;
export const MAX_ACTIVE_SNAPSHOTS = 512;
export const MAX_SEEN_RANGES = 64;
export const MAX_DECODED_SEEN_RANGES = 128;
export const MAX_PATH_CHARS = 4096;
export const MAX_EDIT_OPERATIONS = 100;
export const MAX_EDIT_PAYLOAD_BYTES = 128 * 1024;
export const MAX_EDIT_PAYLOAD_LINES = 10_000;
export const MAX_EDIT_CHANGED_BYTES = 128 * 1024;
export const MAX_EDIT_LINE_BYTES = 64 * 1024;
export const MAX_EDIT_DETAILS_BYTES = 256 * 1024;
export const EDIT_PREVIEW_CONTEXT = 2;
export const MAX_EDIT_PREVIEW_LINES = 120;
export const MAX_SNAPSHOT_ENTRY_BYTES = 32 * 1024;
export const MAX_RECOVERY_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_RECOVERY_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_RECOVERY_ENTRIES = 128;
export const MAX_RECOVERY_VERSIONS_PER_PATH = 4;
export const MAX_RECOVERY_EDIT_DISTANCE = 512;

export const EDIT_OPS = ["replace", "delete", "insert_before", "insert_after"] as const;
export type HashlineEditOp = (typeof EDIT_OPS)[number];

const editOperationSchema = Type.Object(
  {
    op: StringEnum(EDIT_OPS, { description: "replace/delete consume original lines; insert_before/insert_after add lines beside the start anchor" }),
    start: Type.Integer({ minimum: 1, description: "Original physical line anchor, 1-indexed" }),
    end: Type.Optional(Type.Integer({ minimum: 1, description: "Inclusive final original line for replace/delete only; defaults to start" })),
    lines: Type.Optional(
      Type.Array(Type.String(), {
        maxItems: MAX_EDIT_PAYLOAD_LINES,
        minItems: 1,
        description: "Final logical lines without terminators; required for replace/inserts; must be omitted entirely for delete (never null or an empty array)",
      }),
    ),
  },
  { additionalProperties: false },
);

export const hashlineEditSchema = Type.Object(
  {
    path: Type.String({ minLength: 1, maxLength: MAX_PATH_CHARS, description: "File path, relative or absolute" }),
    snapshot: Type.String({
      pattern: "^h1_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$",
      description: "Snapshot token returned by read for this file and branch",
    }),
    edits: Type.Array(editOperationSchema, {
      minItems: 1,
      maxItems: MAX_EDIT_OPERATIONS,
      description: "Disjoint operations in original-file coordinates; ranges cannot overlap and insertion gaps cannot repeat",
    }),
  },
  { additionalProperties: false },
);

export type HashlineEditInput = Static<typeof hashlineEditSchema>;
export type HashlineEditOperation = Static<typeof editOperationSchema>;
