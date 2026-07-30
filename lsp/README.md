# LSP 插件

`lsp` 把 Language Server Protocol 能力暴露为 Pi 的单一 `lsp` 工具，提供诊断、hover、定义、类型定义、实现、引用、文档/工作区符号、重命名预览和 code action 预览。

重命名和 code action 始终只返回预览，不修改文件；实际改动仍应交给 Pi 的编辑工具。

> 维护约束：凡是改变 LSP action、参数、默认服务器、配置 schema/合并顺序、路由、进程生命周期、输出格式、与 Plan 的工具策略或安装方式，都必须在同一改动中同步本 README。

## 效果与边界

- 按文件后缀和 server role 路由到匹配的 language server；多个候选按 priority 从高到低尝试。
- client 按 `server + workspace root` 懒启动并复用，空闲后自动 shutdown。
- diagnostics 对所有匹配服务器并行请求，保留成功结果并单独报告局部失败。
- `edit`/`write` 工具成功后，已启动且覆盖该文件的 client 会同步最新磁盘内容；`ast_grep_edit` 仅在成功返回严格的 v1 `edit-apply` details 时触发同样同步，并把 details path 当作 literal machine path（不会剥离 `@`），preview、错误结果和 malformed details 均忽略。
- 工具运行时 TUI status 显示当前 action；`/lsp` 显示已配置和活跃的 client。
- `server` 通常应省略；指定时优先按配置的 server ID 路由。若没有同名 ID，唯一的 LSP language ID 也可作为别名，例如 `java` 解析为 `jdtls`；多个候选会明确报歧义，不会任意选择。
- 输出受 Pi 的 2,000 行/50 KiB 上限约束；formatter 在全局限额前保留每个原始 replacement，截断时完整格式化结果写入权限为 `0600` 的临时文件，并在 session reload/shutdown 时清理。
- 所有 file action 都将 realpath 限制在当前 workspace 内，符号链接不能绕过边界。

该插件是 LSP client，不包含 language server 本身。对应可执行文件必须在 `PATH` 中；server 仅在第一次实际请求时启动，因此 `/lsp` 显示“configured”不代表二进制已安装。

## 安装与启用

要求：Node.js `>=22.19.0`、npm、兼容 `@earendil-works/pi-coding-agent >=0.81.0` 的 Pi，以及目标语言的 language server。

```bash
cd /path/to/pi-extensions/lsp
npm ci
mkdir -p "$HOME/.pi/agent/extensions"
ln -sfn "$PWD" "$HOME/.pi/agent/extensions/lsp"
```

软链接必须指向 `lsp/` 包根目录。Pi 读取 `package.json` 的 `pi.extensions` 并加载 `./src/index.ts`。仓库移动后需重建链接；随后重启 Pi，或执行 `/reload`。

开发时可直接加载：

```bash
pi --extension ./src/index.ts
```

## 默认服务器

插件内置以下路由配置，但不会安装这些程序：

| Server ID / command | 文件类型 | 主要 root marker |
| --- | --- | --- |
| `typescript-language-server` | TS、TSX、JS、JSX 及 ESM/CJS 变体 | `tsconfig.json`、`jsconfig.json`、`package.json`、`.git` |
| `vue-language-server` | `.vue` | `vue.config.js`、`vite.config.ts`、`package.json`、`.git` |
| `svelteserver` | `.svelte` | `svelte.config.js/ts`、`package.json`、`.git` |
| `pyright-langserver` | `.py`、`.pyi` | `pyrightconfig.json`、`pyproject.toml`、`setup.py`、`requirements.txt`、`.git` |
| `rust-analyzer` | `.rs` | `Cargo.toml`、`.git` |
| `gopls` | `.go` | `go.work`、`go.mod`、`.git` |
| `jdtls` | `.java` | Gradle/Maven wrapper 与构建文件、Eclipse metadata、`.git` |
| `clangd` | C/C++ headers 与 sources | `compile_commands.json`、`compile_flags.txt`、`CMakeLists.txt`、`.git` |
| `sourcekit-lsp` | Swift、Objective-C、Objective-C++ | `Package.swift`、`compile_commands.json`、`.git` |

默认 priority：Vue/Svelte 为 110，其余为 100。JDTLS 默认使用 60 秒 request timeout、1 秒 diagnostics settle，并为每个 workspace 建立独立 storage。

## 使用方法

### 状态

```text
/lsp
```

该命令列出 server ID、启动命令、roles、活跃 client、workspace root、状态、打开文档数，以及本次实际加载的配置文件。

agent 也可调用：

```json
{ "action": "status" }
```

### Action 与参数

推荐工作流：重命名导出符号或改其签名前，必须先跑 `references` 找全 callsite（文本搜索会漏 re-export 和别名用法）；重命名用 `rename_preview` 拿全部受影响位置，再用 edit 落地，比 `rg` 加手动查找更快更全。有意义的改动后跑 `diagnostics` 验证。

| Action | 必填参数 | 可选参数/说明 |
| --- | --- | --- |
| `diagnostics` | `file` | `severity` 为 `all|error|warning|info|hint`；可指定 `server`。 |
| `hover` | `file` + position | 返回目标位置的类型/文档信息。 |
| `definition` | `file` + position | 定义位置。 |
| `type_definition` | `file` + position | 类型定义位置。 |
| `implementation` | `file` + position | 实现位置。 |
| `references` | `file` + position | `includeDeclaration` 默认 `true`。 |
| `symbols` | `file` | 当前文档符号，不需要 position。 |
| `workspace_symbols` | 无 | 可传 `query`、`server`；没有活跃兼容 client 时必须显式给 `server`。 |
| `rename_preview` | `file` + position + `newName` | 仅格式化 `WorkspaceEdit`，不落盘；`resultCount` 统计实际 text edits 与 resource operations。 |
| `code_actions` | `file` + start position | 可用 `endLine`、`endColumn` 指定 range；仅预览。 |

position 有两种写法：

- `line` + 可选 `column`：均为 1-based；column 按 Unicode 字符计数，默认 1。
- `symbol`：省略 line 时，在文件中解析唯一的精确 symbol；零次或多次匹配都会报错。

常见调用：

```json
{ "action": "diagnostics", "file": "src/index.ts", "severity": "error" }
```

```json
{ "action": "definition", "file": "src/index.ts", "symbol": "loadConfig" }
```

```json
{
  "action": "code_actions",
  "file": "src/index.ts",
  "line": 10,
  "column": 1,
  "endLine": 12,
  "endColumn": 1
}
```

`file` 可为 workspace 相对路径、绝对路径或带 `@` 前缀的用户 mention 路径，但解析后的真实文件必须位于当前 workspace。`@` 剥离只属于直接 `lsp` 工具输入；外部成功 edit details 的 canonical relative path 按字面解析，因此根目录中的 `@sample.ts`、`..foo.ts` 等合法名称不会被改写。`limit` 控制格式化结果数，默认来自配置，单次最多 500。

## 配置位置与优先级

无需配置即可使用内置 server。自定义文件按以下顺序加载：

1. 全局：`$HOME/.pi/agent/lsp.json`
2. 项目：`<workspace>/.pi/lsp.json`

项目配置只有在 Pi 信任该项目时才加载。后加载的项目配置覆盖全局配置；两者都在内置配置之上打 patch。配置在 manager 创建时读取，不热更新；修改后执行 `/reload` 或新建 session。

每个配置文件在参与 merge 前严格解码：顶层、server 和 `readyNotification` 的未知字段会报出来源文件；错误的 boolean、array、record、priority 或 timeout 类型不会被 truthy coercion 或默认值静默吞掉。一个配置源无效时，该次 manager 创建整体失败。

示例：

```json
{
  "idleTimeoutMs": 300000,
  "requestTimeoutMs": 15000,
  "diagnosticsSettleMs": 500,
  "maxResults": 100,
  "servers": {
    "typescript-language-server": {
      "priority": 120
    },
    "jdtls": {
      "disabled": true
    },
    "lua-language-server": {
      "command": "lua-language-server",
      "args": [],
      "fileTypes": [".lua"],
      "rootMarkers": [".luarc.json", ".git"],
      "roles": ["navigation", "diagnostics", "actions"],
      "priority": 100,
      "settings": {
        "Lua": {
          "diagnostics": {
            "globals": ["vim"]
          }
        }
      }
    }
  }
}
```

### 顶层字段

| 字段 | 默认值 | 语义 |
| --- | --- | --- |
| `idleTimeoutMs` | `300000` | client 空闲关闭时间；`0` 禁用 idle shutdown；最大 `2147483647`。 |
| `requestTimeoutMs` | `15000` | 全局请求超时，必须为正整数且不超过 `2147483647`。 |
| `diagnosticsSettleMs` | `500` | 打开/更新文档后等待 diagnostics 稳定的时间；可为 `0`，最大 `2147483647`。 |
| `maxResults` | `100` | 默认格式化结果数，必须为 `1..500` 的整数。 |
| `logEnabled` | `true` | 排查日志总开关；只有显式 `false` 完全关闭。只有全局文件生效，项目配置设置会被严格 decoder 拒绝。 |
| `logLevel` | `error` | 排查日志级别 `error`/`warn`/`info`/`debug`；未知取值回退 `error`。同样只有全局文件生效。 |
| `servers` | 内置集合 | 以 server ID 为 key 的新增配置或 patch。 |

### Server 字段

| 字段 | 语义 |
| --- | --- |
| `command`、`args` | 可执行文件及参数。新增 server 必须提供非空 command；patch 内置 server 时可省略。参数不经过 shell。 |
| `fileTypes` | 后缀数组；已知后缀自动映射 language ID，可配合统一 `languageId`。 |
| `extensions` | 更精确的 `{ ".后缀": "language-id" }` 映射；与 `fileTypes` 合并。 |
| `rootMarkers` | 从文件目录向 workspace 根搜索；数组前面的 marker 优先级更高。无 marker 时使用 workspace 根。 |
| `roles` | `navigation`、`diagnostics`、`actions` 的非空子集。 |
| `priority` | 数值越高越先路由；同 priority 按 server ID 排序。 |
| `env` | 合并到 server 子进程环境的字符串键值。 |
| `initOptions` | 发送给 initialize 的 `initializationOptions`；跨配置层做一层对象合并。 |
| `settings` | initialize 后发送的 workspace configuration；后层 server patch 提供时整体替换该字段。 |
| `requestTimeoutMs`、`diagnosticsSettleMs` | 覆盖该 server 的全局值。 |
| `workspaceStorage` | workspace storage 路径模板。相对路径以 workspace root 解析，支持 `~/`。 |
| `readyNotification` | 可选 `{ method, field?, value? }`；等待特定 server notification 后才视为 ready。 |
| `disabled` | `true` 从合并结果删除该 server。后续更高优先级配置可重新定义同 ID。 |

Server patch 除 `initOptions` 外是浅合并。修改嵌套对象时应提供完整目标字段，避免误以为会递归合并。

### 命令占位符

`command`/`args` 支持：

- `{workspaceRoot}`：当前 server client 的 workspace root。
- `{cacheDir}`：平台缓存目录下的 `pi-lsp`。
- `{serverId}`：清洗后的 server ID。
- `{workspaceHash}`：workspace root 的 SHA-256 前 20 位。
- `{workspaceStorage}`：由 `workspaceStorage` 模板展开后的目录；命令引用它时插件会自动创建目录。

默认 storage 模板为 `{cacheDir}/{serverId}/{workspaceHash}`。`workspaceStorage` 本身不能递归引用 `{workspaceStorage}`。

## 路由与进程生命周期

1. `src/config.ts` 合并内置、全局、可信项目配置，并按 priority 排序。
2. file action 先 realpath 校验 workspace 边界，再根据 suffix + role 选候选 server。`server` 参数优先匹配配置 ID；没有同名 ID 时，可用唯一 language ID（如 `java`）选择其对应 server。
3. `src/server-manager.ts` 为候选计算 workspace root，按需启动 `LspClient`；启动失败或未声明 capability 时尝试下一候选。显式指定 `server` 时不 fallback 到其他 ID。
4. `src/lsp-client.ts` 用 stdio JSON-RPC initialize，跟踪 document version/position encoding，转发取消信号并收集有限 stderr。正常 shutdown 先发送协议 `shutdown`/`exit`；仍存活时 Unix 对独立 process group 依次发送 TERM/KILL，Windows 使用 `taskkill /t /f`，等待父进程与后代结束后才完成 cleanup。
5. diagnostics 是例外：所有匹配 diagnostics server 并行运行；只有全部失败时工具整体失败。

## 安全与限制

- rename/code actions 不 apply；README 或 prompt 中不应把它描述成自动 refactor。
- server command 直接 spawn，不经 shell；配置仍属于可执行代码边界，因此项目级配置必须经过 Pi trust。
- workspace root 搜索不会越过当前 Pi workspace，外部文件和指向外部的 symlink 会被拒绝。
- `workspace_symbols` 未显式指定 server 时只查询已经活跃且支持该 capability 的 client，避免无目标地启动所有 server。
- 临时完整输出只存于当前 session 生命周期；内容是未做逐 edit 截断的完整格式化结果，但路径不是持久 artifact。

## 排查日志

默认开启 `error` 级别：只在工具或 server 失败时写日志，且日志目录在首次写入时才创建，无事件的 session 仍然零磁盘副作用。开关与级别按以下顺序取第一个命中：

1. 环境变量 `PI_LSP_LOG`；
2. 环境变量 `PI_EXT_LOG`（所有使用同一 logger 的扩展共享的 fallback）；
3. 全局配置 `~/.pi/agent/lsp.json`（遵循 `PI_CODING_AGENT_DIR`）的顶层键：

```json
{ "logEnabled": true, "logLevel": "debug" }
```

- 环境变量大小写不敏感：取值为 `error`/`warn`/`info`/`debug` 直接设级别；`0`/`false`/`off` 完全关闭；其他任何非空值（如 `1`）选择最详细的 `debug`。
- `logEnabled`：只有显式 `false` 完全关闭；省略或其他取值视为开启。
- `logLevel`：`error`（默认）、`warn`、`info`、`debug`；缺失或未知取值回退 `error`。
- 只有全局文件生效：logger 在扩展加载时只读取全局配置一次，项目级 `.pi/lsp.json` 设置 `logEnabled`/`logLevel` 会被严格 decoder 拒绝；修改后 `/reload` 生效。环境变量优先于配置文件，适合一次性排障：`PI_LSP_LOG=debug pi ...`。
- 日志写入 `getAgentDir()/logs/lsp.log`（即 `~/.pi/agent/logs/lsp.log`）。文件超过 5 MiB 轮转为 `lsp.log.1`，只保留一份备份。
- 每行是一条 JSON：`ts`、`level`、`ext`、`event` 与 `context`，事件目录：

  | event | level | 关键 context |
  | --- | --- | --- |
  | `manager_ready` | info | `cwd`、`trusted`、`servers`、`loadedFrom` |
  | `server_started` | info | `server`、`root`、`command` |
  | `server_exited` | warn | 非预期退出（crash）；`server`、`root`、`command`。idle/主动 shutdown 不记 |
  | `server_idle_shutdown` | debug | `server`、`root` |
  | `tool_succeeded` | info | 完整请求形状 + `resultCount`/`errorCount`/`truncated`/`durationMs` |
  | `tool_failed` | error | 完整请求形状（action、file、server、行列、symbol/query/newName）+ `cwd`/`durationMs` |
  | `command_failed` | error | `command`、`cwd` |
  | `client_start_failed` | warn | `server`、`action`、`file`、`command`；error 消息含捕获的 server stderr |
  | `diagnostics_failed` | warn | `server`、`file`、`root` |
  | `file_synced` | debug | `file`、`servers`、`failed`（edit/write/ast_grep_edit 后的文档同步） |
  | `sync_failed` | warn | `server`、`file` |
  | `shutdown` | info | `cwd`、`clients`、`pending` |

  `PI_LSP_LOG=debug` 即可按时间线还原“配置加载 → server 启动 → 每次工具调用与耗时 → 文档同步 → 关闭”的完整场景。C1 控制字符会被中和，避免在终端或编辑器中打开日志时执行转义序列。
- 日志是尽力而为的旁路：写入或轮转失败会被静默吞掉，绝不影响工具执行或改变任何返回结果。

## 与 Plan、Goal 和 Todo 的关系

- Plan 的 `planning`、`awaitingApproval` 只读 allowlist 显式允许 `lsp` 与 `ast_grep_search`，不允许 `ast_grep_edit`。规划期 Request `ask` 不改变 Plan phase。Navigation、diagnostics、symbols、rename preview 和 code-action preview 不写工作区；批准进入执行期后，各工具是否继续可用取决于进入 Plan 前的有效工具集。
- LSP 不监听 Plan/Goal/Todo channel，也不调用 `pi-extensions:todo-service:v1`。Goal continuation 和普通 Todo 工作流可以使用模型当前可见的 `lsp` 工具，但 diagnostics、references 或 preview 结果不会自动改变 Goal、Plan step 或 Todo task 状态。
- Todo 不接管 LSP client 生命周期；Plan 的 tool lease 只影响工具可见性，Todo 的 progress provider 只影响进度投影，已启动 client 仍由 LSP 自己在 idle、session reload 和 shutdown 时清理。

## 实现原理与关键节点

- `src/index.ts`：`lsp` 工具 schema、action dispatch、`/lsp`、状态 UI、tool-result 同步 wiring 和 shutdown。
- `src/config.ts`：内置服务器、配置路径、严格 decoder、分层 patch、schema normalization、后缀/role 路由。
- `src/server-manager.ts`：client 缓存、候选 fallback、并行 diagnostics、idle timer 和有界 shutdown。
- `src/logger.ts`：默认开启 `error` 级、由 `PI_LSP_LOG`/`PI_EXT_LOG` 环境变量或全局 `lsp.json` 的 `logEnabled`/`logLevel` 控制、首次写入才创建日志目录、写入 `getAgentDir()/logs/lsp.log` 并有界轮转、C1 中和、吞掉自身失败的排查日志。与 hashline 的同名文件逐字节相同，避免跨包生产导入。
- `src/lsp-client.ts`：子进程组、JSON-RPC、initialize/capability、文档同步、position encoding、timeout/cancel、ready notification 和升级式进程树回收。
- `src/roots.ts`：区分用户 `@` mention 与 literal machine path 的 realpath workspace confinement，以及 root marker 选择。
- `src/positions.ts`：1-based Unicode 输入到 LSP position 的转换及唯一 symbol 解析。
- `src/format.ts`：诊断、去重位置、符号、hover、忠实 WorkspaceEdit、准确 edit 计数和 code action 的稳定文本格式。
- `src/output.ts`：输出截断、私有临时 artifact 与清理。
- `src/tool-sync.ts`：内置 edit/write 与 `ast_grep_edit` 成功 apply 的严格解码、workspace 路径重验和 best-effort active-client 同步。
- `test/fake-server.mjs`：确定性的测试 LSP 子进程；`test/*.test.ts` 覆盖严格配置、路由、协议、完整 artifact、准确计数、失败、取消、settle、顽固进程树和清理。

## 开发与验证

```bash
cd /path/to/pi-extensions/lsp
npm run check
npm test
```

真实 smoke test 还需安装至少一个对应 language server，在目标项目中启动 Pi，然后依次检查 `/lsp`、`status`、`diagnostics` 和一个 navigation action。
