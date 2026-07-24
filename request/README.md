# Request UI 插件

`request` 为 Pi 提供统一的交互式请求界面：agent 可通过 `ask` 工具一次提交一组相关问题；其他 extension 的 `ctx.ui.select()`、`ctx.ui.confirm()`、`ctx.ui.input()` 会在 TUI session 中自动使用同一 renderer；需要描述、预览、多选或多问题的 extension 可通过版本化事件 channel 调用同一 coordinator。

该插件只处理当前进程中的短生命周期交互，不持久化答案、不访问网络，也不改变非 TUI 模式的行为。

## 安装

要求 Node.js `>=22.19.0`、npm，以及兼容 `@earendil-works/pi-coding-agent >=0.81.0` 的 Pi。

```bash
cd /path/to/pi-extensions/request
npm ci
mkdir -p "$HOME/.pi/agent/extensions"
ln -sfn "$PWD" "$HOME/.pi/agent/extensions/request"
```

软链接必须指向 `request/` package，而不是仓库根目录。安装或修改后在 Pi 中执行 `/reload`。如需从仓库根目录管理全部 extension：

```bash
make pi-extensions-on
make pi-extensions-status
```

`make pi-extensions-off` 和 `make pi-extensions-toggle` 提供安全关闭与切换；管理器只处理仍指向当前仓库的链接，不覆盖同名普通文件、目录或外部软链接。

Request 本身不分发、不选择、也不写入任何 theme；所有颜色只从 Pi 当前 `Theme` 的语义 token 读取。仓库提供的可选全局 palette 独立位于 [`../themes/`](../themes/README.md)，即使不安装 Request 也可使用。

## `ask` 工具

`ask` 接受 1–10 个相关 choice question。每题有稳定 `id`、简短导航 `header`、问题正文、1–10 个选项，以及可选的 `recommended` 零基索引和 `multi` 多选标志。`Other (type your own)` 由工具自动追加，不应在 options 中重复声明。

```json
{
  "i": "Choose release behavior",
  "questions": [
    {
      "id": "strategy",
      "header": "Strategy",
      "question": "Which release strategy should be used?",
      "options": [
        {
          "label": "Rolling",
          "description": "Replace instances gradually with no planned outage.",
          "preview": "Best when old and new versions can run concurrently."
        },
        {
          "label": "Blue/green",
          "description": "Switch traffic between two complete environments."
        }
      ],
      "recommended": 0,
      "multi": false
    }
  ]
}
```

`i` 是可选的简短调用意图，只显示在 tool call 上下文中。`recommended` 只设置初始焦点并显示 `(Recommended)`，不会在用户确认前生成答案。

单题成功时，tool `details` 直接返回一个 answer：

```ts
interface RequestAnswer {
  id: string;
  question: string;
  options: string[];
  multi: boolean;
  selectedOptions: string[];
  customInput?: string;
}
```

多题成功时返回 `{ results: RequestAnswer[] }`，顺序与 questions 相同；Review 允许显式提交未回答问题，此时 `selectedOptions` 为空且没有 `customInput`。Esc、Ctrl+C、AbortSignal 或 timeout 取消 `ask` 时，tool call 以错误结束，不伪造用户选择。

## 交互模型

宽度至少 24 列且终端高度至少 9 行时使用带边框布局；更窄或更矮时切换为无边框 compact view。正文随终端高度滚动，焦点项始终保持可见；所有行都会截断或换行到当前可用宽度。

- `↑`/`↓` 移动选项；`Home`/`End` 跳到首尾。
- 单选题用 `Enter` 确认当前项；多选题用 `Space` 切换当前项、`Enter` 进入下一题或 Review。
- 聚焦选项时显示 description；有 preview 时只展开当前选项的 preview。
- `Other` 用 `Enter` 打开文本编辑器；`Enter` 保存，Esc 返回选项列表。自定义答案最多 1,000 字符。
- 多题用 `Tab`/`→` 前进、`Shift+Tab`/`←` 后退；顶部导航显示 active、answered 和 unanswered 状态。
- Review 用 `↑`/`↓` 选择题目或 Submit；`Enter` 返回所选题编辑或提交整组答案。
- 一般状态下 Esc/Ctrl+C 取消整次请求；文本型 native input 中也保持这一取消语义。

## 其他 extension 的共享入口

### 原生 UI adapter

TUI `session_start` 时，Request 在共享 `ExtensionUIContext` 实例上安装 adapter：

- `ctx.ui.select(title, options, opts)` → 统一单选界面，返回原 option string 或 `undefined`。
- `ctx.ui.confirm(title, message, opts)` → Yes/No 统一界面，取消仍返回 `false`。
- `ctx.ui.input(title, placeholder, opts)` → 统一文本界面，保留空字符串和首尾空格；取消仍返回 `undefined`。

`timeout` 与 `signal` 会继续生效。Request 在 session 切换或 shutdown 时中止未完成 dialog 并恢复原方法；恢复前会确认当前方法仍是自己的 wrapper，不覆盖其他 extension 后续安装的 adapter。空选项、首尾空格 option、重复 option 或超出 Request 边界的 native payload 会安全回退 Pi 原生方法，以保持原返回值语义。

例如 Goal 的 “Replace active goal?” 使用 `ctx.ui.confirm()`，因此同时加载 Request 后会自动采用统一 renderer；没有加载 Request 时仍使用 Pi 原生确认框。专用的 Plan Review 等 `ctx.ui.custom()` 组件仍保留自己的领域界面。

### 版本化事件协议

需要多问题、description、preview、multi、Other 或 text question 的 extension 应使用：

```text
pi-extensions:request-ui:v1
```

`request/src/index.ts` 导出 `REQUEST_UI_CHANNEL`、`requestFromUser()` 及全部 public types。显式依赖 Request package 的调用方可直接使用 helper：

```ts
import {
  requestFromUser,
  type RequestQuestion,
} from "/path/to/pi-extensions/request/src/index.ts";

const questions: RequestQuestion[] = [{
  id: "cache",
  header: "Cache",
  question: "Which cache policy should be used?",
  options: [
    { label: "LRU", description: "Bounded recency cache." },
    { label: "TTL", description: "Time-based expiry." },
  ],
  recommended: 0,
}];

const result = await requestFromUser(pi, questions, {
  signal: abortController.signal,
  timeout: 30_000,
});
```

仓库内独立 package 不应建立跨 package production import；它们可按 `RequestUIEnvelope` 的结构直接向该 channel emit。Envelope 包含 `version: 1`、`questions`、可选 `options`、一次性的 `accept()` 仲裁函数，以及 `resolve()`/`reject()` completion。第一个加载的兼容 listener 接受请求；没有 listener 时 `requestFromUser()` 明确 reject，不会静默挂起。所有入口由同一个 coordinator 串行显示，避免多个 extension 的 dialog 互相覆盖。

事件 API 还支持文本题：

```ts
{
  id: "notes",
  header: "Notes",
  question: "Add optional implementation notes.",
  kind: "text",
  placeholder: "May be empty"
}
```

## 输入边界与生命周期

- request：最多 10 题、16 KiB 规范化 payload。
- question：id 最多 64 字符，只接受字母数字开头及 `._-`；header 最多 80 字符；正文最多 1,000 字符。
- option：每题最多 10 项；label 最多 160 字符且规范化后不得重复；description 最多 500 字符；preview 最多 4,000 字符。
- answer：文本和 Other 最多 1,000 字符。
- 非 TUI 模式下 `ask` 明确失败；native UI 不会在该模式安装 adapter；事件请求在没有 ready TUI session 时 reject。
- 所有异步请求支持 abort 和 timeout；session shutdown 会 abort 当前及排队请求、清除 timer/listener，并注销事件 channel。

## 代码结构

- `src/index.ts`：composition root；注册 tool/channel，管理 session signal，并安装/恢复 native adapter。
- `src/request.ts`：public types、输入上限、规范化与结果结构。
- `src/component.ts`：响应式 Question/Review TUI、键盘状态机、滚动和 Editor 集成。
- `src/dialog.ts`：所有调用方共享的串行 coordinator。
- `src/adapters.ts`：`select`/`confirm`/`input` 的兼容 adapter 与保守 fallback。
- `src/protocol.ts`：`pi-extensions:request-ui:v1` client/helper 和 listener arbitration。
- `src/tool.ts`：TypeBox `ask` schema、tool execution、call/result renderer。
- `test/integration.test.ts`：tool、native API、真实 Goal 共存、外部 fixture、并发、取消、超时、headless 和 terminal fallback 行为。

## 开发与验证

```bash
cd request
npm ci
npm run check
npm test
```

隔离加载 smoke：

```bash
pi --no-session -p --extension "$PWD" "Reply with exactly: SMOKE_OK"
```

交互验证需在真实 Pi TUI 中触发 `ask`，检查 choice、Other、Review、取消，以及窄终端 compact view。
