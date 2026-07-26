# Promptline Editor

参考截图风格的自定义 pi 输入框：深色终端感、细黄色闭合边框、底部独立状态条。

## 特性

- 替换默认 editor，不改变输入、提交、粘贴图片、快捷键等行为，也不注册或覆盖任何工具。
- 输入区使用包含四角、上下边和左右边的完整闭合边框；Goal 状态嵌入上边框。
- 输入框下方单独显示：当前 model、思考等级、Plan 状态、项目路径、git branch 和 context window 占用。
- 监视当前 worktree 的 Git `HEAD`；执行 `git switch`、`git checkout` 或外部切换分支后，分支标签会自动刷新。
- 默认 footer 隐藏，避免同一组状态信息重复出现。
- 输入 `/` 打开 slash 命令下拉框时，输入框仍保持闭合，状态条和候选列表依次显示在下方。
- slash/autocomplete 选中项使用更醒目的加粗 `warning` 色，描述文字也会加重显示。
- agent 工作时右侧显示轻量 spinner。
- 使用当前 pi theme token 着色，主要依赖 `warning`、`accent`、`muted`、`dim`。

## 使用

从仓库根目录启用：

```sh
make pi-extensions-on
```

在 pi 中执行：

```text
/reload
```

如果要调整颜色，优先修改当前 theme 的这些 token：

```text
warning
accent
muted
dim
```

## 说明

这是独立插件，不会影响 `model-tags`。如果还有其他插件也调用 `ctx.ui.setEditorComponent()`，最后加载的插件会接管 editor。
