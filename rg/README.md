# RG 插件

`rg` 为 Pi 注册一个 ripgrep 驱动的 `rg` 工具。它是 Pi 内建 `grep` execution path 的显式别名；两者同时启用时，扩展只向 agent 暴露 `rg`，避免重复 tool schema 和虚假的 fallback。

session shutdown 时扩展把自己占用的 active-tool 槽位恢复为 `grep`，因此 `/reload` 或卸载不会永久隐藏内建工具。

> 维护约束：凡是改变 RG 的参数、搜索行为、工具优先级、事件接入、Pi 内建 grep 依赖、与其他扩展的工具协作或安装方式，都必须在同一改动中同步本 README。

## 效果

- 注册名为 `rg` 的 Pi tool，schema、执行语义和 result renderer 直接复用当前 Pi 的 `createGrepToolDefinition`；call renderer 使用正确的 `rg` 标题。
- 每次执行时用 `ctx.cwd` 重新创建 definition，搜索根目录始终跟随当前 Pi workspace，而不是启动扩展时的进程目录。
- 在 `session_start` 与 `session_tree` 后折叠 active tools：`rg` 和 `grep` 同时存在时只保留一个 `rg`，且所有无关工具保持原相对顺序。
- 在 `session_shutdown` 恢复被替换的 `grep`；若扩展没有执行过替换，或外部已恢复/移除相关工具，则不覆盖外部状态。
- prompt 明确说明两者共享执行路径，同一失败请求不能通过改名为 `grep` 获得独立 fallback。
- 搜索尊重 `.gitignore`，返回文件路径、行号和可选上下文；hidden 文件由底层 ripgrep 搜索规则处理。
- 仅 TUI 与 HTML export 会将可识别的 `path:line: text` 和 `path-line- text` 结果按文件路径分组：每个文件路径显示一次，匹配行和 context 行缩进列在其下。
- 模型可见的 tool result content、session 中持久化的 `GrepToolDetails` 与内建 grep 执行格式保持原样，仍是 Pi 提供的逐行 `path:line: text` 输出。

## 安装与启用

要求：Node.js `>=22.19.0`、npm，以及兼容 `@earendil-works/pi-coding-agent >=0.81.0` 的 Pi。

```bash
cd /path/to/pi-extensions/rg
npm ci
mkdir -p "$HOME/.pi/agent/extensions"
ln -sfn "$PWD" "$HOME/.pi/agent/extensions/rg"
```

软链接必须指向 `rg/` 包根目录。Pi 读取 `package.json` 的 `pi.extensions` 并加载 `./src/index.ts`。仓库移动后需重建链接；随后重启 Pi，或执行 `/reload`。

开发时可直接加载：

```bash
pi --extension ./src/index.ts
```

底层通过 Pi 的工具管理器寻找 `rg` 可执行文件；系统没有 ripgrep 时，Pi 会尝试下载。离线环境建议预先安装 `rg` 并确保其位于 `PATH`。

## 使用方法

`rg` 是 agent tool，不是 shell 命令透传。可用参数与 Pi 当前内建 `grep` 一致：

| 参数 | 必填 | 默认值 | 语义 |
| --- | --- | --- | --- |
| `pattern` | 是 | — | 正则表达式；`literal: true` 时按普通字符串。 |
| `path` | 否 | 当前 workspace | 要搜索的目录或文件。 |
| `glob` | 否 | 无 | 文件 glob，例如 `*.ts`、`**/*.test.ts`。 |
| `ignoreCase` | 否 | `false` | 忽略大小写。 |
| `literal` | 否 | `false` | 禁用正则解释。 |
| `context` | 否 | `0` | 每个匹配前后展示的行数。 |
| `limit` | 否 | `100` | 最大匹配数；小于 1 的值会规范为 1。 |

示例：

```json
{
  "pattern": "registerTool\\(",
  "path": "src",
  "glob": "*.ts",
  "context": 2,
  "limit": 50
}
```

字面量搜索：

```json
{
  "pattern": "foo.bar",
  "path": "src/index.ts",
  "literal": true,
  "ignoreCase": true
}
```

默认结果最多 100 个匹配或 50 KiB，以先达到者为准；过长单行也会截断，并在 tool details/UI 中标明命中数、字节或行截断。

### 输出显示

交互式 TUI 与 HTML export 的 collapsed 视图最多显示 15 个最终显示行（包括文件标题、缩进行和尾部 limit notice）；展开后显示全部。若 Pi 宿主输出不完全匹配当前的匹配行、context 行以及末尾 notice 格式，则安全回退为原始文本显示，不会丢弃、重排或猜测内容。

## 与 Pi `grep` 及其他扩展的关系

初始 active tools 如下：

```text
read, grep, lsp, rg, write
```

扩展调整为：

```text
read, rg, lsp, write
```

`replaceGrepWithRg()` 只在两个名称同时存在时折叠别名；只有 `grep` 或只有 `rg` 时保持该工具。Plan 的只读策略执行相同折叠，所以进入 planning/approval phase 不会重新引入重复 schema。扩展 shutdown 后，上例恢复为 `read, grep, lsp, write`。

Goal、Todo 和 Request 不拥有或调用 RG；RG 也不调用 `pi-extensions:todo-service:v1`，不会根据搜索结果创建、完成或修改 Todo task。Goal continuation 及普通执行轮只在 `rg` 当前可见时使用它，任务进度与完成证据仍由对应 Goal/Plan/Todo 状态机显式提交。

## 配置

RG 没有独立配置文件。可调行为全部来自每次 tool call 的参数；底层上限、`.gitignore` 规则和 ripgrep 发现逻辑继承已安装版本的 `@earendil-works/pi-coding-agent`。

这意味着升级 Pi 依赖可能改变 `rg` 的 schema 或输出语义。升级 peer/dev dependency 时必须对照 Pi 的 `createGrepToolDefinition`，同步本 README 并运行测试。

## 实现原理与关键节点

运行时代码位于 `src/index.ts` 和 `src/result-renderer.ts`：

- 模块加载时从 Pi factory 取得参数 schema，用于注册 `rg` 工具。
- `execute` 使用 `ctx.cwd` 创建新的内建 grep definition，并原样转发 `toolCallId`、参数、`AbortSignal`、update callback 与 context。
- `replaceGrepWithRg()` 是纯函数：Set 去重、别名折叠、不修改调用方数组，且不重排无关工具。
- `session_start` 和 `session_tree` 应用替换，`session_shutdown` 只恢复本扩展实际替换过的内建 `grep`。
- `test/priority.test.ts` 验证折叠、不变性、真实 prompt、call/result renderer 和 lifecycle 恢复。真实搜索执行继承 Pi 内建 grep definition，升级 Pi host 后仍需执行 live smoke。

## 开发与验证

```bash
cd /path/to/pi-extensions/rg
npm run check
npm test
```

升级 Pi host 包时，除类型检查和单元测试外，还应在 Pi 中执行一次真实 `rg` tool call，覆盖 pattern、path、glob 和 limit，确认继承的 schema 与 runtime behavior 没有漂移。
