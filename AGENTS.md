# Repository Guidelines

## Project Overview

This repository contains five independent, private TypeScript extensions for `@earendil-works/pi-coding-agent`:

- `rg`: registers a ripgrep-backed `rg` tool and prioritizes it over Pi's built-in `grep`.
- `plan`: implements a planning/approval/execution state machine with tool restrictions.
- `goal`: tracks a persistent objective and optional token budget, then coordinates automatic continuation with Plan.
- `lsp`: exposes language-server navigation, diagnostics, symbols, rename previews, and code actions through one `lsp` tool.
- `request`: provides one responsive request UI for the `ask` tool, native extension dialogs, and versioned cross-extension requests.

There is no root npm package or workspace. Treat each top-level directory as a separate package and run package commands from that directory.
The top-level `themes/` directory is a standalone global Pi resource, not an extension package and not owned by any extension.

## Architecture & Data Flow

Each `<extension>/package.json` declares `pi.extensions: ["./src/index.ts"]`. Pi loads that module and calls its default `*Extension(pi: ExtensionAPI)` function. Global themes are discovered and selected independently of extension loading.

- Plan and Goal keep mutable lifecycle state in `src/index.ts`; command registration, tool contracts, prompts, schemas, and event/journal protocols live in focused modules. Pure transition and validation logic lives in `state.ts`. Both extensions persist versioned custom entries with `pi.appendEntry()` and rebuild from the active branch on `session_start` and `session_tree`.
- Plan moves through `planning -> awaitingApproval -> executing`, leases the active tool set without losing external changes, and injects phase-specific context before agent turns. Goal injects objective context, accounts tokens/time, and queues continuation turns until completion or a terminal status.
- Plan and Goal communicate on `pi-extensions:plan-state:v1`, defined independently in each package's `protocol.ts`; they do not import each other in production. Keep both protocol modules and `plan/test/coexistence.test.ts` synchronized.
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
| `themes/` | Standalone repository-wide light/dark Pi palettes and their global installation/activation contract. |

Each package owns its dependencies, lockfile, compiler configuration, and tests. Do not add cross-package production imports or assume root-level dependency resolution.

## Development Commands

Use Node.js `>=22.19.0` and npm. From one extension directory:

```sh
cd goal                    # or plan, lsp, request, rg
npm ci
npm run check              # tsc --noEmit
npm test                   # node --import tsx --test test/*.test.ts
```

To check every package from the repository root:

```sh
for dir in goal plan lsp request rg; do
  (cd "$dir" && npm run check && npm test) || exit 1
done
```

GitHub Actions runs the same `npm ci`, `npm run check`, and `npm test` sequence for all five packages via `.github/workflows/ci.yml`.

There are no `build`, `lint`, `format`, `start`, or `dev` scripts. TypeScript is loaded directly by Pi and tests; `npm run check` intentionally emits no build artifacts.

For global development use, every plugin Pi should load must be symlinked into Pi's global extension directory. Link package directories separately—the repository root is not a Pi package:

```sh
mkdir -p "$HOME/.pi/agent/extensions" "$HOME/.pi/agent/themes"
for name in goal plan lsp request rg; do
  ln -sfn "$PWD/$name" "$HOME/.pi/agent/extensions/$name"
done
for theme in "$PWD"/themes/pi-extensions-*.json; do
  ln -sfn "$theme" "$HOME/.pi/agent/themes/$(basename "$theme")"
done
```

Run that loop from the repository root, or link only the package under development. Pi follows each package's manifest to `src/index.ts`; use `/reload` after changing extension code. Theme discovery is independent: select a newly installed theme once through `/settings` or restart after changing `settings.json`; only an already-active custom theme file hot reloads. Do not use `npm link` for this workflow or commit machine-specific links.

For an isolated load smoke test that does not use the current session or global links:

```sh
for name in goal plan lsp request rg; do
  pi --no-session -p --extension "$PWD/$name" "Reply with exactly: SMOKE_OK"
done
```

## Code Conventions & Common Patterns

- Use strict ESM TypeScript with `NodeNext` resolution. Keep explicit `.ts` suffixes on local imports, two-space indentation, double quotes, and semicolons; no formatter is configured, so match surrounding code.
- Use PascalCase for classes/interfaces/types, camelCase for functions and fields, and `UPPER_SNAKE_CASE` for protocol/configuration constants. Source filenames are lowercase and hyphenated when multiword.
- Keep `src/index.ts` as the Pi composition root: lifecycle state, host registration, and dependency wiring only. Put commands, tools, prompts, protocol parsing, schemas, deterministic transitions, routing, and formatting in focused modules such as `command.ts`, `tools.ts`, `prompts.ts`, `protocol.ts`, and `state.ts`.
- Define tool input with TypeBox (`Type.Object`) and `StringEnum`. Model finite states/actions with string-literal unions and validate unknown persisted/config input before use.
- There is no dependency-injection container. Pi supplies `ExtensionAPI`/context; pass other dependencies explicitly or through constructors such as `ServerManager(cwd, config)`.
- Preserve immutable state transitions in `goal/src/state.ts` and `plan/src/state.ts`. Entry modules may own lifecycle state, while LSP long-lived resources belong in manager/client classes and `Map`s.
- Throw `Error` from validation, routing, and tool execution failures so Pi records a failed tool call. Slash-command/UI handlers may catch `unknown`, format it with `error instanceof Error ? error.message : String(error)`, and notify the user.
- Propagate `AbortSignal` through async tool and LSP work. Use `Promise.allSettled` where one server/client failure must not discard other results, and clean up listeners, timers, processes, and temporary resources on all exit paths.
- Treat the Plan/Goal event channel as a versioned cross-package contract. Update both sides and `plan/test/coexistence.test.ts` together if its name or payload changes.
- Treat Pi's `ThemeColor`/`ThemeBg` unions as the repository-wide UI contract. Use `text`/`muted`/`dim` for hierarchy, `accent`/`borderAccent` for focus, `selectedBg` for selection, `success`/`warning`/`error` for state, `md*` for Markdown, and `tool*` for tool output. Never hardcode ANSI, RGB, hex, or a plugin-private palette in component code; custom components must render from the host `Theme` so theme changes propagate. The standalone top-level `themes/` directory owns every distributable `pi-extensions-*` palette. Extension packages consume only host semantic tokens and never import or register those files in production. Every palette must pass `node themes/validate.mjs`; live TUI backgrounds come from the terminal, so light and dark palettes must declare and validate against the matching `export.pageBg` family.
- Extension READMEs are part of the implementation contract. Any behavior, command/tool schema, configuration, integration, installation, or architecture change MUST update that extension's `<extension>/README.md` in the same change. Cross-extension changes MUST update every affected README; work is incomplete while documentation describes stale behavior.

## Important Files

- `docs/pi-extension-development.md`: versioned Pi API reference, ecosystem examples, extension design rules, security guidance, and pre-merge checklist; read it before adding or materially changing an extension.
- `goal/README.md`, `plan/README.md`, `lsp/README.md`, `request/README.md`, `rg/README.md`: user-facing installation, global symlink integration, usage, configuration, effects, implementation principles, and key code nodes. Keep each aligned with its extension.
- `themes/README.md`: global palette installation, activation lifecycle, semantic roles, and extension integration contract.
- `*/package.json`: Pi entry metadata, Node requirement, scripts, and package-local dependencies.
- `*/tsconfig.json`: shared strict `NodeNext`, `noEmit` TypeScript contract covering `src/**/*.ts` and `test/**/*.ts`.
- `.github/workflows/ci.yml`: standalone theme validation plus a five-package Node 22.19 matrix running clean install, typecheck, and tests.
- `plan/src/index.ts`, `plan/src/command.ts`, `plan/src/tools.ts`, `plan/src/state.ts`, `plan/src/tool-lease.ts`: Plan lifecycle wiring, user/tool boundaries, state machine, and coexistence-safe active-tool leasing.
- `goal/src/index.ts`, `goal/src/command.ts`, `goal/src/tools.ts`, `goal/src/state.ts`: Goal lifecycle wiring, user/tool boundaries, persistence, continuation, and accounting rules.
- `lsp/src/index.ts`, `lsp/src/config.ts`, `lsp/src/server-manager.ts`, `lsp/src/lsp-client.ts`: LSP API boundary, layered configuration, routing/lifecycle, and protocol transport.
- `lsp/src/roots.ts`, `lsp/src/positions.ts`, `lsp/src/format.ts`: workspace confinement, position conversion, and bounded output formatting.
- `rg/src/index.ts`: complete RG extension and exported priority helper.
- `request/src/index.ts`, `request/src/component.ts`, `request/src/adapters.ts`, `request/src/protocol.ts`: Request lifecycle wiring, responsive renderer, native UI compatibility layer, and shared request channel.
- `themes/pi-extensions-*.json`, `themes/validate.mjs`: standalone global Pi palettes and the role-aware schema/contrast gate.
- `plan/test/harness.ts`, `plan/test/coexistence.test.ts`: in-process Pi test double and the main cross-extension behavioral suite.

## Runtime/Tooling Preferences

- Runtime: Node.js `>=22.19.0`; packages are native ESM. Do not assume Bun-specific APIs.
- Package manager: npm, evidenced by one lockfile v3 per package. No exact npm version or `packageManager` field is pinned; update the affected package's lockfile when dependencies change.
- Pi compatibility: common host packages and TypeBox are peer dependencies at `>=0.81.0` and development dependencies for local checking. Keep Pi host libraries as peers rather than ordinary bundled runtime dependencies.
- `lsp` alone ships runtime dependencies (`vscode-jsonrpc` and `vscode-languageserver-protocol`). New third-party code needed at runtime belongs in that package's `dependencies`; test/type tooling belongs in `devDependencies`.
- CI contains a dependency-free theme validation job plus a five-package matrix in `.github/workflows/ci.yml`. There is still no repository-level npm package, formatter, linter, bundler, or generated-output workflow; do not invent root scripts or shared dependency resolution unless deliberately converting to a workspace.

## Testing & QA

Tests use Node's built-in `node:test` runner, `node:assert/strict`, and `tsx`. Test files are direct children named `test/*.test.ts`; helpers such as `plan/test/harness.ts` and `lsp/test/fake-server.mjs` are intentionally outside that glob.

- Put pure transition and validation contracts beside the relevant package tests.
- Use `plan/test/coexistence.test.ts` for observable Goal/Plan lifecycle behavior; it imports Goal directly and exercises commands, tools, events, UI state, abort/wait ordering, persistence, and continuation.
- LSP tests use isolated temporary workspaces and a deterministic child-process fake server. Cover initialization failure, request cancellation/timeout, process crashes, diagnostic settling, partial multi-server failure, idle cleanup, and bounded shutdown; always remove temporary files in cleanup hooks.
- Request tests drive the real component through tool, native UI, external event, and Goal confirmation paths. Cover single/multi/Other/Review behavior, serialization, abort/timeout/shutdown, headless rejection, fallback semantics, and bounded narrow-terminal rendering.
- Run `node themes/validate.mjs` for any palette change. Run `npm run check` and `npm test` in every affected package. For Plan/Goal protocol changes, run both packages and the Plan coexistence suite; CI repeats the theme gate and all five package checks from clean installs.
- No coverage tool, threshold, skipped-test convention, or focused-test script is configured. Add tests for new observable contracts and plausible regressions; do not assert incidental implementation details merely to increase coverage.
