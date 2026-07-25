import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  MAX_ITEMS_PER_APPEND,
  MAX_PHASE_NAME_CHARS,
  MAX_STATUS_DETAIL_CHARS,
  MAX_TASK_CONTENT_CHARS,
  MAX_TODO_PHASES,
  MAX_TODO_TASKS,
  MAX_VIEW_LIMIT,
} from "./state.ts";

export const TODO_OPERATIONS = [
  "init",
  "append",
  "start",
  "done",
  "block",
  "drop",
  "reopen",
  "edit",
  "get",
  "view",
] as const;

const TodoInitPhase = Type.Object({
  phase: Type.String({ minLength: 1, maxLength: MAX_PHASE_NAME_CHARS }),
  items: Type.Array(Type.String({ minLength: 1, maxLength: MAX_TASK_CONTENT_CHARS }), {
    minItems: 1,
    maxItems: MAX_TODO_TASKS,
  }),
}, { additionalProperties: false });

export const TodoParams = Type.Object({
  op: StringEnum(TODO_OPERATIONS, {
    description: "Operation to perform. Set every field not used by this operation to null; non-null known fillers are ignored only when they belong to another operation.",
  }),
  list: Type.Optional(Type.Union([
    Type.Array(TodoInitPhase, { minItems: 1, maxItems: MAX_TODO_PHASES }),
    Type.Null(),
  ], { description: "init only: the complete ordered phase and task list; null for every other operation." })),
  phase: Type.Optional(Type.Union([
    Type.String({ minLength: 1, maxLength: MAX_PHASE_NAME_CHARS }),
    Type.Null(),
  ], { description: "append: target/new phase. view: exact phase filter, or null for all phases. null for every other operation." })),
  items: Type.Optional(Type.Union([
    Type.Array(Type.String({ minLength: 1, maxLength: MAX_TASK_CONTENT_CHARS }), {
      minItems: 1,
      maxItems: MAX_ITEMS_PER_APPEND,
    }),
    Type.Null(),
  ], { description: "append only: ordered task texts to add; null for every other operation." })),
  id: Type.Optional(Type.Union([
    Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    Type.Null(),
  ], { description: "start, done, block, drop, reopen, edit, or get: stable task ID; null for init, append, or view." })),
  content: Type.Optional(Type.Union([
    Type.String({ minLength: 1, maxLength: MAX_TASK_CONTENT_CHARS }),
    Type.Null(),
  ], { description: "edit only: replacement task text; null for every other operation." })),
  reason: Type.Optional(Type.Union([
    Type.String({ minLength: 1, maxLength: MAX_STATUS_DETAIL_CHARS }),
    Type.Null(),
  ], { description: "block, drop, or reopen only: truthful transition reason; null for every other operation." })),
  note: Type.Optional(Type.Union([
    Type.String({ minLength: 1, maxLength: MAX_STATUS_DETAIL_CHARS }),
    Type.Null(),
  ], { description: "done only: concise verification evidence, or null when omitted; null for every other operation." })),
  includeClosed: Type.Optional(Type.Union([
    Type.Boolean(),
    Type.Null(),
  ], { description: "view only: include completed and dropped tasks; null means false and is required for every other operation." })),
  offset: Type.Optional(Type.Union([
    Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    Type.Null(),
  ], { description: "view only: zero-based task offset; null means 0 and is required for every other operation." })),
  limit: Type.Optional(Type.Union([
    Type.Integer({ minimum: 1, maximum: MAX_VIEW_LIMIT }),
    Type.Null(),
  ], { description: `view only: maximum returned tasks; null means the default. Maximum ${MAX_VIEW_LIMIT}.` })),
}, { additionalProperties: false });
