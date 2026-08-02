# Notify 插件

`notify` 在 agent 完全空闲（任务完成或等待用户输入）时发送带外通知：macOS 系统通知、终端 bell，以及可选的 ntfy.sh HTTP 推送。通知路径完全不依赖 `ctx.ui`，因此在 TUI、RPC、JSON、print 四种模式中都能工作。

> 维护约束：凡是改变 Notify 的触发时机、通道行为、命令、配置 schema、安全校验或安装方式，都必须在同一改动中同步本 README。

## 触发与防抖

- 核心触发是 `agent_settled` 事件，而不是 `agent_end`：`agent_end` 之后仍可能自动重试、压缩重试或处理 follow-up，只有 `agent_settled` 表示没有后续自动行为的稳定空闲点。
- **空闲确认窗口**：`agent_settled` 是按"一次 agent 运行"发出的，而一个逻辑任务可能跨多次运行——Plan 交接、Goal 自动续跑、排队的 follow-up、用户打断后立刻追问，都是上一个 run settle 后立刻开始新 run，此时直接通知就是"还在运行中"的误报。因此 settle 后不立即发送，而是等待 3 秒宽限期（`DEFAULT_SETTLE_GRACE_MS`）：宽限期内触发 `agent_start` 则取消本次待发通知；宽限期结束时再用 `ctx.isIdle()` 与 `ctx.hasPendingMessages()` 复核，任一不满足（新运行已开始、或有排队消息等待继续）则跳过。
- 每次 `agent_start` 记录运行开始时间；settle 时先经过纯函数门控（`src/state.ts` 的 `decideSettledNotification`）：
  - `enabled`（配置）与 `/notify off`（运行时）任一为关则跳过；
  - `minTurnSeconds > 0` 时，短于该阈值的运行不通知（避免琐碎秒回的打扰）；
  - 距上一次自动通知不足 `minIntervalSeconds` 时跳过（默认 30 秒，防止连续 settle 轰炸）。
- 一次 dispatch 正在进行时，新的 dispatch 会被跳过（`dispatch already in flight`）；每次 dispatch 有 15 秒总超时，各通道还有自己的超时。
- 通知文案为 `<项目目录名> is idle — waiting for input`，标题可配置；文案不含任何 session 内容或 secret。

## 通知通道

通道是可插拔的纯函数适配器（`src/channels.ts`），每个适配器报告自己的平台/配置可用性，发送失败只影响自己：

| 通道 | 默认 | 说明 |
| --- | --- | --- |
| `osascript` | 开 | macOS 系统通知。用 `pi.exec("osascript", ["-e", script])` 执行，参数是数组、不经 shell；标题/正文做 AppleScript 字符串转义（`\`、`"` 转义，控制字符折叠为空格）。非 macOS 平台降级为不可用，`/notify status` 会注明 `requires macOS`。超时 10 秒。 |
| `bell` | 开 | 终端 bell（`\x07`）。TUI 模式写 `process.stdout`；RPC/JSON/print 模式写 `process.stderr`，避免污染机器可读 stdout。 |
| `ntfy` | 关 | ntfy.sh 兼容的 HTTP 推送。POST 到 `<baseUrl>/<topic>`，带 `Title` 头与正文，token 以 `Authorization: Bearer` 发送。超时 8 秒，`redirect: "manual"`，3xx 一律拒绝（不对跳转后的地址做信任）。 |

### ntfy 的 SSRF 校验（`src/ssrf.ts`）

发送前对 `baseUrl` 做两层校验：

1. 字面校验：只允许 `https:`；拒绝 URL 内嵌凭据、`localhost`/`*.localhost`/`*.local`/`*.internal`，以及私网/保留 IP 字面量（IPv4 全量常见段、IPv6 `::1`/ULA/link-local/IPv4-mapped）。
2. DNS 校验：解析 hostname，任一解析结果为私网/保留地址即拒绝；DNS 失败也拒绝。

### secret 边界

- ntfy token 只来自配置文件 `channels.ntfy.token` 或环境变量 `PI_NOTIFY_NTFY_TOKEN`（环境变量优先）；topic 同理可用 `PI_NOTIFY_NTFY_TOPIC` 覆盖。
- token 永不进入通知文案、`/notify status` 输出（只显示 `token configured/not configured`）、警告、错误 outcome 或日志。

## 配置

分层合并（低优先级在前）：内置默认 < 全局 `~/.pi/agent/notify.json` < 项目 `.pi/notify.json`（仅 project trust 激活时读取）< 环境变量（仅 ntfy topic/token）。

- 逐字段覆盖；某一文件层 JSON 非法、schema 不符、含未知字段或值越界时，整层被拒绝（fail closed）并保留下层配置，session 启动时以 warning 说明原因；文件不存在则静默跳过。
- 配置在 `session_start`（含 reload/new/resume/fork）重新加载；加载本身抛错时通知暂停并在 UI 报错，不影响 agent 运行。

默认值：

```json
{
  "version": 1,
  "enabled": true,
  "minIntervalSeconds": 30,
  "minTurnSeconds": 0,
  "title": "Pi",
  "channels": {
    "osascript": { "enabled": true },
    "bell": { "enabled": true },
    "ntfy": { "enabled": false, "baseUrl": "https://ntfy.sh" }
  }
}
```

字段约束：`minIntervalSeconds`/`minTurnSeconds` 为 0..86400 的有限数；`title` 1..80 字符；`channels` 只接受 `osascript`/`bell`/`ntfy`；`ntfy.topic` 为 1..128 字符的 `[A-Za-z0-9_-]`；`ntfy.token` 1..256 字符；`ntfy.baseUrl` 1..300 字符且必须通过上述 SSRF 字面校验才真正可用。未知字段、错误类型都会导致该层被拒绝。

启用 ntfy 的最小全局配置（`~/.pi/agent/notify.json`）：

```json
{
  "version": 1,
  "channels": {
    "ntfy": { "enabled": true, "topic": "my-private-topic" }
  }
}
```

token 推荐走环境变量而不是文件：`export PI_NOTIFY_NTFY_TOKEN=tk_...`。

## 用户命令

`/notify [status|test|on|off]`：

- `status`（无参数时默认）：显示总开关（配置 + 运行时）、去抖参数、上次通知时间、各配置层的应用情况、各通道 enabled/available 状态及不可用原因；ntfy 启用时显示 baseUrl 与 topic，token 只显示是否已配置。
- `test`：立即向所有启用的通道发一条测试通知（绕过门控且不影响防抖时钟），逐通道报告 `delivered` / `skipped (原因)` / `failed (原因)`；全部失败时以 error 级别显示。
- `on` / `off`：本会话内开/关自动通知（`session_start` 时重置为开）；持久开关请改配置文件的 `enabled`。

本插件不注册任何模型工具。

## 模式与生命周期

- TUI/RPC/JSON/print 四种模式都能发系统通知：dispatch 只走 `pi.exec`、`fetch` 和 stderr/stdout bell，不调用 `ctx.ui`。`ctx.ui.notify` 仅用于命令回复、配置 warning 和"所有通道失败"的降级提示，且都先检查 `ctx.hasUI`。
- 所有 exec/fetch 都携带 AbortSignal 与超时；dispatch 级 15 秒超时与 `session_shutdown` 触发的 abort 通过 `AbortSignal.any` 合成。
- `session_shutdown` 幂等：中止进行中的 dispatch、清掉运行计时，重复调用安全；插件不启动常驻 timer、watcher 或子进程。

## 实现原理与关键节点

- `src/index.ts`：composition root，只做事件注册与依赖装配；导出 `createNotifyExtension(pi, deps)` 供测试注入通道/配置加载器/时钟，默认导出为真实接线。
- `src/state.ts`：纯函数门控（`decideSettledNotification`）与通知文案（`buildMessage`），无 I/O。
- `src/config.ts`：配置类型、默认值、逐层严格校验（`parseNotifyConfigFile`，整层 fail closed）、纯合并（`mergeNotifyConfig`）、环境变量覆盖（`applyNotifyEnv`）与分层加载（`loadNotifyConfig`，`readFile` 可注入）。
- `src/channels.ts`：三个通道适配器；`escapeAppleScriptString` 单独导出以便测试。
- `src/ssrf.ts`：IP/URL 字面校验与 DNS 解析校验，`lookup` 可注入。
- `src/notifier.ts`：运行时编排——运行计时、防抖时钟、in-flight 去重、dispatch 超时与 abort。
- `src/command.ts`：`/notify` 命令与纯函数 `formatStatus`。

## 安装与启用

要求：Node.js `>=22.19.0`、npm，以及兼容 `@earendil-works/pi-coding-agent >=0.82.1` 的 Pi。

```bash
cd /path/to/pi-extensions/notify
npm ci
mkdir -p "$HOME/.pi/agent/extensions"
ln -sfn "$PWD" "$HOME/.pi/agent/extensions/notify"
```

软链接必须指向 `notify/` 包根目录；Pi 读取 `package.json` 的 `pi.extensions` 并加载 `./src/index.ts`。随后重启 Pi 或执行 `/reload`。仓库根目录也可用 `make pi-on` 统一管理全部扩展链接。

## 开发与验证

```bash
cd notify
npm ci
npm run check    # tsc --noEmit
npm test         # node --import tsx --test test/*.test.ts
```

测试覆盖：配置解析/合并/分层与环境变量（含 malformed 输入 fail closed、secret 不泄漏）、SSRF 字面与 DNS 校验、三个通道适配器（含转义、超时/失败 outcome、token 不泄漏）、纯门控逻辑，以及 harness 级的注册形状、settle 触发、空闲确认窗口（宽限期内新 run 取消、idle/pending 复核、shutdown 取消）、去抖、时长阈值、`/notify` 各子命令、print 无 UI 路径、配置加载失败和幂等 shutdown。`test/harness.ts` 在 `test/*.test.ts` glob 之外，提供内存版 ExtensionAPI/Context 与录制通道。
