# Todo 插件

`todo` 为 Pi 增加一张按 session branch 持久化的短期执行看板：它把多步骤工作拆成有序 phase 和稳定数字 ID 的任务，只允许一个当前活动项，并在完成、阻塞、放弃或重新打开时留下结构化状态。模型通过全局 `todo` 工具使用普通看板；明确声明 Todo package 依赖的 extension 通过 typed `installTodo(pi)` service 操作同一 runtime，独立 extension 仍可使用版本化兼容 channel。Plan 的 managed ledger 与普通 board 是两个独立状态域。

普通 Todo 是执行账本，不是 Plan 审批、Goal 终态判断或项目级 issue tracker；managed ledger 也不把 Plan steps 复制进普通 board。

> 维护约束：凡是改变 Todo 的行为、工具 schema、命令、状态机、持久化协议、输出上限、与 Plan/Goal/Request/RG/LSP 的协作或安装方式，都必须在同一改动中同步本 README 和 [`../docs/design/08-todo-extension-design.md`](../docs/design/08-todo-extension-design.md)。

## 适用场景与效果

Todo 适合以下工作：

- 已经过调查确认范围，并能列出三个以上彼此独立、可验证的执行步骤；
- 用户明确要求 Todo 跟踪，或明确给出至少三个需要完成的执行事项；
- 执行中需要跨 turn、compaction、reload 或 branch navigation 保留精确进度；
- 用户希望在 TUI 中持续看到当前项、剩余项和 blocker。

仅包含需求、示例、问题、选项或假设的列表不应触发看板；先调查或澄清，确定进入执行后再创建。单步修改和纯问答不应创建看板。Todo 也不替代团队 backlog、长期项目管理或跨 session 同步。

启用后：

- agent 获得一个顺序执行、带显式全局使用说明的 `todo` 工具；只要没有更严格的 active-tool lease 隐藏它，模型会从工具 schema、description、`promptSnippet` 和 `promptGuidelines` 感知其能力；
- 当前 Pi 进程中的其他扩展可通过 `pi-extensions:todo-service:v1` 读写同一普通 board；声明 Todo package 依赖的 extension 则直接持有同一 `TodoService`。两条入口复用模型工具的 reducer、校验、输出、Plan gate 和 branch persistence；
- TUI 使用独立的 `todo` footer/status 和最多 12 行的 widget；Plan 通过 direct service 管理进度时，同一个 UI key 临时投影 managed Plan progress，普通 board 保持冻结且不被覆盖；
- 普通 open task 或 managed Plan progress 的有界摘要会注入每轮 system prompt，所有文本按不可信数据处理；
- 普通 board 的成功工具结果、用户命令和 service mutation 与 managed Plan ledger 分别写入 Pi session journal，切换 branch 时恢复各自最新有效快照；
- 普通 settled 看板保留 footer，完成时的 widget 显示到下一轮开始；Plan terminal `off` 立即恢复普通投影，随后 managed `close` 成功时清除 ledger。

## 安装与启用

要求：Node.js `>=22.19.0`、npm，以及兼容 `@earendil-works/pi-coding-agent >=0.81.0` 的 Pi。

从仓库根目录启用全部扩展（包含 Todo）：

```bash
make pi-extensions-on
make pi-extensions-status
```

也可只安装 Todo：

```bash
cd /path/to/pi-extensions/todo
npm ci
mkdir -p "$HOME/.pi/agent/extensions"
ln -sfn "$PWD" "$HOME/.pi/agent/extensions/todo"
```

软链接必须指向 `todo/` package 根目录。Pi 根据 `package.json` 的 `pi.extensions` 加载 `./src/index.ts`；安装或修改后重启 Pi，或执行 `/reload`。

开发时可绕过全局链接：

```bash
pi --no-session --extension ./src/index.ts
```

`todo` 使用 Pi 的全局工具名 `todo`。这里的“全局”仅指同一 Pi 进程中的工具 namespace 与 event bus，不跨 Pi 实例、进程、workspace 或 session。不要同时加载另一个注册同名工具或提供同一 service channel 的 Todo extension；本扩展不会猜测或迁移其他实现留下的同名、无版本 tool details。

## Agent 工具与模型感知

插件注册一个 `todo` 工具，以 `op` 区分操作：

`pi.registerTool()` 使当前 active tool schema、description、`promptSnippet` 和 `promptGuidelines` 进入模型边界；Todo 不额外调用 `setActiveTools()`，因此不会覆盖其他扩展的工具集合。Plan 等显式 lease 仍可按自身安全阶段暂时隐藏 `todo`：Plan 的只读 planning/approval 阶段不暴露 mutation-capable Todo，执行期由 `update_plan_step` 更新唯一 managed owner。退出 lease 后由所有者恢复原工具集。

普通 Todo 只应在工作已进入执行、用户明确要求追踪，或用户明确给出至少三个执行事项时初始化；列表本身不是充分条件。对需求、示例、问题、选项或假设先调查或澄清，确认可执行范围后再建板。

| `op` | 必填字段 | 行为 |
| --- | --- | --- |
| `init` | `list: [{ phase, items[] }]` | 创建完整有序看板；自动把第一项设为 `inProgress`。仅在无看板或当前看板已 settled 时允许。 |
| `append` | `phase`, `items[]` | 向现有或新 phase 原子追加任务；不允许覆盖或替换 open 看板。 |
| `start` | `id` | 启动一个 `pending` 项；原活动项退回 `pending`。 |
| `done` | `id`，可选 `note` | 仅完成当前 `inProgress` 项；`note` 可记录简短验证证据。 |
| `block` | `id`, `reason` | 阻塞当前活动项并自动推进；只用于具体外部依赖、用户决定或权限缺失。 |
| `drop` | `id`, `reason` | 把仍在范围中的项标为 `dropped`，保留 tombstone 和原因。 |
| `reopen` | `id`, `reason` | 重新打开 `blocked`、`completed` 或 `dropped` 项，并按需自动推进。 |
| `edit` | `id`, `content` | 修改未关闭任务的文本；稳定 ID 不变。 |
| `get` | `id` | 读取当前 board 中一项任务及 phase、状态和时间戳。 |
| `view` | 可选 `phase`, `includeClosed`, `offset`, `limit` | 分页读取看板；默认只返回 open task，默认 20、最多 50 项。 |

初始化示例：

```json
{
  "op": "init",
  "list": [
    {
      "phase": "Implementation",
      "items": [
        "Add state transition",
        "Wire the extension lifecycle"
      ]
    },
    {
      "phase": "Verification",
      "items": [
        "Run the package checks"
      ]
    }
  ]
}
```

任务 ID 在一个 board 内单调递增；创建新 board 时从 `#1` 重新开始，并由新的 `boardId` 隔离旧代。所有 mutation 从当前 runtime snapshot 计算，模型不能提交 sequence、revision 或整表状态。

OpenAI 等 strict-schema provider 会补齐扁平 schema 的全部字段，因此每个 optional property 同时接受显式 `null`：当前 `op` 不使用的字段必须为 `null`；`view` 的 `phase/includeClosed/offset/limit` 为 `null` 时采用“全部 phase / false / 0 / 默认 20”。Runtime 仍忽略属于其他 op 的非 null 已声明 filler，以兼容旧 provider；但当前 op 的必填字段不能为 null，实际读取字段的类型、范围和领域迁移仍严格校验。TypeBox 继续拒绝 schema 外字段，忽略值不会进入状态、输出或错误信息。

### 状态规则

| 状态 | 含义 |
| --- | --- |
| `pending` | 尚未开始，可被显式选择或自动推进。 |
| `inProgress` | 当前主 agent 正在处理；全 board 最多一个。 |
| `blocked` | 仍在范围内，但缺少当前执行无法解决的具体前提。 |
| `completed` | 该项交付及对应验证已完成。 |
| `dropped` | 已明确退出范围，原因仍保留。 |

只要存在 `pending`，状态机就保证恰有一个 `inProgress`。`done`、`block`、`drop` 和 `reopen` 会按 phase/task 顺序自动推进下一项。非法迁移、重复项、越界输入、取消和输出超限都会原子失败，不增加 revision/sequence，也不消耗 ID。

Todo 不根据文件修改、命令退出码或测试文本自动推断完成。Runtime 只能强制“当前项才可完成”；业务证据仍由 agent 判断，Goal 仍做独立的 objective completion audit。

## `/todos` 用户命令

```text
/todos
/todos status
/todos show
/todos hide
/todos toggle
/todos clear
/todos reopen <id> <reason>
```

| 命令 | 行为 |
| --- | --- |
| `/todos`、`/todos status` | TUI 打开可滚动看板；dialog-capable RPC 发送完整只读通知。 |
| `/todos show` | 显示常驻 widget。 |
| `/todos hide` | 隐藏常驻 widget，不改变持久状态。 |
| `/todos toggle` | 切换 widget 可见性。 |
| `/todos clear` | 先中止并等待当前 agent idle，再请求用户确认；确认后清空当前投影，session 历史仍保留。 |
| `/todos reopen <id> <reason>` | 中止并等待当前 agent idle，把关闭或阻塞项重新打开，并写入 command journal entry。 |

`status/show/hide/toggle/clear` 的 UI 路径仅在 TUI 或具备 dialog UI 的 RPC 中可用。Print/JSON 模式继续支持完整 `todo` 工具；查看状态应调用 `todo view`，需要确认的 clear 会 fail closed。模型工具没有 `clear` op，不能物理清除用户范围。

## 持久化与恢复

Todo 不写 `TODO.md`、SQLite 或其他工作区文件。权威状态来自当前 Pi session branch：

- agent mutation 和只读 checkpoint 使用 `isError === false` 的成功 `toolResult.details`，discriminant 为 `pi-extensions:todo-tool-details`，details 版本仍为 v1；
- `/todos clear|reopen` 与 Todo service mutation 使用 custom entry `todo-state-v2`；v2 明确记录 `source: "command" | "service"` 和实际 `operation`；
- 旧 `todo-state-v1` command entry 只读迁移，新的 custom mutation 只写 v2，不改写历史、不双写；
- tool details、v1/v2 custom entry 共享 branch 单调 `sequence`，并携带完整、有界、不可变快照；
- `session_start` 与 `session_tree` 严格解码当前 branch，较旧 sequence 不覆盖较新状态，相同 sequence 的冲突状态会被拒绝；
- malformed v1/v2 entry 被跳过并最多警告一次；`todo-state-v3+` 或未来 tool-details 版本会建立 restore barrier，隐藏 prompt/widget 并冻结读写，防止旧代码覆盖新格式；
- compaction 不依赖摘要记住任务；下一轮从结构化状态重新注入 open working set；
- Plan provider 的 mutable status 使用独立 custom entry `todo-managed-progress-v1`；它以 `sessionId + executionId` 隔离一次批准执行，带单调 revision 和最后 request ID，支持同一 `update_plan_step` 调用的幂等重放；
- managed ledger 严格校验完整 Plan step 集、唯一 ID、最多一个 `inProgress`、时间与 64 KiB envelope；malformed record 不会部分载入或写入普通 board。

Task 文本、phase、reason 和 note 会随本地 Pi session 持久化。不要把密码、token 或其他 secret 写入 Todo。

## TUI、输出与硬上限

UI 只投影已验证状态，并只使用 Pi `Theme` 的 semantic tokens；它不注册或选择私有 palette。Todo 始终只使用自己的 `todo` status/widget key，不覆盖 Plan、Goal 或其他扩展的 key。

普通模式的 widget heading 显示当前（或下一可见）phase，任务按“当前项 → runnable pending → blocked”排列。Plan 未批准时不投影候选步骤看板；Todo 也尚未建立 managed ledger。Todo 被选为 Plan 执行期 provider 后，`todo` key 改投影 managed steps，Plan 不显示自己的步骤 widget；managed footer/widget 也使用普通 Todo 一致的 `#1`、`#2` 顺序号，Plan wire ID 仅供 `update_plan_step` 和执行 prompt 使用。普通 board 仍在 branch 中冻结保存。两种 Todo widget 都通过 host component factory 按实际 `render(width)` 截断。Expanded tool result 会列出普通 board 本次变更涉及的 phase；字节截页会显示请求大小、输出上限和精确续读 offset。

主要硬上限：

| 项目 | 上限 |
| --- | ---: |
| phase 数 | 20 |
| 每个 board 的任务总数 | 100 |
| 单次 append | 50 |
| phase 名 | 80 字符 |
| task 文本 | 240 字符 |
| reason/note | 500 字符 |
| 持久 state | 60 KiB UTF-8 |
| details/custom envelope | 64 KiB UTF-8 |
| 单次模型输出 | 16 KiB、200 行 |
| prompt 中 open task | 20 |
| widget | 12 行 |
| managed Plan steps | 50 |
| managed step 文本 | 500 字符 |
| managed prompt open steps | 20 |
| managed custom envelope | 64 KiB UTF-8 |

所有显示文本拒绝换行、terminal control 和 bidirectional formatting code point。`view` 同时受 offset/limit 和模型输出上限约束；结果给出 `nextOffset`，若 board/revision 在分页中改变，应从 offset 0 重新读取。

## 与其他扩展协作

### 通用 Todo service

`src/index.ts` 导出 `installTodo()`、`TodoService`、`TODO_SERVICE_CHANNEL`、`requestTodoService()` 及其 TypeScript request/operation/result 类型。明确声明 package dependency 的调用方直接安装并使用 service：

```ts
import { installTodo } from "pi-todo-dev";

const todo = installTodo(pi);
const result = todo.execute({
  sessionId: ctx.sessionManager.getSessionId(),
  operation: {
    op: "append",
    phase: "Verification",
    items: ["Run the consumer integration check"],
  },
  signal,
});
```

Service 支持 `init/append/start/done/block/drop/reopen/edit/get/view`，故意不暴露用户确认专属的 `clear`。返回 `{ content, details }`；`details` 与成功 `todo` tool result 使用同一严格解码的 `TodoToolDetails`。Mutation 在返回前同步完成 append `todo-state-v2`、内存/UI commit 和 result settlement：append 失败、提交前取消、非法输入、session 不匹配、extension 未 ready 或 active Plan gate 都拒绝且不改变状态；提交完成后发生的取消不会把已持久化成功误报成失败。`get/view` 不写 journal。

`pi-extensions:todo-service:v1` 保留给未声明 Todo package dependency 的独立 extension。它采用单接收者 `accept()` 仲裁并委托同一 direct board method；session shutdown 注销 listener，失效 service 引用 fail closed。

### Plan

Plan 是 Todo 的声明依赖：Plan package 先加载 Request、Todo extension resource，再加载自身入口；三个包又被单独加载时，`installTodo()` 的 EventBus-scoped runtime registry 保证 tool、command、listener 和 journal runtime 仍只注册一次。

- Plan 在每次 phase transition 直接调用 `todo.syncPlanPhase({ sessionId, phase })`；Todo 不再监听或解码 `pi-extensions:plan-state:v1`。该 broadcast 仍供可选 Goal 消费。
- `/plan approve` 始终直接调用 `todo.progress.open`，并在得到完整有效 snapshot 后才持久化 `providerId: "todo"` 与 execution ID。open/read/update 失败显式失败，不创建 local fallback，也不切换 owner。
- `open` 原子写入完整 approved step definitions 和全 pending snapshot；`update` 以 Plan 传入的 tool-call request ID 幂等提交 status，保证最多一个 `inProgress`；`read` 返回有 revision 的完整 snapshot；`close` 清除 ledger。
- Agent 始终调用 `update_plan_step`。普通 `todo` mutation 仍被冻结，且不能寻址 managed step；这是一份单向 ownership transfer，不是 Plan state 与普通 Todo board 的双写同步。
- planning/clarification/approval/blocked 阶段隐藏普通 Todo prompt/widget。执行期 `todo` key 仅显示 managed widget，并注入唯一的 `<untrusted_execution_progress>`；Plan 与 Todo 都不写入底部状态栏。
- Plan complete/cancel 先持久化 v3 terminal tombstone、恢复工具并直接同步 `off`，再 best-effort `close` managed ledger。Todo 立即恢复原 branch board 和 widget 偏好；close 成功会 append null，失败时残留 ledger 不投影且下一次 approval 可原子替换。

普通 board 与 managed ledger 分别持久化和恢复；两者只共享 Todo 的 UI key，生命周期与 ID 空间不相交。

### Goal

Goal 定义完整 objective 及自动 continuation，Todo 记录当前拆出的执行项。两者的 system prompt 通过 hook 组合，不互相覆盖。Todo settled 不自动完成 Goal，Goal complete 也不清空 Todo；open/blocked Todo 是 Goal 完成审计应关注的不一致，但不是自动状态转换。

### Request

`/todos clear` 使用标准 `ctx.ui.confirm()`。加载 Request 时，它会通过共享 adapter 渲染统一确认界面；未加载时沿用 Pi 原生确认语义。Todo 不 import Request，也不要求 Request 必装。

### RG 与 LSP

RG 和 LSP 是独立工作工具，不监听 Todo channel，也不调用 Todo service。Todo 不设置全局 active tools，不接管搜索或 language-server 生命周期，也不会根据搜索命中、diagnostics 或 refactor preview 自动推断 task 完成；agent 必须在获得可核验结果后显式调用 `todo done`。Plan 活跃时由 Plan tool lease 决定 RG/LSP 的可见性，managed progress 仍只通过 `update_plan_step` 更新。

## 配置与实现节点

Todo 没有外部配置文件，也不启动 timer、process、watcher 或网络资源。

- `src/index.ts`：composition root、普通 branch snapshot、managed Plan snapshot、lifecycle hooks、service/Plan listener、provider 和 UI 投影。
- `src/state.ts`：普通 board 的 immutable 类型、纯 transition、normalizer 和 strict decoder。
- `src/tools.ts`、`src/tool-schema.ts`：`todo` schema、模型可见 metadata、共享 operation executor、runtime validation 和工具注册。
- `src/service.ts`：全局 Todo service v1 request/response channel、单接收者仲裁、取消与结果解码。
- `src/persistence.ts`：普通 board 的 v1 tool details、v1→v2 custom entry 恢复、bounded envelope 和 active-branch replay。
- `src/progress-provider.ts`：Plan progress wire contract、Todo provider、managed journal replay、prompt/footer/widget。
- `src/prompts.ts`：普通 board 的静态使用规则及 XML-escaped、有界动态摘要。
- `src/output.ts`：普通 board counts、分页、模型文本、footer/widget 和 semantic render data。
- `src/protocol.ts`：独立的 Plan v1 phase coordination contract。

## 开发与验证

```bash
cd /path/to/pi-extensions/todo
npm run check
npm test
```

`npm run check` 执行严格 TypeScript `noEmit` 检查；`npm test` 使用 Node `node:test` + `tsx`，覆盖状态机、v1/v2 持久化、prompt、输出、真实 extension harness、全局 service 的共享状态/恢复/失败原子性，以及 Plan/Goal/Request 两种加载顺序和 headless/TUI 语义。

真实 Pi 的隔离 lifecycle smoke 可从仓库根目录执行：

```bash
pi --no-session -p --mode json --thinking off \
  --no-extensions --no-context-files --no-skills --no-prompt-templates \
  --extension "$PWD/todo" --tools read,todo \
  "Create three Todo items, complete each with current evidence, and report only after the board is settled."
```

验收时应检查 JSON 事件中的 `todo` tool results、递增 sequence、最终 settled counts 和零 error tool result，不能只检查最后一条自然语言文本。OpenAI strict-schema 场景还应确认未使用字段实际为 `null`，最终 `view.phase === null` 能读取完整 board。
