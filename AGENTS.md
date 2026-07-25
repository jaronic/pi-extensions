# Repository Guidelines

## Project Overview

This repository contains seven independent, private TypeScript extensions for `@earendil-works/pi-coding-agent`:

- `rg`: registers a ripgrep-backed `rg` tool and prioritizes it over Pi's built-in `grep`.
- `plan`: implements a planning/approval/execution state machine with tool restrictions.
- `goal`: tracks a persistent objective and optional token budget, then coordinates automatic continuation with Plan.
- `lsp`: exposes language-server navigation, diagnostics, symbols, rename previews, and code actions through one `lsp` tool.
- `request`: provides one responsive request UI for the `ask` tool, native extension dialogs, and versioned cross-extension requests.
- `todo`: maintains a bounded, branch-local execution ledger with stable task IDs, one active task, and Plan-aware mutation gating.
- `promptline-editor`: owns the themed custom editor, compact status line, and live Git branch indicator.

There is no root npm package or workspace. Treat each top-level directory as a separate package and run package commands from that directory.
The top-level `themes/` directory is a standalone global Pi resource, not an extension package and not owned by any extension.

## Architecture & Data Flow

Each `<extension>/package.json` declares `pi.extensions: ["./src/index.ts"]`. Pi loads that module and calls its default `*Extension(pi: ExtensionAPI)` function. Global themes are discovered and selected independently of extension loading.

- Plan and Goal keep mutable lifecycle state in `src/index.ts`; command registration, tool contracts, prompts, schemas, and event/journal protocols live in focused modules. Pure transition and validation logic lives in `state.ts`. Both extensions persist versioned custom entries with `pi.appendEntry()` and rebuild from the active branch on `session_start` and `session_tree`.
- Todo keeps its immutable board snapshot in `src/index.ts`; pure transitions and strict decoding live in `state.ts`, while tool results and command custom entries share a versioned sequence/replay protocol in `persistence.ts`.
- Plan moves through `planning -> awaitingApproval -> executing`, leases the active tool set without losing external changes, and injects phase-specific context before agent turns. Goal injects objective context, accounts tokens/time, and queues continuation turns until completion or a terminal status.
- Plan broadcasts `pi-extensions:plan-state:v1`; Goal and Todo independently define and validate the same versioned payload without production cross-imports. Keep all three protocol modules plus `plan/test/coexistence.test.ts` and `todo/test/coexistence.test.ts` synchronized.
- LSP resolves and confines a requested file to the workspace, chooses a configured server by action and file type, reuses one client per server/workspace root, synchronizes the document, sends JSON-RPC, and formats bounded results. `tool_result` performs best-effort sync after `edit`/`write`; `session_shutdown` closes clients and child processes.
- RG delegates execution to Pi's grep definition using `ctx.cwd`, then reorders active tools on session lifecycle events.
- Request normalizes and serializes interactive questions through one responsive Question/Review component. It installs session-scoped adapters over the shared `ExtensionUIContext` `select`/`confirm`/`input` methods and exposes `pi-extensions:request-ui:v1` for richer independent callers; shutdown aborts pending dialogs and restores only wrappers it still owns.

## Key Directories

| Path | Purpose |
| --- | --- |
| `goal/src/`, `goal/test/` | Goal lifecycle plus focused command, tool, prompt, protocol, persistence, accounting, and state modules. |
| `plan/src/`, `plan/test/` | Plan lifecycle plus focused command, tool, prompt, protocol, output, tool-lease, and state-machine modules. |
| `lsp/src/`, `lsp/test/` | LSP configuration, routing, JSON-RPC clients, formatting, and fake-server tests. |
| `rg/src/`, `rg/test/` | Ripgrep tool registration, priority logic, and focused tests. |
| `request/src/`, `request/test/` | Request schemas, responsive TUI, native adapters, event protocol, serialized coordinator, and tests. |
| `todo/src/`, `todo/test/` | Todo state machine, bounded output, mixed-carrier branch persistence, TUI/command surfaces, and cross-extension coexistence tests. |
| `promptline-editor/src/`, `promptline-editor/test/` | Promptline TUI renderer plus Git `HEAD` branch monitor and linked-worktree regression test. |
| `themes/` | Standalone repository-wide light/dark Pi palettes and their global installation/activation contract. |
| `Makefile`, `scripts/` | Safe global Pi link controls and their dependency-free behavior tests. |

Each package owns its dependencies, lockfile, compiler configuration, and tests. Do not add cross-package production imports or assume root-level dependency resolution.

## Development Commands

Use Node.js `>=22.19.0` and npm. From one extension directory:

```sh
cd promptline-editor       # or goal, plan, lsp, request, rg, todo
npm ci
npm run check              # tsc --noEmit
npm test                   # node --import tsx --test test/*.test.ts
```

To check every package from the repository root:

```sh
for dir in goal plan lsp request rg todo promptline-editor; do
  (cd "$dir" && npm run check && npm test) || exit 1
done
```

GitHub Actions runs the same `npm ci`, `npm run check`, and `npm test` sequence for all seven packages via `.github/workflows/ci.yml`.

There are no `build`, `lint`, `format`, `start`, or `dev` scripts. TypeScript is loaded directly by Pi and tests; `npm run check` intentionally emits no build artifacts.

For global development use, enable this repository's seven extensions and six themes from the repository root:

```sh
make pi-on
make pi-status
```

Use `make pi-extensions-on|off|toggle|status` or `make pi-themes-on|off|toggle|status` for one resource class. The generic `pi-on`, `pi-off`, `pi-toggle`, and `pi-status` targets also accept `SCOPE=extensions` or `SCOPE=themes`. They delegate to `scripts/pi-global-links.sh`, respect `PI_CODING_AGENT_DIR`, touch only links that resolve into this repository, and refuse conflicting files, directories, or foreign links. Theme-off operations also refuse while a managed theme is selected; choose a built-in theme through `/settings` first.

Pi follows each linked package's manifest to `src/index.ts`; use `/reload` after changing extension code. Theme discovery is independent: select a newly installed theme once through `/settings`; only an already-active custom theme file hot reloads. Do not use `npm link` for this workflow or commit machine-specific links.

For an isolated load smoke test that does not use the current session or global links:

```sh
for name in goal plan lsp request rg todo promptline-editor; do
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
- Treat the Plan coordination event as a versioned Plan/Goal/Todo contract. Update all three protocol definitions and both coexistence suites if its name or payload changes.
- Treat Pi's `ThemeColor`/`ThemeBg` unions as the repository-wide UI contract. Use `text`/`muted`/`dim` for hierarchy, `accent`/`borderAccent` for focus, `selectedBg` for selection, `success`/`warning`/`error` for state, `md*` for Markdown, and `tool*` for tool output. Never hardcode ANSI, RGB, hex, or a plugin-private palette in component code; custom components must render from the host `Theme` so theme changes propagate. The standalone top-level `themes/` directory owns every distributable `pi-extensions-*` palette. Extension packages consume only host semantic tokens and never import or register those files in production. Every palette must pass `node themes/validate.mjs`; live TUI backgrounds come from the terminal, so light and dark palettes must declare and validate against the matching `export.pageBg` family.
- Extension READMEs are part of the implementation contract. Any behavior, command/tool schema, configuration, integration, installation, or architecture change MUST update that extension's `<extension>/README.md` in the same change. Cross-extension changes MUST update every affected README; work is incomplete while documentation describes stale behavior.

## Important Files

- `docs/pi-extension-development.md`: versioned Pi API reference, ecosystem examples, extension design rules, security guidance, and pre-merge checklist; read it before adding or materially changing an extension.
- `goal/README.md`, `plan/README.md`, `lsp/README.md`, `request/README.md`, `rg/README.md`, `todo/README.md`, `promptline-editor/README.md`: user-facing installation, global symlink integration, usage, configuration, effects, implementation principles, and key code nodes. Keep each aligned with its extension.
- `themes/README.md`: global palette installation, activation lifecycle, semantic roles, and extension integration contract.
- `*/package.json`: Pi entry metadata, Node requirement, scripts, and package-local dependencies.
- `*/tsconfig.json`: shared strict `NodeNext`, `noEmit` TypeScript contract covering `src/**/*.ts` and `test/**/*.ts`.
- `.github/workflows/ci.yml`: dependency-free theme validation and global-link-manager tests plus a seven-package Node 22.19 matrix running clean install, typecheck, and tests.
- `plan/src/index.ts`, `plan/src/command.ts`, `plan/src/tools.ts`, `plan/src/state.ts`, `plan/src/tool-lease.ts`: Plan lifecycle wiring, user/tool boundaries, state machine, and coexistence-safe active-tool leasing.
- `goal/src/index.ts`, `goal/src/command.ts`, `goal/src/tools.ts`, `goal/src/state.ts`: Goal lifecycle wiring, user/tool boundaries, persistence, continuation, and accounting rules.
- `lsp/src/index.ts`, `lsp/src/config.ts`, `lsp/src/server-manager.ts`, `lsp/src/lsp-client.ts`: LSP API boundary, layered configuration, routing/lifecycle, and protocol transport.
- `lsp/src/roots.ts`, `lsp/src/positions.ts`, `lsp/src/format.ts`: workspace confinement, position conversion, and bounded output formatting.
- `rg/src/index.ts`: complete RG extension and exported priority helper.
- `request/src/index.ts`, `request/src/component.ts`, `request/src/adapters.ts`, `request/src/protocol.ts`: Request lifecycle wiring, responsive renderer, native UI compatibility layer, and shared request channel.
- `todo/src/index.ts`, `todo/src/state.ts`, `todo/src/tools.ts`, `todo/src/persistence.ts`, `todo/src/output.ts`: Todo lifecycle wiring, immutable transitions, bounded tool contract, branch replay, and TUI/model projections.
- `promptline-editor/src/index.ts`, `promptline-editor/src/branch.ts`: custom editor composition plus live Git `HEAD` monitoring for normal and linked worktrees.
- `themes/pi-extensions-*.json`, `themes/validate.mjs`: standalone global Pi palettes and the role-aware schema/contrast gate.
- `Makefile`, `scripts/pi-global-links.sh`, `scripts/pi-global-links.test.mjs`: conflict-safe global extension/theme link controls and isolated behavior tests.
- `plan/test/harness.ts`, `plan/test/coexistence.test.ts`: in-process Pi test double and the main cross-extension behavioral suite.

## Runtime/Tooling Preferences

- Runtime: Node.js `>=22.19.0`; packages are native ESM. Do not assume Bun-specific APIs.
- Package manager: npm, evidenced by one lockfile v3 per package. No exact npm version or `packageManager` field is pinned; update the affected package's lockfile when dependencies change.
- Pi compatibility: common host packages and TypeBox are peer dependencies at `>=0.81.0` and development dependencies for local checking. Keep Pi host libraries as peers rather than ordinary bundled runtime dependencies.
- `lsp` alone ships runtime dependencies (`vscode-jsonrpc` and `vscode-languageserver-protocol`). New third-party code needed at runtime belongs in that package's `dependencies`; test/type tooling belongs in `devDependencies`.
- CI contains a dependency-free resource job plus a six-package matrix in `.github/workflows/ci.yml`. There is still no repository-level npm package, formatter, linter, bundler, or generated-output workflow; do not invent shared dependency resolution unless deliberately converting to a workspace.

## Testing & QA

Tests use Node's built-in `node:test` runner, `node:assert/strict`, and `tsx`. Test files are direct children named `test/*.test.ts`; helpers such as `plan/test/harness.ts` and `lsp/test/fake-server.mjs` are intentionally outside that glob.

- Put pure transition and validation contracts beside the relevant package tests.
- Use `plan/test/coexistence.test.ts` for observable Goal/Plan lifecycle behavior; it imports Goal directly and exercises commands, tools, events, UI state, abort/wait ordering, persistence, and continuation.
- LSP tests use isolated temporary workspaces and a deterministic child-process fake server. Cover initialization failure, request cancellation/timeout, process crashes, diagnostic settling, partial multi-server failure, idle cleanup, and bounded shutdown; always remove temporary files in cleanup hooks.
- Request tests drive the real component through tool, native UI, external event, and Goal confirmation paths. Cover single/multi/Other/Review behavior, serialization, abort/timeout/shutdown, headless rejection, fallback semantics, and bounded narrow-terminal rendering.
- Todo tests cover pure transitions, strict mixed-carrier replay, bounded prompt/output, command and TUI/headless behavior, and Plan/Goal/Request coexistence in both load orders.
- Run `node themes/validate.mjs` for any palette change and `make pi-links-test` for global-link-manager changes. Run `npm run check` and `npm test` in every affected package. For Plan coordination protocol changes, run Goal, Plan, and Todo plus both coexistence suites; CI repeats the resource gates and all six package checks from clean installs.
- No coverage tool, threshold, skipped-test convention, or focused-test script is configured. Add tests for new observable contracts and plausible regressions; do not assert incidental implementation details merely to increase coverage.
