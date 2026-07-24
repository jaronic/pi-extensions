# 02 · 运行时分层与 Agent Loop：循环很小，边界很厚

> 本篇回答：Pi 的四个主要 package 怎样分工；一次请求怎样穿过消息转换、流式响应、工具执行、steering、follow-up、retry 和 compaction；这些边界为什么不能都塞进一个“万能 Agent 类”。

## 1. 四层不是目录美学，而是四种复用尺度

```mermaid
flowchart TB
    Apps[终端 / IDE / Chat / Worker / 自定义产品]
    CA[pi-coding-agent<br/>会话、资源发现、内置工具、扩展、配置、模式]
    Core[pi-agent-core<br/>状态化 Agent、tool loop、事件、steering/follow-up]
    AI[pi-ai<br/>Provider、模型目录、统一流式协议、消息转换]
    TUI[pi-tui<br/>组件、输入、Overlay、差分渲染]
    Providers[Anthropic / OpenAI / Google / Bedrock / ...]
    Terminal[终端]

    Apps --> CA --> Core --> AI --> Providers
    CA --> TUI --> Terminal
    Apps -. 可直接使用 .-> Core
    Apps -. 只需模型协议时 .-> AI
```

| 层 | 它负责保证什么 | 它刻意不知道什么 |
| --- | --- | --- |
| `pi-ai` | Provider 请求、流式事件、模型能力/用量、消息与工具协议 | session、TUI、项目文件、extension |
| `pi-agent-core` | Agent 状态、turn/tool loop、消息队列、取消、事件流 | JSONL session、资源发现、具体 Coding 工具 |
| `pi-coding-agent` | Coding 产品语义：会话树、压缩、配置、资源、extension、四种运行模式 | 具体宿主产品的业务 UI/权限中心 |
| `pi-tui` | 终端组件、键盘输入、overlay、宽度约束、无闪烁更新 | Agent 或 session 的业务含义 |

### 为什么不合并

如果 Provider 适配直接读项目配置，任何聊天机器人都要携带 Coding Agent；如果 core 直接写 JSONL，会话后端就无法替换；如果 TUI 组件知道 Plan 状态，它就不再是通用终端库。

[设计解读] 分层的价值不是“每层都纯粹”，而是允许三个不同选择：

1. 只借 `pi-ai` 构建完全不同的推理程序；
2. 借 `pi-agent-core` 复用可靠 tool loop；
3. 借 Coding Agent SDK 或 extension 复用完整 Harness。

代价是跨层概念较多：`Message`、`AgentMessage`、session entry、extension event 并不完全相同，开发者需要知道当前位于哪一层。

## 2. 最小 Agent Loop

去掉流式、错误、Hook 和队列后，循环只有四步：

```mermaid
flowchart TD
    Prompt[加入用户消息] --> LLM[调用模型]
    LLM --> Calls{返回工具调用?}
    Calls -->|是| Execute[执行工具并加入结果]
    Execute --> LLM
    Calls -->|否| End[结束]
```

真正的实现之所以长，是因为每条箭头都必须回答边界问题：

- 模型响应流到一半被取消，历史保存什么？
- 工具参数能解析但被 token limit 截断，是否执行？
- 一条 assistant message 有多个 tool call，顺序还是并行？
- 用户在工具运行时发来纠偏，何时插入？
- 自定义内部消息怎样转换成 Provider 能接受的 role？
- API 失败后自动 retry，`agent_end` 算不算真正结束？

Pi 的复杂度主要在这些确定性问题，而不是再实现一个隐藏 planner。

## 3. 一次完整请求的时序

下面把 `pi-coding-agent` 的扩展生命周期与 core loop 放在一起。事件名以 0.81.1 Extension API 为准。

```mermaid
sequenceDiagram
    actor U as 用户/宿主
    participant C as Coding Agent Harness
    participant X as Extensions
    participant A as Agent Core
    participant P as Provider
    participant T as Tools

    U->>C: prompt
    C->>X: input hook
    X-->>C: continue / transform / handled
    C->>X: before_agent_start
    X-->>C: systemPrompt / message
    C->>A: agent run
    A-->>X: agent_start

    loop 每个 turn
      A-->>X: turn_start
      A->>X: context(messages)
      X-->>A: 可修改的 AgentMessage[]
      A->>P: convertToLlm 后的请求
      P-->>A: message_start / update / end

      opt assistant 返回 tool calls
        par 可并行的工具
          A-->>X: tool_execution_start
          A->>X: tool_call gate
          X-->>A: allow / block
          A->>T: execute(args, signal, onUpdate)
          T-->>A: partial update
          A-->>X: tool_execution_update
          T-->>A: final result
          A->>X: tool_result transform
          X-->>A: modified result
          A-->>X: tool_execution_end
        end
      end

      A-->>X: turn_end
    end

    A-->>X: agent_end
    C->>C: retry / auto-compaction / queued follow-up?
    C-->>X: agent_settled
    C-->>U: 稳定完成
```

注意三个容易混淆的边界：

- `turn_end`：一条 assistant 响应及其工具结果完成。
- `agent_end`：一次底层 core run 完成；上层仍可能自动 retry、compact 后 retry，或处理 follow-up。
- `agent_settled`：Coding Agent 确认没有自动后续动作，适合 Goal、状态栏、清理和“真正空闲”判断。

本仓库 Goal 选择 `agent_settled` 排队 continuation，正是为了避免在自动 compaction/retry 尚未结束时启动重叠 run。

## 4. 双循环：工具链与后续消息不是同一队列

当前 [agent-loop.ts](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts) 是一个内外双循环：

```mermaid
flowchart TD
    Start[进入 run] --> Steering0[读取已排队 steering]
    Steering0 --> Inner{有工具后续<br/>或 pending message?}
    Inner -->|是| Inject[注入 pending message]
    Inject --> Model[调用模型]
    Model --> Error{error / aborted?}
    Error -->|是| AgentEnd[agent_end]
    Error -->|否| Tool{有 tool call?}
    Tool -->|是| RunTools[执行工具批次]
    Tool -->|否| TurnEnd[turn_end]
    RunTools --> TurnEnd
    TurnEnd --> Snapshot[prepareNextTurn<br/>可切模型/上下文/thinking]
    Snapshot --> Stop{shouldStopAfterTurn?}
    Stop -->|是| AgentEnd
    Stop -->|否| PullSteering[读取 steering]
    PullSteering --> Inner
    Inner -->|否| Follow{有 follow-up?}
    Follow -->|是| Pending[作为下一轮 pending] --> Inner
    Follow -->|否| AgentEnd
```

### Steering 与 follow-up 的语义差异

| 队列 | 何时读取 | 目的 | 例子 |
| --- | --- | --- | --- |
| steering | run 开始及每个 turn 结束后 | 尽快改变当前方向 | “先别改数据库，先确认调用方” |
| follow-up | Agent 原本要停止时 | 当前请求完成后继续 | “完成后再跑一次性能对比” |

两者均支持 `one-at-a-time` 或 `all` 投递模式。拆成两类的好处是语义稳定：用户无需用“消息排队顺序”猜它会打断当前推理还是启动下一项工作。代价是宿主 UI 和 RPC 必须让调用方明确选择。

## 5. 消息转换：内部状态可以丰富，Provider 输入必须收敛

Agent Core 全程使用 `AgentMessage`，只在调用模型前转换成 `pi-ai` 的 `Message[]`：

```mermaid
flowchart LR
    S[Session entries<br/>消息、压缩、custom state]
    B[构建当前 branch context]
    A["AgentMessage[]<br/>允许应用自定义 role"]
    H[transformContext / context hook]
    L[convertToLlm]
    P["Provider Message[]"]

    S --> B --> A --> H --> L --> P
    H -. 可删减/改写，但不必持久化 .-> A
    L -. 过滤 UI-only/custom state .-> P
```

这条边界解决了一个常见矛盾：应用需要保存比 Provider 协议更丰富的状态，但 Provider 只接受有限 role 和 block 类型。

例如一个 Review UI 可以保存结构化审阅结果：

```ts
type ReviewMessage = {
  role: "review";
  decision: "approve" | "reject";
  comments: string[];
};
```

它可以存在于应用/session 中；`convertToLlm` 决定把它转成一条用户文本、摘要，或完全过滤。无需欺骗类型系统，把所有状态硬塞成 user message。

### 两阶段转换的 Tradeoff

- `transformContext` 适合临时裁剪、缓存提示和扩展协作；结果不自动成为 session 事实。
- `convertToLlm` 是 Provider 前的最终协议边界；若最后一条内部消息被过滤成空，Provider 可能拒绝 continuation。
- 多个 extension 的 `context` handler 按注册顺序串联，后者看到前者结果。组合能力强，但顺序就是行为，必须避免两个扩展互相“纠正”同一消息。

## 6. 流式响应：事件是事实，UI 只是订阅者

模型不会直接返回完整 assistant message。Core 先把 partial message 放入当前 context，再随 Provider delta 替换它并发事件：

```mermaid
sequenceDiagram
    participant P as Provider stream
    participant A as Agent context
    participant E as Event subscribers

    P-->>A: start(partial)
    A->>A: push partial message
    A-->>E: message_start
    P-->>A: text/thinking/toolcall delta
    A->>A: replace last partial
    A-->>E: message_update
    P-->>A: done/error
    A->>A: replace with final message
    A-->>E: message_end
```

因此同一事件流可以驱动：

- TUI 的实时文本与 thinking 展示；
- JSON mode 的机器可读输出；
- RPC 客户端；
- 测试和遥测；
- extension 的状态/UI 更新。

[设计解读] “流式优先”不是显示效果，而是把长操作建模为可观察状态机。若运行时只在末尾返回 Promise，取消、进度、工具输出和远程 UI 都只能另造旁路协议。

### TUI 为什么独立成包

`pi-tui` 使用三种渲染策略：首次输出保留 scrollback；宽度变化或视口上方变化时全量重绘；普通更新只从首个变化行重绘到末尾。更新包在 CSI 2026 synchronized output 中，减少闪烁。

```mermaid
flowchart TD
    Render["组件 render(width)"] --> Compare{与上一帧比较}
    Compare -->|首次| First[输出全部，不清 scrollback]
    Compare -->|宽度变化/视口上方变化| Full[清屏并全量重绘]
    Compare -->|普通变化| Diff[移动到首个变化行<br/>清尾并重绘差异]
    First --> Sync[原子同步输出]
    Full --> Sync
    Diff --> Sync
```

Tradeoff：组件必须严格保证每行不超过给定 width；复杂 overlay、窄终端和输入焦点都需要显式处理。换来的则是 Agent 事件与终端绘制解耦，Headless 模式无需加载一套假 UI。

## 7. 工具执行：并行完成，但保持模型可理解的顺序

一条 assistant message 可以包含多个 tool call。当前 Core 默认允许并行；全局可设 sequential，单个工具也可声明 `executionMode: "sequential"`。批次里只要存在 sequential 工具，整个批次顺序执行。

并行模式有意区分四种顺序：

```mermaid
sequenceDiagram
    participant A as Assistant source order
    participant R as Runtime
    participant T1 as Tool A（慢）
    participant T2 as Tool B（快）
    participant C as Context

    A->>R: [call A, call B]
    R-->>R: start A / preflight A
    R-->>R: start B / preflight B
    par execute
      R->>T1: A
      R->>T2: B
    end
    T2-->>R: update/end B
    T1-->>R: update/end A
    R->>C: toolResult A
    R->>C: toolResult B
```

| 事件/数据 | 顺序 |
| --- | --- |
| `tool_execution_start` 与 preflight | assistant 源码顺序 |
| `tool_execution_update` | 可交错 |
| `tool_execution_end` | 实际完成顺序 |
| 最终 tool result message | assistant 源码顺序 |

为什么不让结果按完成顺序进入模型？因为 tool call 与 result 是对话协议的一部分，稳定的源顺序更容易满足 Provider 配对要求，也让同一 assistant message 的语义不受网络/磁盘时序随机影响。

为什么 `end` 又按完成顺序发？因为 UI 和监控应该立即知道快工具已完成，不必等慢工具。

### Preflight、执行、finalize 三段式

```mermaid
flowchart LR
    Call[tool call] --> Find[查找工具]
    Find --> Prepare[prepareArguments]
    Prepare --> Validate[TypeBox/schema 校验]
    Validate --> Gate[beforeToolCall / tool_call gate]
    Gate --> Execute["execute(signal, onUpdate)"]
    Execute --> Finalize[tool_result 可改写]
    Finalize --> Result[tool result message]

    Find -. 未找到 .-> Error[结构化错误结果]
    Validate -. 非法 .-> Error
    Gate -. block .-> Error
    Execute -. throw .-> Error
    Error --> Result
```

工具失败通常被转换成 `isError` tool result，而不是让整个 loop 因异常消失。模型能看到错误并修正参数或选择替代方案。

一个细节体现了运行时边界意识：若 assistant 因 output token limit 以 `stopReason: "length"` 结束，Core **不会执行其中任何 tool call**。流式 JSON 修复可能让被截断参数“刚好可解析且通过 schema”，执行它会把残缺意图变成真实副作用；安全做法是全部返回错误，让模型重发完整调用。

### 并行的 Tradeoff

- 读取两个独立文件时，并行直接降低延迟。
- 两个写工具可能修改同一文件，完成顺序不代表语义顺序；应声明 sequential 或由上层避免同批冲突。
- `Promise.all` 保留最终数组顺序，但每个工具的副作用仍真实并发；“结果有序”不等于“执行隔离”。
- abort 后已进入不可取消系统调用的工具可能仍完成，因此工具自身必须传播 signal 并清理子进程。

## 8. Turn 边界是安全的重新配置点

每个 `turn_end` 后，Core 可调用 `prepareNextTurn`，原子地替换下一 turn 使用的 context、model 和 thinking level；还可用 `shouldStopAfterTurn` 强制结束。

```mermaid
flowchart LR
    T1[Turn N<br/>固定输入快照] --> End[turn_end]
    End --> Prep[prepareNextTurn]
    Prep --> C[context N+1]
    Prep --> M[model N+1]
    Prep --> R[reasoning N+1]
    C --> T2[Turn N+1]
    M --> T2
    R --> T2
```

这比在 Provider stream 中途修改全局变量可靠：当前请求的工具 schema、模型和上下文保持一致，变化从下一 turn 生效。

适用场景：

- 预算接近上限时切换便宜模型；
- 工具阶段完成后加入压缩上下文；
- 某个领域状态变化后更换 system/tool set；
- 每 turn 执行外部策略检查。

Tradeoff：如果上层改变了工具集合，却没有同步 system prompt 中的说明，下一 turn 会收到自相矛盾的上下文。快照边界提供时序正确性，不替调用者保证语义一致。

## 9. Coding Harness 在 Core 之外补上的机制

Core 只负责一次状态化运行。`pi-coding-agent` 再组合：

```mermaid
flowchart TB
    CoreRun[Agent Core run]
    Retry[Provider 自动重试]
    Compact[达到阈值后 compaction]
    Follow[queued follow-up]
    Session[JSONL session 持久化]
    Resources[extension / skill / prompt / theme]
    Modes[TUI / print / JSON / RPC]
    Settled[agent_settled]

    Resources --> CoreRun
    Session --> CoreRun
    CoreRun --> Retry --> CoreRun
    CoreRun --> Compact --> CoreRun
    CoreRun --> Follow --> CoreRun
    CoreRun --> Settled
    Settled --> Session
    CoreRun --> Modes
```

这解释了为什么 extension 不应把 `agent_end` 当成“用户任务彻底结束”。Core 不知道上层是否会自动压缩或续跑；Harness 才能发出 `agent_settled`。

## 10. 一个实践链路：安全重命名导出符号

以“重命名 TypeScript 导出函数”为例：

```mermaid
sequenceDiagram
    actor U as 用户
    participant P as Pi Harness
    participant M as 模型
    participant L as LSP extension
    participant S as Language Server
    participant F as 文件系统

    U->>P: 重命名 loadConfig 为 readConfig
    P->>M: 当前 branch + system + lsp tool schema
    M->>L: references(loadConfig)
    L->>S: textDocument/references
    S-->>L: 跨文件调用点
    L-->>M: 有界 content + 完整 details/artifact
    M->>L: rename(preview 或 apply)
    L->>S: textDocument/rename
    S-->>L: WorkspaceEdit
    L->>F: 经确认后应用编辑
    L-->>M: 修改摘要
    M->>L: diagnostics(changed files)
    L-->>M: 诊断结果
    M-->>U: 完成与验证证据
```

这里每层只做自己擅长的事：模型判断目标，LSP 提供语义，Server 保证引用解析，Extension 约束路径和输出，Harness 保证取消/会话，用户仍能 steering。若把所有能力写成一条超级 prompt，任何一层失败都难以定位。

## 11. 选择哪个运行层

| 需求 | 推荐入口 | 原因 | 主要代价 |
| --- | --- | --- | --- |
| 只统一调用多个模型 | `pi-ai` | 不携带 Agent/session 语义 | tool loop 自己实现 |
| 自定义领域 Agent loop | `pi-agent-core` + `pi-ai` | 复用事件、工具、队列 | session/UI/资源自己组合 |
| 在现有 Pi 增加能力 | Extension | 最短路径，复用完整 Harness | 与 Pi 同进程、受生命周期约束 |
| 在应用中嵌入 Pi 会话 | Coding Agent SDK | 复用 session、工具、扩展 | 需管理宿主与资源边界 |
| 终端之外远程控制 | RPC mode | 事件/命令协议现成 | 连接、鉴权和隔离由外层负责 |
| 产品长期改变核心语义 | fork 或内化 package | 可以重设产品边界 | 跟进上游成本最高 |

## 12. 本篇结论

Pi 的 Agent loop 可以画成四个框，但可生产运行时需要处理：

- 内部消息到 Provider 消息的单向收敛；
- partial message 的可观察流；
- 工具参数、门禁、错误和并发顺序；
- steering 与 follow-up 的确定语义；
- turn、core run 与 settled 的不同完成边界；
- 上层 retry、compaction、session 和资源生命周期。

因此“小核心”不等于“简单实现”。它意味着：**认知流程保持开放，协议和生命周期边界做厚。**

## 参考资料

- [Agent Core README](https://github.com/earendil-works/pi/tree/main/packages/agent)
- [Agent loop source](https://github.com/earendil-works/pi/blob/main/packages/agent/src/agent-loop.ts)
- [Extension lifecycle](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Coding Agent SDK](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md)
- [JSON mode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md)
- [RPC mode](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md)
- [pi-tui README](https://github.com/earendil-works/pi/tree/main/packages/tui)
- [上一篇：设计哲学](01-philosophy.md) · [下一篇：上下文、会话与记忆](03-context-and-sessions.md)
