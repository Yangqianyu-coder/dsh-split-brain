# 脑裂 Split-brain · DeepSeek Harness 插件

把**当前对话窗口**克隆成一个**一模一样的独立智能体**：副本只带已经聊完的部分，
**不含正在执行的那一轮**；任务直接交给它就**立刻开跑，不进队列**；两边都做完后
`/merge` 把两份结论和文件改动面合成一份**合并报告**送回原会话，并列出冲突文件。

设计说明见 [DESIGN.md](DESIGN.md)（切点语义、为什么不排队、合并仲裁政策、对照过的公开案例）。

## 用法

| 入口 | 怎么用 |
| --- | --- |
| `/split <任务>` | 劈出 1 个半球并直接开工 |
| `/split 任务A \|\| 任务B` | 一次劈出多个半球（上限 `config.maxBranches`） |
| `/split-status` | 看各半球收口情况、原会话分裂后改了哪些文件 |
| `/merge` | 等各半球收口 → 生成合并报告送回本会话（`/merge --no-wait` 只合当前结论） |
| `/merge vote` | 指定仲裁政策：`append`（并列采纳）/ `synthesize`（合成一份）/ `vote`（同题多解投票） |
| `/split-abort` | 中止，取消还在跑的半球 |
| `split_brain` 工具 | 模型侧同一实现：`{action, tasks, isolation, policy, wait}` |

半球是**普通会话**：侧栏里能看到（标题 `<原标题> ⨯ A`），点进去能继续聊、能插话、
能单独执行 `/merge`（合并永远送回原会话）。输入框下方有一条「半球条」显示血缘与实时状态。

## 什么时候该脑裂（触发边界）

默认**不脑裂**：分裂的成本是 N 份完整上下文 + N 个可见会话窗口，只有**互相独立**的并行才换得来收益。
这段准则同时写进工具描述（模型侧唯一判据）和执行闸门（`splitGate`，纯函数），所以既是建议也是硬约束。

三条同时成立才分：

1. 有 ≥2 路**互相独立**的子问题——任何一路的结果都不是另一路的前提；
2. 每路都能各自跑到一份**可独立评审的结论**，不是一句查询；
3. 并行换来**实打实的收益**——省墙钟时间、多版方案对照、多视角评审；或用户明说「分头、并行、同时、给我几版」。

该分的三类：

| 场景 | 怎么做 |
| --- | --- |
| **挂起长活**：用户交来一件耗时且与后续提问无关的事（整理表格、长文汇总、全量分析、批量处理互不相关文件），又不想干等、不想打断对话 | 把这件活重写成一条**自包含**任务交给半球，原会话立刻腾出来接下一个问题。这就是「挂起」而不是「打断」 |
| 一份产出要多视角评审（安全 / 性能 / 可读性）或多版方案对照 | 一路一个视角，`policy: append` 并列；同题多解用 `vote` |
| 几个互不相关、各自查完才出结论的子题 | 一路一题，`maxBranches` 内宁少勿凑 |

交接的硬约束（这类场景最容易踩）：切点只带**已完成轮次**，半球看不到正在执行的这一轮，
也看不到原会话之后的内容。所以交给它的 `task` 必须自带材料——要处理的内容、文件路径、已确认的口径
写进正文或 `@文件`，别写「按上面那份继续」。分出去以后原会话别再碰同一批文件；必须同写就 `isolation: worktree`。

不该分：子问题之间有依赖链；只是想要多一个答案；用户在提问、要解释代码、要一份文档；
半分钟能做完的小事（分裂的往返比做完还慢）；不可逆或对外的动作（删除、推送、发布、发送、付款）；
本会话还没有已完成轮次，或已有未收口的脑裂组。更合适的别的手段：小查询 → `read`/`grep`，
一两个子任务 → `subagent`，成百文件的无状态扇出 → `workflow`，长期协作共享任务板 → `Team`。

闸门拒绝码（`split` 专属；`status` / `merge` / `abort` 这些收口动作永远放行）：

| code | 触发条件 | 含义 |
| --- | --- | --- |
| `auto-trigger-off` | `config.autoTrigger: off` | 整个 profile 关掉分裂，人和模型都不行 |
| `manual-only` | `autoTrigger: manual` 且调用方是模型 | 只有人按 `/split` 才开半球 |
| `needs-reason` | 模型侧 `split` 没写 `reason`（或短于 8 字） | 写不出「各路为什么独立」就说明不该分 |
| `branch-no-resplit` | 半球内部再劈半球（`allowNestedSplit: false`） | 血缘成树后合并目标与冲突面会乱 |
| `group-open` | 上一组既没 `merge` 也没 `abort` | 一次只保持一组：先收口旧的，否则新血缘会盖掉旧组成员表 |
| `too-many-branches` | 超过 `config.maxBranches` | 一次分裂的半球数上限 |
| `no-completed-turn` | 会话还没有任何已完成轮次 | 等这一轮落地再分，或就地顺序做完 |

`source`（`tool` / `command`）由宿主入口决定、不进 `args`，所以模型传 `source: 'command'`
会被 `checkArgs` 当未知参数拒掉，闸门不可被自称人侧绕过。

## 三个关键语义

1. **切点 = 最后一个已完成轮次**。复用 harness 的 fork 边界（`turn/end` 之后的独立事件也算已完成），
   正在执行的 turn 不会被复制——未闭合的 turn/step 无法作为合法历史重放。
   还没有任何已完成轮次时明确拒绝：`no-completed-turn`。
2. **不排队**。投递走 `sessionController.prompt(mode:'queue')` → `agent.followup()`，
   会**唤醒** agent；半球刚 fork 出来是 idle，所以当场起轮。（`agent.inject()` 只塞 inbox 不唤醒，
   那才是「分了任务却在排队」的观感，这里刻意不用。）
3. **合并要仲裁，不是拼接**。合并报告四段：各半球结论 / 改动面交集（冲突表）/ 仲裁政策 /
   过程引用（`dsh-session:` mention，装上 session-reference 就能点开看半球的原始推导）。
   **本插件永不自动覆盖文件**，冲突只报告。

## 为什么不用插件私有记忆

harness 不允许往会话日志写自定义事件 type（老读者只接受带 `ignorable` 的事件，
而 `Session.append()` 给不了这个标记）。所以血缘写成机读标记行，落在本来就要落盘的内容里：

```
[split-brain role=branch group=sb-xxxx origin=session-… label=A cut=7]   ← 半球简报第一行
[split-brain role=origin group=sb-xxxx cut=7 members=session-…|A,session-…|B]  ← 工具/命令结果、合并报告
```

由 session projection（`key: 'splitBrain'`，纯同步折叠 + `wire.view`）现推：
浏览器拿到的是 Host 已算好的整值，插件没有自己的 Client 折叠代码，也没有数据库表。
**重启、清缓存、换版本都不丢**——日志就是唯一真相源。

## 配置（profile 的 `cordis.patch.yml`，用户层可覆盖）

```yaml
- id: dsh-split-brain
  name: '@local/dsh-split-brain'
  config:
    maxBranches: 4          # 一次最多几个半球
    labelPrefix: '⨯'         # 半球标题的血缘标记
    resultCharBudget: 4000   # 每份结论的截断长度
    mergeTimeoutMs: 600000   # 合并前等待收口上限；0 = 不等
    isolation: 'shared'      # shared | worktree（worktree 需启用 experimental worktree 行）
    policy: 'append'         # append | synthesize | vote
    briefingExtra: ''        # 追加到简报的项目纪律
    autoTrigger: 'ask'       # ask | manual | off：只拦 split，见「什么时候该脑裂」
    allowNestedSplit: false  # 半球内部能否再劈下一级
```

## 安装

```
dsh --profile web
# 设置 → 插件 → 安装 bundle，目录指到本包；或由 agent 执行
# plugin_manager { action: "install_bundle", target: "<本包绝对路径>" }
```

装完刷新页面。Host 半边替换需要重启 Host 才加载新的 JS 代际。

## 自检

```
node test/selfcheck.mjs
```

不装插件也能验的核心语义：切点落在最后一个 `turn/end`、`turn/end` 之后的独立事件算已完成、
新 `turn/start` 之后不算、血缘折叠（branch/origin 互不误配）、继承前缀里的父会话标记被地板值挡掉
（且返回同一引用 = 零下游开销）、任务段抽取、改动面只算自己区间、收口判定、坏持久状态修而不抛、
`textOf` 不把块的 `type` 字段混进正文（曾经的真实缺陷）。

## 已知边界

- **半球不是并排分页**：半球条挂在输入框下方（`conversation.composer.dock`），点「打开」走的是宿主
  `uiWorkspace.openSession`，它**同步替换主视图**——主区域一次只显示一个会话。宿主目前没有会话级深链路由，
  也没有会话 dock 面板，所以「浏览器里几个半球并排翻页」这一版做不到，要真做需要新开一个 dock/tab 面。
- 快照式分裂：半球看不到原会话之后的内容，反之亦然，简报里写死了这句提醒。
- `shared` 隔离下两边共用工作目录，写密集任务会互相踩——所以有冲突表 + 不自动写文件。
- `worktree` 隔离需要启用 `@deepseek-ai/dsh-experimental-tool-worktree` 那组行，否则明确报错并建议降级。
- 半球若在等人回答，状态如实显示 `waiting-user`，不会静默卡住。
- 改动面来自 `workspace/changes`（只在 Host 内存里，重启/会话 dispose 后没了）+ `tool/call` 参数（冷会话也能算）并用。
