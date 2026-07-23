import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_REQUEST_PAYLOAD_BYTES,
  MAX_REQUEST_QUESTIONS,
  normalizeRequestQuestions,
  type RequestQuestion,
  unansweredRequestResult,
} from "../src/request.ts";

test("request questions normalize choice and text contracts", () => {
  const normalized = normalizeRequestQuestions([
    {
      id: "runtime",
      header: " Runtime ",
      question: " Choose a runtime ",
      options: [
        { label: " Node.js ", description: " Native ESM ", preview: "" },
        { label: "Bun" },
      ],
      recommended: 1,
      multi: true,
    },
    {
      id: "notes",
      question: " Add notes ",
      kind: "text",
      placeholder: " Optional details ",
    },
  ]);

  assert.deepEqual(normalized, [
    {
      id: "runtime",
      header: "Runtime",
      question: "Choose a runtime",
      kind: "choice",
      multi: true,
      options: [
        { label: "Node.js", description: "Native ESM", preview: undefined },
        { label: "Bun", description: undefined, preview: undefined },
      ],
      recommended: 1,
      allowOther: true,
    },
    {
      id: "notes",
      header: "Question 2",
      question: "Add notes",
      kind: "text",
      placeholder: "Optional details",
    },
  ]);

  assert.deepEqual(unansweredRequestResult(normalized, true), {
    cancelled: true,
    results: [
      {
        id: "runtime",
        question: "Choose a runtime",
        options: ["Node.js", "Bun"],
        multi: true,
        selectedOptions: [],
      },
      {
        id: "notes",
        question: "Add notes",
        options: [],
        multi: false,
        selectedOptions: [],
      },
    ],
  });
});

test("request validation rejects ambiguous and oversized payloads", () => {
  const base: RequestQuestion = {
    id: "choice",
    question: "Choose",
    options: [{ label: "A" }, { label: "B" }],
  };

  assert.throws(() => normalizeRequestQuestions([]), /At least one/);
  assert.throws(() => normalizeRequestQuestions([base, { ...base }]), /duplicated/);
  assert.throws(() => normalizeRequestQuestions([{ ...base, options: [{ label: "A" }, { label: " A " }] }]), /label "A" is duplicated/);
  assert.throws(() => normalizeRequestQuestions([{ ...base, recommended: 2 }]), /out of range/);
  assert.throws(() => normalizeRequestQuestions([{ ...base, id: "bad id" }]), /unsupported characters/);
  assert.throws(
    () => normalizeRequestQuestions(Array.from({ length: MAX_REQUEST_QUESTIONS + 1 }, (_, index) => ({ ...base, id: `q-${index}` }))),
    /at most/,
  );

  const oversized = Array.from({ length: 5 }, (_, index): RequestQuestion => ({
    id: `large-${index}`,
    question: "Large preview",
    options: [{ label: `Option ${index}`, preview: "x".repeat(4_000) }],
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(oversized), "utf8") > MAX_REQUEST_PAYLOAD_BYTES);
  assert.throws(() => normalizeRequestQuestions(oversized), /payload exceeds/);
});
