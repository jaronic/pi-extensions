# Doclint 插件

`doclint` 把本仓库的文档契约检查机械化：注册一个只读的 `doc_lint` 模型工具和一个 `/doclint` 命令，对仓库执行同一组静态检查，防止 AGENTS.md、各包 README 与实现之间的文档漂移。检查不修改任何文件，结果按文件分组、带 error/warning 严重级。

> 维护约束：凡是改变 `doc_lint` 的检查项、严重级规则、参数、命令行为、输出格式或安装方式，都必须在同一改动中同步本 README。

## 检查项

所有检查由 `runDocLint()` 在传入的仓库根目录下执行，输入只有文件系统 adapter 和根路径，输出是结构化的 finding 列表：

1. **agents-table**（根 AGENTS.md 包表覆盖）
   - 含合法 `pi.extensions` manifest 的顶层目录必须出现在 AGENTS.md 包表中，缺失为 error；找不到表头为 `Package` 的表格、或根 AGENTS.md 缺失，也是 error。
   - 包表中没有对应 package.json 的条目为 warning；有 package.json 但无 `pi` manifest 的目录（如 `uikit` 共享库包）允许出现在包表中，不产生 finding；以 `/` 结尾的条目（如 `themes/`）视为非包资源行，不参与该方向检查。
2. **surface-names**（README 工具/命令名与 src 注册名一致）
   - 静态扫描包 `src/**/*.ts`（跳过 dotdir 与 `node_modules`）中 `registerTool({ name: "..." })` 与 `registerCommand("...", ...)` 的字符串字面量；容忍换行与 `registerTool<...>(...)` 泛型实参，扫描前先剥离注释，文档注释中引用的注册形状不算注册。
   - 已注册但从未在 README 反引号中出现的工具名/命令名为 error（文档契约要求 README 与实现同步）。
   - 反向为 warning 且刻意收窄：普通反引号标识符只有紧跟 工具/命令/tool/command 标记词（如 `` `ask` 工具 ``、`` `diff_report` tool ``）才算表面引用；反引号 `/name` 视为命令引用。豁免集合 = 本仓库任一扩展注册的全部名字 + Pi 内建工具（`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`）+ Pi 内建 slash 命令（`/reload`、`/new`、`/resume`、`/fork`、`/tree`、`/compact` 等），跨包引用与内建引用都不报告。
3. **npm-scripts**（README npm scripts 与 package.json scripts 一致）
   - README 提到的 `npm run <name>`（含 `npm test` 隐式别名）必须存在于 package.json scripts，缺失为 error；`npm ci`、`npm install` 等 npm 内建子命令不视为 script 引用。
   - package.json scripts 中从未在 README 出现的 script 为 warning。
4. **manifest-paths**（package.json 的 pi.extensions 路径存在性）
   - 每个 `pi.extensions` 条目必须是包目录内的相对路径（拒绝绝对路径与 `..` 逃逸）且文件存在，违反为 error。
   - package.json 非法 JSON、非对象、`pi.extensions` 非字符串数组、`scripts` 非字符串映射等 malformed 输入一律报 error，不做部分信任。

任何含合法 `pi.extensions` manifest 的包缺少 README.md 本身也是 error（文档契约要求每包必有 README）。

## 严重级与输出

- **error**：确定性的契约违反（缺表项、注册名未文档化、README 引用不存在的 script、manifest 路径失效、malformed manifest）。
- **warning**：启发式或双向一致性中较弱的方向（表内多余条目、README 表面引用未注册、script 未文档化）。

工具输出先给出 error/warning 总数、lint 根目录与被扫描包清单，然后按文件分组列出 finding（组内 error 先于 warning），最后用 Pi 的 `truncateHead` 截断到 50KB/2000 行预算；finding 总数另有 `maxFindings` 上限（默认 100），被截断/省略的数量都会在输出中明示。tool result 的 details 附带结构化摘要（root、packagesScanned、errors、warnings、omitted 与前 50 条 finding）。

`doc_lint` 还注册了自定义 `renderCall`/`renderResult` 渲染钩子（仅影响 TUI 展示，模型面向的 `content` 文本不变，仍由 `format.ts` 生成）：调用卡片是共享的单行标题（bold toolTitle 品牌 + muted action + accent root），经 `pi-uikit-dev` 的 `toolCallTitle`/`reuseTextComponent` 实现流式重渲染复用；结果体首行是 `statusRow` 状态行（✓/!/✕ + 计数摘要），随后是 root 与扫描包清单的 `kvRow`、omitted 警示行，finding 按文件分组（accent 文件名，组内 error 先于 warning），每行按严重级经 `tone(error/warning)` 着色，折叠态只显示前 15 行 body 并以 `moreLinesHint` 提示隐藏行数，展开态显示全部；超出 details 50 条上限的 finding 另有 muted 尾注指向完整文本输出。details 缺失或非法时回退为 output/error tone 的纯文本。所有着色都经 `pi-uikit-dev` 原语（`tone`/`statusRow`/`kvRow`/`collapseLines`/`moreLinesHint`/`linesToText`），与其他扩展共用同一套样式映射。

## 安装与启用

要求：Node.js `>=22.19.0`、npm，以及兼容 `@earendil-works/pi-coding-agent >=0.82.1` 的 Pi。

```bash
cd /path/to/pi-extensions/doclint
npm ci
mkdir -p "$HOME/.pi/agent/extensions"
ln -sfn "$PWD" "$HOME/.pi/agent/extensions/doclint"
```

软链接必须指向 `doclint/` 包根目录。Pi 读取 `package.json` 的 `pi.extensions` 并加载 `./src/index.ts`。仓库移动后需重建链接；随后重启 Pi，或执行 `/reload`。

开发时可直接加载：

```bash
pi --extension ./src/index.ts
```

## 使用方法

### `doc_lint` 工具

| 参数 | 必填 | 默认值 | 语义 |
| --- | --- | --- | --- |
| `action` | 是 | — | 目前只有 `check`：执行全部检查项。 |
| `root` | 否 | 当前 workspace | 待 lint 的仓库根，相对当前 workspace 解析。 |
| `maxFindings` | 否 | `100` | finding 收集上限（1–500），超出部分计入 `omitted`。 |

`root` 先相对 `ctx.cwd` 解析，再做 realpath 规范化；规范化后的路径必须等于当前 workspace 或位于其内部，否则工具调用失败（fail closed），防止 symlink 或 `..` 把 lint 指到 workspace 之外。根目录不存在同样抛错。

### `/doclint` 命令

`/doclint [root]` 执行与 `doc_lint` 完全相同的检查，结果通过 `ctx.ui.notify` 展示：有 error 时级别为 error，仅有 warning 时为 warning，零 finding 为 info；根目录非法时通知失败原因。该命令不持有状态、不写 session，在 tui/rpc/json/print 四种模式下都安全（无 UI 模式下 notify 是无操作，命令仍会完成检查）。

## 已知误报边界

- 注册名扫描只看字符串字面量：`name` 必须是定义对象的第一个属性，经变量间接传递的 definition 不会被发现；模板字符串内的 `${...}` 不按嵌套解析。
- “README 提到但代码不存在”方向刻意收窄：普通标识符需要标记词紧跟反引号之后；豁免集合覆盖全仓库注册名与当前已知 Pi 内建命令/工具。未来 Pi 新增内建命令、非常规表述或标记词紧贴的非工具词（如 `` `demo` 工具箱 `` 之外的生造用法）仍可能产生 warning，需人工甄别后更新白名单。
- 反向豁免以“全仓库注册名”为准：某包 README 引用的名字如果由兄弟包注册，即使引用语境已过时也不会报告；强一致性仍由 error 方向（注册名必须出现在本包 README）保证。
- README 反引号中的文件名、参数名、事件名等只要不带紧贴的标记词、不含 `/` 前缀就不会被当作表面引用。
- 检查是纯静态文本比对，不理解 Markdown 语义与 TypeScript 语法树；它防漂移，不证明文档内容正确。

## 配置

Doclint 没有独立配置文件。全部可调行为来自工具参数（`root`、`maxFindings`）；检查规则与白名单常量定义在 `src/scan.ts`。

## 实现原理与关键节点

- `src/scan.ts`：纯正则扫描器与白名单（注册名、反引号标识符、AGENTS.md 包表、npm script 提及、表面引用），无 I/O。
- `src/checks.ts`：`runDocLint()` 纯函数编排全部检查项；输入是 `RepoFileSystem` adapter + 根路径，输出 `LintReport`（finding 带 file/check/severity/message），finding 按发现顺序保留并应用 `maxFindings` 上限。
- `src/fs-adapter.ts`：node:fs 实现的 adapter 与 `resolveLintRoot()`（realpath + workspace 边界校验）。
- `src/format.ts`：按文件分组渲染文本，`truncateHead` 应用输出预算。
- `src/renderer.ts`：`doc_lint` 的 TUI 渲染钩子（call 卡片标题、结果状态行/分组 finding 列表/折叠），全部经 `pi-uikit-dev` 原语着色，不接触模型面向的文本。
- `src/index.ts`：仅装配——注册 `doc_lint` 工具（含 `renderCall`/`renderResult`）与 `/doclint` 命令；扩展不持有进程、timer 或 watcher，shutdown 无需清理。
- `test/`：`scan.test.ts`（扫描器边界）、`checks.test.ts`（内存 adapter 驱动的全部检查项，含 malformed manifest 输入）、`format.test.ts`（分组、排序、截断）、`index.test.ts`（注册接线、渲染钩子接线与真实 details 渲染、真实临时仓库执行、workspace 外 root 失败路径、取消、print 模式无 UI 路径）、`renderer.test.ts`（call 标题与 Text 复用、状态行/分组/严重级着色形状、折叠与展开、omitted 与 details 上限尾注、error/malformed details 回退）；`test/mock-fs.ts` 是共享的内存 adapter 与 fixture。

## 开发与验证

```bash
cd /path/to/pi-extensions/doclint
npm run check
npm test
```

升级 Pi host 包时，除类型检查与单元测试外，还应在 Pi 中执行一次真实 `doc_lint` tool call 与 `/doclint`，确认注册签名、notify 行为与 `ctx.cwd` 语义没有漂移。
