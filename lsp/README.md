# LSP 插件

`lsp` 把 Language Server Protocol 能力暴露为 Pi 的单一 `lsp` 工具，提供诊断、hover、定义、类型定义、实现、引用、文档/工作区符号、重命名预览和 code action 预览。

重命名和 code action 始终只返回预览，不修改文件；实际改动仍应交给 Pi 的编辑工具。

> 维护约束：凡是改变 LSP action、参数、默认服务器、配置 schema/合并顺序、路由、进程生命周期、输出格式或安装方式，都必须在同一改动中同步本 README。

## 效果与边界

- 按文件后缀和 server role 路由到匹配的 language server；多个候选按 priority 从高到低尝试。
- client 按 `server + workspace root` 懒启动并复用，空闲后自动 shutdown。
- diagnostics 对所有匹配服务器并行请求，保留成功结果并单独报告局部失败。
- `edit`/`write` 工具成功后，已启动且覆盖该文件的 client 会同步最新磁盘内容。
- 工具运行时 TUI status 显示当前 action；`/lsp` 显示已配置和活跃的 client。
- 输出受 Pi 的 2,000 行/50 KiB 上限约束；截断时完整格式化结果写入权限为 `0600` 的临时文件，并在 session reload/shutdown 时清理。
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
| `rename_preview` | `file` + position + `newName` | 仅格式化 `WorkspaceEdit`，不落盘。 |
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

`file` 可为 workspace 相对路径、绝对路径或带 `@` 前缀的路径，但解析后的真实文件必须位于当前 workspace。`limit` 控制格式化结果数，默认来自配置，单次最多 500。

## 配置位置与优先级

无需配置即可使用内置 server。自定义文件按以下顺序加载：

1. 全局：`$HOME/.pi/agent/lsp.json`
2. 项目：`<workspace>/.pi/lsp.json`

项目配置只有在 Pi 信任该项目时才加载。后加载的项目配置覆盖全局配置；两者都在内置配置之上打 patch。配置在 manager 创建时读取，不热更新；修改后执行 `/reload` 或新建 session。

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
| `idleTimeoutMs` | `300000` | client 空闲关闭时间；`0` 禁用 idle shutdown。 |
| `requestTimeoutMs` | `15000` | 全局请求超时，必须为正整数。 |
| `diagnosticsSettleMs` | `500` | 打开/更新文档后等待 diagnostics 稳定的时间；可为 `0`。 |
| `maxResults` | `100` | 默认格式化结果数，必须为正整数。 |
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
2. file action 先 realpath 校验 workspace 边界，再根据 suffix + role 选候选 server。
3. `src/server-manager.ts` 为候选计算 workspace root，按需启动 `LspClient`；启动失败或未声明 capability 时尝试下一候选。显式指定 `server` 时不 fallback 到其他 ID。
4. `src/lsp-client.ts` 用 stdio JSON-RPC initialize，跟踪 document version/position encoding，转发取消信号、收集有限 stderr，并在超时、进程退出或 shutdown 时清理 pending request。
5. diagnostics 是例外：所有匹配 diagnostics server 并行运行；只有全部失败时工具整体失败。

## 安全与限制

- rename/code actions 不 apply；README 或 prompt 中不应把它描述成自动 refactor。
- server command 直接 spawn，不经 shell；配置仍属于可执行代码边界，因此项目级配置必须经过 Pi trust。
- workspace root 搜索不会越过当前 Pi workspace，外部文件和指向外部的 symlink 会被拒绝。
- `workspace_symbols` 未显式指定 server 时只查询已经活跃且支持该 capability 的 client，避免无目标地启动所有 server。
- 临时完整输出只存于当前 session 生命周期；不要把其路径当持久 artifact。

## 实现原理与关键节点

- `src/index.ts`：`lsp` 工具 schema、action dispatch、`/lsp`、状态 UI、edit/write 后同步和 shutdown。
- `src/config.ts`：内置服务器、配置路径、分层 patch、schema normalization、后缀/role 路由。
- `src/server-manager.ts`：client 缓存、候选 fallback、并行 diagnostics、idle timer 和有界 shutdown。
- `src/lsp-client.ts`：子进程、JSON-RPC、initialize/capability、文档同步、position encoding、timeout/cancel、ready notification。
- `src/roots.ts`：realpath workspace confinement 与 root marker 选择。
- `src/positions.ts`：1-based Unicode 输入到 LSP position 的转换及唯一 symbol 解析。
- `src/format.ts`：诊断、位置、符号、hover、WorkspaceEdit 和 code action 的稳定文本格式。
- `src/output.ts`：输出截断、私有临时 artifact 与清理。
- `test/fake-server.mjs`：确定性的测试 LSP 子进程；`test/*.test.ts` 覆盖配置、路由、协议、失败、取消、settle 和清理。

## 开发与验证

```bash
cd /path/to/pi-extensions/lsp
npm run check
npm test
```

真实 smoke test 还需安装至少一个对应 language server，在目标项目中启动 Pi，然后依次检查 `/lsp`、`status`、`diagnostics` 和一个 navigation action。
