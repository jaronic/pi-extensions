# Hashline 插件

`hashline` 为 Pi 同名覆盖内建 `read` 与 `edit`，把普通文本编辑收紧为一条可验证的工作流：`read` 返回当前文件的完整 SHA-256 snapshot 和精确物理行号；`edit` 只接受当前 session branch 已记录、路径一致且目标行确实展示过的 snapshot。文件 bytes 未变化时走完整 CAS；发生漂移时，只有全部目标与已展示上下文仍逐字节相同、映射唯一且共享同一行偏移，才允许 verified rebase。

它解决的是 stale state、盲改未读区域和并行 lost update，不是模糊 patch、三方 merge 或安全沙箱。无法证明安全映射时，调用在写入前拒绝，并直接返回已 journal 的当前上下文和可重试 snapshot。

> 维护约束：凡是改变 Hashline 的 `read`/`edit` schema、snapshot/journal 协议、物理行或 EOL 语义、并发/取消/写入边界、输出上限、与 Plan/LSP/RG 的共存或安装方式，都必须在同一改动中同步本 README 和 [`../docs/design/11-hashline-extension-design.md`](../docs/design/11-hashline-extension-design.md)。

## 效果与边界

启用后：

- `read` 保持 Pi 的 `path`、`offset`、`limit` 参数和图片能力；可编辑文本改为 `LINE:TEXT` 输出，并在顶部附带 `h1_…` snapshot；
- 调用卡片分别显示 `Hashline read` 和 `Hashline edit`，使同名内建工具覆盖在 UI 中可见；
- snapshot 是原始文件 bytes 的完整 SHA-256 base64url token，覆盖 BOM、LF/CRLF/CR、尾随空白和最终换行；
- snapshot metadata 写入当前 Pi session branch 的版本化 custom journal；reload、resume 和 tree navigation 时从当前 branch 重放，不写项目 sidecar；
- `edit` 一次修改一个已存在文件，支持最多 100 个互不冲突的 `replace`、`delete`、`insert_before` 和 `insert_after`；
- 所有 operation 均引用同一份原文件坐标。数组前后顺序不会使后续行号位移；
- replace/delete 的每一行必须已被该 snapshot 展示；插入 gap 两侧存在的行都必须已展示；
- edit 先固定 authored path 的 canonical target，再以该 target 进入 Pi 共享 mutation queue；获得锁后重新核对 path 未 retarget，并比较完整 bytes。并行同-token edit 若目标/上下文相交则后到者拒绝；若互不相交且满足 verified rebase 证明，两者可依次成功。等待期间 retarget 仍以 `E_PATH_MISMATCH` 拒绝；
- 成功 result 保持 Pi 内建 `EditToolDetails` 的 `diff`、`patch`、`firstChangedLine` 形状，并返回有界的变更预览和可继续使用的新 snapshot；verified rebase 成功时会明确报告原范围、重定位范围与统一偏移；
- stale recovery 不猜路径、不改 payload、不做三方 merge。它只接受唯一的、逐物理行 byte-identical 的 unchanged-run 映射；目标、上下文、EOL、映射唯一性或统一偏移任一无法证明，就零写入拒绝并返回当前坐标附近的 refreshed snapshot。

Hashline 不新建、重命名、移动或删除文件，也不允许把非空文件清成空 bytes。新文件、完整重写和显式清空继续使用 `write`；symbol rename 和 code action 使用 `lsp`。

## 安装与启用

要求：Node.js `>=22.19.0`、npm，以及兼容 `@earendil-works/pi-coding-agent >=0.82.1` 的 Pi。

从仓库根目录启用全部扩展（包含 Hashline）：

```bash
make pi-extensions-on
make pi-extensions-status
```

也可只安装 Hashline：

```bash
cd /path/to/pi-extensions/hashline
npm ci
mkdir -p "$HOME/.pi/agent/extensions"
ln -sfn "$PWD" "$HOME/.pi/agent/extensions/hashline"
```

软链接必须指向 `hashline/` package 根目录。Pi 根据 `package.json` 的 `pi.extensions` 加载 `./src/index.ts`；安装或修改后重启 Pi，或执行 `/reload`。

开发时可绕过全局链接：

```bash
pi --no-session --extension ./src/index.ts
```

Hashline 占有全局工具名 `read` 和 `edit`。不要同时加载另一个覆盖这两个名字的 extension：Pi 按最后注册者决定实际 definition，不提供 middleware composition。加载顺序改变时，后加载的 override 会接管对应 slot；Hashline 不会通过 `setActiveTools()` 抢回所有权。

## `read` 合同

参数与 Pi 内建 `read` 一致：

| 参数 | 必填 | 语义 |
| --- | --- | --- |
| `path` | 是 | 相对当前 workspace 或绝对文件路径。 |
| `offset` | 否 | 1-based 起始物理行，必须为正安全整数。 |
| `limit` | 否 | 最多返回的物理行数，必须为正安全整数。 |

可编辑文本示例：

```text
[hashline path="src/greet.ts" snapshot="h1_cKnQSQ2wksWuDYj8LA9oH-v96HoYjAs1bPvlQ23HfFM"]
10:export function greet(name: string) {
11:  return `Hi ${name}`;
12:}
```

只有完整返回的 `N:…` source row 才进入该 snapshot 的 seen ranges。Header、截断 notice 和错误文本不授权任何行；单行超出剩余输出预算时不会返回半行 anchor。

以下 regular 文件仍可只读，但不获得 snapshot：

- 图片，包括 magic signature 匹配但解码失败的损坏图片；
- 空文件；
- hardlink target；
- 无效 UTF-8、含 NUL 或单行超过 64 KiB 的文本；
- 超过 16 MiB、250,000 个物理行或其他已声明上限的文件。

当 `stat.size` 已超过 16 MiB 时，Hashline capture 会在分配完整 Buffer 前停止并回退 Pi 内建 `read`；因此仍保留宿主的大文件/图片只读行为，但不为 snapshot/recovery 额外复制正文。

目录、FIFO、device 和其他非 regular 输入会在 non-blocking capture 阶段以 `E_NOT_EDITABLE` 明确拒绝，不会被误报为空文件，也不会获得 snapshot。

Symlink 可读取和编辑，但 snapshot 绑定其 canonical target；read 后或 queue 等待期间 retarget 都会使 edit 失败。Hashline 的物理行 scanner 只把第一个 UTF-8 BOM 作为文件标记单独恢复；后续 BOM 属于正文并原样保留。LF/CRLF/CR、混合 EOL、尾随空白和未终止 EOF 都不会被整体规范化，也不会生成虚假尾部空行。

## `edit` 合同

顶层输入只有三个字段：

```ts
interface HashlineEditInput {
  path: string;
  snapshot: string;
  edits: HashlineEditOperation[];
}
```

Operation 字段矩阵：

| `op` | `start` | `end` | `lines` | 行为 |
| --- | --- | --- | --- | --- |
| `replace` | 必填 | 可选，默认 `start` | 必填、至少一项 | 替换 inclusive 原始范围。 |
| `delete` | 必填 | 可选，默认 `start` | 禁止 | 删除 inclusive 原始范围。 |
| `insert_before` | 必填 | 禁止 | 必填、至少一项 | 插入到原始 `start` 行之前。 |
| `insert_after` | 必填 | 禁止 | 必填、至少一项 | 插入到原始 `start` 行之后。 |

`lines` 中每个字符串是一条最终逻辑行，不带 `N:` 前缀或换行符；空字符串表示一条空白行。字段组合、extra keys、非安全整数、NUL、换行、未配对 UTF-16 surrogate 和所有 byte/line 上限都会在 runtime 再次验证。

示例：

```json
{
  "path": "src/greet.ts",
  "snapshot": "h1_cKnQSQ2wksWuDYj8LA9oH-v96HoYjAs1bPvlQ23HfFM",
  "edits": [
    {
      "op": "replace",
      "start": 11,
      "lines": ["  return `Hello ${name}`;"]
    },
    {
      "op": "insert_after",
      "start": 12,
      "lines": ["", "export const DEFAULT_NAME = \"world\";"]
    }
  ]
}
```

所有 range 必须互不重叠；同一 insertion gap 只能写一次，`insert_after N` 与 `insert_before N+1` 视为同一 gap；consume range 内部不能再插入。整个 operation set 先验证、在内存中应用并生成完整 details/result，随后只进行一次文件写入。

成功后只把实际返回的预览行登记为新 snapshot 的 seen ranges，不把旧 snapshot 的行号授权自动映射到新版本。后续目标不在预览中时必须先获得新的 displayed provenance：通常再次 `read`；若误发 edit，则 `E_UNSEEN_LINE` 会零写入拒绝，并且只有在 current rows 已 journal 后才返回可直接重试的 refreshed snapshot。

### Verified stale recovery

Hashline 只为最多 4 MiB 的已 journal 快照保留 branch-local、纯内存的有界 source cache。live digest 与提交 token 不同且旧 bytes 仍在 cache 时，`edit` 才尝试以下证明：

1. 把全部 operation 的 consume range 或 insertion gap 合成一个 envelope；其中每条物理行都必须属于旧 snapshot 的 seen provenance，再在两侧各扩展最多 2 条已展示行作为 context；
2. 要求该 proof window 的每条 `body + eol` 在旧文件和当前文件中 byte-identical，且位于同一个 unchanged diff run；
3. 要求 proof window 在旧文件与当前文件中都只出现一次，所有 operation 因而共享一个统一行偏移；
4. 用当前文件、重定位后的 operation 和映射后的 seen ranges 重新执行 range、gap、conflict、payload、no-op、输出及 commit 前全部检查。

只有四步全过才写入，当前文件中不相交的外部变化原样保留。目标或上下文改变、multi-operation envelope 含 unseen gap、重复上下文、跨多个 diff hunk、不同 operation 需要不同偏移、旧 bytes 不在 cache，都会拒绝。verified rebase 不持久化旧正文，也不把旧 seen ranges 自动授权给成功后的新 snapshot；成功版本仍只授权结果 preview 实际展示的行。

## 失败语义

Hashline 自定义的 schema、snapshot、provenance、资源、并发与 mutation 失败会抛带稳定 code 的 `Error`，由 Pi 记录为失败 tool call。内建 `read` 的路径解析、权限和宿主图片处理错误保留 Pi 原语义；它们不会生成 snapshot：

| Code | 含义与下一步 |
| --- | --- |
| `E_BAD_REQUEST` | 字段组合、额外字段、行号、payload 或 `read` offset/limit 非法；按 schema 修正输入。 |
| `E_SNAPSHOT_REQUIRED` | token 缺失或格式非法；读取同一文件。 |
| `E_SNAPSHOT_UNKNOWN` | token 不在当前 branch/store 或已被 LRU 淘汰；若错误附带 refreshed header，直接使用该 token 重建操作，否则 read。 |
| `E_PATH_MISMATCH` | token 属于其他 canonical path，或 symlink/path 已改变 target；读取目标路径。 |
| `E_STALE_SNAPSHOT` | 文件 bytes 已变化且 verified rebase 无法证明安全映射；零写入，按错误中的当前坐标与 refreshed token 重建操作。 |
| `E_UNSEEN_LINE` | range 或 insertion gap 未完整展示；错误直接展示并授权缺失的当前范围，使用附带 token 重试。 |
| `E_RANGE` / `E_EDIT_CONFLICT` | 当前坐标越界、range 重叠或 insertion gap 冲突；错误附带相关当前上下文，修正 operation set 后使用其 token。 |
| `E_NO_CHANGE` / `E_WOULD_EMPTY` | 结果 bytes 相同，或会把非空文件清空；错误附带当前上下文，核对目标；完整清空使用 write。 |
| `E_NOT_EDITABLE` / `E_TOO_LARGE` | 文件类型、编码、hardlink 或 byte/line/details 上限不适用；改用明确的其他工具。 |
| `E_BRANCH_CHANGED` / `E_ABORTED` | commit 前 session branch 改变或调用取消；当前调用零写入，在当前 branch 重新 read。 |
| `E_WRITE_FAILED` | write 或 close 已进入未知状态，文件可能部分改变；必须 read，不能盲目重试。 |

`E_SNAPSHOT_UNKNOWN`、无法恢复的 `E_STALE_SNAPSHOT`、`E_UNSEEN_LINE`、`E_RANGE`、`E_EDIT_CONFLICT`、`E_NO_CHANGE` 和 `E_WOULD_EMPTY` 会尽力在同一 queue 临界区内捕获一次 live bytes、journal 有界当前范围，再把 `[hashline … snapshot="h1_…"]` 与 `LINE:TEXT` 放进原错误。只要 header 出现，它就已属于当前 branch，显示的行就是该 token 新增的 seen provenance；可直接修正参数重试，无需额外 `read`。刷新本身失败时保留原错误并明确要求 read，绝不把未 journal 的行伪装成授权上下文。

写入成功后 journal append 失败不会伪装成 edit 失败；结果会明确说明“文件已更新，但没有 follow-up snapshot”，要求重新 read。commit 开始后的取消也不会把已完成副作用报告成取消失败。

## 持久化、输出与硬上限

Snapshot custom entry 使用 `pi-extensions:hashline-snapshot:v1`，只保存 token/digest、canonical path、byte/line counts、seen ranges 和来源；不保存文件正文。用于 verified rebase 的旧 bytes 只存在独立的有界 `RecoveryStore` 内存 cache，不进入 journal，因此 reload/resume 后 metadata token 仍可走 exact CAS，但不能恢复旧 bytes。`session_start`、`session_tree` 与 `session_shutdown` 都清空该 cache；前两者再从当前 branch 严格解码并重建 metadata projection。malformed entry 被忽略，并在有 UI 时汇总警告。

主要上限：

| 项目 | 上限 |
| --- | ---: |
| 可编辑文件 | 16 MiB、250,000 物理行 |
| 活跃路径 / 每路径版本 / 总 snapshot | 128 / 8 / 512 |
| 单 snapshot seen ranges | 64 |
| recovery cache | 单版本 4 MiB、每路径 4 版本、总 128 版本 / 64 MiB |
| 单次 edit operation | 100 |
| payload | 128 KiB、10,000 逻辑行 |
| 单行 | 64 KiB |
| consumed + replacement bytes | 128 KiB |
| 完整 edit details | 256 KiB |
| follow-up preview | 120 source 行，每个变更 span 前后 2 行 |
| tool content | Pi 默认 50 KiB、2,000 行 |

Metadata LRU 只限制当前可用的 token projection，不删除 session journal；RecoveryStore LRU 只限制本进程、当前 branch 可用的旧 bytes。metadata token 被淘汰不会因 live hash 相同而自动复活；旧 bytes 被淘汰则只禁用 verified rebase，不影响同 token 的 exact CAS。

## 与其他扩展协作

- Plan：Hashline 不修改 active tool 集。Plan planning/approval 阶段可保留 Hashline `read` 并隐藏 `edit`；退出 lease 后恢复原 definition。
- LSP：成功工具名仍为 `edit`，输入仍有顶层 `path`，details 保持内建形状，因此 LSP 的 `tool_result` 同步路径继续工作。
- RG：搜索结果不构成 snapshot provenance；grep/rg 后仍需 `read`。Hashline 不改变 RG/grep 定义或顺序。
- Goal、Todo、Request：没有 production import、共享 UI key 或私有事件协议。Promptline Editor 只接管 editor，不注册或覆盖 `read`/`edit`，可与 Hashline 同时加载。
- 内建 `write`：继续使用 Pi 的同文件 mutation queue；它在 snapshot 后改文件时，下一次 Hashline edit 会进入 stale recovery，只有不相交且满足完整证明的目标才继续，否则零写入刷新。

## 安全与残余风险

Hashline 是误编辑约束，不是权限系统：

1. 不使用 Pi mutation queue 的同权限进程，仍可能在最终校验与 in-place write 的极短窗口修改 inode，或替换/重定向 authored path。写入 handle 固定在已校验 target，因此不会跟随到新 target，但旧 inode 可能在提交时已不再由原路径指向；portable Node.js filesystem API 不提供通用 compare-and-swap path write。
2. In-place write 保留 inode/mode 并兼容 Pi 行为，但断电、磁盘或 close 故障可能产生部分写入；`E_WRITE_FAILED` 后必须 read。
3. 另一个后加载的同名 override 可替换 Hashline；安装时应检查实际 active `read`/`edit` definition。
4. SHA-256 token 不是授权凭据或 sandbox；恶意 extension 与同用户进程拥有相同文件权限。
5. 大文件、特殊编码、hardlink 和特殊文件会 fail closed，不承诺覆盖所有文件类型。

因此不要把 Hashline 描述为“完全原子”“可以阻止所有外部覆盖”或“安全沙箱”。它提供的是 branch provenance、seen-line proof、完整 byte CAS 或严格 verified rebase，以及共享 mutation queue 共同组成的高可靠编辑前置条件。

## 排查日志

默认不写任何日志文件，普通 session 无磁盘副作用。需要排查问题时通过环境变量开启：

- `PI_HASHLINE_LOG` 控制本扩展；`PI_EXT_LOG` 为本仓库多个扩展共享的开关，`PI_HASHLINE_LOG` 优先级更高。
- 取值：`error`（默认级别）、`warn`、`info`、`debug`；`1`/`true`/`on`/`yes` 等价 `error`；`0`/`off`/`false`/`no` 或留空为关闭。
- 日志写入 `getAgentDir()/logs/hashline.log`（即 `~/.pi/agent/logs/hashline.log`，遵循 `PI_CODING_AGENT_DIR`）。文件超过 5 MiB 轮转为 `hashline.log.1`，只保留一份备份。
- 每行是一条 JSON：`ts`、`level`、`ext`、`event` 与 `context`。edit 失败记录 `path`、错误码、`snapshot` token、操作数与 runtime `generation`。为避免噪音，属于正常控制流的 CAS 拒绝（stale/unseen/no-change/path-mismatch/branch-changed 等）记为 `debug`，只有 `E_WRITE_FAILED` 与非 Hashline 的意外错误记为 `error`；read 失败记为 `debug`。C1 控制字符会被中和，避免在终端或编辑器中打开日志时执行转义序列。
- 日志是尽力而为的旁路：写入或轮转失败会被静默吞掉，绝不影响工具执行、CAS 语义或改变任何返回结果。想要“常开”，在 shell profile 中设置一次 `export PI_HASHLINE_LOG=debug` 即可完整记录 CAS 拒绝链路。

## 实现节点

- `src/index.ts`：composition root、runtime generation、metadata/recovery store、两个同名 tool override 与 session lifecycle。
- `src/read-tool.ts`：Pi read adapter、可取消且 non-blocking 的 stable regular-file capture、图片 magic fail-closed、snapshot journal。
- `src/edit-tool.ts`：pinned-canonical queue、path retarget 复核、exact CAS / verified rebase、拒绝热刷新、commit 与 truthful post-commit result。
- `src/recovery.ts`：有界 branch-local source cache、通过 exact-pinned runtime dependency `diff@8.0.4` 计算 byte-faithful Myers unchanged runs、唯一 proof-window 映射与统一 offset rebase。
- `src/operations.ts`：strict input decoder、前移的累计资源预算、seen/range/gap 验证、原坐标 conflict plan 和纯 apply。
- `src/lines.ts`：严格 UTF-8、显式单 BOM 处理、物理行/EOL scanner 与 byte-preserving serializer。
- `src/snapshots.ts`、`src/persistence.ts`：immutable seen ranges、LRU、v1 decoder 与 current-branch replay。
- `src/output.ts`：有界 read body、变更 preview、follow-up snapshot，以及只在 journal 成功后返回的拒绝当前上下文。
- `src/logger.ts`：默认关闭、`PI_HASHLINE_LOG`/`PI_EXT_LOG` 开关、写入 `getAgentDir()/logs/hashline.log` 并有界轮转、按 CAS 拒绝/意外错误分级、C1 中和、吞掉自身失败的排查日志。与 lsp 的同名文件逐字节相同，避免跨包生产导入。
- `src/schemas.ts`、`src/prompts.ts`：TypeBox schema、硬上限与模型可见使用规则。

## 开发与验证

```bash
cd /path/to/pi-extensions/hashline
npm run check
npm test
```

测试覆盖 raw-byte digest、重复 BOM/EOL/Unicode、canonical token、严格且 structure-first 的 journal、metadata/recovery entry/byte LRU、四种 operation、seen coverage、path/payload fail-fast 与输出上限、unknown/unseen/range/conflict/no-op/would-empty 热刷新和直接重试、refresh journal 失败不回显 source、stale 正负/零偏移 rebase、目标/EOL/重复上下文/跨 hunk/unseen multi-op envelope 拒绝、同-token 相交拒绝与不相交并发成功、path mismatch 零写入、并发 queue、queue 等待期间 symlink retarget、取消/branch generation、write/close/journal failure、大文件 allocation 前内建 fallback、损坏图片与 non-regular 输入、hardlink、reload/tree source-cache 隔离和 Plan/LSP/RG load order。

隔离加载 smoke：

```bash
pi --no-session -p --no-extensions --no-context-files --no-skills \
  --no-prompt-templates --extension "$PWD/hashline" \
  "Reply with exactly: SMOKE_OK"
```

加载成功只证明 manifest 与宿主 API 兼容。发布前还必须在临时 workspace 执行真实 `read → edit → disk read`、外部插行后的 verified rebase、目标改变后的 refreshed rejection/retry、同-token 相交与不相交并发、reload 后 exact CAS / 无 source-cache recovery、branch isolation、图片 passthrough，以及卸载后内建 `read`/`edit` 恢复。
