# AST-Grep 插件

`ast-grep` 为 Pi 提供结构感知的代码搜索和单文件改写：

- `ast_grep_search`：按一种显式语言和一个文件/目录 scope 搜索 AST 形状；
- `ast_grep_edit`：先完整预览，再以内容绑定的 `previewId` 原子应用一个文件内的改写。

它补充而不替代 `rg` 和 `lsp`：文字/正则搜索用 `rg`，symbol、reference、diagnostic 和语言服务器重构用 `lsp`，语法形状和 metavariable rewrite 用本插件。

何时优先本插件：重命名或改签名前，用 `ast_grep_search` 结构搜索而非 `rg`，以覆盖简写、多行和 re-export 形式；单文件内的符号重命名或重复调用形状改写，用 `ast_grep_edit` 一次原子完成，而不是多次手动 edit。

> 维护约束：工具参数、默认值、语言/平台、二进制版本、路径/写入边界、输出、Plan/LSP 集成、安装或发布门发生变化时，必须在同一改动中更新本 README。

## 运行边界

- 固定使用官方 ast-grep CLI `0.45.0` 的 package-local native binary；不调用 `PATH` 中的 `sg`/`ast-grep`。
- 每次执行显式加载包内 12-byte trusted config，不读取项目 `sgconfig.yml`、custom rules 或 dynamic languages。
- 一次调用只接受一种显式语言；不会从扩展名猜测。
- exact-file 搜索从受 identity 和 8 MiB 上限保护的 snapshot 经 stdin 执行。目录搜索沿用 ast-grep 默认 ignore/hidden 行为，并逐组件验证 CLI 返回的真实文件名、symlink、identity 和 workspace containment。
- CLI 永不写工作区。Edit 在 Pi 的 canonical file mutation queue 内读取最多 3 MiB 的单一 snapshot，校验 ast-grep 的实际 byte ranges，再以同目录临时文件和 atomic rename 提交。
- Hard link、symlink/junction、非 UTF-8、显式 `ERROR` syntax node、zero-width、重叠或超预算 rewrite 均 fail closed。
- `previewId` 绑定 canonical workspace/path、语义参数、source bytes 和实际 replacements。它只防 stale write，不代表用户批准，也不持久化授权。
- Preview 必须完整容纳全部 before/after；无法容纳时整次失败且不签发 ID。
- v1 不提供多文件事务、project YAML rules、自动 formatter、语言推断或 UI approval。

## 安装与启用

要求 Node.js `>=22.19.0`、npm，以及兼容 `@earendil-works/pi-coding-agent >=0.81.0` 的 Pi。

支持且由 native CI 覆盖的 tuple：

| OS | Architecture / libc | Optional package |
| --- | --- | --- |
| macOS | arm64 | `@ast-grep/cli-darwin-arm64@0.45.0` |
| macOS | x64 | `@ast-grep/cli-darwin-x64@0.45.0` |
| Linux | arm64 + glibc | `@ast-grep/cli-linux-arm64-gnu@0.45.0` |
| Linux | x64 + glibc | `@ast-grep/cli-linux-x64-gnu@0.45.0` |
| Windows | x64 + MSVC | `@ast-grep/cli-win32-x64-msvc@0.45.0` |

Linux musl、其他 architecture 和未列 tuple 会在工具首次使用时清晰拒绝，不会回退到系统命令。

从仓库根目录启用全部资源：

```bash
make pi-on
make pi-status
```

只手动启用本插件：

```bash
cd /path/to/pi-extensions/ast-grep
npm ci
mkdir -p "$HOME/.pi/agent/extensions"
ln -sfn "$PWD" "$HOME/.pi/agent/extensions/ast-grep"
```

软链接必须指向 `ast-grep/` package 根。Pi 根据 `package.json` 加载 `./src/index.ts`；修改代码后执行 `/reload`。不使用 `npm link`。

## `ast_grep_search`

必填参数：

| 参数 | 说明 |
| --- | --- |
| `pattern` | 可解析的 ast-grep structural pattern；UTF-8 最多 4 KiB。 |
| `language` | 下文 allowlist 中的一种 canonical 小写名称。 |

可选参数：

| 参数 | 默认值 | 合同 |
| --- | --- | --- |
| `path` | `.` | 已存在的 workspace 内文件或目录；最多 4096 characters。 |
| `globs` | `[]` | 仅目录搜索；最多 16 项、每项最多 256 characters，按 ast-grep 顺序传递，`!` 可排除。 |
| `selector` | 无 | contextual pattern 的 selector；最多 256 bytes。 |
| `strictness` | `smart` | `cst | smart | ast | relaxed | signature | template`。 |
| `limit` | `20` | 本页 1–50 条完整结果。 |
| `offset` | `0` | 0–1000；`offset + limit + 1 <= 1051`。 |
| `timeoutMs` | `30000` | 1000–120000 ms，覆盖排队、I/O、native work 和格式化。 |

示例：

```json
{
  "pattern": "console.log($$$ARGS)",
  "language": "typescript",
  "path": "src",
  "globs": ["*.ts", "!*.test.ts"],
  "limit": 20
}
```

`$NAME` 捕获一个 node，`$_` 匿名匹配一个 node，`$$$NAME` 捕获零个或多个 nodes；重复 metavariable 必须结构相等。不要把 `$$NAME` 当作 multi capture。非 standalone fragment 需要提供足够 context，并可配合 `selector`。

结果按 path、byte range 和稳定 payload hash 排序。`nextOffset` 存在时可继续分页；分页不是 snapshot-isolated，任何写入后都应从 offset 0 重启。零匹配表示 pattern 执行成功，不证明 scope 内每个文件都 parse-valid。

最终 `details` 中的 workspace-relative `scope`/`path` 保留真实、well-formed、NUL-free 字符串，供 LSP 等 machine consumer 精确解析；模型最终 `content` 把路径显示为完整 JSON string literal，例如真实换行文件名显示为 `"src/a\nb.ts"`。后续工具调用应使用该 literal 解码后的字符串值；literal 无法完整进入最终输出预算时整次操作失败。TUI 与 transient progress 使用相同 JSON-style escaping 的固定上限 projection，过长时明确以 `...` 截断，不能反向当作 machine path。

## `ast_grep_edit`

必填参数：

| 参数 | 说明 |
| --- | --- |
| `action` | `preview` 或 `apply`。 |
| `path` | 一个已存在、workspace 内、非 hard-linked 的 regular file。 |
| `language` | 显式 allowlist language。 |
| `pattern` | 最多 4 KiB。 |
| `rewrite` | 最多 8 KiB；空字符串删除非空 match。 |

可选参数：

| 参数 | 默认值 | 合同 |
| --- | --- | --- |
| `selector` | 无 | 与 search 相同。 |
| `strictness` | `smart` | 与 search 相同。 |
| `maxReplacements` | `20` | 1–50；限制dedupe/no-op归一化后的有效替换，超过即零写入失败；raw CLI records另有固定50条硬上限。 |
| `timeoutMs` | `20000` | 1000–120000 ms。 |
| `previewId` | 无 | action=preview 禁止携带（省略该字段；工具适配器强制填充时只容忍 `null` 或空字符串 placeholder，执行前移除），报错后按原调用去掉该字段重试。action=apply 必填，必须是 preview 返回的 64 位 lower-case hex。 |

正确流程：

```json
{
  "action": "preview",
  "path": "src/sample.ts",
  "language": "typescript",
  "pattern": "oldName($A)",
  "rewrite": "newName($A)"
}
```

检查完整 preview 后，用相同的 `path`、`language`、`pattern`、`rewrite`、`selector`、`strictness` 和 `maxReplacements` apply；只有 `timeoutMs` 可以不同：

```json
{
  "action": "apply",
  "path": "src/sample.ts",
  "language": "typescript",
  "pattern": "oldName($A)",
  "rewrite": "newName($A)",
  "previewId": "<preview 返回的 64 位 id>"
}
```

Source 或语义参数改变后，旧 ID 明确 stale；重新 preview，不要盲目重试。零 effective replacement（包括多个局部 rewrite 合成后完整 output 仍等于 source）不签发 ID，也不能 apply 或替换 inode。成功结果返回 before/after SHA-256 和 replacement count。

Atomic rename 若抛错，扩展不会直接猜测失败：只有 target 的全量 bytes/hash 等于 preview output，且 installed inode 正是已 fsync 的 sibling temp，才按真实提交成功返回；旧 source、其他 inode/bytes 或不可读状态都失败并要求先人工检查文件再决定是否重试。

## 语言

`bash`, `c`, `cpp`, `csharp`, `css`, `dart`, `elixir`, `go`, `haskell`, `hcl`, `html`, `java`, `javascript`, `json`, `kotlin`, `lua`, `markdown`, `nix`, `php`, `python`, `ruby`, `rust`, `scala`, `solidity`, `swift`, `typescript`, `tsx`, `yaml`。

这 28 项由真实 pinned binary 逐项 compile-and-match；新增语言必须同时更新 allowlist、CLI language mapping、真实 smoke 和每个 accepted native tuple 的 CI。

## 共存

- Plan 的 planning、approval 和 blocked 只允许只读 `ast_grep_search`；`ast_grep_edit` 仅在执行阶段恢复。
- LSP 只在成功返回严格 v1 `edit-apply` details 后，以 details 中未经显示转义的 canonical workspace-relative path 同步已启动的 client；preview、错误或 malformed details 不触发同步。
- 插件不监听 Goal/Todo/Request channel，不修改它们的状态。
- 后加载的第三方 extension 若注册同名工具，Pi 没有原子 name reservation；不要共载其他 `ast_grep_search`/`ast_grep_edit` provider。

## 残余风险

- Portable Node 只有 pathname-based `lstat`/`realpath`/`opendir`/`rename`，没有稳定的 cross-platform `openat`/`renameat` capability。实现会在每级、temp 创建前后和 rename 前后复核 workspace/parent/target/temp identity 与 bytes，但不能宣称消除最后一次检查后的主动 namespace race。同用户恶意进程、FUSE/network filesystem 或不可信 workspace 应使用 container/VM 或不要使用 edit。
- Atomic replacement 创建新 inode，只复制 `mode & 0o777`。Owner、ACL、xattr、setuid/setgid/sticky bits 和特殊 metadata 不保留；有这类要求的文件不要用本工具改写。
- 正常失败和 shutdown 会清理 extension-owned sibling temp；SIGKILL、掉电或 filesystem 故障可能留下形如 `.<name>.pi-ast-grep-<uuid>.tmp` 的 `0o600` 文件。确认目标内容和进程已停止后再人工处理。
- Pi mutation queue 只协调同一进程内的文件工具，不是 OS lock。外部 editor/write 通过 snapshot、hash 和 identity 检测后 fail closed，但主动 race 仍属于上一条限制。
- Pi 0.81.1 串行 dispatch shutdown handlers。插件从自己的 `session_shutdown` handler 获得控制后会 abort/等待；严格无人值守流程应先取消并等待 active tool settle，再 reload/quit。

## 开发与验证

```bash
cd ast-grep
npm ci
npm run check
npm test
npm run release-smoke
```

`npm test` 包含 cross-platform runner fake-process fault matrix、路径/identity/atomic-write 回归、输出/renderer 信任边界、28 语言 real binary smoke 和真实 preview/apply。Runner fixture 直接以 `process.execPath` 执行固定首参 `run` 脚本，保持 `shell:false` 且不依赖 shebang；只有 BinaryManager 的五组 shebang executable handshake/fault fixture 在 Windows 明确 skip，真实 package-local `.exe` handshake、全部 integration/language 测试及 UTF-16 lossy twin fixture仍为必过项。不会使用 `.cmd` 或 shell fallback。`release-smoke` 先执行 `npm pack --dry-run`，再把 tarball clean `--omit=dev` 安装，通过 Pi 自己的 extension loader 和 deterministic provider 驱动真实 `pi --no-session --print` 完成 search、stale rejection 与 apply。

根 CI 在 macOS arm64/x64、glibc Linux arm64/x64 和 Windows x64 上运行 check/test；每个 native job 将声明的 tuple 注入测试，测试会核对实际 OS/arch、package-local binary 与 `0.45.0` handshake。Linux 使用真实 non-UTF-8/U+FFFD lossy twin，Windows 使用真实 unpaired-surrogate/U+FFFD lossy twin；Linux x64 另运行 packed Pi smoke。完整设计、残余 TOCTOU 限制、威胁模型、故障注入和 Definition of Done 见 [`docs/design/10-ast-grep-extension-design.md`](../docs/design/10-ast-grep-extension-design.md)。
