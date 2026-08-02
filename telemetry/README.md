# Telemetry 插件

`telemetry` 是一个纯观察型 Pi 扩展：它统计模型在会话中实际调用了哪些工具、成功率如何、随 provider/model 如何变化，为排查“工具不活跃”类问题和离线评测提供数据基础。它不注册任何模型工具、不注入 prompt、不拦截或修改任何工具调用，对 agent 行为零干预。

> 维护约束：凡是改变 Telemetry 的行为、命令、数据维度、持久化格式、隐私边界或安装方式，都必须在同一改动中同步本 README。

## 适用场景与效果

适合回答这类问题：

- 当前 provider/model 下，模型实际调用了哪些工具，各占多少次？
- 某个工具的失败率是否异常偏高（例如 schema 不兼容导致模型反复调用失败）？
- 切换 provider/model 后，工具使用分布和成功率如何变化？

启用后：

- 每次 `tool_call` 按 `{tool, provider, model}` 维度计数；`tool_result` 补记失败与耗时（从 call 到 result 的墙钟时间）。provider/model 取自事件发生时 `ctx.model`，模型缺失时降级为 `unknown`。
- 聚合数据有界：最多 256 个 `{tool, provider, model}` 分组，超出时淘汰最久未使用的分组；单个维度值最长 128 个 Unicode 字符。
- 每个 turn 结束且数据有变化时，把完整快照作为 Pi session journal 的 custom entry（`telemetry-state-v1`）持久化；`session_start` 与 `session_tree` 都按当前分支重放恢复，最后一条有效快照生效。
- 恢复不信任反序列化数据：版本不符或结构非法的快照整体丢弃，单条非法聚合（计数为负、failures > calls、重复维度等）逐条跳过并告警，维度值未规范化的条目同样丢弃。
- handler 对 `tool_call` 返回 `undefined`，永不阻塞或改写工具调用；观察逻辑失败不会影响原工具协议。

## 隐私边界

Telemetry **只**记录工具名、provider ID、model ID、计数与耗时。它绝不读取、记录或导出工具参数（`input`）、工具输出（`content`/`details`）、prompt 文本或任何会话内容。`tool_call`/`tool_result` 事件中的参数与结果对象从不进入聚合状态、journal 快照或 export 文件。导出 JSON 可安全地离开本机用于离线评测，但仍包含你使用的 provider/model 名称，分享前请自行确认。

## 安装与启用

要求：Node.js `>=22.19.0`、npm，以及兼容 `@earendil-works/pi-coding-agent >=0.82.1` 的 Pi。

```bash
cd /path/to/pi-extensions/telemetry
npm ci
mkdir -p "$HOME/.pi/agent/extensions"
ln -sfn "$PWD" "$HOME/.pi/agent/extensions/telemetry"
```

软链接必须指向 `telemetry/` 包根目录，而不是 `src/index.ts`；Pi 会读取 `package.json` 中的 `pi.extensions` 并加载 `./src/index.ts`。仓库移动后应重新创建链接。随后重启 Pi，或在已运行的 Pi 中执行 `/reload`。

开发时也可绕过全局发现，直接从本目录启动：

```bash
pi --extension ./src/index.ts
```

## 使用方法

### 用户命令

```text
/telemetry [status]
/telemetry export [file]
/telemetry reset
```

| 命令 | 行为 |
| --- | --- |
| `/telemetry`、`/telemetry status` | 显示总调用数、失败数、成功率、分组占用，以及按调用数排序的前 10 个 `{tool @ provider/model}` 分组（调用数、失败数、成功率、平均耗时）。 |
| `/telemetry export [file]` | 把完整聚合数据导出为 JSON（默认 `telemetry-export.json`，写入会话 cwd）。路径必须是 cwd 内的相对路径：绝对路径、`..` 逃逸、符号链接逃逸一律拒绝；目标目录必须已存在；已存在的文件不会被覆盖。 |
| `/telemetry reset` | 清空全部聚合数据并追加一条空快照（保证分支重放后仍为空）。有对话框 UI 时先要求确认；无 UI 路径直接执行。 |

命令仅注册 `telemetry` 一个；扩展不注册任何 agent 工具，也不修改 active tools。

### 导出格式

`/telemetry export` 生成的 JSON（版本 `1`）：

```json
{
  "version": 1,
  "generatedAt": 1754000000000,
  "totals": { "calls": 42, "failures": 3, "successRate": 0.9286 },
  "aggregates": [
    {
      "tool": "read",
      "provider": "anthropic",
      "model": "claude-sonnet-4",
      "calls": 20,
      "failures": 1,
      "totalDurationMs": 8400,
      "timedCalls": 20,
      "firstSeenAt": 1753999900000,
      "lastSeenAt": 1753999990000,
      "successRate": 0.95,
      "avgDurationMs": 420
    }
  ]
}
```

`aggregates` 按调用数降序排列。`timedCalls` 可能小于 `calls`：只有本进程观察到的完整 call→result 对才有耗时样本；恢复后到达的孤儿 result 只计入调用与失败数。离线评测（对比不同 provider/model 的工具活跃度与成功率）直接按 `provider`/`model` 字段切片即可。

## 状态与生命周期

- 观察：`tool_call` 记录一次调用并把 `{dims, startedAt}` 按 `toolCallId` 存入有界 pending 表（上限 128，FIFO 淘汰）；`tool_result` 匹配 pending 计算耗时并结算失败。工具调用被其他扩展阻止、被取消或跨 restore 丢失时，pending 条目被丢弃——调用计数仍保留，只是没有耗时样本。
- 持久化：`turn_end` 时如有变化则追加完整快照；reset 追加空快照。恢复时从 `ctx.sessionManager.getBranch()` 顺序重放，最后一条有效快照生效；解码失败恢复快照为空并在有 UI 时告警。
- `session_start` 与 `session_tree` 都会清空内存与 pending 表后重放，保证分支切换后数据与当前分支一致；restore 后到达的无匹配 result 按一次隐含调用计数。
- `session_shutdown` 幂等清空 pending 表；本扩展没有 timer、子进程或监听器需要释放。
- 四种模式：TUI/RPC 下命令通过 `ctx.ui.notify`/`confirm` 交互；JSON/print 模式下观察与持久化照常工作（不依赖任何 UI），slash 命令本身不可调用，也不会因为没有 UI 而崩溃。

## 与其他插件协作

Telemetry 是纯观察者：不注册工具、不接管 active tools、不使用跨插件事件 channel，也不读取其他扩展的 custom entry。它与 Goal/Plan/Todo/Request 等插件可任意组合加载，互不影响；其他扩展注册的自定义工具同样以 `{tool, provider, model}` 维度被统计。工具调用若被 Plan 等门禁阻止（`tool_call` 返回 block），该次调用仍计入“模型尝试调用”，但不会产生 result——这正是评测“模型想用什么”与“实际能用什么”差异所需的数据。

## 配置

Telemetry 没有外部配置文件。运行期控制项只有 `/telemetry` 命令；持久化跟随 Pi session journal，不写独立状态文件（export 是显式的用户动作）。

## 实现原理与关键节点

- `src/index.ts`：扩展入口与装配根；持有聚合状态、有界 pending 表与 dirty 标记，注册生命周期与观察 hooks，负责 branch 恢复与快照持久化。
- `src/state.ts`：纯聚合模块；维度规范化、有界分组（LRU 淘汰）、不可变状态转换、严格的持久化解码边界、汇总/导出/状态格式化。
- `src/command.ts`：`/telemetry` 用户控制面（status/export/reset）。
- `src/export.ts`：导出路径安全（cwd 内解析、`realpath` 防符号链接逃逸、拒绝覆盖）与 JSON 写盘。
- `test/state.test.ts`：聚合、边界、淘汰、解码拒绝/跳过、导出与格式化的纯单元测试。
- `test/extension.test.ts` + `test/harness.ts`：注册面（零工具）、观察流、持久化时机、分支恢复、malformed 快照、无 UI 路径、export 安全（逃逸/覆盖/符号链接）与 reset 确认流。

## 开发与验证

```bash
cd /path/to/pi-extensions/telemetry
npm run check
npm test
```

`npm run check` 执行严格 TypeScript `noEmit` 检查；`npm test` 使用 Node `node:test` + `tsx`。
