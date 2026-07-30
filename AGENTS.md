# Repository Guidelines

## Project Overview

This repository contains ten independent, private TypeScript extensions for `@earendil-works/pi-coding-agent`:

- `rg`: registers a ripgrep-backed `rg` alias and replaces duplicate active `grep` exposure while loaded.
- `plan`: implements read-only planning, approval, refinement, and clean handoff of approved steps to Todo.
- `goal`: tracks a persistent objective and optional token budget, then coordinates automatic continuation while remaining mutually exclusive with active Plan mode.
- `lsp`: exposes language-server navigation, diagnostics, symbols, rename previews, and code actions through one `lsp` tool.
- `ast-grep`: provides pinned-native structural search plus preview-bound, atomic single-file AST rewriting.
- `hashline`: overrides `read`/`edit` with branch-local SHA-256 snapshots, seen-line provenance, and same-file compare-and-set writes.
- `request`: provides one responsive request UI for the `ask` tool, native extension dialogs, and versioned cross-extension requests.
- `todo`: maintains a bounded, branch-local execution ledger with stable task IDs, one active task, and Plan-aware mutation gating.
- `promptline-editor`: owns the themed custom editor, compact status line, and live Git branch indicator.
- `diffreport`: bundles Request, collects bounded Git evidence, and launches multi-pass LLM exploration that reconstructs business behavior, problem/decision chains, and tradeoffs into an evidence-backed Markdown report with diagrams.

There is no root npm package or workspace. Treat each top-level directory as a separate package and run package commands from that directory.
The top-level `themes/` directory is a standalone global Pi resource, not an extension package and not owned by any extension.

## Architecture & Data Flow

Each standalone `<extension>/package.json` declares its own Pi resources. Plan bundles Request and Todo and loads Request → Todo → Plan; Diffreport bundles Request and loads Request → Diffreport. Diffreport exposes `change-report` through both `pi.skills` for package loading and `resources_discover` for extension-only global symlinks; Pi deduplicates the canonical skill path. Request/Todo use EventBus-scoped registries so standalone and bundled physical copies share one runtime. Global themes are discovered and selected independently of extension loading.

- Plan and Goal keep mutable lifecycle state in `src/index.ts`; command registration, tool contracts, prompts, schemas, and event/journal protocols live in focused modules. Pure transition and validation logic lives in `state.ts`. Both extensions persist versioned custom entries with `pi.appendEntry()` and rebuild from the active branch on `session_start` and `session_tree`.
- Todo keeps its immutable board snapshot in `src/index.ts`; pure transitions and strict decoding live in `state.ts`, while tool results and command custom entries share a versioned sequence/replay protocol in `persistence.ts`.
- Plan moves through `planning`, optional clarification/blocking, and `awaitingApproval`; approval commits its steps to the ordinary Todo board and closes Plan immediately. Goal injects objective context, accounts tokens/time, and queues continuation turns until completion or a terminal status.
- Plan/Goal use the versioned `pi-extensions:exclusive-workflow:v1` query protocol to prevent overlapping active workflows. Plan directly syncs its candidate phase to Todo for mutation gating, then calls `handoffPlan()` on approval; Todo does not maintain a separate Plan progress ledger.
- LSP strictly decodes configuration, confines files to the workspace, routes by action/file type, reuses one client per server/workspace root, synchronizes documents, formats faithful bounded output, and terminates server process trees during shutdown. `tool_result` performs best-effort sync after built-in `edit`/`write` and strictly decoded successful `ast_grep_edit` apply results.
- Hashline preserves Pi's `read`/`edit` names, schemas where applicable, renderers, result details, and shared mutation queue while adding strict byte snapshots and branch-local seen-line provenance. Snapshot metadata is replayed from versioned custom entries; refreshable refusals (stale, unknown, unseen, range, conflict, no-change, would-empty) return as plain tool results carrying a journaled refreshed snapshot rather than thrown errors, while wrong-path, branch-change, and genuine mutation failures still throw before writing.
- Ast-grep resolves an exact platform package to a pinned native executable, confines every candidate and match to the canonical workspace, bounds traversal/output, and separates deterministic preview from fingerprint-bound atomic apply.
- RG delegates execution and result rendering to Pi's grep definition using `ctx.cwd`, collapses simultaneous `rg`/`grep` active entries to `rg`, and restores `grep` on shutdown.
- Request validates and serializes interactive questions through one responsive Question/Review component. It rejects terminal/bidirectional controls at external display boundaries, neutralizes them in free text, and exposes `installRequest(pi)` as the shared runtime service; `pi-extensions:request-ui:v1` remains a compatibility channel for independent callers. It installs session-scoped adapters over the shared `ExtensionUIContext` `select`/`confirm`/`input` methods; shutdown aborts pending dialogs and restores only wrappers it still owns.
- Diffreport uses the direct `installRequest(pi)` service for source/boundary collection and the shared `ask` tool for later material ambiguity. Its command sends an exploration brief rather than a static summary; the stateless `diff_report` tool supplies overview/patch/history evidence, while the bundled `change-report` skill requires repository-wide business-flow tracing and writes the final Markdown artifact. `src/index.ts` must advertise its canonical `skills/` directory on every `resources_discover` startup/reload so `~/.pi/agent/extensions/diffreport` works without a separate global skill link.

## Key Directories

| Path | Purpose |
| --- | --- |
| `goal/src/`, `goal/test/` | Goal lifecycle plus focused command, tool, prompt, protocol, persistence, accounting, and state modules. |
| `plan/src/`, `plan/test/` | Plan lifecycle plus focused command, tool, prompt, protocol, output, tool-lease, and state-machine modules. |
| `lsp/src/`, `lsp/test/` | LSP configuration, routing, JSON-RPC clients, formatting, and fake-server tests. |
| `ast-grep/src/`, `ast-grep/test/` | Native CLI resolution, workspace scan, structural search, preview/apply rewrite pipeline, bounded output, and failure-path tests. |
| `hashline/src/`, `hashline/test/` | Hashline read/edit overrides, byte-faithful lines, snapshot replay/LRU, guarded mutation pipeline, and coexistence tests. |
| `rg/src/`, `rg/test/` | Ripgrep alias registration, active-tool replacement/restoration, and focused tests. |
| `request/src/`, `request/test/` | Request schemas, responsive TUI, native adapters, event protocol, serialized coordinator, and tests. |
| `todo/src/`, `todo/test/` | Todo state machine, bounded output, mixed-carrier branch persistence, TUI/command surfaces, and cross-extension coexistence tests. |
| `promptline-editor/src/`, `promptline-editor/test/` | Promptline TUI renderer plus Git `HEAD` branch monitor and linked-worktree regression test. |
| `diffreport/src/`, `diffreport/test/` | Request-driven report workflow, bounded Git evidence views, real-repository integration, Markdown kickoff, and business-analysis formatting contracts. |
| `themes/` | Standalone repository-wide light/dark Pi palettes and their global installation/activation contract. |
| `Makefile`, `scripts/` | Safe global Pi link controls and their dependency-free behavior tests. |

Each package owns its dependencies, lockfile, compiler configuration, and tests. Cross-package production imports require a formal package dependency, public package-root export, bundled runtime dependency, and manifest resource ordering; never import another package through `../../other/src` in production.

## Development Commands

Use Node.js `>=22.19.0` and npm. From one extension directory:

```sh
cd promptline-editor       # or goal, plan, lsp, ast-grep, hashline, request, rg, todo, diffreport
npm ci
npm run check              # tsc --noEmit
npm test                   # node --import tsx --test test/*.test.ts
```

Ast-grep additionally provides `npm run release-smoke`, which packs the extension, performs a clean `--omit=dev` install, loads the packed package through Pi, and drives a deterministic real Pi CLI search/stale-apply/apply sequence.

To check every package from the repository root, install dependencies first and then run checks; several packages import sibling packages in tests, so the install phase must cover all ten directories before any test runs. The authoritative per-package test-dependency list is the `testDependencies` matrix in `.github/workflows/ci.yml` (for example `plan` needs `goal` and `ast-grep` installed, `hashline` needs `plan`, `lsp`, and `rg`, `todo` needs `goal`, `plan`, and `request`):

```sh
for dir in goal plan lsp ast-grep hashline request rg todo promptline-editor diffreport; do
  (cd "$dir" && npm ci) || exit 1
done
for dir in goal plan lsp ast-grep hashline request rg todo promptline-editor diffreport; do
  (cd "$dir" && npm run check && npm test) || exit 1
done
```

GitHub Actions runs `npm ci`, `npm run check`, and `npm test` for all ten packages. Ast-grep runs that suite on its five accepted native OS/architecture/libc tuples and gates its packed clean-install Pi smoke separately.

There are no `build`, `lint`, `format`, `start`, or `dev` scripts. TypeScript is loaded directly by Pi and tests; `npm run check` intentionally emits no build artifacts.

For global development use, enable this repository's ten extensions and six themes from the repository root:

```sh
make pi-on
make pi-status
```

Use `make pi-extensions-on|off|toggle|status` or `make pi-themes-on|off|toggle|status` for one resource class. The generic `pi-on`, `pi-off`, `pi-toggle`, and `pi-status` targets also accept `SCOPE=extensions` or `SCOPE=themes`. They delegate to `scripts/pi-global-links.sh`, respect `PI_CODING_AGENT_DIR`, touch only links that resolve into this repository, and refuse conflicting files, directories, or foreign links. Theme-off operations also refuse while a managed theme is selected; choose a built-in theme through `/settings` first.

Pi follows each linked package's manifest to `src/index.ts`; use `/reload` after changing extension code. Theme discovery is independent: select a newly installed theme once through `/settings`; only an already-active custom theme file hot reloads. Do not use `npm link` for this workflow or commit machine-specific links.

For an isolated load smoke test that does not use the current session or global links:

```sh
for name in goal plan lsp ast-grep hashline request rg todo promptline-editor diffreport; do
  pi --no-session -p --extension "$PWD/$name" "Reply with exactly: SMOKE_OK"
done
```

## Code Conventions & Common Patterns

- Use strict ESM TypeScript with `NodeNext` resolution. Keep explicit `.ts` suffixes on local imports, two-space indentation, double quotes, and semicolons; no formatter is configured, so match surrounding code.
- Use PascalCase for classes/interfaces/types, camelCase for functions and fields, and `UPPER_SNAKE_CASE` for protocol/configuration constants. Source filenames are lowercase and hyphenated when multiword.
- Keep `src/index.ts` as the Pi composition root: lifecycle state, host registration, and dependency wiring only. Put commands, tools, prompts, protocol parsing, schemas, deterministic transitions, routing, and formatting in focused modules such as `command.ts`, `tools.ts`, `prompts.ts`, `protocol.ts`, and `state.ts`.
- Define tool input with TypeBox (`Type.Object`) and `StringEnum`. Model finite states/actions with string-literal unions and validate unknown persisted/config input before use.
- There is no dependency-injection container. Pi supplies `ExtensionAPI`/context; pass other dependencies explicitly or through constructors such as `ServerManager(cwd, config)`.
- Preserve immutable state transitions in `goal/src/state.ts`, `plan/src/state.ts`, and `todo/src/state.ts`. Entry modules may own lifecycle state, while LSP long-lived resources belong in manager/client classes and `Map`s.
- Throw `Error` from validation, routing, and tool execution failures so Pi records a failed tool call. Slash-command/UI handlers may catch `unknown`, format it with `error instanceof Error ? error.message : String(error)`, and notify the user.
- Propagate `AbortSignal` through async tool and LSP work. Use `Promise.allSettled` where one server/client failure must not discard other results, and clean up listeners, timers, processes, and temporary resources on all exit paths.
- Treat Plan/Goal workflow exclusivity, Plan→Todo phase sync, and Plan→Todo handoff as explicit versioned/direct contracts. Update every affected protocol/service definition, README, and both coexistence suites when these semantics change.
- Treat Pi's `ThemeColor`/`ThemeBg` unions as the repository-wide UI contract. Use `text`/`muted`/`dim` for hierarchy, `accent`/`borderAccent` for focus, `selectedBg` for selection, `success`/`warning`/`error` for state, `md*` for Markdown, and `tool*` for tool output. Never hardcode ANSI, RGB, hex, or a plugin-private palette in component code; custom components must render from the host `Theme` so theme changes propagate. The standalone top-level `themes/` directory owns every distributable `pi-extensions-*` palette. Extension packages consume only host semantic tokens and never import or register those files in production. Every palette must pass `node themes/validate.mjs`; live TUI backgrounds come from the terminal, so light and dark palettes must declare and validate against the matching `export.pageBg` family.
- Extension READMEs are part of the implementation contract. Any behavior, command/tool schema, configuration, integration, installation, or architecture change MUST update that extension's `<extension>/README.md` in the same change. Cross-extension changes MUST update every affected README; work is incomplete while documentation describes stale behavior.

## Important Files

- `docs/pi-extension-development.md`: versioned Pi API reference, ecosystem examples, extension design rules, security guidance, and pre-merge checklist; read it before adding or materially changing an extension.
- `goal/README.md`, `plan/README.md`, `lsp/README.md`, `ast-grep/README.md`, `hashline/README.md`, `request/README.md`, `rg/README.md`, `todo/README.md`, `promptline-editor/README.md`, `diffreport/README.md`: user-facing installation, global symlink integration, usage, configuration, effects, implementation principles, and key code nodes. Keep each aligned with its extension.
- `themes/README.md`: global palette installation, activation lifecycle, semantic roles, and extension integration contract.
- `*/package.json`: Pi entry metadata, Node requirement, scripts, and package-local dependencies.
- `*/tsconfig.json`: shared strict `NodeNext`, `noEmit` TypeScript contract covering `src/**/*.ts` and `test/**/*.ts`.
- `.github/workflows/ci.yml`: dependency-free theme/link validation, a nine-package general Node 22.19 matrix, a five-tuple ast-grep native matrix, and a gated packed Pi smoke; together they cover all ten extensions.
- `plan/src/index.ts`, `plan/src/command.ts`, `plan/src/tools.ts`, `plan/src/state.ts`, `plan/src/tool-lease.ts`, `plan/src/workflow-mode.ts`: Plan lifecycle wiring, user/tool boundaries, state machine, coexistence-safe active-tool leasing, and the Plan-side exclusive-workflow query protocol.
- `goal/src/index.ts`, `goal/src/command.ts`, `goal/src/tools.ts`, `goal/src/state.ts`, `goal/src/workflow-mode.ts`: Goal lifecycle wiring, user/tool boundaries, persistence, continuation, accounting rules, and the Goal-side exclusive-workflow query protocol. The `workflow-mode.ts` copies in plan and goal are intentionally identical byte-for-byte to avoid production cross-package imports; keep them in sync when the `pi-extensions:exclusive-workflow:v1` semantics change.
- `lsp/src/index.ts`, `lsp/src/config.ts`, `lsp/src/server-manager.ts`, `lsp/src/lsp-client.ts`, `lsp/src/tool-sync.ts`: LSP API boundary, layered configuration, routing/lifecycle, protocol transport, and successful edit synchronization.
- `lsp/src/logger.ts`, `hashline/src/logger.ts`: bounded troubleshooting log written as single-line JSON to `getAgentDir()/logs/<ext>.log` with 5 MiB rotation, lazy log-directory creation, C1 neutralization, and swallowed self-failures. The threshold resolves from `PI_<EXT>_LOG` (e.g. `PI_LSP_LOG`/`PI_HASHLINE_LOG`), then the shared `PI_EXT_LOG` fallback, then the top-level `logEnabled`/`logLevel` keys in each extension's global `getAgentDir()/<ext>.json` (LSP's strict decoder accepts them only in the global file), defaulting to on at `error`; env values are a level name, `0`/`false`/`off` to disable, or any other truthy value for `debug`. Each record must stay reproducible (request/action shape, resolved command, captured server stderr, snapshot token, error code, duration, runtime generation). LSP logs lifecycle (`manager_ready`/`server_started`/`tool_succeeded`/`shutdown`) at `info`, start/diagnostics/sync failures and unexpected `server_exited` at `warn`, tool/command failures at `error`, and idle-shutdown/file-sync at `debug`; Hashline logs `edit_committed`/`snapshots_restored` at `info`, `edit_refused` (routine CAS refusals) and capture/shutdown events at `debug`, and `E_WRITE_FAILED`/unexpected errors at `error`. The two `logger.ts` copies are intentionally identical byte-for-byte to avoid production cross-package imports; keep them in sync when this logging contract changes.
- `lsp/src/roots.ts`, `lsp/src/positions.ts`, `lsp/src/format.ts`: workspace confinement, position conversion, and bounded output formatting.
- `ast-grep/src/index.ts`, `ast-grep/src/runner.ts`, `ast-grep/src/workspace.ts`, `ast-grep/src/edit.ts`: tool wiring, native process control, path traversal/confinement, and preview-bound atomic edit semantics.
- `hashline/src/index.ts`, `hashline/src/read-tool.ts`, `hashline/src/edit-tool.ts`, `hashline/src/operations.ts`: snapshot lifecycle, read capture, guarded compare-and-set mutation, and deterministic line operations.
- `rg/src/index.ts`: complete RG extension and exported active-alias replacement helper.
- `request/src/index.ts`, `request/src/component.ts`, `request/src/adapters.ts`, `request/src/protocol.ts`: idempotent Request installer/service, responsive renderer, native UI compatibility layer, and independent-caller request channel.
- `todo/src/index.ts`, `todo/src/state.ts`, `todo/src/tools.ts`, `todo/src/persistence.ts`, `todo/src/service.ts`, `todo/src/output.ts`: idempotent installer/service, immutable ordinary board and Plan handoff transition, bounded tool contract, branch replay, and TUI/model projections.
- Use `plan/test/coexistence.test.ts` for observable Goal/Plan lifecycle behavior, Request clarification, direct Todo failure semantics, commands, tools, UI state, abort/wait ordering, persistence, and continuation.
- LSP tests use isolated temporary workspaces and a deterministic child-process fake server. Cover initialization failure, request cancellation/timeout, process crashes, diagnostic settling, partial multi-server failure, successful external edit synchronization, idle cleanup, and bounded shutdown; always remove temporary files in cleanup hooks.
- Ast-grep tests use isolated workspaces plus fake and pinned-native runners. Cover every accepted platform package and language, trusted config isolation, raw filename/symlink/identity boundaries, traversal/output/heap limits, malformed or flooded CLI streams, scheduler/operation cancellation and shutdown, complete preview fingerprints, all synchronous commit deadline guards, temp/parent/workspace inode races, permissions, and atomic rename failures. Run `npm run release-smoke` for package or release-boundary changes.
- Request tests drive the real component through tool, native UI, external event, direct service, and Goal confirmation paths. Cover single/multi/Other/Review behavior, serialization, abort/timeout/shutdown, headless rejection, fallback semantics, and bounded narrow-terminal rendering.
- Todo tests cover pure transitions, strict mixed-carrier replay, direct/compatibility service behavior, bounded prompt/output, command and TUI/headless behavior, and Plan-only/dependencies-first/Plan-first registration plus ordinary-board handoff regressions.
- `promptline-editor/src/index.ts`, `promptline-editor/src/branch.ts`: custom editor composition plus live Git `HEAD` monitoring for normal and linked worktrees.
- `diffreport/src/index.ts`, `diffreport/src/command.ts`, `diffreport/src/workflow.ts`, `diffreport/src/tool.ts`, `diffreport/src/git-diff.ts`, `diffreport/src/formatter.ts`: Request composition, extension-only skill discovery, source/boundary selection, exploration kickoff, Git evidence routing, and bounded evidence formatting; `diffreport/skills/change-report/SKILL.md` owns the multi-pass business-report and diagram methodology.
- `themes/pi-extensions-*.json`, `themes/validate.mjs`: standalone global Pi palettes and the role-aware schema/contrast gate.
- `Makefile`, `scripts/pi-global-links.sh`, `scripts/pi-global-links.test.mjs`: conflict-safe global extension/theme link controls and isolated behavior tests.
- `plan/test/harness.ts`, `plan/test/coexistence.test.ts`: in-process Pi test double and the main cross-extension behavioral suite.

## Runtime/Tooling Preferences

- Runtime: Node.js `>=22.19.0`; packages are native ESM. Do not assume Bun-specific APIs.
- Package manager: npm, evidenced by one lockfile v3 per package. No exact npm version or `packageManager` field is pinned; update the affected package's lockfile when dependencies change.
- Pi compatibility: common host packages and TypeBox are peer dependencies at `>=0.81.0` and development dependencies for local checking. Keep Pi host libraries as peers rather than ordinary bundled runtime dependencies.
- `lsp` ships `vscode-jsonrpc` and `vscode-languageserver-protocol`; `ast-grep` ships five exact-pinned `@ast-grep/cli-*` platform packages as optional dependencies. Plan bundles Request/Todo and Diffreport bundles Request through formal package dependencies, bundled dependencies, and manifest resource ordering. New third-party runtime code belongs in the owning package's `dependencies`; test/type tooling belongs in `devDependencies`.
- CI contains a dependency-free resource job, a nine-package general matrix, and a five-tuple ast-grep native matrix. There is still no repository-level npm package, formatter, linter, bundler, or generated-output workflow; do not invent shared dependency resolution unless deliberately converting to a workspace.

## Testing & QA

Tests use Node's built-in `node:test` runner, `node:assert/strict`, and `tsx`. Test files are direct children named `test/*.test.ts`; helpers such as `plan/test/harness.ts` and `lsp/test/fake-server.mjs` are intentionally outside that glob.

- Put pure transition and validation contracts beside the relevant package tests.
- Hashline tests cover byte-precise digest/line behavior, strict snapshot replay/LRU, operation conflicts and limits, stale/unseen/path failures, concurrent mutation, cancellation/commit boundaries, symlink/hardlink policy, lifecycle recovery, and Plan/LSP/RG coexistence.
- Run `node themes/validate.mjs` for any palette change and `make pi-links-test` for global-link-manager changes. Run `npm run check` and `npm test` in every affected package. Diffreport changes must cover extension-only bundled-skill discovery, Request selection, real Git evidence, Markdown kickoff, and bounded output; Plan/Goal exclusivity or Plan/Todo handoff changes require Goal, Plan, and Todo plus both coexistence suites.
- No coverage tool, threshold, skipped-test convention, or focused-test script is configured. Add tests for new observable contracts and plausible regressions; do not assert incidental implementation details merely to increase coverage.
