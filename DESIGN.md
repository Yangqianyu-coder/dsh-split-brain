# 脑裂插件（Split-brain）设计说明

> 目标：把**当前对话窗口**克隆成一个一模一样的智能体副本，副本**不包含正在执行的那一轮任务**，
> 拿到任务后**直接开跑、不排队**，两边都做完后**再把结果合并回原会话**。

---

## 1. 一句话定义

`/split <任务>` 在**上一个已完成轮次**处劈出一个**用户可见的独立会话**（半球 / hemisphere），
立刻把任务交给它执行；原会话继续干自己的活；两边都空闲后 `/merge` 把两份结论 + 两份文件改动
合成一份「合并报告」送回原会话，并显式列出**冲突面**（两边都碰过的文件）。

这就是数据库意义上的 split-brain：**两个脑同时认为自己是主**，所以合并时必须做仲裁，
而不是简单拼接。

---

## 2. 与已有实现的关系（先调研，再设计）

DSH 里已经有三块非常接近的积木，本插件是**组合 + 补齐**，不重复造轮子：

| 已有能力 | 位置 | 本插件怎么用 |
|---|---|---|
| 会话劈叉（fork） | `ctx.sessionController.fork({ sessionId })`，`atSeq` 省略时默认取**最后一个已完成轮次前缀**（`latestCompletedPrefixBoundary`） | 正好是「没有当前正在执行任务的部分」这一需求，直接复用，不自己算切点 |
| 进程内 fork 子代理 | `@deepseek-ai/dsh-subagent-fork-in-process`（README 明确写：子 agent 能看到所有**已完成轮次**、看不到**进行中轮次**，初始内容是一次性快照） | 语义验证：harness 作者已经把「切在 `turn/end`」当作正确语义；本插件把同样的切点用在一个**可见的顶层会话**上，而不是隐藏的子会话 |
| 直接投递任务 | `ctx.sessionController.prompt({ sessionId, requestId, mode, content })` → `agent.followup(message)`（`followup` 会唤醒 agent；`inject` 不会） | 副本刚 fork 出来是 idle，`followup` = 立即起一轮，**不进队列** |
| 等待收敛 | `ctx.sessionController.wait({ sessionId, timeoutMs, afterSeq })` → `reason: 'idle' \| 'input-required' \| 'timeout'` + 该区间内的 assistant 记录 | 合并前判定「两边都做完了」；`input-required` 用来发现「副本在等人回答」这种卡死 |
| 文件改动面 | `ctx.workspaceChanges.summary(sessionId, event.seq)`（对每条 `workspace/changes` 事件调用） | 算两个半球的改动交集 = 冲突表。它只在 Host 内存里（会话 dispose / Host 重启即失效），所以并用第二个来源：`tool/call` 的 `write`/`edit`/`str_replace` 参数里的路径 —— 冷会话也算得出来 |
| 跨会话引用 | `ctx.sessionReferenceResolver.prepare(...)`（`dsh-session-reference`，已在 profile 中启用） | 合并报告里给原会话带上「可展开查看副本原始过程」的引用，不重复灌 token |
| 同 Session 的 git 工作树 | `ctx.worktrees.create(agent, ...)`（experimental，默认未启用） | 写密集型分裂的**隔离模式**：每个半球一套 worktree + 分支，最后交给 git 合并 |

### 网上已有的同类做法（对照过的公开案例类型）

1. **git branch + worktree 并行 agent**（Conductor / Cursor background agents / GitHub Copilot coding agent / Devin 多 session）：
   每个并行任务一个分支或工作树，合并走 PR。→ 对应本设计的 `isolation: 'worktree'`。
2. **ChatGPT / Claude 的 "edit & retry"、分支对话**：在某条消息处开新分支，两条历史并存但不合并。
   → 本设计的差别正是**合并**这一步，且合并包含仲裁策略。
3. **LangGraph time-travel / checkpoint fork**：从某个 checkpoint 复制 state 再走不同路径，常用于 A/B 对比。
   → 对应 `atSeq` 切点语义；本设计用持久 event log 的切点，不自己存 state。
4. **分布式系统的 split-brain 处理**（etcd / Pacemaker / Cassandra：quorum、fencing、last-write-wins、人工仲裁）：
   → 对应 `policy: 'append' | 'synthesize' | 'vote'`，冲突文件永远**交人裁决**，绝不自动 last-write-wins。
5. **Tree-of-Thought / 多路采样再投票**：同题多解，择优合并。→ 对应 `vote` 策略（一个任务劈 N 份，取最优）。

> 说明：本轮会话里 `web_search` 因 API key 未配置返回 401，上述案例是对公开工具类型的既有认知归纳，
> 不是刚抓取的实时链接；插件本体不依赖这些外部实现。

---

## 3. 语义设计（关键决策）

### 3.1 切点：只带「已完成轮次」，不带进行中轮次

- 直接用 `sessionController.fork()` 的默认边界（最后一个 `turn/end` 之后的独立事件也算进去）。
- 为什么不能从 `turn/start` 处切：未闭合的 turn/step 无法作为合法历史重放；
  harness 在 fork 时会给「开放尾巴」补 synthetic fork closers，但**模型看到的仍然是一次干净结束**。
- 副本第一条消息里明确告知它：
  「你在 `t#N` 处被劈出来，父会话正在继续，你看不到它之后的内容；不要等兄弟半球。」

### 3.2 不排队：`followup` 而不是 `inject`

- `agent.inject()` 只是把消息塞进 inbox，**不会唤醒** agent → 会出现「明明分了任务却在排队」的观感。
- `prompt(mode:'queue')` 在副本 idle 时立即起轮；若副本恰好在跑，`mode:'steer'`（`agent.steer`）
  可以插进当前步；插件默认 `queue`，并在副本 busy 时回报 `deferred`，由调用方决定 steering。

### 3.3 副本是**一等公民会话**，不是子会话

- fork 出来的会话继承 `cwd`、继承 preset（`composeAgent(presetForObservation(source))`）、
  并 `workspace.attachSession()` → 侧栏里就能看见，可以点进去继续聊、可以插话、可以单独 `/merge`。
- header 里只有 `isSeeded` + `inheritedEventCount`（`parentSession` 只给 subagent 用，普通 fork 不写），
  所以**血缘必须由插件自己落到日志里**——见 3.5。

### 3.4 合并 = 报告 + 仲裁，不是「把两份文字拼起来」

合并报告固定四段：

1. **各半球结论**：`sessionId` / 标签 / 最终 assistant 文本（截断上限可配）/ 轮次数 / token 用量。
2. **改动面交集（冲突表）**：两边都写过的文件 → 状态 `CONFLICT`；只有一边写 → `CLEAN`；
   都写但内容 diff 相同 → `DUPLICATE`（可安全丢弃一份）。
3. **仲裁策略**：
   - `append`（默认）：只把两份结论并列交给原会话，由原会话自己决定；最保守。
   - `synthesize`：再起一个「合并脑」（第三个 fork，只读历史）专门产出统一结论。
   - `vote`：同题多解时按一致性投票，输出多数答案 + 少数派附注。
4. **可展开的过程引用**：用 `sessionReferenceResolver` 引用半球会话，不重放其全过程。

**永不自动改文件**：冲突只报告，写操作交回人或原会话 agent。这是 split-brain 场景唯一安全的边界。

### 3.5 状态从日志推导（升级安全性）

硬约束：不能往会话日志里写自定义 `type`（老读者只接受带 `ignorable: true` 的事件，
而 `Session.append()` 无法设置它；`appendPluginRecord()` 是 experimental 专用，格式迁移只尽力保留）。

所以：

- **副本侧**：briefing 首条用户消息带机读标记
  `[split-brain role=branch group=<groupId> origin=<sessionId> label=<A|B|…> cut=<seq>]`。
  这条消息本身就是 durable `user/message` → 投影折叠可读，`cut` 顺带给出「这个半球自己的区间起点」。
- **原会话侧**：`/split`、`/merge` 的结果文本（durable `command/done`）与 `split_brain` 工具结果
  （durable `tool/result`）都带成员行
  `[split-brain role=origin group=<groupId> cut=<seq> members=<sid|A,…>]`；
  合并报告正文也带同一行，所以原会话折叠出的成员表会随每次合并刷新。
- 插件把折叠结果注册为 **session projection** `key: 'splitBrain'`，声明 `wire.view`，
  于是 Client 拿到的是 Host 已算好的值（`useProjection('splitBrain')`），浏览器不自己翻日志。
- **继承前缀的标记要挡住**：折叠的 `init(header, inheritedEventCount)` 把 `inheritedEventCount`
  存成地板 `floor`，`apply` 只看 `event.seq >= floor` —— 否则副本会把**父会话**某次 `/split`
  留下的 origin 标记认成自己的血缘。返回同一引用（`Object.is`）表示无变化，零下游开销。
- **不建私有表**。实现时一度打算用 `storageDomain` 存 group 记录，后来判掉：成员、标签、切点、
  任务原文、改动面、收口状态**全都能从两侧日志现推**，多一张 `split_brain` 表就多一个
  「缓存与日志不一致」的 bug 面（而且 record schema 要真 zod，等于给安装期加依赖）。
  「日志是唯一真相源」落到代码上就是**零私有状态**。
- `stateSchema` / `viewSchema` 在 drive 里只被调 `.parse()`，所以给一个**永不抛**的等价物
  （坏值修回初值、坏成员剔除）：既守住契约，又不用把 `@deepseek-ai/schemastery` 变成硬依赖，
  冷读遇到陈旧 checkpoint 也不会因为抛错而打不开会话。

### 3.6 隔离模式（决定冲突有多贵）

| 模式 | 说明 | 适用 |
|---|---|---|
| `shared`（默认） | 副本与原会话共用同一工作目录 | 调研、分析、写文档、审查等**只读**任务 |
| `worktree` | 每个半球一个 git worktree + 分支，合并交 git（需启用 experimental worktree 行；不可用时明确降级并告知） | 并行改代码 |

`shared` 模式在 briefing 里强制提示：「你和兄弟半球共享工作目录，避免写同一文件」。

### 3.7 一个操作，两个调用方

`split / status / merge / abort` 只在 Host 侧实现一次（`apply` 内的四个闭包，共用同一套
`readEvents` / `filesOf` / 标记生成），两条入口共用：

- 模型侧：`split_brain` 工具（`action` 参数）。
- 人侧：`/split`、`/split-status`、`/merge`、`/split-abort` 四条 slash command（浏览器里的按钮走 command 通道）。

### 3.8 触发边界：默认不分，闸门可执行

脑裂的成本是 **N 份完整上下文 + N 个用户可见的会话窗口**，收益只有**互相独立**的并行才换得来；
有依赖链时并行通常更慢（交接与合并的开销照付，省下的时间没多少）。所以边界的设计原则是
**把"不分"设为默认，把"分"变成需要举证的决定**，而不是给模型一个随时可用的并行按钮。

边界做两层，缺一层都会失效：

| 层 | 载体 | 作用 |
| --- | --- | --- |
| 判据 | `TRIGGER_POLICY` 常量 → 工具描述第一段 | 模型唯一读得到的准则；先给否决默认，再给放行条件 |
| 闸门 | `splitGate`（模块级**纯函数**，`split()` 入口调用） | 不合规直接拒，返回自带下一步的 code；可进 selfcheck 验 |

`splitGate` 只拦 `action=split`；`status / merge / abort` 是收口动作，永远放行——
拦收口只会把半球变成悬空进程。判定次序：

1. `autoTrigger: off` → `auto-trigger-off`（人和模型都拦，profile 级总开关）；
2. 发起者是半球且 `allowNestedSplit: false` → `branch-no-resplit`（血缘成树后合并目标与冲突面会乱）；
3. 模型侧且 `autoTrigger: manual` → `manual-only`（只有人按 `/split` 才开）；
4. 上一组既没 `merge` 也没 `abort` → `group-open`（投影只存一个 `groupId`，新 origin 标记会盖掉旧组成员表，
   旧组从此合不回来；收口判据 = 日志里出现过 `# 脑裂合并报告` 或 `已中止脑裂组 <groupId>`，**人和模型一样拦**）；
5. 模型侧 `reason` 缺失或短于 8 字 → `needs-reason`（人侧不要求：按下 `/split` 本身就是意图证据）。

`source` 由宿主入口决定（工具=`tool`，命令=`command`），**不进 `args`**，
`checkArgs` 的白名单也没有它，所以模型传 `source:'command'` 会当未知参数拒掉——闸门不能靠自称人侧绕过。

三类正例与「挂起长活」这条最容易被误解：切点是**最后一个已完成轮次**，进行中那一轮不进副本，
所以"把当前任务挂起来"不是把正在跑的这一轮搬走，而是**把它重写成一条自包含任务交给半球**：
`task` 里必须带材料（内容、路径、已确认口径），原会话那一轮做完分裂动作就收尾、立刻腾出来接下一个问题。
交接后原会话不得再碰同一批文件（`shared` 会撞），必须同写就 `isolation: worktree`。

---

## 4. 生命周期状态机

```
pending ──(prompt accepted)──▶ running ──(wait: idle)──▶ settled
   │                                │                        │
   │                                ├──(wait: input-required)▶ waiting-user
   └──(fork 失败 / 无已完成轮次)───▶ failed                   │
                                     └──(merge)──▶ merged ◀───┘
                                     └──(abort)──▶ aborted
```

组（group）状态 = 成员状态聚合：`splitting → running → all-settled → merging → merged`，
外加 `partial`（有成员 failed/aborted，允许「只合成功的那几份」）。

---

## 5. 界面（复用宿主槽位，不做 iframe 页面）

- `conversation.composer.dock`：**半球条**（origin 与每个副本窗口都显示）
  - 每个成员一行：标签、状态点（running / settled / waiting-user / conflict）、
    「打开这个半球」→ `ctx.uiWorkspace.openSession(id)`；
  - origin 上多一行「N/M 已完成 → 运行 /merge」。
  - 只读投影值 + `useSessionStatus()` 的宿主状态，主题只用 `--dsw-alias-*` token。
- 侧栏 `sidebar.panellist` + `main`（第二版）：**脑裂面板**，列出本 workspace 全部分裂组、
  每组改动文件与冲突计数，一键跳到 `/merge`。
- 副本的会话标题：`<原标题> ⨯ A`，一眼认得出血缘。

第一版只做 composer dock 条（最小可见闭环），面板列为第二版。

---

## 6. 配置（写在 profile 的 `cordis.patch.yml`，用户层可覆盖）

```yaml
- insert:
    - id: dsh-split-brain
      name: '@local/dsh-split-brain'
      config:
        maxBranches: 4          # 单次分裂最多几个半球
        labelPrefix: '⨯'        # 标题血缘标记
        briefingExtra: ''        # 追加到 briefing 的项目纪律
        resultCharBudget: 4000   # 每个半球最终结论的截断长度
        mergeTimeoutMs: 600000   # wait 收敛上限
        isolation: 'shared'      # shared | worktree
        policy: 'append'         # append | synthesize | vote
        autoTrigger: 'ask'       # ask | manual | off —— split 的触发闸门
        allowNestedSplit: false  # 半球内部再劈下一级
```

---

## 7. 已知风险与取舍

1. **KV cache 复用**：副本继承逐字节相同前缀，provider/model 不变时首轮很便宜；
   briefing 放在继承历史**之后**（与 harness fork 子代理一致），避免污染可复用前缀。
2. **两边真的会互相看不见**：briefing 明确写「快照式分裂，不会实时同步」，
   避免模型以为能共享上下文。
3. **同一工作目录并发写**：默认 `shared` 只适合只读任务；冲突表 + 不自动写文件是安全阀。
4. **副本可能问用户问题**：`input-required` 状态如实上报，条上显示「在等人」，不静默等待。
5. **原会话被压缩（compaction）**：投影折叠只看标记行，压缩后旧事件仍在日志里，
   值可重放；`stateVersion` 改动即丢弃陈旧 checkpoint。
6. **restart-required**：替换已安装 bundle 需重启 Host 才会加载新的 JS 代际；
   Client 半边靠 `dsh dev:web` watcher + 页面刷新。
7. **不实现的事**：不自动 git commit/merge（交回人或 git 工具）、不做跨机器分裂、
   不伪装成 `spawn_teammate`（team 是协作，脑裂是**同一历史的并行分身 + 事后仲裁**）。
