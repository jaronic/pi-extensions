# Todo Extension 设计

> 文档状态：当前实现合同，更新于 2026-08-02。实现位于 `todo/`，运行基线为 Node.js `>=22.19.0` 与 `@earendil-works/pi-coding-agent >=0.82.1`。

## 1. 结论

Todo 是 branch-local 的短期执行账本。它提供：

- 有序 phase 与稳定数字 task ID；
- 全 board 最多一个 `inProgress` task；
- 明确的 `pending`、`inProgress`、`blocked`、`completed`、`dropped` 状态；
- tool、用户命令和 extension service 共用的一套 reducer、校验、持久化与 UI；
- reload、compaction 与 session-tree navigation 后的严格恢复；
- Plan 批准时把步骤一次性转交普通 Todo board。

Plan handoff 不创建第二套进度协议。批准成功后 Plan 立即关闭；后续只通过普通 `todo` 工具、数字 `#ID` 和普通 Todo widget 更新状态。

Todo 不是审批系统、Goal 终态判断器、团队 backlog 或跨 session issue tracker。

## 2. 产品边界

### 2.1 适用场景

- 用户明确要求 Todo 跟踪；
- 用户给出至少三个可执行事项；
- 调查后形成多个独立、可验证的实现步骤；
- 工作需要跨 turn、compaction、reload 或 branch navigation 保持精确进度；
- Plan 已获批准，需要把顶层实施步骤转入执行账本。

仅包含需求、示例、问题、选项或假设的列表不应触发看板。单步修改与纯问答也不需要 Todo。

### 2.2 非目标

- Plan 审批、refinement 或 artifact 管理；
- Goal 自动 continuation 或完成审计；
- 依赖图、父子树、优先级、负责人、截止时间；
- 根据文件修改、命令退出码或测试文本自动推断完成；
- 模型清空或物理删除历史任务；
- 外部文件、SQLite 或远端服务作为第二事实源；
- 为 Plan 维护 managed owner、execution ID 或独立 step ledger。

## 3. 架构

```mermaid
flowchart TD
    Agent[Agent todo tool] --> Engine[executeTodoOperation]
    User[/todos commands] --> Engine
    Consumer[TodoService caller] --> Engine
    Compat[Todo service v1 channel] --> Engine
    Plan[Plan approval] --> Handoff[handoffPlan]

    Engine --> Reducer[transitionTodo]
    Handoff --> Adapter[transitionPlanHandoff]
    Adapter --> Reducer

    Reducer --> Commit[validated snapshot commit]
    Commit --> Journal[tool details or todo-state-v2]
    Journal --> State[TodoSnapshot closure]
    State --> Prompt[bounded system prompt]
    State --> Widget[semantic Todo widget]

    Branch[session_start/session_tree] --> Replay[restoreTodoSnapshot]
    Replay --> State

    Plan --> PhaseSync[syncPlanPhase]
    PhaseSync --> Gate[Plan mutation/UI gate]
    Gate --> Engine
```

核心不变量：

1. tool、command、service 与 Plan handoff 最终都复用普通 Todo transition；
2. branch 中只有一条单调 `sequence`；
3. 内存 state、model output、prompt 与 widget 都是同一 `TodoSnapshot` 的投影；
4. Plan 候选期只冻结普通 board，不复制或改写它；
5. Plan 批准后只留下普通 Todo state，Plan 不再拥有执行进度。

## 4. 数据模型

```ts
type TodoStatus =
  | "pending"
  | "inProgress"
  | "blocked"
  | "completed"
  | "dropped";

interface TodoTask {
  id: number;
  content: string;
  status: TodoStatus;
  createdAt: number;
  updatedAt: number;
  reason?: string;
  note?: string;
}

interface TodoPhase {
  name: string;
  tasks: TodoTask[];
}

interface TodoState {
  version: 1;
  boardId: string;
  revision: number;
  phases: TodoPhase[];
  createdAt: number;
  updatedAt: number;
  nextTaskId: number;
}

interface TodoSnapshot {
  sequence: number;
  state: TodoState | null;
}
```

`boardId` 隔离看板代际；`nextTaskId` 让 task ID 在一个 board 内稳定单调；`revision` 描述 board 内 mutation；`sequence` 跨 tool details 与 custom entry 统一排序。

Task 文本不是 ID。Rename、同名任务和模型措辞变化不能改变寻址方式。

## 5. 状态机

### 5.1 Board 状态

- `empty`：`state === null`；
- `active`：至少一个 `inProgress` 或 `pending`；
- `blocked`：没有 runnable task，但仍有 `blocked`；
- `settled`：所有 task 都是 `completed` 或 `dropped`。

只要存在 `pending`，状态机就保证恰有一个 `inProgress`。`done`、`block`、`drop` 与 `reopen` 会按 phase/task 顺序自动推进。

### 5.2 Task transition

```text
pending -> inProgress     start 或自动推进
inProgress -> completed  done
inProgress -> blocked    block
pending/inProgress -> dropped  drop
blocked/completed/dropped -> pending 或 inProgress  reopen
```

只有当前 `inProgress` task 可以 `done` 或 `block`。`start` 可以把另一个 pending task 设为 active，并把原 active task退回 pending。

`blocked` 只用于当前执行无法解决的具体外部前提，例如用户决定、权限或凭据。部分实现、测试失败或待修复错误仍属于 `inProgress`。

## 6. 模型工具

一个全局 `todo` 工具通过 `op` 区分操作：

| op | 输入 | 结果 |
| --- | --- | --- |
| `init` | `list: [{ phase, items[] }]` | 创建完整 board，启动第一项 |
| `append` | `phase`, `items[]` | 原子追加到现有或新 phase |
| `start` | `id` | 切换 active task |
| `done` | `id`, optional `note` | 完成当前 task并自动推进 |
| `block` | `id`, `reason` | 阻塞当前 task并自动推进 |
| `drop` | `id`, `reason` | 保留 tombstone并退出范围 |
| `reopen` | `id`, `reason` | 恢复关闭或阻塞 task |
| `edit` | `id`, `content` | 修改 open task 文本，ID 不变 |
| `get` | `id` | 读取一个精确 task |
| `view` | optional filters/pagination | 分页读取 board |

模型没有 `clear`。物理清空只存在于需要用户确认的 `/todos clear`。

Strict-schema provider 可能补齐所有声明字段，因此 optional 字段接受显式 `null`。Runtime 只读取当前 op 对应字段，但当前 op 的必填字段、类型、范围和状态迁移始终严格校验。

## 7. 原子提交与持久化

Todo 不写工作区状态文件。权威状态来自当前 Pi session branch：

- 成功 `todo` tool result 的 `details.kind === "pi-extensions:todo-tool-details"`，details version 为 v1；
- command 与 direct/compatibility service mutation 写 `todo-state-v2` custom entry；
- legacy `todo-state-v1` command entry只读迁移；
- 所有 carrier 共享单调 `sequence` 与完整 bounded snapshot。

Mutation 顺序：

1. 严格解码并规范化输入；
2. 从当前 frozen state 计算完整 transition；
3. 校验 state 和 envelope 上限；
4. 在 commit boundary 前检查 `AbortSignal`；
5. tool 由成功 result details 提交，command/service 先 append custom entry；
6. 更新 closure state 与 UI；
7. 返回 bounded content/details。

校验、取消、journal append 或上限失败都不会增加 sequence/revision、消耗 ID 或留下部分 state。

`/todos clear` 在确认前捕获当前 snapshot，确认后提交前与最新 snapshot 做 CAS（sequence 与 state 全等比较）；确认期间 board 发生任何变化（tool/service mutation、Plan handoff 或 branch restore，包括初始化新 board）都拒绝清空并提示重新确认，避免用户确认的投影与实际被清空的 board 不一致。

### 7.1 Restore

`session_start` 与 `session_tree` 顺序扫描当前 branch：

- 只接受成功且严格解码的 Todo carrier；
- 选择最高有效 sequence；
- 同 sequence 不同 state 视为冲突并警告；
- malformed 记录不部分载入；
- `todo-state-v3+` 或未来 tool-details version 建立 fail-closed barrier，隐藏 prompt/widget 并冻结读写；
- branch 改变后重新计算，允许切换到没有 future entry 的 branch 恢复。

Compaction 不删除 branch journal，因此无需依赖摘要记住任务。

## 8. UI、prompt 与输出

Todo 使用 host `Theme` semantic tokens，不持有 ANSI、RGB、hex 或私有 palette。

Widget 使用 `todo` key，最多 12 行：

```text
Todo · <phase> · 0/3 completed · 0 blocked · 0 dropped
→ #1 Current task
○ #2 Next task
! #3 Blocked task
```

排序为 active → runnable pending → blocked。默认不重复列 completed/dropped 文本；计数始终保留。唯一例外是结算时刻：使看板 settled 的那次 `done`/`drop` 结果附带一段有界 `Settled recap:`（最多 20 任务 / 4 KiB）列出全部 closed 任务供模型向用户总结；看板 settled 后 widget/status 立即清理。

`before_agent_start` 只在 board active/blocked 且 Plan gate 关闭时注入 `<untrusted_todo_state>`。投影最多包含 20 个 open task，active task 优先；所有 task/phase/reason 文本 XML escape并明确视为不可信数据。XML 实体扩张可能把合法文本放大数倍，因此转义后的最终 UTF-8 输出另受 32 KiB 上限约束：达到上限时在任务边界停止追加，并保留 `... N more open tasks; call todo view` 提示。

Tool `content`、expanded renderer 和分页输出独立有界。`view` 返回 `nextOffset`；分页期间 revision 改变时调用方应从 offset 0 重读。

## 9. Todo service

`installTodo(pi)` 返回进程内 typed `TodoService`：

```ts
interface TodoService {
  readonly lifetime: AbortSignal;
  execute(request: TodoServiceRequest): TodoServiceResult;
  handoffPlan(request: TodoPlanHandoffRequest): TodoServiceResult;
  syncPlanPhase(input: TodoPlanPhaseSync): void;
}
```

`execute` 支持除 `clear` 外的全部普通 op。它和模型工具复用 `executeTodoOperation()`，因此不能绕过 session、Plan gate、validation、AbortSignal 或 persistence。

未声明 Todo package dependency 的独立 extension 可通过 `pi-extensions:todo-service:v1` compatibility channel 调用同一 `execute`。Channel 使用 `accept()` 保证单接收者；session shutdown 后 listener 与旧 service 引用 fail closed。

`installTodo()` 通过 EventBus-scoped registry 幂等安装。Plan package加载 Todo resource，同时直接调用 installer；无论 Plan/Todo 加载顺序如何，tool、command、listener 和 runtime 都只注册一次。

## 10. Plan handoff

### 10.1 候选期 gate

Plan 调用：

```ts
todo.syncPlanPhase({ sessionId, phase });
```

允许 phase：`off`、`planning`、`awaitingClarification`、`awaitingApproval`、`blocked`。

非 `off` 时：

- Todo mutation tool、command 和 service request fail closed；
- ordinary prompt/widget 隐藏；
- `get/view` 仍可读取冻结 board；
- Todo state、sequence、active pointer 和 widget preference 都不改变。

Plan 同时通过自己的 tool lease 隐藏模型可见的 mutation tool。Runtime gate 是第二层保护，防止 direct service 或其他扩展绕过 lease。

### 10.2 批准提交

`/plan approve` 只在 Todo 已同步为 `awaitingApproval` 时调用：

```ts
todo.handoffPlan({
  sessionId,
  phase: planHandoffPhaseName(summary), // Plan summary 派生的概要，为空时回退 "Plan"
  items: approvedSteps,
  signal,
});
```

`transitionPlanHandoff` 复用普通 transition：

- `state === null` 或 board settled：执行普通 `init`，创建新 board并启动第一项；
- board open/blocked：执行普通 `append`，保留现有 active pointer；
- 派生的 phase 名已存在：追加 ` (2)`、` (3)` 等不冲突后缀；
- 总 phase/task 数、重复内容、字符串与 envelope 上限仍由普通 reducer拒绝。

成功提交使用 `source: "service"` 与实际 `operation: "init" | "append"` 的 `todo-state-v2` entry。它没有特殊 task 类型、隐藏 owner 或额外 revision 空间。

### 10.3 生命周期边界

- handoff 失败：Todo 不变，Plan 保持 `awaitingApproval`，不排队执行；
- handoff 成功：Plan 写 terminal journal、同步 Todo phase `off`、清除 Plan UI、恢复原工具并排队执行；
- handoff 返回内容与 Plan 排队的执行消息都明确 board 已初始化、禁止重新 `init` 或重复 `append` 转交步骤；agent 只通过普通 Todo `#ID` 更新任务；
- Todo settled 不向 Plan发送完成事件；
- reload/branch replay只恢复普通 Todo snapshot；
- 取消未批准 Plan 不创建或修改 Todo task。

这实现的是一次 clean handoff，不是双写同步。

## 11. 与 Goal、Request、RG、LSP 协作

### Goal

Goal 与 Todo 状态正交。Goal objective/continuation 与 Todo task prompt 可以同时存在；Todo settled 不自动完成 Goal，Goal complete 也不清空 Todo。Plan 与 active Goal 的互斥由 Plan/Goal 自己的 workflow query 协议负责，不改变 Todo handoff契约。

### Request

`/todos clear` 使用标准 `ctx.ui.confirm()`。加载 Request 时共享 adapter提供统一 UI；未加载时保留 Pi 原生确认。Todo 不 import Request。

### RG 与 LSP

Todo 不接管 active tools，不监听 RG/LSP，也不从搜索、diagnostics 或 refactor preview 推断 task 完成。Plan 候选期由 Plan lease 决定这些工具是否可见；批准后 Plan 已关闭，Todo 与恢复后的工具独立运行。

## 12. 硬上限

| 项目 | 上限 |
| --- | ---: |
| phase 数 | 20 |
| board task 总数 | 100 |
| 单次 append | 50 |
| phase 名 | 80 字符 |
| task 文本 | 240 字符 |
| reason/note | 500 字符 |
| 持久 state | 60 KiB UTF-8 |
| details/custom envelope | 64 KiB UTF-8 |
| 单次模型输出 | 16 KiB、200 行 |
| prompt open task | 20 |
| prompt 字节上限 | 32 KiB（XML 转义后最终 UTF-8） |
| widget | 12 行 |

所有显示文本拒绝换行、terminal control 与 bidirectional formatting code point。字符上限（phase 名、task 文本、reason/note）按 Unicode code point 计数（`Array.from(...).length`），与 Plan 的 `validatePlanText` 口径一致。

## 13. 实现节点

```text
todo/
├── src/
│   ├── index.ts        # composition root、snapshot、lifecycle、service、handoff、UI
│   ├── state.ts        # immutable model、ordinary transitions、Plan handoff adapter
│   ├── tool-schema.ts  # TypeBox public schema
│   ├── tools.ts        # shared operation executor 与 model tool
│   ├── service.ts      # direct service、Plan handoff、compatibility channel
│   ├── persistence.ts  # tool details、v1/v2 journal replay、future barrier
│   ├── command.ts      # /todos control surface
│   ├── prompts.ts      # static guidance 与 bounded escaped projection
│   ├── output.ts       # counts、pagination、tool text、widget
│   └── protocol.ts     # strict Plan phase sync
└── test/
    ├── state.test.ts
    ├── persistence.test.ts
    ├── prompts.test.ts
    ├── output.test.ts
    ├── integration.test.ts
    └── coexistence.test.ts
```

`src/index.ts` 只编排 runtime 与 commit boundary；普通领域规则留在 `state.ts`。Plan handoff adapter 只选择 `init` 或 `append` 及唯一 phase 名，不复制 reducer。

## 14. 验收合同

实现或修改 Todo/Plan handoff 时至少证明：

- 普通 init/append/start/done/block/drop/reopen/edit/get/view 契约不回归；
- Plan 活跃 phase 冻结 Todo mutation并隐藏 prompt/widget；
- Plan approve 对空/settled board 执行 init，对 open board 执行 append；
- open board 的原 active task不被抢占；
- UI 只显示普通 Todo `#N` 样式，Plan UI 与步骤工具已消失；
- handoff 失败原子保持 Plan awaiting approval 与 Todo unchanged；
- handoff 后 reload 只从普通 Todo journal恢复；
- cancel before approval 不创建 Todo task；
- Plan/Goal active workflow 不能重叠；
- Goal 与 Todo 不互相伪造完成；
- package typecheck 与完整 Node test suites 通过。

开发命令：

```bash
cd todo
npm run check
npm test
```

Plan/Goal 协作改变时还必须在 `plan/`、`goal/` 运行对应 check/test。
