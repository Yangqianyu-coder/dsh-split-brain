// 语义自检：不需要装插件，直接验证脑裂的核心断言。
// 运行：node test/selfcheck.mjs
import assert from 'node:assert/strict'
import { __internals } from '../lib/index.js'

const {
  completedPrefixBoundary, branchMarker, originMarker, BRANCH_RE, ORIGIN_RE,
  parseOriginMembers, projectionDefinition, taskFromBriefing, firstOwnUserText,
  changedFiles, hasOpenTurn, syntheticCloser, realTurns, finalAssistantText, textOf,
  splitGate, TRIGGER_POLICY, DEFAULTS,
} = __internals

const SESSION = 'session-11111111-2222-3333-4444-555555555555'
const BRANCH = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

// 一条真实形状的会话日志：两轮已完成，第三轮正在进行（有未闭合 turn + 一次写文件）
let seq = -1
const ev = (type, data = {}) => ({ seq: ++seq, type, time: 0, ...data })

const log = [
  ev('user/message', { content: [{ type: 'text', text: '第一轮的任务' }], source: { kind: 'user' } }),
  ev('turn/start', { turn: 1 }),
  ev('assistant/message', { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '第一轮回答' }] } }),
  ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ev('user/message', { content: [{ type: 'text', text: '第二轮的任务' }] }),
  ev('turn/start', { turn: 2 }),
  ev('assistant/message', { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '第二轮回答' }] } }),
  ev('turn/end', { turn: 2, reason: { kind: 'completed' } }),
  // 正在执行的第三轮：绝不能进副本
  ev('turn/start', { turn: 3 }),
  ev('tool/call', { turn: 3, step: 1, callId: 'c1', name: 'write', arguments: JSON.stringify({ file_path: 'C:\\ws\\src\\live.js', content: 'x' }) }),
]
const LAST_DONE = 7
assert.equal(completedPrefixBoundary(log), LAST_DONE, '切点必须落在最后一个 turn/end')
assert.equal(hasOpenTurn(log.slice(LAST_DONE + 1)), true, '第三轮要判为未收口')

// 切点之后的独立事件（compaction 之类）要一起带上，但不能带新的 turn/start
// 真实日志里 seq 恒等于数组下标，所以拼完片段必须重排 seq。
const reindex = (rows) => rows.map((event, index) => ({ ...event, seq: index }))
const withTail = reindex([...log.slice(0, LAST_DONE + 1), ev('session/stats', {}), ev('todo/write', { todos: [] })])
assert.equal(completedPrefixBoundary(withTail), 9, 'turn/end 之后的独立事件属于已完成前缀')
const tailThenTurn = reindex([...withTail, ev('turn/start', { turn: 4 })])
assert.equal(completedPrefixBoundary(tailThenTurn), 9, '新的 turn/start 之后不算已完成')

// 没有任何已完成轮次：拒绝分裂，而不是劈出半个 turn
assert.equal(completedPrefixBoundary([ev('user/message', {}), ev('turn/start', { turn: 1 })]), undefined)

// 简报标记：半球折叠成 branch，原会话折叠成 origin，两种互不误配
const groupId = 'sb-deadbeef'
const briefing = [
  branchMarker(groupId, SESSION, 'A', LAST_DONE),
  '',
  '你在原对话的 seq=7 处被劈出来',
  '## 你的任务',
  '评估方案 B 的风险',
  '## 交回协议',
  '1. 直接开工',
].join('\n')
assert.ok(BRANCH_RE.test(briefing), '简报要带可折叠的 branch 标记')
assert.ok(!ORIGIN_RE.test(briefing), 'branch 标记不能被当成 origin')
assert.equal(taskFromBriefing(briefing), '评估方案 B 的风险', '任务段要能取回来')

const originLine = originMarker(groupId, LAST_DONE, [[BRANCH, 'A'], [SESSION, 'B']])
assert.ok(ORIGIN_RE.test(originLine))
assert.deepEqual(parseOriginMembers(ORIGIN_RE.exec(originLine)[3]), [
  { id: BRANCH, label: 'A' }, { id: SESSION, label: 'B' },
], '成员列表还原成 {id,label}')

// 投影折叠：init 带 inheritedEventCount 作为地板，父会话的标记绝不能被认成自己的血缘
const def = projectionDefinition
const floor = 9
let state = def.init({ isSeeded: true }, floor)
assert.equal(state.floor, floor)

const parentStaleOrigin = { seq: 3, type: 'command/done', kind: 'success', text: originMarker('sb-OLD', 1, [['session-old', 'Z']]) }
assert.equal(def.apply(state, parentStaleOrigin), state, '低于地板的事件必须原样返回同一引用')

state = def.apply(state, { seq: 10, type: 'user/message', content: [{ type: 'text', text: briefing }] })
assert.equal(state.role, 'branch')
assert.equal(state.groupId, groupId)
assert.equal(state.label, 'A')
assert.equal(state.cutSeq, LAST_DONE)

const unrelated = { seq: 11, type: 'assistant/message', message: { content: [{ type: 'text', text: '普通回答' }] } }
assert.equal(def.apply(state, unrelated), state, '无标记事件零下游开销（同引用）')

const asOrigin = def.apply(def.init({}, 0), { seq: 5, type: 'tool/result', message: { content: [{ type: 'text', text: originLine }] } })
assert.equal(asOrigin.role, 'origin')
assert.equal(asOrigin.members.length, 2)
assert.deepEqual(def.wire.view(asOrigin), asOrigin, '有血缘时 view 复用 state 引用')
assert.equal(def.wire.view(def.init({}, 0)), null, '没有血缘时 view 是 null，半球条不渲染')

// 持久化状态被外部改动过也不能把冷读搞崩：stateSchema.parse 必须修而不抛
const repaired = def.stateSchema.parse({ floor: 'nope', groupId: 42, members: [{ id: 'x' }, null, { id: 'y', label: 7 }] })
assert.equal(repaired.floor, 0)
assert.equal(repaired.groupId, null)
assert.deepEqual(repaired.members, [{ id: 'x', label: 'x' }, { id: 'y', label: 'y' }], '坏 label 要退化成 id 尾巴，非对象成员要被剔除')
assert.equal(def.stateSchema.parse(null).floor, 0)

// 半球写过的文件：只算它自己那一区间的，且斜杠统一
const branchLog = [
  { seq: 8, type: 'user/message', content: [{ type: 'text', text: briefing }] },
  { seq: 9, type: 'turn/start', turn: 1 },
  { seq: 10, type: 'tool/call', name: 'edit', arguments: JSON.stringify({ file_path: 'src\\a.ts' }) },
  { seq: 11, type: 'tool/call', name: 'write', arguments: JSON.stringify({ path: 'docs/b.md' }) },
  { seq: 12, type: 'tool/call', name: 'bash', arguments: JSON.stringify({ command: 'ls' }) },
  { seq: 13, type: 'tool/call', name: 'edit', arguments: '{ 坏 JSON' },
  { seq: 14, type: 'assistant/message', message: { content: [{ type: 'text', text: '结论：' }, { type: 'text', text: 'A 可行' }] } },
  { seq: 15, type: 'turn/end', turn: 1 },
]
assert.deepEqual(changedFiles(branchLog, 9), ['docs/b.md', 'src/a.ts'], '改动面只收自己的写工具')
assert.deepEqual(changedFiles(branchLog, 11), ['docs/b.md'], 'fromSeq 是包含式的：之前的事件不算')
assert.deepEqual(changedFiles(branchLog, 12), [], '只剩非写工具和坏 JSON 时改动面为空')
assert.equal(finalAssistantText(branchLog, 9), '结论：\nA 可行')
// 简报就是 seq 8 那条 user 消息：branchView 用 marker.seq 当 fromSeq，所以取得回任务段
assert.equal(firstOwnUserText(branchLog, 8).includes('## 你的任务'), true, '半球自己的第一条消息就是简报')
assert.equal(firstOwnUserText(branchLog, 9), '', '越过简报就没有 user 消息了')
assert.equal(hasOpenTurn(branchLog.filter((e) => e.seq >= 9)), false, '半球收口判定')

// 文本抽取要能穿过任意事件形状（合并报告靠它，不能只认一种嵌套）
assert.deepEqual(textOf({ message: { content: [{ type: 'text', text: 'a' }, { type: 'image' }] } }), ['a'])
assert.deepEqual(textOf([{ text: 'b' }, { nested: { text: 'c' } }]), ['b', 'c'])
// 回归：块的 type 字段绝不能被当成正文（曾经把 "text" 混进合并报告）
assert.deepEqual(textOf({ seq: 1, type: 'user/message', content: [{ type: 'text', text: '正文' }] }), ['正文'])
assert.deepEqual(textOf({ type: 'command/done', kind: 'success', text: '一条结果' }), ['一条结果'])

// 过程引用：base64url 必须能还原成原会话 id（session-reference 的写法）
const encoded = Buffer.from(BRANCH, 'utf8').toString('base64url')
assert.equal(Buffer.from(encoded, 'base64url').toString('utf8'), BRANCH)

// 回归（本插件自己劈出的半球 A 审出来的真实缺陷）：
// fork 造种子时会给源会话那个未闭合 turn 补一条 turn/end{reason.kind:'forked'}，
// 冷读还会合成 turn/end{interrupted}。它们都不是「半球干完了一轮」。
const cut = 760
const seeded = [
  { seq: cut + 0, type: 'turn/end', reason: { kind: 'forked' } },        // 切点尾巴上的合成闭合
  { seq: cut + 1, type: 'user/message', content: [{ type: 'text', text: briefing }] },
  { seq: cut + 2, type: 'turn/start', turn: 2 },
  { seq: cut + 3, type: 'assistant/message', message: { content: [{ type: 'text', text: '还在写' }] } },
]
assert.equal(syntheticCloser({ type: 'turn/end', reason: { kind: 'forked' } }), true)
assert.equal(syntheticCloser({ type: 'turn/end', reason: { kind: 'interrupted' } }), true)
assert.equal(syntheticCloser({ type: 'turn/end', reason: { kind: 'completed' } }), false)
assert.equal(realTurns(seeded), 0, '刚劈开时真实轮次必须是 0，不能被合成闭合骗成已收口')
assert.equal(hasOpenTurn(seeded), true, '正在跑的那一轮要认出未闭合')

const done = [...seeded, { seq: cut + 4, type: 'turn/end', reason: { kind: 'completed' } }]
assert.equal(realTurns(done), 1, '真闭合才计数')
assert.equal(hasOpenTurn(done), false, '收口后没有未闭合轮')

// 只有合成闭合、简报都还没落盘：这是投递失败的样子，必须报 pending 而不是 settled
assert.equal(firstOwnUserText(seeded.filter((e) => e.type !== 'user/message'), cut + 1), '')

// -- 触发闸门：默认不分，只有独立多路才分 ----------------------------------
const G = (input) => splitGate(input)?.code
const OK_REASON = '三个子题互不依赖：性能、安全、可读性各自出结论'
assert.equal(DEFAULTS.autoTrigger, 'ask', '默认闸门：模型可分但必须带 reason')
assert.equal(G({ source: 'tool', reason: OK_REASON }), undefined, '独立多路 + reason → 放行')
assert.equal(G({ source: 'tool' }), 'needs-reason', '模型自发 split 不写理由 → 拒')
assert.equal(G({ source: 'tool', reason: '随便' }), 'needs-reason', '理由短到没内容视同没写')
assert.equal(G({ source: 'command' }), undefined, '人按 /split 本身就是意图证据，不要求 reason')
assert.equal(G({ source: 'tool', role: 'branch', reason: OK_REASON }), 'branch-no-resplit', '半球不再往下劈')
assert.equal(G({ source: 'command', role: 'branch' }), 'branch-no-resplit', '人侧也不许造树状血缘')
assert.equal(G({ source: 'tool', role: 'branch', reason: OK_REASON, allowNestedSplit: true }), undefined, 'allowNestedSplit 才开绿灯')
assert.equal(G({ source: 'tool', reason: OK_REASON, autoTrigger: 'manual' }), 'manual-only', 'manual：模型不自发分')
assert.equal(G({ source: 'command', autoTrigger: 'manual' }), undefined, 'manual：人照样能分')
assert.equal(G({ source: 'command', autoTrigger: 'off' }), 'auto-trigger-off', 'off 是 profile 级总开关，连人一起拦')
assert.equal(G({ source: 'tool', reason: OK_REASON, openGroup: true }), 'group-open', '一次只保持一组')
assert.equal(G({ source: 'command', openGroup: true }), 'group-open', '旧组未收口时人也拦：投影只有一个 groupId，新血缘会盖掉旧的')
assert.equal(G({ source: 'tool', role: 'branch', reason: OK_REASON, autoTrigger: 'manual' }), 'branch-no-resplit', '次序：递归拦截先于 manual')
assert.equal(G({ source: 'tool', role: 'branch', reason: OK_REASON, autoTrigger: 'off' }), 'auto-trigger-off', '次序：off 压过一切')
assert.equal(G({ source: 'tool', reason: OK_REASON, autoTrigger: 'nope' }), undefined, '坏配置值退化成默认 ask，不抛')
assert.match(TRIGGER_POLICY, /默认不脑裂/, '文案必须先把否决默认说出口')
assert.match(TRIGGER_POLICY, /挂起长活/, '「挂起长活、不挡下一个问题」要在正例里')
assert.match(TRIGGER_POLICY, /更该用别的工具/, '文案要能说清与 subagent / workflow / Team 的分工')

console.log('selfcheck ok：切点 / 血缘折叠 / 地板隔离 / 任务抽取 / 改动面 / 合成闭合剔除 / 触发闸门 全部通过')
