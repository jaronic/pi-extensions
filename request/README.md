# Request UI 插件

`request` 为 Pi 提供统一的交互式请求界面：agent 可通过 `ask` 工具一次提交一组相关问题；其他 extension 的 `ctx.ui.select()`、`ctx.ui.confirm()`、`ctx.ui.input()` 会在 TUI session 中自动使用同一 renderer；明确声明 Request package 依赖的 extension 可直接调用导出的 typed `installRequest(pi)` service，未声明依赖的独立 extension 仍可通过版本化事件 channel 调用同一 coordinator。

该插件只处理当前进程中的短生命周期交互，不持久化答案、不访问网络，也不改变非 TUI 模式的行为。

> 维护约束：凡是改变 Request 的工具 schema、native adapter、事件协议、协调器、输入边界、生命周期、与 Goal/Plan/Todo 的协作或安装方式，都必须在同一改动中同步本 README。

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

单题成功时，tool `details` 直接返回一个紧凑 answer：

```ts
interface AskAnswerDetails {
  id: string;
  multi: boolean;
  selectedOptions: string[];
  customInput?: string;
}
```

多题成功时返回 `{ results: AskAnswerDetails[] }`，顺序与 questions 相同。tool details 不重复保存原 question/options，并受 50 KiB 独立上限约束。版本化事件 API 的 `RequestDialogResult` 为兼容 v1 仍返回完整 `RequestAnswer`（包含 `question` 与 `options`）。Review 允许显式提交未回答问题，此时 `selectedOptions` 为空且没有 `customInput`。Esc、Ctrl+C、AbortSignal 或 timeout 取消 `ask` 时，tool call 以错误结束，不伪造用户选择。

## 交互模型

宽度至少 24 列且终端高度至少 9 行时使用带边框布局；更窄或更矮时切换为无边框 compact view。正文随终端高度滚动，焦点项始终保持可见；所有行都会截断或换行到当前可用宽度。

- `↑`/`↓` 移动选项；`Home`/`End` 跳到首尾。
- 单选题用 `Enter` 确认当前项；多选题用 `Space` 切换当前项、`Enter` 进入下一题或 Review。
- 聚焦选项时显示 description；有 preview 时只展开当前选项的 preview。
- `Other` 用 `Enter` 打开文本编辑器；`Enter` 保存，Esc 返回选项列表。自定义答案最多 1,000 字符；单选题保存 Other 时会原子替换旧选项，不会同时返回两种互斥答案。
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

例如 Goal 的 “Replace active goal?” 和 Todo 的 `/todos clear` 都使用 `ctx.ui.confirm()`，因此同时加载 Request 后会自动采用统一 renderer；没有加载 Request 时仍使用 Pi 原生确认框。专用的 Plan Review 等 `ctx.ui.custom()` 组件仍保留自己的领域界面。

### 与 Goal、Plan 和 Todo 的边界

- Goal 的 active-objective replacement 与 Todo 的 `/todos clear` 通过标准 `ctx.ui.confirm()` 自动获得 Request renderer；调用方仍拥有确认后的状态转换与 journal 写入。
- Plan Review 保留自己的领域组件；Plan clarification 由其领域状态机调用 Request service 展示单选问题，Plan 仍独自验证选择并写入 journal。Todo managed Plan progress 不经过 Request coordinator。
- Request 不调用 Todo service，不创建普通 Todo task，也不读取或更新 managed Plan ledger。它只负责交互结果；Goal、Plan、Todo 分别校验结果并提交自己的状态。

### 版本化事件协议

需要多问题、description、preview、multi、Other 或 text question 的 extension 应使用：

```text
pi-extensions:request-ui:v1
```

`request/src/index.ts` 导出 `installRequest()`、`RequestService`、`REQUEST_UI_CHANNEL`、`requestFromUser()` 及全部 public types。明确声明 package dependency 的调用方直接安装并持有 service：

```ts
import {
  installRequest,
  type RequestQuestion,
} from "pi-request-ui-dev";

const request = installRequest(pi);
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

const result = await request.request(questions, {
  signal: abortController.signal,
  timeout: 30_000,
});
```

`pi-extensions:request-ui:v1` 继续是未声明 package dependency 的兼容入口。此类独立 package 可按 `RequestUIEnvelope` 的结构 emit；第一个 listener 接受请求，没有 listener 时 `requestFromUser()` 明确 reject。所有直接、`ask` 与 channel 入口由同一个 coordinator 串行显示，避免 dialog 互相覆盖。

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

- request：最多 10 题、16 KiB 规范化 payload；tool details 最多 50 KiB。
- question：id 最多 64 字符，只接受字母数字开头及 `._-`；header 最多 80 字符；正文最多 1,000 字符。
- option：每题最多 10 项；label 最多 160 字符且规范化后不得重复；description 最多 500 字符；preview 最多 4,000 字符。
- header、id、label、placeholder 与 tool intent 必须为单行。所有外部展示文本拒绝终端控制字符和 Unicode 双向格式控制；Editor 自由文本在存储和渲染前把这些字符替换为可见的 `�`，不会原样写入终端。
- answer：文本和 Other 最多 1,000 字符。
- 非 TUI 模式下 `ask` 明确失败；native UI 不会在该模式安装 adapter；事件请求在没有 ready TUI session 时 reject。
- 所有异步请求支持 abort 和 timeout；session shutdown 会 abort 当前及排队请求、清除 timer/listener、注销兼容 channel；失效 installation 的旧 service 引用会 fail closed。

## 代码结构

- `src/index.ts`：composition root；导出幂等 `installRequest()` service，注册 tool/channel，管理 session signal，并安装/恢复 native adapter。
- `src/request.ts`：public types、输入上限、规范化与结果结构。
- `src/component.ts`：响应式 Question/Review TUI、键盘状态机、滚动和 Editor 集成。
- `src/dialog.ts`：所有调用方共享的串行 coordinator。
- `src/adapters.ts`：`select`/`confirm`/`input` 的兼容 adapter 与保守 fallback。
- `src/protocol.ts`：`pi-extensions:request-ui:v1` client/helper 和 listener arbitration。
- `src/tool.ts`：TypeBox `ask` schema、tool execution、call/result renderer。
- `test/integration.test.ts`：tool、native API、真实 Goal 共存、外部 fixture、单选/Other 不变量、控制字符、并发、取消、超时、headless 和 terminal fallback 行为。

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
