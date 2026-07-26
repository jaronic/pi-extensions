#!/usr/bin/env node

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("ast-grep 0.45.0\n");
  process.exit(0);
}

const valueOf = (prefix) => args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
const pattern = valueOf("--pattern=") ?? (args.includes("--kind=ERROR") ? "error-guard" : "");
const language = valueOf("--lang=") ?? "typescript";
const languageNames = {
  javascript: "JavaScript",
  typescript: "TypeScript",
  tsx: "Tsx",
};
const cliLanguage = languageNames[language] ?? `${language.slice(0, 1).toUpperCase()}${language.slice(1)}`;
const rewrite = valueOf("--rewrite=");
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const source = Buffer.concat(chunks).toString("utf8") || "foo(x)";
const file = args.includes("--stdin") ? "STDIN" : "src/sample.ts";

const record = (text = "foo(x)") => {
  const start = Math.max(0, source.indexOf(text));
  const end = start + Buffer.byteLength(text);
  const value = {
    text,
    file,
    lines: text,
    charCount: { leading: 0, trailing: 0 },
    language: cliLanguage,
    range: {
      byteOffset: { start, end },
      start: { line: 0, column: start },
      end: { line: 0, column: end },
    },
    metaVariables: {
      single: {
        A: {
          text: "x",
          range: {
            byteOffset: { start: start + 4, end: start + 5 },
            start: { line: 0, column: start + 4 },
            end: { line: 0, column: start + 5 },
          },
        },
      },
      multi: {},
      transformed: {},
    },
  };
  if (rewrite !== undefined) {
    value.replacement = rewrite.replace("$A", "x");
    value.replacementOffsets = { start, end };
  }
  return value;
};

const writeRecord = (value, newline = true) => process.stdout.write(`${JSON.stringify(value)}${newline ? "\n" : ""}`);
const waitForDrain = (stream) => new Promise((resolve) => stream.once("drain", resolve));

if (pattern === "error-guard" || pattern === "no-match") {
  process.exitCode = 1;
} else if (pattern.startsWith("valid")) {
  writeRecord(record());
} else if (pattern === "split-valid") {
  const bytes = Buffer.from(`${JSON.stringify(record("foo(é)"))}\n`);
  for (let index = 0; index < bytes.length; index += 3) process.stdout.write(bytes.subarray(index, index + 3));
} else if (pattern === "two-records") {
  writeRecord(record());
  writeRecord(record());
} else if (pattern === "consumer-flood") {
  const stdoutFlood = (async () => {
    for (let index = 0; index < 5_000; index += 1) {
      if (!writeRecord(record())) await waitForDrain(process.stdout);
    }
  })();
  const stderrFlood = (async () => {
    const chunk = Buffer.alloc(4096, 0x65);
    for (let index = 0; index < 128; index += 1) {
      if (!process.stderr.write(chunk)) await waitForDrain(process.stderr);
    }
  })();
  await Promise.all([stdoutFlood, stderrFlood]);
} else if (pattern === "eof-record") {
  writeRecord(record(), false);
} else if (pattern === "malformed") {
  process.stdout.write("{not-json}\n");
} else if (pattern === "empty-line") {
  process.stdout.write("\n");
} else if (pattern === "oversized") {
  process.stdout.write(`${"x".repeat(1024 * 1024 + 1)}\n`);
} else if (pattern === "status-zero") {
  process.exitCode = 0;
} else if (pattern === "status-one-record") {
  writeRecord(record());
  process.exitCode = 1;
} else if (pattern === "failure") {
  process.stderr.write(`failure in ${process.cwd()} using ${valueOf("--config=") ?? "config"}\n\x1b[31munsafe\x1b[0m\n`);
  process.exitCode = 2;
} else if (pattern === "hang" || pattern === "hang-ignore-term") {
  if (pattern === "hang") process.on("SIGTERM", () => process.exit(0));
  if (pattern === "hang-ignore-term") process.on("SIGTERM", () => undefined);
  writeRecord(record());
  setInterval(() => undefined, 60_000);
} else {
  process.stderr.write(`unknown fake mode: ${pattern}\n`);
  process.exitCode = 2;
}
