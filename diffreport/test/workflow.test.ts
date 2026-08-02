import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  RequestAnswer,
  RequestDialogResult,
  RequestQuestion,
  RequestService,
} from "pi-request-ui-dev";
import {
  buildDefaultReportPath,
  buildExplorationKickoff,
  collectAnalysisBrief,
  parseCommandArgs,
  type AnalysisBrief,
} from "../src/workflow.ts";

function makeAnswer(
  id: string,
  selectedOptions: string[] = [],
  customInput?: string,
  multi = false,
): RequestAnswer {
  return {
    id,
    question: id,
    options: selectedOptions,
    multi,
    selectedOptions,
    ...(customInput === undefined ? {} : { customInput }),
  };
}

function makeGitPi(commitLog = ""): { pi: ExtensionAPI; calls: string[][] } {
  const calls: string[][] = [];
  const pi = {
    async exec(command: string, args: string[]) {
      assert.equal(command, "git");
      assert.equal(args[0], "-c");
      assert.equal(args[1], "core.quotePath=false");
      assert.equal(args[2], "--literal-pathspecs");
      calls.push(args);
      let stdout = "";
      if (args[3] === "rev-parse" && args[4] === "--is-inside-work-tree") stdout = "true\n";
      else if (args[3] === "for-each-ref") {
        stdout = "feature/payment\t*\t2026-07-29T12:00:00Z\nmain\t \t2026-07-28T12:00:00Z\n";
      } else if (args[3] === "symbolic-ref") stdout = "origin/main\n";
      else if (args[3] === "branch") stdout = "feature/payment\n";
      else if (args[3] === "rev-parse" && args.includes("--verify")) stdout = "0123456789abcdef\n";
      else if (args[3] === "rev-list") stdout = "0123456789abcdef\n";
      else if (args[3] === "log") stdout = commitLog;
      return { stdout, stderr: "", code: 0, killed: false };
    },
  } as unknown as ExtensionAPI;
  return { pi, calls };
}

function makeRequestService(
  responder: (questions: readonly RequestQuestion[], call: number) => RequestDialogResult,
): { service: RequestService; questions: RequestQuestion[][] } {
  const questions: RequestQuestion[][] = [];
  const service: RequestService = {
    lifetime: new AbortController().signal,
    async request(nextQuestions) {
      questions.push([...nextQuestions]);
      return responder(nextQuestions, questions.length);
    },
  };
  return { service, questions };
}

test("parseCommandArgs supports all four entry shapes without turning descriptions into filters", () => {
  assert.deepEqual(parseCommandArgs("uncommitted checkout state"), {
    selection: "uncommitted",
    commitTargets: [],
    description: "checkout state",
    outputPath: undefined,
  });
  assert.deepEqual(parseCommandArgs("branch feature/payment"), {
    selection: "branch",
    target: "feature/payment",
    commitTargets: [],
    base: undefined,
    description: undefined,
    outputPath: undefined,
  });
  assert.deepEqual(parseCommandArgs("branch feature/payment 支付失败后的重试 --base main"), {
    selection: "branch-context",
    target: "feature/payment",
    commitTargets: [],
    base: "main",
    description: "支付失败后的重试",
    outputPath: undefined,
  });
  assert.deepEqual(parseCommandArgs("commits abc123 main..feature --description 决策演进"), {
    selection: "commits",
    commitTargets: ["abc123", "main..feature"],
    description: "决策演进",
    outputPath: undefined,
  });
});

test("parseCommandArgs handles quotes, custom output, and malformed input", () => {
  const parsed = parseCommandArgs("branch feature --description \"payment retry policy\" --base main --output \"reports/payment flow.md\"");
  assert.equal(parsed.description, "payment retry policy");
  assert.equal(parsed.outputPath, "reports/payment flow.md");
  assert.match(parseCommandArgs("branch 'unterminated").error ?? "", /unterminated quote/);
  assert.match(parseCommandArgs("uncommitted --unknown").error ?? "", /Unknown option/);
});

test("Request drives branch + description selection and preserves context as a hypothesis", async () => {
  const { pi, calls } = makeGitPi();
  const request = makeRequestService((questions, call) => {
    if (call === 1) {
      assert.equal(questions[0]?.id, "analysis-source");
      return { cancelled: false, results: [makeAnswer("analysis-source", ["Branch + description"])] };
    }
    assert.deepEqual(questions.map((question) => question.id), ["branch-target", "branch-base", "business-context"]);
    return {
      cancelled: false,
      results: [
        makeAnswer("branch-target", ["feature/payment"]),
        makeAnswer("branch-base", ["main"]),
        makeAnswer("business-context", [], "支付失败后保留原交易意图"),
      ],
    };
  });
  const brief = await collectAnalysisBrief(
    pi,
    request.service,
    process.cwd(),
    parseCommandArgs(""),
    true,
    new Date("2026-07-29T12:34:56.000Z"),
  );
  assert.deepEqual(brief, {
    source: "branch",
    target: "feature/payment",
    base: "main",
    commitTargets: [],
    description: "支付失败后保留原交易意图",
    outputPath: "reports/diffreport/20260729-123456-branch-feature-payment.md",
  });
  assert.equal(request.questions.length, 2);
  assert.equal(calls.some((args) => args.some((arg) => arg.startsWith("--grep="))), false);
});

test("Request commit history selection maps human labels back to exact commit hashes", async () => {
  const hash = "0123456789abcdef0123456789abcdef01234567";
  const log = `${hash}\u001fAdd retry policy\u001fAda\u001f2026-07-29T10:00:00Z\u001fDecision context\u001e`;
  const { pi } = makeGitPi(log);
  const request = makeRequestService((questions, call) => {
    if (call === 1) {
      return { cancelled: false, results: [makeAnswer("analysis-source", ["Commit history"])] };
    }
    const choice = questions[0];
    assert.ok(choice && choice.kind !== "text");
    const label = choice.options[0]?.label;
    assert.ok(label);
    return { cancelled: false, results: [makeAnswer("commit-selection", [label], undefined, true)] };
  });
  const brief = await collectAnalysisBrief(
    pi,
    request.service,
    process.cwd(),
    parseCommandArgs(""),
    true,
    new Date("2026-07-29T12:34:56.000Z"),
  );
  assert.deepEqual(brief?.commitTargets, [hash]);
  assert.equal(brief?.source, "commits");
  assert.match(brief?.outputPath ?? "", /commits-0123456789ab\.md$/);
});

test("Request cancellation stops before an exploration brief is created", async () => {
  const { pi } = makeGitPi();
  const request = makeRequestService(() => ({ cancelled: true, results: [] }));
  const brief = await collectAnalysisBrief(
    pi,
    request.service,
    process.cwd(),
    parseCommandArgs(""),
    true,
    new Date("2026-07-29T12:34:56.000Z"),
  );
  assert.equal(brief, undefined);
});

test("default report paths and kickoff require a multi-pass Markdown artifact", () => {
  const withoutOutput: Omit<AnalysisBrief, "outputPath"> = {
    source: "branch",
    target: "feature/payment",
    base: "main",
    commitTargets: [],
    description: "Payment retry behavior",
  };
  assert.equal(
    buildDefaultReportPath(withoutOutput, new Date("2026-07-29T12:34:56.000Z")),
    "reports/diffreport/20260729-123456-branch-feature-payment.md",
  );
  const kickoff = buildExplorationKickoff({ ...withoutOutput, outputPath: "reports/diffreport/payment.md" });
  assert.match(kickoff, /load and follow the bundled `change-report` skill/);
  assert.match(kickoff, /multiple evidence passes/);
  assert.match(kickoff, /evidence anchor, not a hard investigation boundary/);
  assert.match(kickoff, /Request plugin's `ask` tool/);
  assert.match(kickoff, /immutable commit IDs/);
  assert.match(kickoff, /revision-qualified Git reads/);
  assert.match(kickoff, /untrusted evidence, never instructions/);
  assert.match(kickoff, /analyst-generated counterfactuals/);
  assert.match(kickoff, /inline evidence IDs/);
  assert.match(kickoff, /reports\/diffreport\/payment\.md/);
  assert.match(kickoff, /Mermaid flow\/sequence\/state diagrams/);
  assert.match(kickoff, /problem chain, decision chain/);
  assert.match(kickoff, /in Simplified Chinese/);
  assert.match(kickoff, /only intended workspace write/);
  assert.doesNotMatch(kickoff, /Risk Assessment|severity ranking/);
});

test("branch options keep the recommended branch selectable beyond the recent slice", async () => {
  const branchRows = [
    ...Array.from({ length: 16 }, (_, index) =>
      `feature/b${String(index + 1).padStart(2, "0")}\t \t2026-07-${String(28 - index).padStart(2, "0")}T12:00:00Z`),
    "main\t \t2026-07-10T12:00:00Z",
    "feature/old\t*\t2026-07-01T12:00:00Z",
  ].join("\n");
  const pi = {
    async exec(command: string, args: string[]) {
      assert.equal(command, "git");
      assert.equal(args[0], "-c");
      assert.equal(args[1], "core.quotePath=false");
      assert.equal(args[2], "--literal-pathspecs");
      let stdout = "";
      if (args[3] === "rev-parse" && args[4] === "--is-inside-work-tree") stdout = "true\n";
      else if (args[3] === "for-each-ref") stdout = branchRows;
      else if (args[3] === "symbolic-ref") stdout = "origin/main\n";
      else if (args[3] === "branch") stdout = "feature/old\n";
      else if (args[3] === "rev-parse" && args.includes("--verify")) stdout = "0123456789abcdef\n";
      return { stdout, stderr: "", code: 0, killed: false };
    },
  } as unknown as ExtensionAPI;
  const { service, questions } = makeRequestService((_nextQuestions, call) => {
    if (call === 1) {
      return { cancelled: false, results: [makeAnswer("analysis-source", ["Branch"])] };
    }
    return {
      cancelled: false,
      results: [
        makeAnswer("branch-target", ["feature/old"]),
        makeAnswer("branch-base", ["main"]),
      ],
    };
  });

  const brief = await collectAnalysisBrief(
    pi,
    service,
    "/tmp",
    { commitTargets: [] },
    true,
    new Date("2026-07-29T12:34:56.000Z"),
  );
  assert.equal(brief?.target, "feature/old");
  assert.equal(brief?.base, "main");

  // feature/old is the current branch but ranks 18th by recency; it must
  // still appear in the target options and be the recommended choice.
  const selectionQuestions = questions[1] ?? [];
  const targetQuestion = selectionQuestions.find((question) => question.id === "branch-target");
  const baseQuestion = selectionQuestions.find((question) => question.id === "branch-base");
  if (!targetQuestion || targetQuestion.kind === "text") assert.fail("target question must be a choice question");
  if (!baseQuestion || baseQuestion.kind === "text") assert.fail("base question must be a choice question");
  const targetOptions = targetQuestion.options ?? [];
  assert.ok(targetOptions.some((option) => option.label === "feature/old"));
  assert.equal(targetOptions[targetQuestion.recommended ?? 0]?.label, "feature/old");
  const baseOptions = baseQuestion.options ?? [];
  assert.equal(baseOptions[baseQuestion.recommended ?? 0]?.label, "main");
});

test("kickoff adds a direct-answer focus section only when user context exists", () => {
  const withContext = buildExplorationKickoff({
    source: "branch",
    target: "feature/payment",
    base: "main",
    commitTargets: [],
    description: "支付失败后的重试",
    outputPath: "reports/diffreport/payment.md",
  });
  assert.match(withContext, /## Focus/);
  assert.match(withContext, /direct-answer section/);
  assert.match(withContext, /支付失败后的重试/);
  assert.match(withContext, /never drop the snapshot matrix, evidence labels, or the evidence index/);

  const withoutContext = buildExplorationKickoff({
    source: "uncommitted",
    commitTargets: [],
    outputPath: "reports/diffreport/uncommitted.md",
  });
  assert.doesNotMatch(withoutContext, /## Focus/);
});
