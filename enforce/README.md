# Enforce 插件

工具促活层（enforcement kit）：用确定性的规则表提升低频高价值工具（`lsp`、`ast_grep_*` 等）的利用率。手法对标社区的 claude-code-lsp-enforcement-kit（阻断/提醒 + 给出可直接复制的替代调用），但更克制：默认规则全部是 nudge（放行原调用 + steer 提示），gate（阻断调用）只能在配置文件中显式启用。

## 效果与边界

- 在 `tool_call` 事件中按规则表匹配工具名、参数正则、文件 glob，命中后：
  - **nudge**：放行原调用，并通过 `pi.sendMessage(..., { deliverAs: "steer" })` 向模型注入一条带参数化替代调用示例的提示；同一规则每个 session 最多提示一次（`once`，可用配置关闭）。
  - **gate**：返回 `{ block: true, reason }` 阻断调用，reason 内含插值后的替代调用示例，模型可直接复制重试。gate 每次都阻断，不受 `once` 限制。
- 规则只在它推荐的工具确实处于 active tools 时生效（用 `pi.getActiveTools()` 探测）。不 import、不探测 lsp / ast-grep 包是否存在；没装这些包时对应规则静默失效。
- 不注册任何工具；只注册 `/enforce` 命令与 `session_start` / `tool_call` / `session_shutdown` 三个生命周期 handler。
- 无分支相关状态，不持久化；`session_start` 重新加载配置并清空 nudge 记忆，`session_shutdown` 幂等清理。
- nudge 投递失败（如 session 正忙）被吞掉，绝不影响原工具调用。
- TUI / RPC / JSON / print 四种模式行为一致：核心路径不依赖 UI；配置错误仅在 `ctx.hasUI` 时额外 notify 一次。

## 安装与启用

本包是私有开发包（`pi-enforce-dev`）。仓库根目录执行：

```sh
make pi-extensions-on    # 或 scripts/pi-global-links.sh 管理的等价链接
```

然后在 Pi 中 `/reload`。隔离加载 smoke：

```sh
pi --no-session -p --extension "$PWD/enforce" "Reply with exactly: SMOKE_OK"
```

## 使用方法

`/enforce` 支持三个子命令（均可 Tab 补全）：

- `/enforce status`（或无参数）：规则总数、gate/nudge 分布、本 session 已发送 nudge 数、生效的配置文件、配置错误。
- `/enforce rules`：逐条列出规则（id、action、来源、生效条件、匹配的工具名），最多 30 条。
- `/enforce reload`：重新读取两层配置文件、清空 nudge 记忆并报告结果；配置错误时 fail closed（见下）。

## 默认规则

全部 nudge，均要求推荐工具在 active tools 中才生效：

| id | 匹配 | 推荐 | 意图 |
| --- | --- | --- | --- |
| `prefer-lsp-symbols-grep` | `grep`，pattern 为裸标识符 | `lsp` | 语义符号解析优于文本搜索，示例 `lsp { action: "workspace_symbols", query: "<匹配值>" }` |
| `prefer-lsp-symbols-rg` | `rg`，pattern 为裸标识符 | `lsp` | 同上 |
| `prefer-ast-grep-search-grep` | `grep`，pattern 含 `$$$` 元变量 | `ast_grep_search` | 文本搜索无法解释 ast-grep 元变量 |
| `prefer-ast-grep-search-rg` | `rg`，pattern 含 `$$$` 元变量 | `ast_grep_search` | 同上 |
| `prefer-ast-grep-edit-sed` | `bash`，命令含 `sed ... -i` | `ast_grep_edit` | 结构化重写 + 强制 preview 比 sed -i 更适合改代码 |

## 配置位置与优先级

内置默认 < 全局 `~/.pi/agent/enforce.json` < 项目 `.pi/enforce.json`（项目层路径用 Pi 导出的 `CONFIG_DIR_NAME` 构造，仅在项目受信任时读取）。

配置按规则 id 打补丁（与 lsp 的 server 配置同款语义）：与内置规则同 id 的条目合并覆盖单个字段；新 id 必须是完整规则；`disabled: true` 删除该规则。

```jsonc
{
  "rules": {
    // 显式把内置 nudge 升级为 gate（gate 的唯一启用方式）
    "prefer-lsp-symbols-grep": { "action": "gate" },
    // 关掉某条内置规则
    "prefer-ast-grep-edit-sed": { "disabled": true },
    // 自定义规则
    "no-curl": {
      "tool": "bash",
      "action": "gate",
      "message": "Use the request tooling instead of curl for ${1}.",
      "example": { "tool": "request", "input": { "url": "${1}" } },
      "paramField": "command",
      "paramPattern": "\\bcurl\\s+\\S*(https?://\\S+)",
      "recommend": "request"
    }
  }
}
```

### 顶层字段

- `rules`：对象，key 为规则 id（≤64 字符，小写字母/数字/连字符）。只允许这一个顶层字段。

### 规则字段

- `tool`（新规则必填）：精确匹配的工具名。
- `action`（新规则必填）：`"nudge"` 或 `"gate"`。
- `message`（新规则必填，≤1000 字符）：提示/阻断文本，支持插值。
- `example`：对象（≤20 键），替代调用示例，字符串值支持插值，渲染为 JSON 附在 message 后。约定形状 `{ "tool": "...", "input": { ... } }`。
- `paramField` / `paramPattern`：对 `input[paramField]`（标量）执行正则（≤500 字符，必须可编译）；`paramPattern` 要求同时给 `paramField`。
- `fileParam`（默认 `"path"`）/ `fileGlob`：对文件路径参数做 glob 匹配（`*` 段内、`**` 跨段、`?` 单字符）。
- `recommend`：被推荐的工具名；设置后规则只在该工具处于 active tools 时生效。
- `once`（默认 `true`）：nudge 每 session 只发一次；对 gate 无效。
- `disabled`：`true` 时删除该规则。

### 插值

message 与 example 的字符串支持 `${paramField名}`（取工具入参标量）、`${0}`（正则整体匹配）、`${1..9}`（捕获组）。单个插值上限 200 字符，整条提示上限 4000 字符。未知占位符原样保留。

### 校验与 fail closed

配置按 `unknown` 严格校验：未知字段、错误类型、不可编译正则、超限一律报错。任何一层配置出错（含 JSON 语法错误）都 fail closed：忽略全部配置文件，回退到仅内置 nudge 规则，错误文本通过 `/enforce status` 与 session 开始时的 warning 暴露。内置规则永远不可能变成 gate —— gate 只能由合法配置文件显式产生。

## 与 Plan 的共存语义

Plan 在 `tool_call` 里做只读门禁，Enforce 也在同一事件里匹配规则，二者独立判定、互不调用：

- **无死锁**：Enforce 的 handler 只做纯函数匹配 + fire-and-forget 的 `sendMessage`，不等待 agent 空闲、不监听 Plan 的事件、不修改 active tools。
- **不双重阻断**：Plan 放行其只读工具（grep/rg/lsp 等），Enforce 的默认 nudge 对这些工具幂等（每规则每 session 一次），不会在 Plan 期间刷屏。Plan 阻断 mutation 工具时 Enforce 规则根本不匹配这些工具，保持沉默。
- **gate 组合**：若同一调用被 Plan 和 Enforce gate 同时命中，Pi 合并 block 结果，reason 取先返回者；两个 handler 任意注册顺序都安全（coexistence 测试覆盖两种顺序中的关键一种）。
- Enforce 不使用 `pi-extensions:exclusive-workflow:v1`，与 Plan/Goal 互斥协议无关。

## 实现原理与关键节点

- `src/index.ts`：装配根。注册 `/enforce` 与三个生命周期 handler；配置 lazy 加载（promise 去重）并在 `session_start` 预热；`tool_call` 里评估规则，gate 返回 `{ block, reason }`，nudge 记 `once` 集合后 steer 投递；`session_shutdown` 幂等清空内存状态。
- `src/rules.ts`：纯函数。内置规则表、规则归一化（边界校验 + 正则编译）、迷你 glob 匹配、`${...}` 插值、`evaluateToolCall`（推荐工具不在 active tools 则跳过；gate 优先于 nudge）。
- `src/config.ts`：分层加载（内置 < 全局 < 项目），按 id 打补丁合并，严格 unknown 校验，任何错误 fail closed 到仅内置 nudge 规则。
- `src/command.ts`：`/enforce status|rules|reload`。
- nudge 消息 customType 为 `enforce-nudge-v1`，`display: false`（不进 transcript），`details` 只含 `ruleId` 与 `tool`。

## 开发与验证

```sh
cd enforce
npm ci
npm run check
npm test
```

测试覆盖：规则匹配/插值/glob 纯函数、分层配置与 fail closed、extension harness（nudge/gate/once/无 UI/投递失败/命令/幂等 shutdown）、与 Plan 的 coexistence（`test/coexistence.test.ts`，复用 `plan/test/harness.ts`；需要先 `cd ../plan && npm ci`）。
