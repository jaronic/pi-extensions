# Repository Guidelines

Fourteen independent, private TypeScript extensions for `@earendil-works/pi-coding-agent`, plus the shared `uikit` render-primitive library and standalone global themes. There is no root package or workspace: every top-level extension directory is its own npm package (own dependencies, lockfile, tsconfig, tests). `themes/` is a standalone global Pi resource owned by no extension.

| Package | Purpose |
| --- | --- |
| `rg` | ripgrep-backed `rg` alias; replaces duplicate active `grep` while loaded |
| `plan` | read-only planning/approval; hands approved steps to Todo |
| `goal` | persistent objective + token budget; auto-continuation; mutually exclusive with Plan |
| `lsp` | language-server navigation, diagnostics, symbols, renames, code actions via one `lsp` tool |
| `ast-grep` | pinned-native structural search; preview-bound atomic single-file rewrites |
| `hashline` | `read`/`edit` overrides with branch-local SHA-256 snapshots and CAS writes |
| `request` | one responsive request UI for `ask`, native dialogs, versioned cross-extension requests |
| `todo` | bounded branch-local execution ledger; Plan-aware mutation gating |
| `jaron` | themed custom editor, status line, live Git branch indicator; host package for pi TUI theme development |
| `diffreport` | bounded Git evidence + multi-pass exploration into an evidence-backed Markdown report |
| `telemetry` | passive per-tool call telemetry (counts, failures, latency by provider/model); `/telemetry` export for offline eval |
| `enforce` | rule-driven tool promotion; nudge/gate `tool_call` layer emitting copyable alternative invocations |
| `notify` | out-of-band notifications on `agent_settled` (macOS osascript, terminal bell, ntfy.sh) |
| `doclint` | mechanical AGENTS.md/README contract lint via `doc_lint` tool and `/doclint` |
| `uikit` | shared TUI render primitives (tones incl. markdown/border/diff/selection, tool-card titles, status rows, collapse protocol, `MarkdownTheme`); pure library, no extension entry, consumed via `file:` dependency |
| `themes/` | repository-wide light/dark Pi palettes (`pi-extensions-*`) |

Each extension's internals (state machines, protocols, tool contracts, key files) are documented in its own `<extension>/README.md`; this file intentionally does not duplicate them.

## Cross-Package Rules

- Never import another package via `../../other/src` in production. Cross-package reuse requires a formal package dependency, a public package-root export, and (for bundled runtime code) manifest resource ordering. Shared render primitives live in `uikit` (`pi-uikit-dev`); consume them via a `file:../uikit` dependency plus `bundledDependencies` entry — `uikit` has no extension resource, so no `pi.extensions` ordering is needed.
- Tool renderers across extensions must style through `uikit` primitives (`tone`, `toolCallTitle`, `statusRow`, `collapseLines`, …) rather than ad-hoc `theme.fg` calls, so the same intent renders identically everywhere.
- Plan bundles Request + Todo (loads Request → Todo → Plan); Diffreport bundles Request. Request/Todo use EventBus-scoped registries so standalone and bundled copies share one runtime.
- `plan/src/workflow-mode.ts` and `goal/src/workflow-mode.ts` are intentionally byte-identical; same for `lsp/src/logger.ts` and `hashline/src/logger.ts`. Keep each pair in sync.
- Plan/Goal exclusivity (`pi-extensions:exclusive-workflow:v1`), Plan→Todo phase sync, and Plan→Todo handoff are explicit contracts. Changing them requires updating every affected protocol/service definition, every affected README, and both coexistence suites (`plan/test/coexistence.test.ts`).
- Read `docs/pi-extension-development.md` (versioned Pi API reference + design rules) before adding or materially changing an extension.

## Development Commands

Node `>=22.19.0`, npm, native ESM (do not assume Bun-specific APIs). Per package:

```sh
cd <extension>        # goal plan lsp ast-grep hashline request rg todo jaron diffreport telemetry enforce notify doclint uikit
npm ci
npm run check         # tsc --noEmit; no build/lint/format/dev scripts exist
npm test              # node --import tsx --test test/*.test.ts
```

Whole repo: run the same loop over all fifteen package directories. Several packages import siblings in tests, so `npm ci` must cover all fifteen first; the authoritative per-package test-dependency list is the `testDependencies` matrix in `.github/workflows/ci.yml`.

- `ast-grep` additionally: `npm run release-smoke` (packed clean-install Pi smoke) for package/release-boundary changes.
- Global development links: `make pi-on` / `make pi-status` (`pi-extensions-*` / `pi-themes-*` variants for one class; delegates to `scripts/pi-global-links.sh`, respects `PI_CODING_AGENT_DIR`, refuses foreign or conflicting paths; never `npm link`). Use `/reload` after changing extension code.
- Isolated load smoke: `pi --no-session -p --extension "$PWD/<name>" "Reply with exactly: SMOKE_OK"`.

## Code Conventions

- Strict ESM TypeScript, `NodeNext`; explicit `.ts` suffixes on local imports; two-space indent, double quotes, semicolons (no formatter — match surrounding code). PascalCase types, camelCase members, `UPPER_SNAKE_CASE` protocol constants; lowercase-hyphenated filenames.
- `src/index.ts` is the composition root (lifecycle state, registration, wiring only); logic lives in focused modules (`command.ts`, `tools.ts`, `prompts.ts`, `protocol.ts`, `state.ts`, …). `state.ts` transitions stay pure and immutable; validate unknown persisted/config input before use.
- Tool input via TypeBox (`Type.Object`, `StringEnum`); finite states/actions via string-literal unions.
- Throw `Error` from validation/routing/tool failures so Pi records a failed tool call; slash-command/UI handlers may catch and notify. Propagate `AbortSignal`; clean up listeners, timers, and processes on all exit paths.
- Pi host packages and TypeBox are peer dependencies (`>=0.81.0`), never bundled runtime deps; third-party runtime code belongs in the owning package's `dependencies`, tooling in `devDependencies`.
- UI components render only from host `Theme` semantic tokens (`text`/`muted`/`dim`, `accent`, `selectedBg`, `success`/`warning`/`error`, `md*`, `tool*`); never hardcode ANSI, RGB, hex, or private palettes. Distributable palettes live in `themes/` and must pass `node themes/validate.mjs`.

## Documentation Contract

Extension READMEs are part of the implementation contract: any behavior, command/tool schema, configuration, integration, installation, or architecture change MUST update the affected `<extension>/README.md` in the same change; cross-extension changes update every affected README. Work is incomplete while documentation describes stale behavior.

## Testing

`node:test` + `node:assert/strict` + `tsx`; tests are `test/*.test.ts` direct children, helpers (e.g. `plan/test/harness.ts`, `lsp/test/fake-server.mjs`) live outside that glob. Add tests for new observable contracts and plausible regressions; no coverage tool or thresholds. Area-specific gates: `node themes/validate.mjs` for palette changes, `make pi-links-test` for link-script changes, `npm run release-smoke` (ast-grep) for release boundaries, and Goal + Plan + Todo plus both coexistence suites for exclusivity/handoff changes.
