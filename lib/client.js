/**
 * 脑裂（Split-brain）· 浏览器半边。
 *
 * 只画一条贴在输入框下方的「半球条」：血缘、成员、每个半球的实时状态，
 * 外加跳到兄弟窗口和触发 /merge 的入口。
 * 数据全部来自 Host 已经算好的 session projection（`splitBrain`）与宿主自己的
 * 会话状态选择器；本文件不折叠会话日志、不往插件之外写 DOM、只用主题 token。
 *
 * 动作走宿主既有通道：打开会话用 `uiWorkspace.openSession`，
 * 执行 `/merge` 用 `remote.commands.execute`（和人手动输同一条命令，同一实现）；
 * 拿不到该能力时把命令文本告诉用户，绝不自己复制一份合并逻辑。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-split-brain',
  factory (require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-split-brain'

    const DICT = {
      zh: {
        title: '脑裂',
        origin: '本对话已劈出',
        branch: '你是半球',
        from: '源对话',
        running: '执行中',
        settled: '已收口',
        pending: '未开始',
        waiting: '在等人',
        failed: '失败',
        merged: '已合并',
        aborted: '已中止',
        unknown: '状态未知',
        merge: '合并 /merge',
        mergeHint: '点按无效：在本窗口输入 /merge 执行合并',
        opening: '打开',
      },
      en: {
        title: 'Split-brain',
        origin: 'Branches from this chat',
        branch: 'You are hemisphere',
        from: 'Source chat',
        running: 'running',
        settled: 'settled',
        pending: 'pending',
        waiting: 'needs you',
        failed: 'failed',
        merged: 'merged',
        aborted: 'aborted',
        unknown: 'unknown',
        merge: 'Merge /merge',
        mergeHint: 'Tap did nothing — type /merge in this window',
        opening: 'Open',
      },
    }

    // 组件内 style：卸载即消失，不污染文档，也不碰宿主的样式表。
    const CSS = `
.sb-dock{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:6px 2px 0;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
.sb-title{color:var(--dsw-alias-label-primary);font-weight:600}
.sb-tag{font-variant-numeric:tabular-nums;opacity:.7}
.sb-chip{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}
.sb-chip:hover{border-color:var(--dsw-alias-border-l2)}
.sb-dot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none}
.sb-dot.is-running{background:var(--dsw-alias-brand-primary)}
.sb-dot.is-settled{background:var(--dsw-alias-state-success-primary)}
.sb-dot.is-waiting{background:var(--dsw-alias-state-warn-primary)}
.sb-dot.is-failed{background:var(--dsw-alias-state-error-primary)}
.sb-act{padding:2px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;cursor:pointer}
.sb-act:hover{background:var(--dsw-alias-bg-layer-2)}
.sb-act:disabled{opacity:.55;cursor:default}
.sb-warn{color:var(--dsw-alias-state-warn-primary)}
`

    function dotClass (status) {
      if (status === 'running') return 'sb-dot is-running'
      if (status === 'settled' || status === 'merged') return 'sb-dot is-settled'
      if (status === 'waiting-user') return 'sb-dot is-waiting'
      if (status === 'failed' || status === 'aborted') return 'sb-dot is-failed'
      return 'sb-dot'
    }

    function apply (ctx) {
      // 文案走宿主 locale 服务（zh + en 必须成对注册）。注册或 bind 不可用时，
      // 退回按宿主语言查内嵌字典，再退回浏览器语言——总之不会显示空白。
      let lang = /^zh/i.test((typeof navigator !== 'undefined' && navigator.language) || '') ? 'zh' : 'en'
      const locale = ctx.get('locale')
      let t = (key) => (DICT[lang] && DICT[lang][key]) || DICT.en[key] || key

      if (locale) {
        try {
          const read = (snap) => {
            const base = String((snap && snap.active) || '').split('-')[0]
            lang = DICT[base] ? base : lang
          }
          read(typeof locale.getSnapshot === 'function' ? locale.getSnapshot() : undefined)
          ctx.effect(() => {
            // 注册发生在 effect 里，抛出来会打断整条 client 激活：这里自己兜住。
            try { return locale.register(NS, { zh: DICT.zh, en: DICT.en }) } catch { return undefined }
          })
          if (typeof locale.bind === 'function') {
            const translate = locale.bind(NS)
            t = (key) => translate(key) || DICT.en[key] || key
          }
          ctx.on('locale/change', read)
        } catch { /* 退回内嵌字典 */ }
      }

      const remote = () => { try { return ctx.get('remote') } catch { return undefined } }

      function runCommand (sessionId, line) {
        const commands = remote() && remote().commands
        if (!commands || typeof commands.execute !== 'function') return Promise.resolve(false)
        return Promise.resolve(commands.execute(sessionId, line, [])).then(() => true, () => false)
      }

      function openSession (sessionId) {
        try {
          const uiWorkspace = ctx.get('uiWorkspace')
          if (uiWorkspace && typeof uiWorkspace.openSession === 'function') uiWorkspace.openSession(sessionId)
        } catch (error) {
          console.error('[split-brain] 打开半球会话失败', error)
        }
      }

      function Dock (props) {
        // Dock 本身一个 hook 都不调：它只看宿主 kit 有没有给投影/状态选择器，
        // 然后把渲染整个交给 Strip。两者是不同的元素类型，React 会干净地挂载或卸载
        // 各自的 hook 状态——绝不会出现「这一次比上一次多调了 hook」那种把槽位打崩的写法。
        const { useProjection, useSessionStatus } = props || {}
        if (typeof useProjection !== 'function' || typeof useSessionStatus !== 'function') return null
        return h(Strip, props)
      }

      function Strip (props) {
        const { useProjection, useSessionStatus, sessionId } = props
        // 到这里两个 hook 恒定存在，调用顺序每次一致。
        const split = useProjection('splitBrain')
        const statuses = useSessionStatus()
        const [busy, setBusy] = React.useState(false)
        const [hint, setHint] = React.useState('')

        if (!split || !split.groupId) return null

        const style = h('style', null, CSS)

        if (split.role === 'branch') {
          return h('div', { className: 'sb-dock', role: 'note' },
            style,
            h('span', { className: 'sb-title' }, `⨯ ${t('branch')} ${split.label || ''}`),
            h('span', { className: 'sb-tag' }, `${t('from')} ${split.originSessionId}`),
            h('button', { type: 'button', className: 'sb-act', onClick: () => openSession(split.originSessionId) },
              `${t('opening')} ${t('title')}`),
            h('span', { className: 'sb-tag' }, split.groupId))
        }

        const members = Array.isArray(split.members) ? split.members : []
        return h('div', { className: 'sb-dock', role: 'note' },
          style,
          h('span', { className: 'sb-title' }, `⨯ ${t('origin')}`),
          h('span', { className: 'sb-tag' }, `${members.length} · ${split.groupId}`),
          members.map((member) => {
            // Host 投影给的是 {id,label}；老值或坏值退化成 id 尾巴。
            const id = typeof member === 'string' ? member : member?.id
            if (!id) return null
            const label = (typeof member === 'object' && member.label) ? member.label : String(id).slice(-4)
            const running = statuses && typeof statuses.get === 'function' ? (statuses.get(id) || {}).running : undefined
            const status = running === true ? 'running' : running === false ? 'settled' : 'unknown'
            return h('button', {
              key: id,
              type: 'button',
              className: 'sb-chip',
              title: id,
              onClick: () => openSession(id),
            },
            h('span', { className: dotClass(status) }),
            h('span', null, `${label} · ${t(status)}`))
          }).filter(Boolean),
          h('button', {
            type: 'button',
            className: 'sb-act',
            disabled: busy || sessionId === undefined,
            onClick: async () => {
              setBusy(true)
              const ok = await runCommand(sessionId, '/merge')
              setBusy(false)
              if (!ok) setHint(t('mergeHint'))
            },
          }, busy ? '…' : t('merge')),
          hint ? h('span', { className: 'sb-warn' }, hint) : null)
      }

      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
        name: 'conversation.composer.dock',
        id: NS,
        order: 20,
        label: () => `⨯ ${t('title')}`,
        locale: NS,
      }, Dock))
    }

    return { isPlugin: true, inject: ['slots'], apply }
  },
})
