# uikit — 共享 TUI 渲染原语库

`uikit`（`pi-uikit-dev`）是本仓库所有扩展共用的 TUI 渲染原语层。它**不是 Pi 扩展**（`package.json` 没有 `pi.extensions`，不应被链接或加载），而是一个纯库：把"工具调用卡片标题、状态行、折叠输出"这类反复出现的渲染形状收敛到一处，让各扩展的工具 renderer 风格统一，且所有颜色只经 host `Theme` 语义 token 解析。

设计约束：

- **零运行时状态**：全部为纯函数；没有 installer、service、EventBus channel 或生命周期。
- **主题 token 单一映射点**：`tone()` 是唯一把语义意图映射到 `theme.fg` token 的地方；调用方按意图（muted、output、title…）而非 token 名取色，全仓库同一意图必然同色。
- **不重新发明 pi-tui**：宽度处理（`truncateToWidth`、`visibleWidth`）与基础组件（`Text`、`Box`）直接用 `@earendil-works/pi-tui`；uikit 只封装本仓库的设计系统层。
- 消费方经正式 `file:../uikit` dependency + `bundledDependencies` 引入（与 plan 捆 request/todo 同款模式），禁止 `../../uikit/src` 跨包 import。

## 原语目录

### `tone(theme, name, text)`

命名色调。`name` ∈ `title | accent | muted | dim | text | output | success | warning | error`；`title` = `toolTitle` + bold，`output` = `toolOutput`，其余同名 token。

### `toolCallTitle(theme, { brand, action?, target? })`

工具调用卡片的标准标题行：`<bold toolTitle>Brand</>` + `<muted> · action </>` + `<accent>target</>`。hashline 的 read/edit 卡片即用此形状。

### `reuseTextComponent(lastComponent, content)`

renderCall 的流式安全 Text 复用：参数流式到达时工具会反复重渲染，能改上一次组件就不要每次新建。

### `statusRow(theme, status, label, value?)`

结果行：着色的状态 glyph（`✓` success / `○` pending（warning 色） / `!` warning / `✕` error）+ accent label + 可选 `: value` 文本。request 的 ask 答案行即用此形状。

### `kvRow(theme, key, value)` / `badge(theme, text, tone)`

muted 键 + text 值的键值行；`[text]` 形式的短标记。

### `collapseLines(lines, { expanded, collapsedLimit })` / `moreLinesHint(theme, hiddenCount, noun?)`

折叠输出协议：collapsed 保留头部 `collapsedLimit` 行并返回 `hiddenCount`，expanded 全量；`moreLinesHint` 生成统一尾部提示 `… (N more lines; expand to show all)`。rg 的结果渲染即用此协议。

### `linesToText(lines)`

把着色后的行合成 `Text` 组件。

## 消费方式

消费方 `package.json`：

```jsonc
{
  "dependencies": { "pi-uikit-dev": "file:../uikit" },
  "bundledDependencies": ["pi-uikit-dev"]
}
```

然后按包名导入：`import { toolCallTitle } from "pi-uikit-dev";`。uikit 无扩展入口，消费方的 `pi.extensions` 无需为其增加资源顺序条目。当前消费方：`hashline`、`rg`、`request`。

## 测试

`npm run check` + `npm test`。测试用 `test/stub-theme.ts` 的标记式 Theme stub 断言每个原语解析到了哪个 token，不依赖真实主题或终端。

## 维护约束

新增原语必须是纯函数、只经 `tone()` 取色；改变任何原语的输出形状时，同步检查 hashline/rg/request 的渲染输出与测试断言（它们依赖逐字节一致的输出），并在同一改动中更新本 README。
