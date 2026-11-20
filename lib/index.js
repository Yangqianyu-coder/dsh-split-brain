/**
 * 脑裂（Split-brain）· Host 半边。
 *
 * `/split`（或 `split_brain` 工具）在当前对话的**最后一个已完成轮次**处劈出一个
 * 用户可见的独立会话（半球）：它继承已完成的对话历史，但**看不到正在进行的那一轮任务**；
 * 任务用 `prompt(mode:'queue')` 直接投递，半球此刻是 idle 的，所以立即起轮、**不进队列**；
 * 两边都收口后 `/merge` 把各半球的最终结论 + 文件改动面合成一份合并报告送回原会话，
 * 并显式列出多个来源都写过的文件（脑裂冲突面）。
 *
 * 三条硬约束决定了这里的每个选择（详见 DESIGN.md）：
 *  1. **会话日志是唯一真相源**。不往日志里写自定义事件 type（老读者只接受带
 *     `ignorable` 的事件，`append()` 给不了这个标记），所以血缘写成**机读标记行**放进
 *     本来就要落盘的内容里：半球简报里的 `role=branch`，工具/命令结果与合并报告里的
 *     `role=origin`。重启、换版本、清缓存都不丢。
 *  2. **血缘推导交给 session projection**（`key: 'splitBrain'`，带 `wire.view`）：
 *     浏览器拿到的是 Host 已经算好的整值，插件零 Client 折叠代码。
 *  3. **一个操作两套调用方**：`split / status / merge / abort` 只实现一次，
 *     模型侧走 `split_brain` 工具，人侧走 `/split`、`/merge`、`/split-status`、`/split-abort`。
 *  另外：本插件**永不自动改文件**，冲突只报告，取舍交回人或原会话。
 *
 * 依赖只有 cordis 服务名与 `node:crypto`，不 import 任何 dsh 包：profile 里没有
 * 那些包时安装才不会失败，配置也只需在 patch 里给普通字段。
 *
 * @module @local/dsh-split-brain
 */
import { randomUUID } from 'node:crypto'

export const name = 'dsh-split-brain'

/** 少一个服务都不该半激活（那样工具会撒谎），所以这些是硬依赖。 */
export const inject = ['tools', 'commands', 'agents', 'sessionController', 'sessionQuery', 'sessionProjections']

const DEFAULTS = {
  /** 一次分裂最多几个半球 */
  maxBranches: 4,
  /** 半球标题里的血缘标记 */
  labelPrefix: '⨯',
  /** 合并报告里每个半球最终结论的截断长度 */
  resultCharBudget: 4000,
  /** 合并前等待半球收口的上限（毫秒）；0 表示不等 */
  mergeTimeoutMs: 600000,
  /** shared = 共用工作目录（只读任务安全）；worktree = 每个半球一套 git worktree */
  isolation: 'shared',
  /** append = 并列采纳；synthesize = 合成一份；vote = 同题多解投票 */
  policy: 'append',
  /** 追加到每份半球简报里的项目纪律 */
  briefingExtra: '',
  /**
   * 触发闸门（只管 `action=split`；status / merge / abort 这些收口动作永远放行）：
   *  ask    = 默认。模型可自发分裂，但必须写 reason 说明这是「独立多路」场景。
   *  manual = 模型一律不自发分裂，只有人在输入框 `/split` 才开半球。
   *  off    = 连 `/split` 也关掉，本 profile 不用脑裂。
   */
  autoTrigger: 'ask',
  /** 半球内部能否再劈下一级半球。默认禁止：血缘变树以后，合并目标和冲突面都会混乱。 */
  allowNestedSplit: false,
}

// ---------------------------------------------------------------------------
// 触发边界：模型侧读得到的准则 + 可执行的闸门
// ---------------------------------------------------------------------------

/**
 * 刻意写成「默认不分」。脑裂的成本是 N 份完整上下文 + N 个用户可见的会话窗口，
 * 收益只有**互相独立**的并行才换得来；有依赖链时并行反而更慢。
 * 这段文字直接进工具描述，是模型唯一的判定依据，所以按「先给否决默认，再给放行条件」排序。
 */
const TRIGGER_POLICY = [
  '【触发边界 · 默认不脑裂】绝大多数活在一个会话里顺序做完最好，分裂是例外不是手段。',
  '三条同时成立才分：① 有 ≥2 路互相独立的子问题（任何一路的结果都不是另一路的前提）；'
  + '② 每路都能各自跑到一份可独立评审的结论，不是一句查询；'
  + '③ 并行换来实打实的收益——省墙钟时间、多版方案对照、多视角评审，或者用户明说「分头、并行、同时、给我几版」。',
  '该分的三类：(a) **挂起长活**——用户交来一件耗时且与后续提问无关的事（整理表格、长文汇总、全量分析、批量处理互不相关的文件），'
  + '又不想干等、不想打断当前对话：把这件活重写成一条自包含任务交给半球，原会话立刻腾出来接他下一个问题；'
  + '(b) 一份产出需要多视角评审或多版方案对照投票；(c) 几个互不相关、各自要查完才出结论的子题。',
  '交接的硬约束：切点只带**已完成轮次**，半球看不到正在执行的这一轮，也看不到原会话之后的内容。'
  + '所以交给它的 task 必须自带材料：把要处理的内容、文件路径、已确认的口径写进 task 正文或 @文件，别写「按上面那份继续」。'
  + '分出去以后原会话别再碰同一批文件；必须同写就 isolation=worktree。',
  '更该用别的工具：读文件与检索 → read / grep；一两个子任务或单件小事 → subagent；'
  + '成百文件的无状态扇出、批量迁移 → workflow；长期协作与共享任务板 → Team。',
  '不要分：子问题之间有依赖链；只是想要多一个答案；用户在提问、要解释代码、要一份文档；'
  + '一件半分钟能做完的小事（分裂的往返比做完还慢）；不可逆或对外的动作（删除、推送、发布、发送、付款）；'
  + '本会话还没有已完成轮次，或已有未收口的脑裂组。',
  '拿不准就不分，宁可 2 路不要 4 路凑数。split 必须带 reason 说清独立性在哪；'
  + '分完必须 merge 或 abort 收口，不留悬空半球；半球内部不再二次分裂。',
].join('\n')

/**
 * 分裂前的闸门。纯函数，`test/selfcheck.mjs` 可以直接验，不依赖宿主服务。
 * 返回 `undefined` 放行，否则 `{ code, message }`；message 写给模型看，必须自带下一步。
 * @param input - 判定输入。
 * @param input.source - `'tool'` = 模型经 `split_brain` 调用；`'command'` = 人经 `/split` 调用。
 * @param input.role - 发起者在脑裂组里的身份：`'branch'` 是半球，`'origin'` / `null` 是原会话。
 * @param input.reason - 模型给的「为什么这属于脑裂场景」；人侧不要求。
 * @param input.autoTrigger - `'ask'` | `'manual'` | `'off'`。
 * @param input.allowNestedSplit - 是否允许半球再劈下一级。
 * @param input.openGroup - 是否已有未收口且未合并的脑裂组。
 */
function splitGate ({ source = 'tool', role = null, reason, autoTrigger, allowNestedSplit, openGroup }) {
  const level = ['ask', 'manual', 'off'].includes(autoTrigger) ? autoTrigger : DEFAULTS.autoTrigger

  if (level === 'off') {
    return { code: 'auto-trigger-off', message: '本 profile 已把脑裂关掉（config.autoTrigger=off）。要用就在 patch 里改回 ask 或 manual。' }
  }

  if (role === 'branch' && allowNestedSplit !== true) {
    return { code: 'branch-no-resplit', message: '你自己就是半球，不再往下劈：血缘一旦成树，合并目标和冲突面就乱了。把这份任务做完按交回协议回结论；确实还要更多解法，让用户回原会话再分。' }
  }

  if (source === 'tool' && level === 'manual') {
    return { code: 'manual-only', message: 'config.autoTrigger=manual：模型不自行分裂半球，只有用户在输入框执行 `/split <任务>` 才开。这条消息里用户没明确要求分头并行，就照旧顺序做完。' }
  }

  // 未收口的旧组会盖掉新血缘（投影只有一个 groupId），人和模型一样拦。
  if (openGroup === true) {
    return { code: 'group-open', message: '上一个脑裂组还没收口，一次只保持一组，否则新旧血缘会互相盖掉。先 `/split-status` 看一眼，再 split_brain(action="merge") 收拢或 action="abort" 中止，然后才允许新分裂。' }
  }

  // reason 只向模型要：人按下 /split 本身就是意图的证据。
  if (source !== 'tool') return undefined

  const text = typeof reason === 'string' ? reason.trim() : ''
  if (text.length < 8) {
    return { code: 'needs-reason', message: 'action=split 需要 reason：一句话说清各路为什么互相独立、并行换来什么。写不出这句，就说明这活不该分，直接顺序做完。' }
  }

  return undefined
}

// ---------------------------------------------------------------------------
// 标记：血缘的唯一 durable 载体
// ---------------------------------------------------------------------------

const LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']
const BRANCH_RE = /\[split-brain\s+role=branch\s+group=(\S+)\s+origin=(\S+)\s+label=(\S+)\s+cut=(\d+)\]/
const ORIGIN_RE = /\[split-brain\s+role=origin\s+group=(\S+)\s+cut=(\d+)\s+members=([^\]]*)\]/

function branchMarker (groupId, originSessionId, label, cutSeq) {
  return `[split-brain role=branch group=${groupId} origin=${originSessionId} label=${label} cut=${cutSeq}]`
}

/**
 * 成员行：出现在工具/命令结果与送回原会话的合并报告里，原会话靠它折叠出自己的半球列表。
 * @param entries - `[sessionId, label]` 对。
 */
function originMarker (groupId, cutSeq, entries) {
  const members = entries.map(([id, label]) => `${id}|${label}`).join(',')
  return `[split-brain role=origin group=${groupId} cut=${cutSeq} members=${members}]`
}

function parseOriginMembers (raw) {
  return String(raw).split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const at = item.indexOf('|')
      return at < 0 ? { id: item, label: item.slice(-4) } : { id: item.slice(0, at), label: item.slice(at + 1) }
    })
}

/**
 * 递归收集事件里的正文。两条规矩缺一不可：
 *  - 只有 `text` 键下的字符串才是内容，否则 `{type:'text', text:'…'}` 会把 "text" 当正文抽进合并报告；
 *  - 命中 text 的块不再深入，同一块的其它字段（type、citations 等）不是内容。
 * 不认死某一种嵌套形状：事件结构换样式也不影响血缘折叠。
 */
function textOf (value, out = []) {
  if (typeof value === 'string' || value == null || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    for (const item of value) textOf(item, out)
    return out
  }
  if (typeof value.text === 'string') {
    out.push(value.text)
    return out
  }
  for (const child of Object.values(value)) textOf(child, out)
  return out
}

/**
 * 与 harness fork 的默认切点同一算法：最后一个 `turn/end`，并把它之后仍属独立事件
 * （没有新的 turn/start、append 的 user/message、inbox splice）的尾巴一并带上。
 * @param events - 会话事件数组（seq 即下标）。
 * @returns 包含式切点 seq；没有任何已完成轮次时 undefined。
 */
function completedPrefixBoundary (events) {
  let lastEnd
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'turn/end') { lastEnd = events[i]; break }
  }
  if (lastEnd === undefined) return undefined
  let boundary = lastEnd.seq
  for (const next of events.slice(boundary + 1)) {
    if (next.type === 'turn/start') break
    if (next.type === 'user/message' && next.surfaceOp === 'append') break
    if (next.type === 'agent/inbox/spliced') break
    boundary = next.seq
  }
  return boundary
}

/** 这个区间里最后一条 assistant 文本，就是半球交回的结论。 */
function finalAssistantText (events, fromSeq) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type !== 'assistant/message' || !(event.seq >= fromSeq)) continue
    const text = textOf(event.message?.content ?? event.message ?? event).join('\n').trim()
    if (text) return text
  }
  return ''
}

/** 这个区间里第一条 user 消息：半球的简报（含它的任务）。 */
function firstOwnUserText (events, fromSeq) {
  for (const event of events) {
    if (event.type !== 'user/message' || !(event.seq >= fromSeq)) continue
    const text = textOf(event.content ?? event.message ?? event).join('\n')
    if (text.trim()) return text
  }
  return ''
}

/** 从简报里取出「## 你的任务」那一段；取不到就退回全文摘要。 */
function taskFromBriefing (briefing) {
  const start = briefing.indexOf('## 你的任务')
  if (start < 0) return ''
  const rest = briefing.slice(start + '## 你的任务'.length)
  const end = rest.search(/\n##\s/)
  return (end < 0 ? rest : rest.slice(0, end)).trim()
}

/** 这个区间里写过的文件：从 tool/call 参数取，冷会话也能算。 */
function changedFiles (events, fromSeq) {
  const paths = new Set()
  const writers = new Set(['write', 'edit', 'str_replace', 'apply_patch', 'write_file'])
  for (const event of events) {
    if (event.type !== 'tool/call' || !(event.seq >= fromSeq)) continue
    if (!writers.has(event.name)) continue
    let args
    try { args = JSON.parse(event.arguments) } catch { continue }
    for (const key of ['file_path', 'path', 'target']) {
      const value = args?.[key]
      if (typeof value === 'string' && value.trim()) paths.add(value.replace(/\\/g, '/'))
    }
  }
  return [...paths].sort()
}

/** 还欠一轮吗（有未闭合 turn）。 */
function hasOpenTurn (events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const type = events[i].type
    if (type === 'turn/end') return false
    if (type === 'turn/start') return true
  }
  return false
}

/**
 * 合成闭合事件：`forked` 是 fork 造种子时给源会话那个未闭合 turn 补的刀（只有种子带），
 * `interrupted` 是崩溃后补闭 / session-query 冷读时合成的。
 * 它们都不是「半球真的干完了一轮」，必须从轮次计数里剔除 —— 否则刚劈完的副本
 * 会因为切点那条合成 closer 被立刻判成 settled。（这条修正是本插件自己劈出的半球 A 审查出来的。）
 * @param event - 一个 `turn/end` 事件。
 */
function syntheticCloser (event) {
  const kind = event?.reason?.kind
  return kind === 'forked' || kind === 'interrupted'
}

/** 真实完成的轮次数。 */
function realTurns (events) {
  return events.filter((event) => event.type === 'turn/end' && !syntheticCloser(event)).length
}

// ---------------------------------------------------------------------------
// session projection：日志 → 血缘（并 wire 给浏览器）
// ---------------------------------------------------------------------------

/**
 * 投影状态形状。harness 的 projection drive 只对 stateSchema / viewSchema 调 `.parse()`
 * （见 dsh-session-projection 的 restore / viewCheckpoint / viewCell 三处），
 * 所以这里给一个**永不抛**的等价物：坏值退回初值，冷读永不断，
 * 也就不用把 zod（@deepseek-ai/schemastery）变成安装期硬依赖。
 * @param repair - 把任何不可信输入修成合法值。
 */
function totalSchema (repair) {
  return {
    parse (value) { return repair(value) },
    safeParse (value) { return { success: true, data: repair(value) } },
  }
}

function newState (floor) {
  return { floor, groupId: null, role: null, originSessionId: null, label: null, cutSeq: null, members: [] }
}

function repairState (value) {
  if (!value || typeof value !== 'object') return newState(0)
  const members = Array.isArray(value.members)
    ? value.members.filter((item) => item && typeof item.id === 'string' && item.id)
      .map((item) => ({ id: item.id, label: typeof item.label === 'string' ? item.label : String(item.id).slice(-4) }))
    : []
  return {
    floor: Number.isFinite(value.floor) ? value.floor : 0,
    groupId: typeof value.groupId === 'string' ? value.groupId : null,
    role: value.role === 'branch' || value.role === 'origin' ? value.role : null,
    originSessionId: typeof value.originSessionId === 'string' ? value.originSessionId : null,
    label: typeof value.label === 'string' ? value.label : null,
    cutSeq: Number.isFinite(value.cutSeq) ? value.cutSeq : null,
    members,
  }
}

const projectionDefinition = {
  key: 'splitBrain',
  stateVersion: 1,
  stateSchema: totalSchema(repairState),
  init (_header, inheritedEventCount) {
    return newState(Number(inheritedEventCount ?? 0) || 0)
  },
  apply (state, event) {
    // 继承自父会话前缀里的标记讲的是父会话的血缘，不是这个会话的。
    if (!event || typeof event.seq !== 'number' || event.seq < state.floor) return state
    const hay = textOf(event).join('\n')
    if (!hay.includes('[split-brain')) return state
    const branch = BRANCH_RE.exec(hay)
    if (branch) {
      return { ...state, groupId: branch[1], role: 'branch', originSessionId: branch[2], label: branch[3], cutSeq: Number(branch[4]) }
    }
    const origin = ORIGIN_RE.exec(hay)
    if (origin) {
      return { ...state, groupId: origin[1], role: 'origin', cutSeq: Number(origin[2]), members: parseOriginMembers(origin[3]) }
    }
    return state
  },
  wire: {
    viewSchema: totalSchema((value) => (value && typeof value === 'object' ? repairState(value) : null)),
    // 复用 state 引用：只有标记事件换引用，其它事件零下游开销。
    view (state) { return state.groupId === null ? null : state },
    summary: true,
  },
}

// ---------------------------------------------------------------------------
// 插件本体
// ---------------------------------------------------------------------------

/** 只给自检脚本用的内部件；宿主只读 `apply` / `inject` / `name` / `Config`。 */
export const __internals = {
  completedPrefixBoundary, branchMarker, originMarker, BRANCH_RE, ORIGIN_RE,
  parseOriginMembers, projectionDefinition, taskFromBriefing, firstOwnUserText,
  changedFiles, hasOpenTurn, syntheticCloser, realTurns, finalAssistantText, textOf,
  splitGate, TRIGGER_POLICY, DEFAULTS,
}

export async function apply (ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) }
  const controller = ctx.sessionController
  const query = ctx.sessionQuery
  const agents = ctx.agents
  const store = ctx.get('sessions')
  const titles = ctx.get('sessionTitle')

  const projection = await ctx.sessionProjections.register(projectionDefinition)
  ctx.effect(() => () => {
    try { Promise.resolve(projection.dispose()).catch(() => {}) } catch { /* 已经掉了 */ }
  })

  const now = () => Date.now()
  const signalOf = (signal) => signal ?? new AbortController().signal

  async function readEvents (sessionId) {
    const session = store?.get?.(sessionId)
    if (session?.snapshotEvents !== undefined) return session.snapshotEvents()
    const observed = await query.observeSession(sessionId)
    return observed.events
  }

  function foldOf (session) {
    try { return projection.stateOf(session) } catch { return undefined }
  }

  function titleOf (agent) {
    try { return titles?.get?.(agent.session)?.title ?? null } catch { return null }
  }

  /**
   * 这个会话在这个区间里改过哪些文件。
   * 两个来源并用：`workspace/changes` 事件 + 工作区改动记录（准确，但只在 Host 内存里，
   * 会话被 dispose 或 Host 重启就没了）；以及 `tool/call` 参数（冷会话也算得出来）。
   * @param events - 该会话的完整事件数组。
   * @param fromSeq - 只算这个 seq 之后的改动（半球就是它自己的简报 seq，原会话就是切点之后）。
   */
  function filesOf (events, fromSeq, sessionId) {
    const paths = new Set(changedFiles(events, fromSeq))
    const changes = ctx.get('workspaceChanges')
    if (changes !== undefined) {
      for (const event of events) {
        if (event.type !== 'workspace/changes' || !(event.seq >= fromSeq)) continue
        let summary
        try { summary = changes.summary(sessionId, event.seq) } catch { continue }
        for (const file of summary?.files ?? []) if (file?.display) paths.add(String(file.display).replace(/\\/g, '/'))
      }
    }
    return [...paths].sort()
  }

  /**
   * 过程引用：`@[label](dsh-session:<base64url(sessionId)>)`。
   * session-reference 装上后，原会话点一下就能把那半球的真实过程拉进上下文（快照式，3 个为上限），
   * 没装也只是普通文本，不影响合并。
   */
  function referenceMention (sessionId, label) {
    try {
      return `@[半球 ${label}](dsh-session:${Buffer.from(String(sessionId), 'utf8').toString('base64url')})`
    } catch {
      return `半球 ${label} 会话 \`${sessionId}\``
    }
  }

  /**
   * 组 = 从日志现推的视图，没有任何插件私有记忆。
   * origin 视角：自己的 origin 标记 → 成员表；
   * branch 视角：自己的 branch 标记 → 回到 origin 再读它的 origin 标记。
   */
  async function readGroup (agent) {
    const own = foldOf(agent.session)

    if (own?.role === 'origin' && own.groupId) {
      return { groupId: own.groupId, originSessionId: agent.id, originTitle: titleOf(agent), cutSeq: own.cutSeq ?? 0, entries: own.members, role: 'origin' }
    }

    if (own?.role === 'branch' && own.originSessionId) {
      const originAgent = agents.get(own.originSessionId)
      const originEvents = await readEvents(own.originSessionId).catch(() => [])
      let entries = []
      let groupId = own.groupId
      for (const event of originEvents) {
        const found = ORIGIN_RE.exec(textOf(event).join('\n'))
        if (found && (found[1] === groupId || !groupId)) { groupId = found[1]; entries = parseOriginMembers(found[3]) }
      }
      if (entries.length === 0) entries = [{ id: agent.id, label: own.label }]
      return {
        groupId,
        originSessionId: own.originSessionId,
        originTitle: originAgent ? titleOf(originAgent) : null,
        cutSeq: own.cutSeq ?? 0,
        entries,
        role: 'branch',
      }
    }

    return undefined
  }

  /** 把任务交给一个 idle 的半球：followup 会唤醒 agent，所以立即开跑，不排队。 */
  function dispatch (sessionId, text, signal) {
    return controller.prompt({
      sessionId,
      requestId: `split-brain-${randomUUID()}`,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, signalOf(signal))
  }

  function buildBriefing ({ groupId, label, originSessionId, originTitle, cutSeq, task, mode, policy, extra }) {
    const where = mode === 'worktree'
      ? '你有一个**独立的 git worktree**，文件改动互不干扰，合并时交给 git。'
      : '你和原会话**共用同一个工作目录**：能只读就别写文件；必须写就新建自己的文件，绝不改兄弟半球可能同时改的文件。'
    return [
      branchMarker(groupId, originSessionId, label, cutSeq),
      '',
      `你是一次**脑裂（split-brain）**产生的半球 ${label}：不是后台子任务，而是一个和原对话一模一样的独立对话窗口。`,
      `你在原对话 ${originTitle ?? ''}（\`${originSessionId}\`）的 seq=${cutSeq} —— 也就是最后一个已完成轮次 —— 处被劈出来：`,
      '- 那份历史是你的初始内容，**正在执行的那一轮没有被复制进来**；',
      '- 原会话从这一刻起继续跑，它之后写下的任何东西你都看不到，**不要试图同步**；',
      `- 其它半球也在并行执行同样的机制，你看不到它们，也**不要等它们**。${where}`,
      '',
      '## 你的任务',
      task,
      '',
      '## 交回协议（原会话执行 /merge 时收集你的结论）',
      '1. 直接开工：这份任务本身就是分裂的产物，立即执行就是正确行为，不用先问要不要分。',
      '2. 结束时用**一条**最终回复交回：先「结论」（3-8 行可验证的事实，不要客套），再「改动面」（列出你新建或修改的文件路径，没有就写「无」），最后「风险与未决」。',
      '3. 需要人回答就正常提问；合并方会把你标成 waiting-user，不算失败。',
      `4. 合并仲裁政策：${policy}。`,
      '5. 你不是调度器：不要在半球里再劈半球（`split_brain` 的 split 会被闸门拒成 `branch-no-resplit`），也不要等原会话补给你新信息——它分裂后的轮次你看不见。任务里缺材料就按现有材料给出「够用版」结论，并把缺口写进「风险与未决」。',
      extra ? `## 项目纪律\n${extra}` : '',
    ].join('\n')
  }

  // -- split --------------------------------------------------------------

  /**
   * 上一组是否已**关闭**：合并报告进过原会话，或者同组被中止过。两种都算收口。
   * 只认 `merged` 会把 abort 掉的组永远卡住；不认「已 settle 但未 merge」又会允许
   * 新 origin 标记盖掉旧组的成员表（投影只有一个 groupId），旧组从此合不回来。
   */
  async function groupClosed (agent, groupId) {
    const events = await readEvents(agent.id).catch(() => [])
    for (const event of events) {
      const text = textOf(event).join('\n')
      if (text.includes('# 脑裂合并报告') || text.includes(`已中止脑裂组 ${groupId}`)) return true
    }
    return false
  }

  async function split ({ agent, tasks, isolation, policy, signal, source = 'tool', reason }) {
    const list = (Array.isArray(tasks) ? tasks : [tasks])
      .map((item) => (typeof item === 'string'
        ? { task: item.trim(), label: undefined }
        : { task: String(item?.task ?? '').trim(), label: item?.label ? String(item.label).slice(0, 12) : undefined }))
      .filter((item) => item.task)
    if (list.length === 0) return { ok: false, code: 'empty-task', message: '每个半球都要有一句任务描述。' }
    if (list.length > config.maxBranches) return { ok: false, code: 'too-many-branches', message: `一次最多 ${config.maxBranches} 个半球（改 config.maxBranches）。` }

    // 触发闸门：模型侧（split_brain）与人侧（/split）共用同一份守卫，只在 split 上生效。
    const own = foldOf(agent.session)
    let openGroup = false
    if (own?.role === 'origin' && own.groupId) openGroup = !(await groupClosed(agent, own.groupId))
    const gate = splitGate({
      source,
      role: own?.role ?? null,
      reason,
      autoTrigger: config.autoTrigger,
      allowNestedSplit: config.allowNestedSplit,
      openGroup,
    })
    if (gate !== undefined) return { ok: false, code: gate.code, message: gate.message }

    const events = await readEvents(agent.id)
    const cutSeq = completedPrefixBoundary(events)
    if (cutSeq === undefined) {
      return { ok: false, code: 'no-completed-turn', message: '当前会话还没有**已完成轮次**可劈：脑裂只复制已经结束的对话，正在执行的这一轮不进副本。等这一轮落到 turn/end（比如我把这段回答说完）之后再分裂。' }
    }

    const mode = isolation ?? config.isolation
    const wantWorktree = mode === 'worktree'
    const worktrees = ctx.get('worktrees')
    if (wantWorktree && worktrees === undefined) {
      return { ok: false, code: 'worktree-unavailable', message: 'worktree 隔离需要启用 @deepseek-ai/dsh-experimental-tool-worktree 那组行；当前 profile 没有。改用 shared，或先启用该 bundle。' }
    }

    const groupId = `sb-${randomUUID().slice(0, 8)}`
    const originTitle = titleOf(agent)
    const chosenPolicy = policy ?? config.policy
    const branches = []
    const failures = []

    for (let index = 0; index < list.length; index++) {
      const label = list[index].label ?? LABELS[index] ?? String(index + 1)
      let forked
      try {
        forked = await controller.fork({ sessionId: agent.id })
      } catch (error) {
        failures.push({ label, reason: error instanceof Error ? error.message : String(error) })
        continue
      }
      const branchId = forked.sessionId

      // 标题带出血缘；改名失败不影响功能，只是侧栏不好认。
      try {
        await controller.rename({ sessionId: branchId, title: `${originTitle ?? String(agent.id).slice(-6)} ${config.labelPrefix} ${label}` })
      } catch { /* 没有 title 服务的 profile：忽略 */ }

      if (wantWorktree) {
        try {
          const branchAgent = agents.get(branchId)
          if (branchAgent !== undefined) await worktrees.create(branchAgent, {}, signalOf(signal))
        } catch (error) {
          failures.push({ label, reason: `worktree 失败：${error instanceof Error ? error.message : String(error)}` })
        }
      }

      const briefing = buildBriefing({
        groupId, label, originSessionId: agent.id, originTitle, cutSeq,
        task: list[index].task, mode: wantWorktree ? 'worktree' : 'shared',
        policy: chosenPolicy, extra: config.briefingExtra,
      })

      let status = 'running'
      try {
        await dispatch(branchId, briefing, signal)
      } catch (error) {
        status = 'failed'
        failures.push({ label, reason: `任务未能投递：${error instanceof Error ? error.message : String(error)}` })
      }

      branches.push({ sessionId: branchId, label, status })
    }

    if (branches.length === 0) {
      return { ok: false, code: 'fork-failed', message: `劈叉失败：${failures.map((item) => `${item.label} — ${item.reason}`).join('；')}` }
    }

    return {
      ok: true,
      groupId,
      role: 'origin',
      cutSeq,
      isolation: wantWorktree ? 'worktree' : 'shared',
      policy: chosenPolicy,
      startedAt: now(),
      branches,
      failures,
      marker: originMarker(groupId, cutSeq, branches.map((item) => [item.sessionId, item.label])),
    }
  }

  // -- 每个半球的实时状态 --------------------------------------------------

  async function branchView (group, entry, signal) {
    let running
    try {
      running = (await controller.state({ sessionId: entry.id }, signalOf(signal))).running
    } catch { running = undefined }

    let all = []
    try { all = await readEvents(entry.id) } catch { all = [] }
    const own = all.filter((event) => event.seq > group.cutSeq)

    // 简报那条 user 消息就是这个半球自己的起点。
    // 简报还没落盘 = 任务没投递成功 = pending；绝不把 fork 补的合成 turn/end 当成它干完了。
    const marker = own.find((event) => BRANCH_RE.test(textOf(event).join('\n')))
    if (marker === undefined) {
      return {
        sessionId: entry.id,
        label: entry.label,
        status: 'pending',
        turns: 0,
        task: '',
        files: [],
        text: '',
        note: own.length === 0 ? '副本日志里还没有任何自己的事件' : '日志里没有简报标记：任务可能没投递成功',
      }
    }

    const fromSeq = marker.seq
    const ownEvents = own.filter((event) => event.seq >= fromSeq)
    const turns = realTurns(ownEvents)
    const openTurn = hasOpenTurn(ownEvents)

    let status
    if (running === true || openTurn === true) status = 'running'
    else if (turns > 0) status = 'settled'
    else status = 'pending'

    return {
      sessionId: entry.id,
      label: entry.label,
      status,
      turns,
      task: taskFromBriefing(firstOwnUserText(ownEvents, fromSeq)),
      files: filesOf(all, fromSeq, entry.id),
      text: finalAssistantText(ownEvents, fromSeq),
      note: null,
    }
  }

  // -- status -------------------------------------------------------------

  async function status ({ agent, signal }) {
    const group = await readGroup(agent)
    if (group === undefined) return { ok: false, code: 'no-group', message: '这个会话没有脑裂组。先 `/split <任务>` 劈一个半球。' }

    const members = []
    for (const entry of group.entries) members.push(await branchView(group, entry, signal))

    const originEvents = await readEvents(group.originSessionId).catch(() => [])
    const merged = originEvents.some((event) => event.type === 'user/message' && event.seq > group.cutSeq && textOf(event).join('\n').includes('# 脑裂合并报告'))

    return {
      ok: true,
      groupId: group.groupId,
      role: group.role,
      origin: group.originSessionId,
      cutSeq: group.cutSeq,
      settledCount: members.filter((item) => item.status === 'settled').length,
      memberCount: members.length,
      members: members.map((item) => ({ sessionId: item.sessionId, label: item.label, status: item.status, turns: item.turns, task: item.task })),
      originChangedFiles: filesOf(originEvents, group.cutSeq + 1, group.originSessionId),
      merged,
      marker: originMarker(group.groupId, group.cutSeq, group.entries.map((item) => [item.id, item.label])),
    }
  }

  // -- merge --------------------------------------------------------------

  async function merge ({ agent, wait, policy, signal }) {
    const group = await readGroup(agent)
    if (group === undefined) return { ok: false, code: 'no-group', message: '没有可合并的脑裂组。' }

    // 在半球窗口里执行 /merge：合并永远送回原会话。
    if (group.role === 'branch') {
      const origin = agents.get(group.originSessionId)
      if (origin === undefined) {
        return { ok: false, code: 'origin-cold', message: `原会话 ${group.originSessionId} 当前不在运行：到那个窗口里执行 /merge，或先把它打开。` }
      }
      return merge({ agent: origin, wait, policy, signal })
    }

    const timeoutMs = wait === false ? 0 : Number(config.mergeTimeoutMs)
    const sections = []
    for (const entry of group.entries) {
      if (timeoutMs > 0) {
        try {
          await controller.wait({ sessionId: entry.id, timeoutMs, afterSeq: group.cutSeq }, signalOf(signal))
        } catch { /* 读不到就按现有结论合 */ }
      }
      sections.push(await branchView(group, entry, signal))
    }

    const originEvents = await readEvents(group.originSessionId).catch(() => [])
    const originFiles = filesOf(originEvents, group.cutSeq + 1, group.originSessionId)

    // 冲突面 = 被两个以上来源写过的文件（含原会话自己分裂后的改动）。
    const ownersByFile = new Map()
    const addOwner = (file, owner) => {
      const owners = ownersByFile.get(file) ?? new Set()
      owners.add(owner)
      ownersByFile.set(file, owners)
    }
    for (const item of sections) for (const file of item.files) addOwner(file, `半球 ${item.label}`)
    for (const file of originFiles) addOwner(file, '原会话')
    const conflicts = [...ownersByFile.entries()]
      .filter(([, owners]) => owners.size > 1)
      .map(([file, owners]) => ({ file, owners: [...owners] }))
      .sort((left, right) => left.file.localeCompare(right.file))

    const allSettled = sections.every((item) => item.status === 'settled')
    const chosenPolicy = policy ?? config.policy
    const report = renderReport({ group, sections, conflicts, originFiles, allSettled, policy: chosenPolicy })

    try {
      await dispatch(group.originSessionId, report, signal)
    } catch (error) {
      return {
        ok: false,
        code: 'deliver-failed',
        message: `合并报告已生成，但送回原会话失败：${error instanceof Error ? error.message : String(error)}`,
        conflictFiles: conflicts.map((item) => item.file),
        report,
      }
    }

    return {
      ok: true,
      groupId: group.groupId,
      allSettled,
      policy: chosenPolicy,
      conflictFiles: conflicts.map((item) => item.file),
      conflicts,
      delivered: true,
      settledCount: sections.filter((item) => item.status === 'settled').length,
      memberCount: sections.length,
      marker: originMarker(group.groupId, group.cutSeq, group.entries.map((item) => [item.id, item.label])),
      report,
    }
  }

  function renderReport ({ group, sections, conflicts, originFiles, allSettled, policy }) {
    const budget = Number(config.resultCharBudget)
    const head = [
      originMarker(group.groupId, group.cutSeq, sections.map((item) => [item.sessionId, item.label])),
      '',
      `# 脑裂合并报告 · ${group.groupId}`,
      `切点：原会话 ${group.originTitle ?? group.originSessionId} 的 seq=${group.cutSeq}（最后一个已完成轮次）。仲裁政策：${policy}。`,
      allSettled ? '所有半球都已收口。' : '有半球未收口，下面的结论不完整——先处理未收口的那几份再定稿。',
    ].join('\n')

    const bodies = sections.map((item) => {
      const text = item.text.length > budget
        ? `${item.text.slice(0, budget)}\n…（截断；完整过程在会话 ${item.sessionId}）`
        : item.text
      return [
        '',
        `## 半球 ${item.label}（会话 \`${item.sessionId}\`）· ${item.status} · ${item.turns} 轮`,
        item.task ? `任务：${item.task}` : '',
        '最终结论：',
        text ? text.split('\n').map((line) => `> ${line}`).join('\n') : '> （没有产出最终回复）',
        item.files.length ? `它写过的文件：${item.files.join('、')}` : '它写过的文件：无',
        `过程引用（要点开看它的原始推导时用）：${referenceMention(item.sessionId, item.label)}`,
      ].filter(Boolean).join('\n')
    }).join('\n')

    const clash = [
      '',
      '## 脑裂冲突面（多个来源都写过的文件）',
      conflicts.length === 0
        ? '无重叠：每个半球写的文件都是独一份，可以直接采纳。'
        : conflicts.map((item) => `- **${item.file}** — ${item.owners.join(' / ')}`).join('\n'),
      originFiles.length ? `原会话在分裂后写过：${originFiles.join('、')}` : '原会话在分裂后没有写文件。',
      '',
      '仲裁规则（不要绕过）：冲突文件先读当前内容再决定；要看两份差异就用 git diff 或工作区改动对比。本插件永不自动覆盖文件。',
    ].join('\n')

    const ask = [
      '',
      '## 现在请你（原脑）完成合并',
      policy === 'vote'
        ? '这些半球是同一任务的多种解法：按一致性投票取多数答案，少数派只保留「与多数不同之处」写进最终回复。'
        : policy === 'synthesize'
          ? '把各半球结论合成**一份**统一交付：重复只留一份，矛盾的按证据强弱判定，并在回复里写明依据。'
          : '逐份采纳：仍然成立的并入当前工作，过时的明确废弃，并说明为什么。',
      '最终回复请包含：采纳了什么 / 丢弃了什么及原因 / 冲突文件的处置 / 未收口半球的下一步。',
      `回复末尾附一行「${config.labelPrefix} 合并自 ${group.groupId}」，方便日后回溯。`,
    ].join('\n')

    return [head, bodies, clash, ask].join('\n')
  }

  // -- abort --------------------------------------------------------------

  async function abort ({ agent }) {
    const group = await readGroup(agent)
    if (group === undefined) return { ok: false, code: 'no-group', message: '没有可中止的脑裂组。' }
    const stopped = []
    for (const entry of group.entries) {
      try {
        controller.cancel({ sessionId: entry.id })
        stopped.push(entry.id)
      } catch { /* 该半球已经 idle */ }
    }
    return {
      ok: true,
      groupId: group.groupId,
      stopped,
      marker: originMarker(group.groupId, group.cutSeq, group.entries.map((item) => [item.id, item.label])),
    }
  }

  // ---------------------------------------------------------------------
  // 一个实现，两套入口：工具（模型）+ 命令（人）
  // ---------------------------------------------------------------------

  /**
   * @param source - 调用方身份，**只由宿主侧入口决定**（工具=`tool`，命令=`command`）；
   *   它不进 args，模型传什么都收不到，所以闸门不可被自称「人侧」绕过。
   */
  async function runAction (agent, action, args, signal, source = 'tool') {
    if (agent === undefined) return { ok: false, code: 'no-agent', message: '需要一个发起会话的 agent 上下文。' }
    switch (action) {
      case 'split': return split({ agent, tasks: args.tasks, isolation: args.isolation, policy: args.policy, signal, source, reason: args.reason })
      case 'status': return status({ agent, signal })
      case 'merge': return merge({ agent, wait: args.wait, policy: args.policy, signal })
      case 'abort': return abort({ agent })
      default: return { ok: false, code: 'bad-action', message: `action 只能是 split / status / merge / abort，收到 ${action}` }
    }
  }

  function commandText (action, value) {
    if (action === 'split') {
      const failed = (value.failures ?? []).length > 0
        ? `\n未成功：${value.failures.map((item) => `${item.label} — ${item.reason}`).join('；')}`
        : ''
      return `${config.labelPrefix} 已劈出 ${value.branches.length} 个半球，任务已立即开跑（不排队）：${value.branches.map((item) => `${item.label} → ${item.sessionId}`).join('、')}\n切点 seq=${value.cutSeq}（最后一个已完成轮次）· 隔离 ${value.isolation} · 政策 ${value.policy}${failed}\n${value.marker}`
    }
    if (action === 'status') {
      return `${config.labelPrefix} ${value.groupId}（你在其中是 ${value.role}）· ${value.settledCount}/${value.memberCount} 已收口${value.merged ? ' · 已合并过' : ''}\n${value.members.map((item) => ` - ${item.label} ${item.status}${item.turns ? ` (${item.turns} 轮)` : ''}${item.task ? `：${item.task.slice(0, 48)}` : ''}`).join('\n')}\n原会话分裂后改动：${value.originChangedFiles.length ? value.originChangedFiles.join('、') : '无'}\n${value.marker}`
    }
    if (action === 'merge') {
      return `${config.labelPrefix} 合并报告已送回原会话（${value.allSettled ? '全部半球已收口' : '有半球未收口'}）\n冲突文件：${value.conflictFiles.length ? value.conflictFiles.join('、') : '无重叠'}\n${value.marker}`
    }
    return `${config.labelPrefix} 已中止脑裂组 ${value.groupId}，取消 ${value.stopped.length} 个还在跑的半球\n${value.marker}`
  }

  const ACTIONS = ['split', 'status', 'merge', 'abort']

  function checkArgs (args) {
    if (!args || typeof args !== 'object') return 'args 必须是对象'
    // `source` 故意不在白名单里：模型传 source:'command' 想冒充人侧绕过闸门，这里直接拒。
    const known = ['action', 'tasks', 'isolation', 'policy', 'wait', 'reason']
    for (const key of Object.keys(args)) if (!known.includes(key)) return `未知参数 ${key}`
    if (!ACTIONS.includes(args.action)) return `action 只能是 ${ACTIONS.join(' / ')}`
    if (args.isolation !== undefined && !['shared', 'worktree'].includes(args.isolation)) return 'isolation 只能是 shared / worktree'
    if (args.policy !== undefined && !['append', 'synthesize', 'vote'].includes(args.policy)) return 'policy 只能是 append / synthesize / vote'
    if (args.wait !== undefined && typeof args.wait !== 'boolean') return 'wait 必须是布尔'
    if (args.reason !== undefined && typeof args.reason !== 'string') return 'reason 必须是字符串'
    if (args.tasks !== undefined) {
      if (!Array.isArray(args.tasks)) return 'tasks 必须是数组'
      for (const item of args.tasks) {
        if (typeof item === 'string') continue
        if (!item || typeof item !== 'object' || typeof item.task !== 'string') return 'tasks 每一项要么是字符串，要么是 {task, label?}'
        if (item.label !== undefined && typeof item.label !== 'string') return 'tasks[].label 必须是字符串'
      }
    }
    if (args.action === 'split' && (!Array.isArray(args.tasks) || args.tasks.length === 0)) return 'action=split 需要 tasks'
    return undefined
  }

  const splitBrainTool = {
    name: 'split_brain',
    description: `${TRIGGER_POLICY}\n\n【机制】脑裂：把当前对话在最后一个已完成轮次处克隆成一个**用户可见的独立会话**（半球）。副本不含正在执行的那一轮；任务直接投递、立即执行、不进队列；两边收口后用 action=merge 把各半球结论与文件改动面合并回原会话，并列出冲突文件。共用工作目录时并行写有风险（只读分析最安全），要并行改代码用 isolation=worktree。`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: ['split', 'status', 'merge', 'abort'],
          description: 'split：劈出半球并直接开工；status：看各半球收口情况；merge：收集结论并把合并报告送回原会话；abort：中止并取消还在跑的半球。只有 split 受触发闸门约束。',
        },
        reason: {
          type: 'string',
          description: 'action=split 必填：一句话说清各路为什么互相独立、并行换来什么收益。写不出这句就是不该分——顺序做完即可（config.autoTrigger=ask 的硬门槛，manual 时模型根本不能分）。status / merge / abort 不需要。',
        },
        tasks: {
          type: 'array',
          description: 'action=split 时每个半球要干的活；数组长度就是半球数（上限见 config.maxBranches）。同一任务要多份解法就重复写同一条。',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['task'],
            properties: {
              task: { type: 'string', description: '交给这个半球的任务正文，必须自包含（半球看不到你之后的对话）。' },
              label: { type: 'string', description: '半球标签，默认 A/B/C…；出现在半球会话标题里。' },
            },
          },
        },
        isolation: { type: 'string', enum: ['shared', 'worktree'], description: 'shared：与原会话共用工作目录（默认）；worktree：每个半球一套独立 git worktree（需启用 worktree bundle）。' },
        policy: { type: 'string', enum: ['append', 'synthesize', 'vote'], description: '合并仲裁政策：append 并列采纳、synthesize 合成一份、vote 同题多解投票。' },
        wait: { type: 'boolean', description: 'action=merge 时是否等到各半球收口（默认等到 config.mergeTimeoutMs）；false 只合当前已有结论。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          code: { type: 'string' },
          message: { type: 'string' },
          groupId: { type: 'string' },
          role: { type: 'string' },
          cutSeq: { type: 'number' },
          isolation: { type: 'string' },
          policy: { type: 'string' },
          allSettled: { type: 'boolean' },
          conflictFiles: { type: 'array', items: { type: 'string' } },
          members: { type: 'array', items: { type: 'object', additionalProperties: true } },
          branches: { type: 'array', items: { type: 'object', additionalProperties: true } },
          failures: { type: 'array', items: { type: 'object', additionalProperties: true } },
          marker: { type: 'string' },
        },
      },
      render (args, value) {
        const text = (line) => [{ type: 'text', text: line }]
        if (value.ok === false) return text(`脑裂失败（${value.code ?? 'unknown'}）：${value.message ?? ''}`)
        if (args.action === 'split') {
          const list = (value.branches ?? []).map((item) => `${item.label}=${item.sessionId}(${item.status})`).join(' ')
          return text(`已劈出 ${(value.branches ?? []).length} 个半球，任务已直接开跑（不排队）：${list}\n切点 seq=${value.cutSeq} · 隔离 ${value.isolation} · 政策 ${value.policy}\n${value.marker}\n各半球在自己的会话窗口里执行；收口后调用 split_brain(action="merge") 合并。`)
        }
        if (args.action === 'status') {
          const rows = (value.members ?? []).map((item) => `${item.label} ${item.status}${item.turns === undefined ? '' : `(${item.turns}轮)`}`).join('；')
          return text(`脑裂组 ${value.groupId}（你在这里是 ${value.role}）：${value.settledCount}/${value.memberCount} 已收口 — ${rows}\n${value.marker}`)
        }
        if (args.action === 'merge') {
          const files = value.conflictFiles ?? []
          return text(`合并报告已送回原会话（${value.allSettled ? '全部半球已收口' : '有半球未收口'}），冲突文件 ${files.length} 个${files.length ? `：${files.join('、')}` : ''}。\n全文报告作为本会话的**下一条输入**到达（这里不重复一遍全文，免得同一份长文本在上下文里出现两次）；收到后就按报告完成仲裁，并在最终回复里说明取舍。\n${value.marker}`)
        }
        return text(`已中止脑裂组 ${value.groupId}，取消了 ${(value.stopped ?? []).length} 个还在跑的半球。\n${value.marker}`)
      },
    },
    async execute (args, exec) {
      // 注册的是原始 JSON Schema，没有 defineTool 帮忙校验，这里自己挡住越界参数。
      const problem = checkArgs(args)
      if (problem !== undefined) throw new Error(problem)
      const agent = exec.agent ?? agents.currentInitiator?.()
      return runAction(agent, args.action, args ?? {}, exec.signal, 'tool')
    },
  }

  ctx.tools.register(splitBrainTool)

  const toResult = (action, value) => (value.ok === false
    ? { kind: 'error', text: `脑裂失败（${value.code ?? 'unknown'}）：${value.message ?? ''}` }
    : { kind: 'success', text: commandText(action, value) })

  ctx.commands.register({
    name: 'split',
    description: '把当前对话劈出一个/多个可见半球：副本只带已完成轮次，任务立即执行不排队',
    input: { hint: '<任务A> || <任务B>（用 || 分隔即多个半球）' },
    async handler ({ agent, rawInput, signal }) {
      const tasks = String(rawInput || '').split(/\|\|/).map((item) => item.trim()).filter(Boolean)
      if (tasks.length === 0) return { kind: 'error', text: '用法：/split <任务>；多个半球用 || 分隔：/split 任务A || 任务B' }
      return toResult('split', await runAction(agent, 'split', { tasks: tasks.map((task) => ({ task })) }, signal, 'command'))
    },
  })

  ctx.commands.register({
    name: 'merge',
    description: '收拢所有半球的结论与文件改动面，生成合并报告送回当前会话',
    input: { hint: '[--no-wait] [append|synthesize|vote]' },
    async handler ({ agent, rawInput, signal }) {
      const args = String(rawInput || '').trim().split(/\s+/).filter(Boolean)
      const policy = args.find((item) => ['append', 'synthesize', 'vote'].includes(item))
      return toResult('merge', await runAction(agent, 'merge', { policy, wait: !args.includes('--no-wait') }, signal))
    },
  })

  ctx.commands.register({
    name: 'split-status',
    description: '查看当前会话的脑裂组与各半球收口状态',
    async handler ({ agent, signal }) {
      return toResult('status', await runAction(agent, 'status', {}, signal))
    },
  })

  ctx.commands.register({
    name: 'split-abort',
    description: '中止当前会话的脑裂组，取消还在跑的半球',
    async handler ({ agent, signal }) {
      return toResult('abort', await runAction(agent, 'abort', {}, signal))
    },
  })
}
