# Plan 插件

`plan` 为 Pi 增加“只读调研 → 提交计划 → 用户审批 → 按步骤执行”的状态机，在用户批准前从工具选择和 tool-call 拦截两层阻止工作区写入。

> 维护约束：凡是改变 Plan 的行为、命令、工具 schema、状态机、工具策略、与 Goal 的协议或安装方式，都必须在同一改动中同步本 README。

## 适用场景与效果

适合风险较高、范围较大，或用户希望先审查实施方案再允许修改的任务。进入 Plan 后：

- agent 只能使用显式只读工具做调查；出现会实质改变计划的取舍时，可用 `request_plan_choice` 请求用户在 2–5 个选项间选择。
- `submit_plan` 成功后立即返回摘要与 Review 提示并进入 `awaitingApproval`；完整候选计划仅在 Review、Copy、`/plan status` 与 journal state 中呈现，工具调用不等待 UI。
- 每次成功初次提交或 refinement 重提都会创建一份不可变、仅含 Plan body 的 Markdown artifact；同一绝对路径只写入持久 Plan state 与 machine-readable tool result details，不进入 model-visible content。
- 批准后恢复进入 Plan 前的工具集，并额外启用 `update_plan_step`。
- TUI footer 以独立 keyed status 横向显示 Plan 与 Goal；Plan 提交后，独立 widget 仅显示最多 20 个步骤及其 `pending`、`inProgress`、`completed`、`blocked` 状态。
- 状态写入 Pi session journal；切换 session tree 分支会恢复该分支最后的有效 Plan 状态。

## 安装与启用

要求：Node.js `>=22.19.0`、npm，以及兼容 `@earendil-works/pi-coding-agent >=0.81.0` 的 Pi。

```bash
cd /path/to/pi-extensions/plan
npm ci
mkdir -p "$HOME/.pi/agent/extensions"
ln -sfn "$PWD" "$HOME/.pi/agent/extensions/plan"
```

软链接必须指向 `plan/` 包根目录。Pi 根据 `package.json` 的 `pi.extensions` 加载 `./src/index.ts`。仓库移动后需重建链接；随后重启 Pi，或执行 `/reload`。

开发时可直接加载入口：

```bash
pi --extension ./src/index.ts
```

## 使用方法

### 典型流程

1. 输入 `/plan`。插件停止当前 agent、进入只读 `planning`，但不发送消息或触发模型。
2. 发送需要规划的真实请求；该消息是本轮规划的直接范围。若存在无法由仓库证据解决且会改变方案的取舍，agent 调用 `request_plan_choice`，TUI 在本轮 settled 后显示选择窗口。
3. agent 调查仓库并调用 `submit_plan`。每次成功提交都会生成一个新的不可变 preview artifact。
4. `submit_plan` 所在 agent 轮完全 settled 后，TUI 自动打开 Review；可复制、批准、refine、stay 或取消。关闭后使用 `/plan review` 重新打开，也可直接使用显式命令。
5. 批准后 agent 执行计划，并用 `update_plan_step` 更新每一步。
6. 所有步骤变为 `completed` 时，Plan 自动退出并恢复工具。

```mermaid
stateDiagram-v2
    [*] --> planning: /plan
    planning --> awaitingClarification: request_plan_choice
    awaitingClarification --> planning: TUI 选择或 answer_plan_choice
    planning --> awaitingApproval: submit_plan
    awaitingApproval --> planning: /plan refine
    awaitingApproval --> executing: /plan approve
    planning --> [*]: /plan cancel
    awaitingClarification --> [*]: /plan cancel
    awaitingApproval --> [*]: /plan cancel
    executing --> [*]: 所有步骤 completed
    executing --> [*]: /plan cancel
```

### 规划提示词契约

`planning` 阶段注入完整的英文规划契约：

- Plan 以用户当前的规划请求为直接范围；Goal 不是前置条件。两者同时活跃且目标相关时，Goal 只提供补充上下文或外层约束，不会使 Plan 自动覆盖整个 Goal。
- agent 先通过仓库代码、配置、测试、历史和既有模式消除不确定性，不得询问能够自行查到的信息；具体路径、符号、命令和行为判断必须有证据。
- 只有缺少正确规划所需事实、存在实质性取舍、假设可能破坏数据或契约，或业务语义无法从代码和测试确定时，才调用 `request_plan_choice`；提供 2–5 个有区别的选项及其描述。TUI 会在当前轮 settled 后以键盘选择窗口收集答案；无界面时，用户回复一个选项编号后 agent 调用 `answer_plan_choice`。
- 每个顶层实施阶段都写明 Target、Change 和 Check，并按照真实依赖排序；验证方式必须对应 bug、API、UI、数据库或内部重构的可观察行为。
- `summary` 是一句结果与范围摘要；`plan` 保存完整技术细节；`steps` 与顶层阶段一一对应，通常为 2–8 项且提示词要求每项不超过 120 字符。工具 schema 仍保留 1–50 项、每项最多 500 字符的硬上限。
- 存在旧计划时，它会经过 XML 转义后放入 `<untrusted_plan>`；refinement 必须重新核对证据并提交完整替代计划，而不是 diff 或局部补丁。
- 所有实质问题解决后，agent 恰好调用一次 `submit_plan` 并结束规划轮，不在同一轮执行计划。

### 用户命令

```text
/plan
/plan status
/plan review
/plan resume
/plan approve
/plan refine
/plan cancel
```

| 命令 | 行为 |
| --- | --- |
| `/plan` | Plan 关闭时进入 `planning`，但不排队消息或触发模型；随后发送真实规划请求。Plan 已开启时等同于 status。 |
| `/plan status` | 显示当前 phase、完整计划和步骤状态。 |
| `/plan review` | 仅在 `awaitingApproval` 可用；重新打开自动审批窗口，支持滚动和复制；Stay 或 Esc 后可再次 review。 |
| `/plan resume` | 继续已存在的 planning 或 executing 状态；不会绕过 awaiting approval。 |
| `/plan approve` | 仅在 `awaitingApproval` 可用；恢复原工具并排队执行轮。 |
| `/plan refine` | 仅在 `awaitingApproval` 可用；回到只读 planning，并要求 agent 提交完整替代计划。 |
| `/plan cancel` | 任意活跃 phase 均可取消；恢复原工具，不暂停 active Goal。 |

命令在改变状态前会 abort 当前 agent 并等待 idle，防止旧 agent 在新策略下继续运行。

### Agent 工具

#### `submit_plan`

仅在 `planning` 启用，一次提交完整计划：

```json
{
  "summary": "简洁的结果与范围摘要",
  "plan": "完整 Markdown 实施计划",
  "steps": [
    "调查并确认现有契约",
    "实施变更",
    "验证端到端行为"
  ]
}
```

约束：summary 最多 500 字符，plan 最多 20,000 字符，1–50 个步骤，每步最多 500 字符；完整 payload 还受 40 KiB UTF-8 上限约束。插件为步骤生成稳定 ID，写入不可变 body-only artifact，并以 `terminate: true` 结束当前规划轮。model-visible 调用结果只返回摘要与 Review 提示；绝对路径只在 machine-readable `details.planPath` 和 journal state 中公开，完整 body 与步骤文本不复制到调用结果。

#### `request_plan_choice` 与 `answer_plan_choice`

`request_plan_choice` 仅在 `planning` 启用。它暂停只读规划，记录一个问题及 2–5 个带描述的选项，并在 TUI 当前轮 settled 后显示选择窗口；`↑`/`↓` 选择、Enter 确认、Esc 保持等待。确认后状态返回 `planning` 并排队下一轮。无界面时用户必须明确回复一个一基选项编号，agent 才能在 `awaitingClarification` 调用 `answer_plan_choice`。

#### `update_plan_step`

仅在 `executing` 启用：

```json
{
  "id": "submit_plan 返回的步骤 ID",
  "status": "inProgress"
}
```

status 可为 `pending`、`inProgress`、`completed`、`blocked`。最后一个未完成步骤变为 `completed` 时，Plan 自动完成并退出。

## 阶段与工具策略

| Phase | 可用工具 | 写入能力 |
| --- | --- | --- |
| `planning` | `read`、`rg` 或 `grep`（同时存在时仅 `rg`）、`find`、`ls`、`lsp`、`questionnaire`、`ask`、`create_goal`、`get_goal`、`submit_plan`、`request_plan_choice` | 禁止工作区修改和任意 shell。 |
| `awaitingClarification` | 同一只读集合，但无提交或新选择；额外启用 `answer_plan_choice` | 等待明确选择或 cancel。 |
| `awaitingApproval` | 同一只读集合，但无 `submit_plan` 或选择工具 | 等待用户批准、refine 或 cancel。 |
| `executing` | 进入 Plan 前的有效工具集，加 `update_plan_step` | 按原工具能力执行。 |
| `off` | 不接管工具 | 无额外限制。 |

防护有两层：

1. `setActiveTools` 只向 agent 暴露当前 phase 允许的工具。
2. `tool_call` hook 再次检查 `isPlanToolAllowed`；即使其他扩展误把写工具重新启用，调用仍会被 block。

`PlanToolLease` 不是简单保存/覆盖数组：它在 Plan 活跃期间观察其他扩展新增或移除的工具，退出时合并这些外部变化，避免把并发的工具配置回滚。`rg` 与 `grep` 同时存在时只暴露 `rg`；只有一个搜索别名时保留现有名称。

注意：只读判定按工具名白名单执行。新增真正只读的工具不会自动获准；应先审查语义，再更新 `src/tool-policy.ts` 和测试。

## 审批与无界面模式

`submit_plan` 不在工具执行期间打开或等待审批 UI。它先原子地持久化 `awaitingApproval` 与 artifact，随后立即返回摘要、可用命令及 `terminate: true` 结束规划轮。Pi 的重试、压缩重试和 follow-up 全部结束并触发 `agent_settled` 后，TUI 才自动打开 Review，因此审阅时间不占用工具调用期限；同一提交只自动打开一次。

有 Markdown heading 时，宽度至少 72 列的 Review 会显示 Outline 和 Preview 分栏；窄屏保留完整 Preview 宽度，仅在 Outline 获取 focus 时切换为 heading 列表。没有 heading 时不会显示 Outline。Outline Enter 会跳到对应 Markdown 渲染行。Preview、Outline 与 Actions 用 Tab/Shift+Tab 切换焦点；焦点内的 `↑`/`↓`、Home/End、PgUp/PgDn 分别滚动、选择或跳转。`←`/`→` 切换 Actions，初始 Enter 执行，`c` 复制，Esc 或 Ctrl+C 保持等待。

Review 不维护私有 RGB 或 ANSI palette：普通正文、层级提示、focus、状态和 Markdown 元素分别使用 Pi 的 `text`/`muted`、`accent`、`success`/`warning`/`error` 与 `md*` 语义 token，因此会随当前全局 theme（包括仓库顶层 `themes/` 提供的全部 `pi-extensions-*` palette）一致切换；Plan 不导入、注册或选择任何 palette。

Copy 把未装饰的完整 `renderPlan(plan)` 写入系统剪贴板，并保持 Review 打开；它既不是 body-only artifact，也不包含 Outline marker。复制成功或失败状态直接显示在窗口内。选择 Stay 或按 Esc 只关闭窗口，不改变 `awaitingApproval`；`/plan review` 可随时重新打开。

所有模式使用相同的显式审批命令：

- `/plan approve`：批准并排队执行。
- `/plan refine`：回到只读 refinement。
- `/plan cancel`：取消并恢复工具。

这既是安全边界，也是可靠性边界：没有界面会隐式批准，用户审阅长计划也不会让 `submit_plan` 因等待输入而超时。`/plan status` 可随时重新显示已持久化的完整候选计划。

## 与 Goal 插件协作

Plan 通过版本化 `pi.events` channel 广播 phase、只读状态及是否即将触发下一轮：

- planning/awaiting approval 阻止 Goal 自动续跑和 `update_goal`。
- approve/refine 由 Plan 自己排队下一轮，Goal 不重复发送 continuation。
- cancel 结束 Plan read-only 门控；active Goal 按既有无 pending turn、runtime idle 条件恢复 continuation。
- 所有信号带 session ID；跨 session 的事件会被 Goal 忽略。

协议定义在 `src/protocol.ts` 与 `../goal/src/protocol.ts`。任何协议变化都必须同步两个包及 `test/coexistence.test.ts`。

## 配置与持久化

Plan 没有外部配置文件。状态完全来自命令、工具调用和 Pi session journal：

- journal entry 记录 start、clarify、answer、submit、approve、refine、step、cancel、complete。
- 恢复时严格校验 version、phase、步骤、时间戳及进入时工具集；无效 entry 不会部分恢复。`planPath` 是可选恢复元数据：foreign-OS 或 ENOENT 路径不使整个 state 解码失败。
- 有 session 文件时，artifact 位于 session JSONL 相邻的 `.plan-artifacts/<sessionId>/`；无 session 时位于 OS 临时目录，并在 `session_shutdown` 清理。每份文件使用私有权限、UTF-8 与终止换行，内容只等于规范化后的 `state.plan` body。
- `details.planPath` 与对应 `plan-state-v1.data.state.planPath` 是第三方发现 artifact 的稳定接口。journal 是权威状态：写成但尚未 append journal 的孤立文件不会被恢复；后续 UI 或 Goal 刷新失败不会回滚已提交 artifact。
- context hook 只保留与当前 Plan `updatedAt` 对应的最新显式 phase-transition 隐藏控制消息，避免旧分支消息重复执行；初次 `/plan` 不创建控制消息。
- Plan 输出按 Pi 通用行数/字节限制截断，但完整计划仍保存在 journal state 中。

## 实现原理与关键节点

- `src/index.ts`：扩展入口和状态机编排；工具 lease、journal、UI、生命周期 hooks、显式 phase-transition 控制轮及 Goal 事件均在此汇合。
- `src/state.ts`：纯状态转换、步骤 ID/状态、批准/refine/恢复校验。
- `src/command.ts`：`/plan` 用户控制面和 abort-before-transition 顺序。
- `src/review.ts`：`/plan review` 的可滚动 Markdown 审批窗口、响应式 Outline、焦点和复制行为。
- `src/clarification.ts`：当前轮 settled 后显示的 Plan 选择窗口。
- `src/artifacts.ts`：private、原子、不可变的 body-only artifact writer 与临时目录清理。
- `src/outline.ts`：Markdown heading 解析、渲染跳转 marker 与 marker 清理。
- `src/tools.ts`、`src/tool-schema.ts`：提交、选择与步骤更新契约。
- `src/tool-policy.ts`：只读白名单、phase 判定及 RG 优先顺序。
- `src/tool-lease.ts`：与其他扩展共存时的工具集合并算法。
- `src/prompts.ts`：各 phase 注入的强制约束。
- `src/protocol.ts`：Goal/Plan 版本化协调协议。
- `src/output.ts`：footer 状态文本、步骤 widget、有界输出和 details。
- `test/coexistence.test.ts`：Goal/Plan 端到端交互；`test/harness.ts` 提供 in-process Pi test double。

## 开发与验证

```bash
cd /path/to/pi-extensions/plan
npm run check
npm test
```

改变协议或 Goal 协作时，同时在 `goal/` 运行 `npm run check && npm test`。
