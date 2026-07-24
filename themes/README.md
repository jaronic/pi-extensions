# 全局 Pi 主题

`themes/` 是独立于 `goal`、`plan`、`lsp`、`request`、`rg` 五个 extension package 的全局 Pi 资源。任何插件都不拥有、注册或强制选择这些文件；Pi 负责发现和激活 palette，插件只消费当前 host `Theme` 的语义 token。

## 安装与激活

从仓库根目录执行：

```bash
make pi-themes-on
make pi-themes-status
```

`make pi-themes-off` 只移除仍指向当前仓库的主题链接，`make pi-themes-toggle` 可切换整组链接。若 `settings.json` 当前选择了 `pi-extensions-*` 主题或自动 pair，关闭操作会在修改前拒绝；先通过 `/settings` 选择内置主题再重试，脚本不会用文本替换改写 JSON。冲突的文件、目录和外部软链接也不会被覆盖或删除。

安装只完成“发现”。要在当前会话立即切换，打开 `/settings` 并选择对应 Theme。也可在 `~/.pi/agent/settings.json` 配置自动浅/深切换：

```json
{
  "theme": "pi-extensions-light/pi-extensions-dark"
}
```

也可以配对 `pi-extensions-paper/pi-extensions-graphite`（暖浅色/中性深色）或 `pi-extensions-light/pi-extensions-midnight`（冷浅色/蓝黑深色）。High Contrast 通常作为固定主题单独选择。

直接从外部修改 `settings.json` 不会调用已运行会话的 theme controller；修改后应通过 `/settings` 重新选择，或重启 Pi。主题一旦处于 active 状态，继续编辑对应 JSON 文件会由 Pi 热重载。`--theme <path>` 和 package resource 只增加可发现资源，不等于选择该主题。

自动 pair 会根据终端背景选择左侧浅色或右侧深色主题，并在终端报告 color-scheme 变化时同步切换。Pi 的 live TUI theme 不会改变终端自身背景；浅色 palette 必须搭配浅色终端，深色 palette 必须搭配深色终端，否则不存在能同时在近白与近黑底色上保持正文 AA 对比度的单一前景色。

## 配色目录

| Theme | 预期终端背景 | 方向 | 适用场景 |
| --- | --- | --- | --- |
| `pi-extensions-light` | 冷浅色，参考 `#f8fafc` | teal focus、蓝色链接、清晰 slate 层级 | 日常浅色终端 |
| `pi-extensions-paper` | 暖浅色，参考 `#f7f1e7` | 纸张、棕橙 focus、柔和绿色状态 | 暖色或低蓝光环境 |
| `pi-extensions-dark` | 冷深色，参考 `#0f172a` | 稳定 slate、亮蓝 focus | 默认深色终端 |
| `pi-extensions-midnight` | 蓝黑，参考 `#0b1020` | cyan/teal、高亮蓝紫层级 | 偏冷、高信息密度界面 |
| `pi-extensions-graphite` | 中性深灰，参考 `#18181b` | amber focus、低色偏灰阶 | 中性、低干扰工作流 |
| `pi-extensions-high-contrast` | 纯黑，参考 `#000000` | 白色正文、cyan focus、黄色活动边框 | 最大辨识度与可访问性 |

`export.pageBg` 是对比度校验使用的预期底色，也是 HTML export 的页面色；它不会给 live terminal 绘制整屏背景。

## 视觉方向与语义角色

六套 palette 共享同一角色系统：中性色建立内容层级，accent 表示焦点与导航，绿色表示成功，琥珀色表示警告，红/玫红表示破坏性状态，紫色用于辅助信息与代码语义。每套都按预期背景独立调色，不通过机械反相生成。

| UI 角色 | Pi token |
| --- | --- |
| 主正文、次级说明、弱提示 | `text`、`muted`、`dim` |
| 焦点、导航、活动边框 | `accent`、`borderAccent` |
| 当前选择 | `selectedBg` + `text` |
| 成功、警告、错误 | `success`、`warning`、`error` |
| Markdown | `md*` |
| 工具状态与输出 | `tool*` |
| diff、syntax、thinking、bash | 对应 `toolDiff*`、`syntax*`、`thinking*`、`bashMode` |

`node themes/validate.mjs` 会检查完整 token、变量引用、文件名/主题名一致性，并按实际位置执行 53 组对比度断言：承载内容的正文、状态、message、selection 与 tool 三态文字至少 4.5:1；辅助文字和活动装饰至少 3:1；只有不承载内容的 muted border/关闭态装饰允许 1.5:1。CI 对所有 `pi-extensions-*.json` 强制执行该门禁。

Pi TUI 是键盘优先界面，交互状态以 focus 和 selection 表达，不另造无法由 host 统一驱动的插件私有 hover 状态。

## 插件接入契约

自定义 TUI 必须使用 `ctx.ui.custom()` 提供的 `theme` 实例，例如 `theme.fg("accent", value)` 或 `theme.bg("selectedBg", value)`。不得：

- 在插件源码中硬编码 ANSI、RGB 或 hex；
- 从 `themes/` 或其他插件导入 palette；
- 在 extension manifest 中重复注册全局 palette；
- 在插件生命周期中调用 `setTheme()` 强制覆盖用户选择。

Pi 自带的 Markdown、tool、message、footer 等界面会直接使用同一 host theme；遵守上述契约的现有和未来插件无需依赖主题包即可无缝接入任意全局 Pi theme。
