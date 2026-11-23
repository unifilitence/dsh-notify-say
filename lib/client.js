// dsh-notify-say browser half。
//
// ## 职责（只有两件）
//
//   1. 在 DSH 设置页注册「通知」分区（slots.inject('settings.section')）
//      —— Config schema 只生成「插件配置编辑器」里的表单，**不会**在设置侧栏加分区；
//         侧栏分区必须由 client 注册。本机先例：dsh-opencode-go / dsh-save-money /
//         dsh-cost-meter / dsh-our-free-model 全都这么做。
//   2. 点 Toast 后跳到「那条通知对应的会话」。
//
// ## 为什么必须是这种形态
//
// 宿主契约要求 client 产物自行注册 `window.__ModuleLoader__.load({id, factory})`
// （实测：dsh-sidebar-footer-stack 的 3KB 手写 client.js 也是这个包裹）。
// 直接放 ESM 源码会被当经典脚本执行 → SyntaxError → client-modules 加载失败。
// 本文件**手写**这个包裹，不依赖 esbuild（本机没有 esbuild，也不需要）。
//
// ## 兼容性（本插件首要目标）
//
// client 跑在 sandbox 渲染进程里：sandbox:true / contextIsolation:true /
// nodeIntegration:false → **没有 process、读不了盘**。
// 所以一切数据都走 host 的 /api route（fetch），且**每一处都 try/catch**：
//
//   - 拿不到 slots         → 不注册设置分区，跳转仍工作
//   - 拿不到 uiWorkspace   → 不跳转，用户看到的是"窗口被唤到前台"（旧行为）
//   - route 不可达         → 不跳转，不报错
//
// 任何一环失败都只是"少一个增强"，绝不拖累页面。
window.__ModuleLoader__.load({
  id: 'dsh-notify-say',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var name = 'dsh-notify-say'
    // 声明对 slots 的**硬依赖**，而不是在 apply 里"试一次拿不到就算了"。
    //
    // 为什么（独立审查 2026-10-17 指出）：`slots` 由 dsh-client-ui-renderer 提供，
    // 若本插件激活早于该服务生效，`ctx.get('slots', false)` 会拿到 undefined，
    // 而原实现没有重试 → 设置页分区**永久不出现**，且不留任何日志。
    // 写成 inject 后，宿主会等依赖就绪再激活，从根上避免这个竞态。
    // 先例：dsh-our-free-model/client.js 的 `const inject = ['slots','locale']`。
    var inject = ['slots']

    /** host 注册的 route 前缀（与 lib/session-bridge.js 的 ROUTE_PREFIX 一致）。 */
    var API_PREFIX = 'dsh-notify-say'

    /**
     * 用页面 base 解析 route，而不是 origin-absolute 的 `/api/...`。
     * DSH 可能挂在反向代理的子路径下，写死 `/api/...` 会 404
     * （本机先例 dsh-our-free-model 的注释明确记载了这个坑）。
     */
    function apiUrl(path) {
      try {
        return new URL('api/' + API_PREFIX + '/' + path, document.baseURI).toString()
      } catch (e) {
        return '/api/' + API_PREFIX + '/' + path
      }
    }

    /**
     * 取「最近一条通知对应的会话」；消费即清，避免重复跳转。
     *
     * ⚠️ 返回的是**对象** `{ sessionId, at }`，不是裸字符串。
     *
     * 2026-10-18 外部审阅发现一个 P0 bug：这里原本 `return doc.sessionId`
     * （字符串），但调用方写的是 `if (!doc || !doc.sessionId) return`。
     * 字符串没有 `.sessionId` 属性 → 恒为 undefined → **直接 return**。
     * 结果是会话跳转功能**从未生效过**，而且服务端信号已被 consume 清除，
     * 连重试的机会都没有。
     *
     * 教训：这类"返回类型与调用方期望不符"的 bug，静态审阅一眼可见，
     * 但没有任何单元测试覆盖到（因为两端各自都"看起来对"）。
     * 已加 C27 测试锁住返回形状。
     */
    /**
     * 读「Toast 点击」写入的待跳转会话（v0.4.70 精准跳转）。
     *
     * ## 与 consumeLastSession 的分工
     *
     *   consumeLastSession：读「最近播报队列」，**猜**是哪个会话 ——
     *                       多会话同时有通知时必然猜错（只能取最早的）。
     *   fetchPendingJump  ：读「用户点的那个 Toast 自带的 session id」—— **精确**。
     *
     * 所以先试精确的，没有再退回猜的（保持旧行为）。
     *
     * @returns {Promise<{sessionId:string,at:number}|null>}
     */
    function fetchPendingJump() {
      try {
        if (typeof fetch !== 'function') return Promise.resolve(null)
        // ⚠️ v0.4.78：这里原本写的是 `baseUrl()` —— **那个函数从来没定义过**。
        // 于是每次调用都抛 ReferenceError，被下面的 .catch 静默吞成 null，
        // 表现就是「点 Toast 后处理器确实写入了 pending-jump，但前端永远读不到」。
        // 2026-10-20 实测：日志有 [jump-click]，但零次 openSession CALL。
        // 修法：改用已有的 cfgUrl（它负责拼出 /api/dsh-notify-say/<path>，
        // 且能正确处理反向代理子路径）。
        return fetch(cfgUrl('pending-jump'), {
          method: 'GET',
          headers: { 'cache-control': 'no-store' },
          credentials: 'same-origin',
        }).then(function (r) {
          if (r.status === 204) return null
          if (!r.ok) return null
          return r.json().then(function (o) {
            if (!o || !o.sessionId) return null
            return { sessionId: String(o.sessionId), at: Number(o.at) || 0 }
          })
        }).catch(function () { return null })
      } catch (e) { return Promise.resolve(null) }
    }

    function consumeLastSession() {
      // ⚠️ 必须是 POST + JSON：服务端把它当写操作（会清除信号），
      // 而 http-guard 对写操作要求 JSON content-type —— 用 GET 会收到 403，
      // 会话跳转随之失效（2026-10-18 实测回归，v0.4.25 修）。
      return fetch(apiUrl('consume'), {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
        .then(function (res) {
          if (!res || !res.ok) return null
          if (res.status === 204) return null
          return res.json()
        })
        .then(function (doc) {
          if (!doc) return null
          // v0.4.62：服务端改成返回队列。老服务端只有 sessionId/at，
          // 这里两种形状都要吃 —— 客户端与服务端可能一新一旧（用户在升级中途）。
          var list = []
          if (doc.sessions && doc.sessions.length) {
            for (var i = 0; i < doc.sessions.length; i++) {
              var e = doc.sessions[i]
              if (!e || typeof e.sessionId !== 'string' || !e.sessionId) continue
              list.push({ sessionId: e.sessionId, at: Number(e.at) || 0 })
            }
          } else if (typeof doc.sessionId === 'string' && doc.sessionId) {
            list.push({ sessionId: doc.sessionId, at: Number(doc.at) || 0 })
          }
          return list.length ? list : null
        })
        .catch(function () { return null })
    }

    /**
     * 跳到指定会话。**未文档化 API**，拿不到就静默不动（退回"只唤窗"）。
     */
    // ── 语音包管理 API（v0.4.32）──────────────────────────────────────
    //
    // **只传音色 key，不传 URL** —— 下载地址由 host 从固定源算，
    // 前端传 URL 就等于让本机访问任意地址（SSRF）。
    function fetchVoicePacks() {
      return fetch(apiUrl('voicepacks/index'), { cache: 'no-store', credentials: 'same-origin' })
        .then(function (r) { return r && r.ok ? r.json() : null })
        .catch(function () { return null })
    }

    function installVoicePack(key) {
      return fetch(apiUrl('voicepacks/install'), {
        method: 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: key }),
      }).then(function (r) { return r ? r.json() : null }).catch(function () { return null })
    }

    function uninstallVoicePack(key) {
      return fetch(apiUrl('voicepacks/uninstall'), {
        method: 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: key }),
      }).then(function (r) { return r ? r.json() : null }).catch(function () { return null })
    }
    // 导出诊断（v0.4.35）：宿主读日志 → 脱敏 → 写文件，返回路径。
    // 用 POST：它会写文件，GET 可被任意网页用 <img> 触发。
    function exportDiagnostics() {
      return fetch(apiUrl('diagnostics'), {
        method: 'POST', cache: 'no-store', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }).then(function (r) { return r ? r.json() : null }).catch(function () { return null })
    }

    // 检查更新（v0.4.48）。只读：不下载、不覆盖文件、不执行命令。
    // force=true 表示用户手动点，绕过宿主侧 24 小时缓存。
    function fetchVersion(force) {
      var url = apiUrl('version') + (force ? '?force=1' : '')
      return fetch(url, { cache: 'no-store', credentials: 'same-origin' })
        .then(function (r) { return r && r.ok ? r.json() : null })
        .catch(function () { return null })
    }

    function openSession(ctx, sessionId) {
      try {
        // v0.4.76：**所有**跳转都必须留痕。
        // 这是唯一能让 DSH 换会话的入口，之前没有任何日志，
        // 导致「到底谁触发了跳转」完全查不出来（2026-10-20 排查「自动跳转」的教训）。
        if (!sessionId) {
          uiLog('openSession SKIP: 空 sessionId')
          return false
        }
        var ui = null
        try { ui = ctx.get('uiWorkspace', false) } catch (e) { ui = null }
        if (!ui || typeof ui.openSession !== 'function') {
          uiLog(`openSession SKIP: uiWorkspace 不可用 (ui=${!!ui}) sid=${sessionId}`)
          return false
        }
        // 调用栈能直接告诉我们**是谁**触发的 —— 排查时的决定性证据。
        var stack = ''
        try {
          stack = String(new Error().stack || '').split('\n').slice(2, 5).join(' | ').slice(0, 300)
        } catch (e) { stack = '' }
        uiLog(`openSession CALL sid=${sessionId} via=${stack}`)
        ui.openSession(sessionId)
        return true
      } catch (e) {
        uiLog(`openSession THREW: ${String((e && e.message) || e)}`)
        return false
      }
    }

    // ── 1) 设置页分区 ──────────────────────────────────────────────────────
    //
    // ⚠️ 必须返回 **React 元素**，不能返回原生 DOM。
    // v0.4.1 首版用 document.createElement 造节点，结果设置页点进去**一片空白**
    // —— React 不认识原生 DOM 节点，不会挂载它（实测现象）。
    // React 从 factory 的 require 取（本机先例 dsh-save-money:16 即 require('react')）。
    //
    // 内容：官方 Config 表单负责**编辑**；本卡片只做只读说明 + 常用命令提示。
    // 这样即使 slots 渲染接口变化，损失也仅是一张说明卡。
    var React = null
    try { React = require('react') } catch (e) { React = null }

    /** 极简样式（内联）：不依赖任何 CSS 模块（哈希会随构建漂）。 */
    var S = {
      // 内容宽度约束：设置卡片可能被拉得很宽，长行读起来很累。
      // 680px 是「一行能放下标签+控件+数值，又不至于横跨整屏」的折中。
      // 正文字号 13.5px：Windows 100% 缩放下 13px 偏小（尤其中文），
      // 13.5 是「不显大、但明显好读」的折中。行高 1.75 保持呼吸感。
      box: {
        padding: '14px 14px 16px', fontSize: '13.5px', lineHeight: '1.75',
        maxWidth: '680px', boxSizing: 'border-box',
      },
      title: { fontWeight: 600, marginBottom: '8px' },
      dim: { opacity: 0.75 },
      gap: { opacity: 0.75, marginTop: '6px' },
      code: { fontFamily: 'ui-monospace,Menlo,Consolas,monospace', fontSize: '12px' },
      // flexWrap：窄窗口下允许控件换到下一行，避免横向溢出。
      row: { display: 'flex', alignItems: 'center', gap: '8px', margin: '6px 0', flexWrap: 'wrap' },
      // 标签统一宽度：让所有行的控件左边缘对齐（视觉整齐的关键）。
      label: { minWidth: '92px', flex: '0 0 auto', opacity: 0.95 },
      hint: { opacity: 0.72, fontSize: '12.5px', marginLeft: '6px' },
      err: { color: '#c0392b', fontSize: '12px', marginTop: '6px' },
      ok: { color: '#1e8449', fontSize: '12px', marginTop: '6px' },
      foot: { opacity: 0.65, marginTop: '12px', fontSize: '12.5px', lineHeight: '1.6' },
      // 事件开关：勾选框 + 可换行的说明文字
      // 行间距略放大（v0.4.56）：420px 下说明文字密集，靠间距而不是缩字号。
      toggleRow: { display: 'flex', alignItems: 'flex-start', gap: '8px', margin: '10px 0' },
      toggleBox: { marginTop: '3px', flex: '0 0 auto' },
      toggleText: { flex: '1', lineHeight: '1.5' },
      toggleLabel: { fontWeight: 500 },
      // 说明另起一行：原来用「 — 说明」挤在名称后面，
      // 长中文说明换行后与下一个开关混在一起，难以扫读。
      toggleDesc: { opacity: 0.72, fontSize: '12.5px', marginTop: '2px', lineHeight: '1.6' },
      // 音源说明（弱化、单独一行）
      subHint: { opacity: 0.72, fontSize: '12.5px', margin: '3px 0 9px', lineHeight: '1.6' },
      btn: {
        padding: '5px 12px', fontSize: '12.5px', cursor: 'pointer',
        minHeight: '28px', lineHeight: '1.2',
        border: '1px solid rgba(128,128,128,.45)', borderRadius: '5px',
        background: 'transparent', color: 'inherit',
        transition: 'background .12s ease, border-color .12s ease',
      },
      // 悬停/聚焦反馈：桌面端点击目标小的时候，反馈很重要（知道点到了）。
      btnHover: { background: 'rgba(128,128,128,.14)', borderColor: 'rgba(128,128,128,.65)' },
      // 高级折叠区
      advHead: { margin: '14px 0 4px' },
      advBtn: {
        padding: '2px 0', fontSize: '13px', cursor: 'pointer',
        border: 'none', background: 'transparent', color: 'inherit', fontWeight: 600,
      },
      // 台词输入框：与下拉同样的边框风格，占满剩余宽度
      // 输入类控件统一高度 28px，与按钮对齐（视觉整齐 + 点击目标够大）。
      textInput: {
        flex: '1 1 160px', minWidth: '120px', padding: '4px 8px', fontSize: '13px',
        minHeight: '28px', boxSizing: 'border-box',
        border: '1px solid rgba(128,128,128,.45)', borderRadius: '5px',
        background: 'transparent', color: 'inherit',
      },
      // v0.5.6（issue #3b）：深色模式下下拉展开后看不清。
      //
      // 原样式是 `background: transparent; color: inherit`，看起来"跟随主题"，
      // 但原生 <select> 的**展开列表**由浏览器单独绘制，它按元素上的
      // `color-scheme` 决定用哪套 UA 配色 —— 我们没设，于是默认按浅色画白底，
      // 而文字继承的是深色主题的浅灰 → 白字白底，等于看不见。
      //
      // 修法：`colorScheme: 'inherit'` 让 select 沿用宿主的 color-scheme
      // （宿主在首帧前就给 <html>/<body> 设了它），展开列表随之变深色。
      // 不用写死颜色，浅色主题下行为不变。
      select: {
        padding: '4px 8px', fontSize: '13px', minHeight: '28px',
        boxSizing: 'border-box', maxWidth: '100%',
        border: '1px solid rgba(128,128,128,.45)', borderRadius: '5px',
        background: 'transparent', color: 'inherit',
        colorScheme: 'inherit',
      },
      // 高级区里每行的「子设置」容器：左侧留出缩进，表明从属于上一行
      subBox: {
        margin: '0 0 8px 94px', padding: '6px 10px',
        borderLeft: '2px solid rgba(128,128,128,.28)',
      },
      subRow: { display: 'flex', alignItems: 'center', gap: '8px', margin: '4px 0' },
      subLabel: { minWidth: '68px', fontSize: '12.5px', opacity: 0.88 },

      // ── 分区（v0.4.53 第一阶段 UI）──────────────────────────────────
      //
      // 用「上边框 + 较大上间距」分隔，不用卡片/阴影 ——
      // 与 DSH 原生设置页的克制风格一致，也避免视觉噪音。
      sectionTitle: {
        fontSize: '14.5px', fontWeight: 600, letterSpacing: '.01em',
        margin: '24px 0 3px', paddingTop: '15px',
        borderTop: '1px solid rgba(128,128,128,.22)',
      },
      sectionDesc: { fontSize: '12.5px', opacity: 0.72, margin: '3px 0 11px', lineHeight: '1.6' },

      // ── 滑杆（v0.4.53）──────────────────────────────────────────────
      //
      // 原来用 `flex: 1`：flex-basis 默认 auto → 滑杆按内容宽度生长，
      // 窄窗口下会把右侧数值挤出可视区，出现横向滚动。
      // 改成显式 basis + minWidth + maxWidth，让它可伸缩但有上下限。
      slider: { flex: '1 1 120px', minWidth: '100px', maxWidth: '100%', margin: 0 },

      // 滑杆右侧的数值：固定宽度 + 右对齐 + 等宽数字。
      // 固定宽度是为了滑动时数字位不跳；右对齐让它不贴窗口边缘。
      value: {
        minWidth: '48px', textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
        opacity: 0.78, fontSize: '12.5px',
      },

      // ── 试听按钮组（v0.4.55）────────────────────────────────────────
      //
      // 用户反馈：420px 下五个按钮挤成 4+1，最后一个「拦截」孤零零一行。
      //
      // 改法：整组**独占一行**（flex-basis 100%），用 grid 自动定列数。
      //   · 420px：内容宽约 364 → 排得下 5 列（每列约 63px）→ 一行五个
      //   · 更窄时自动降列 → 自然换行，行距列距一致（都是 6px）
      //   · maxWidth 340：720px 下不让按钮被拉成大块头
      //
      // 不缩小按钮：minmax 下限 56px 比原来的约 51px 还宽一点。
      pvGroup: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(56px, 1fr))',
        gap: '6px',
        flex: '1 1 100%',
        maxWidth: '340px',
        marginTop: '2px',
      },

      // ── 中性提示框（v0.4.55）────────────────────────────────────────
      //
      // 用于「不是错误、但用户应当知道」的状态（如弹窗与声音都关掉）。
      // 刻意**不用红/黄**：这不是故障，是用户自己的选择，只需告知结果。
      noticeBox: {
        margin: '8px 0 2px',
        padding: '8px 10px',
        borderLeft: '3px solid rgba(128,128,128,.5)',
        background: 'rgba(128,128,128,.08)',
        fontSize: '12.5px',
        lineHeight: '1.6',
        opacity: 0.92,
      },

      // 可点击的折叠标题（v0.4.55）：整行可点，箭头固定在最右。
      foldHead: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        cursor: 'pointer',
        userSelect: 'none',
        margin: '16px 0 2px',
        padding: '2px 4px',
        marginLeft: '-4px',
        borderRadius: '4px',
      },
      // 悬停/键盘焦点时的反馈（同一套，键盘用户也要看得见）。
      foldHeadActive: { background: 'rgba(128,128,128,.14)' },
      foldArrow: { flex: '0 0 auto', opacity: 0.6, fontSize: '11px' },

      // 说明文字：弱化但保持可读对比度（不要低到看不清）。
      fieldHint: { fontSize: '12.5px', opacity: 0.72, lineHeight: '1.6', flex: '1 1 100%', margin: '0 0 7px' },

      // 分组标签（v0.4.53）：像「语音包」「版本与更新」这种 ——
      // 它下面跟着一整块内容，不是一个带控件的字段。
      // 与 sectionTitle 的区别：**不带上边框**（它从属于当前分区，不是新分区）。
      groupLabel: {
        fontSize: '13px', fontWeight: 600, opacity: 0.9,
        margin: '16px 0 5px',
      },
    }

    /** 音源 id → 显示名（"跟随默认（xxx）"里要用）。 */
    var SRC_NAME = {
      tts: '系统语音合成',
      bundled: '语音包',
      system: '系统提示音',
      custom: '我的音频',
      none: '不出声',
    }

    // ── 配置读写（走 host route）───────────────────────────────────────────
    //
    // 为什么不走官方 Config 表单：本插件以 bundle 形态挂载时，
    // `volatileForm` 生成的表单出现在「插件配置编辑器」里，而不是设置页分区
    // （实测：分区里只有我们自己画的卡）。所以卡里自带控件，经 host route 落盘到
    // `$DSH_HOME/storages/dsh-notify-say/config.json`，插件每轮播报前重读 →
    // **改完立即生效，不用重启**。
    function cfgUrl(path) {
      try { return new URL('api/' + API_PREFIX + '/' + path, document.baseURI).toString() }
      catch (e) { return '/api/' + API_PREFIX + '/' + path }
    }

    /**
     * 弹出系统文件选择器，拿到**真实绝对路径**。
     *
     * ## 为什么不能只用 `<input type=file>`
     *
     * 浏览器安全限制下，`<input type=file>` 的 File 对象**拿不到绝对路径**
     * （只有 name/size/内容）。而我们的播放进程是按路径读文件的，必须拿真路径。
     *
     * ## 官方给的解法
     *
     * 宿主通过 contextBridge 暴露了 `__DSH_HOST_PATHS__.pathFor(file)`，
     * 底层是 Electron 的 `webUtils.getPathForFile`（app.asar 实证）。
     * 这是**正路**，本机桌面壳就是 `dsh-app://app`，能访问到。
     *
     * ## 降级
     *
     * 拿不到 `__DSH_HOST_PATHS__` 时（例如非桌面壳环境），退回只显示文件名并提示
     * 手动填路径 —— 绝不让按钮"点了没反应"。
     *
     * @returns {Promise<string>} 绝对路径；取消或失败返回空串
     */
    function pickCustomFile() {
      return new Promise(function (resolve) {
        try {
          var input = document.createElement('input')
          input.type = 'file'
          input.accept = 'audio/*,.wav,.mp3,.m4a,.flac,.ogg'
          input.style.display = 'none'
          document.body.appendChild(input)

          var done = function (val) {
            try { input.remove() } catch (e) { /* ignore */ }
            resolve(val || '')
          }

          input.addEventListener('change', function () {
            try {
              var f = input.files && input.files[0]
              if (!f) return done('')
              var host = globalThis.__DSH_HOST_PATHS__
              if (host && typeof host.pathFor === 'function') {
                var p = host.pathFor(f)
                if (typeof p === 'string' && p) return done(p)
              }
              // 拿不到真路径：不静默失败，明确告诉用户
              try {
                console.warn('[dsh-notify-say] 无法取得文件绝对路径，请手动在配置里填 customFile')
              } catch (e) { /* ignore */ }
              return done('')
            } catch (e) { return done('') }
          })
          input.click()
        } catch (e) {
          resolve('')
        }
      })
    }


      /** 把一行诊断写到宿主 notify.log（前缀 [ui]）。v0.4.76
       *  前端状态排查时不可见 —— 这次查「自动跳转」就卡在这里。
       *  失败一律静默。 */
      function uiLog(msg) {
        try {
          if (typeof fetch !== 'function') return
          fetch(cfgUrl('log'), {
            method: 'POST', cache: 'no-store', credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ msg: String(msg).slice(0, 400) }),
          }).catch(function () { /* 静默 */ })
        } catch (e) { /* 静默 */ }
      }
    /**
     * 本地**额外下载**过的音色 key（v0.5.6，issue #3）。
     *
     * 由 host 的 `/config` 响应带来（读一次用户目录，零网络）。
     * 放**模块级变量**而不是主 state：主 state 有 25 处 set() 逐字段重建，
     * 加一个字段要改 25 处，历史上已因此出过 4 次 bug。
     *
     * 时序是安全的：`loadConfig()` 先把它填上，紧接着主 state 才 set()
     * 触发重渲染 —— 那次渲染读到的就是新值。
     */
    var voiceInstalled = []

    function loadConfig() {
      return fetch(cfgUrl('config'), { cache: 'no-store', credentials: 'same-origin' })
        .then(function (r) { return r && r.ok ? r.json() : null })
        .then(function (d) {
          if (d && Array.isArray(d.installed)) {
            voiceInstalled = d.installed.filter(function (k) {
              return typeof k === 'string' && k !== ''
            })
          }
          return d && d.values ? d.values : {}
        })
        .catch(function () { return {} })
    }

    /**
     * 因官方规约**禁止再分发**而绝不能出现在候选里的音色（v0.5.6）。
     *
     * 与 `VOICE_KEYS` 上方那段注释、`tools/release-build.ps1` 的
     * `$NeverShipVoicePrefixes`、`docs/audio-audit/README.md` 的 FORBIDDEN
     * 是同一份名单。这里单独再挡一道，是因为「已下载」这条新通道
     * 绕过了静态清单 —— 老版本装过它们的人，目录里可能还留着文件。
     *
     * 只挡**法律禁止**的三个；`my-voice`（作者本人声音）不挡 ——
     * 那是「不分发」，不是「不许本机用」。
     */
    var VOICE_FORBIDDEN = ['mochiko', 'kasukabe-tsumugi', 'yurei-chan']

    /** 该 key 是否属于禁止出现的音色（前缀匹配，与 release-build.ps1 同款）。 */
    function isForbiddenVoice(key) {
      for (var i = 0; i < VOICE_FORBIDDEN.length; i++) {
        if (key.indexOf(VOICE_FORBIDDEN[i]) === 0) return true
      }
      return false
    }

    /**
     * 下拉候选追加「本地已下载的音色」（v0.5.6，issue #3）。
     *
     * 为什么必须有这一步（用户 2026-10-25 报的）：静态 VOICE_KEYS 只列
     * 发行版内置清单里的音色，用户后来下载的那些一律不在里面 ——
     * 于是下载成功了、语音包列表里写着"已安装"，音色下拉里却根本选不到。
     *
     * @param {string[]} list 调用方已经按语言过滤好的静态候选（**原地追加**）
     * @param {string} lang 'ja' | 'zh'
     * @returns {string[]} 同一个数组（便于链式写）
     */
    function appendInstalled(list, lang) {
      var isZh = lang === 'zh'
      for (var i = 0; i < voiceInstalled.length; i++) {
        var k = voiceInstalled[i]
        // 法律禁止的音色一律不列（见 VOICE_FORBIDDEN 上方注释）
        if (isForbiddenVoice(k)) continue
        if (((k.indexOf('zh-') === 0) === isZh) && list.indexOf(k) < 0) list.push(k)
      }
      return list
    }

    function saveConfig(patch) {
      return fetch(cfgUrl('config/set'), {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: patch }),
      })
        .then(function (r) { return r ? r.json().catch(function () { return null }) : null })
        .catch(function () { return null })
    }

    /**
     * 试听：**只出声，不弹窗**（v0.4.17）。
     *
     * 为什么需要：音量增益 / 发音人 / 音色 / 自定义音频这些设置，
     * 光看数字没法判断效果，只能盲调。有了试听就能边调边听。
     *
     * 与「测试通知」的区别：
     *   · 试听     → 只听声音（ps1 的 -Preview，无 Toast）
     *   · 测试通知 → 完整走一遍 notify()，含 Toast 弹窗
     *
     * @param {string} kind done|fail|question|approval|blocked|chime
     * @returns {Promise<object|null>} host 返回 { ok, kind, source, gain }
     */
    function previewSound(kind) {
      var k = kind || 'done'
      return fetch(cfgUrl('preview?kind=' + encodeURIComponent(k)), {
        cache: 'no-store',
        credentials: 'same-origin',
      })
        .then(function (r) { return r ? r.json().catch(function () { return null }) : null })
        .catch(function () { return null })
    }

    /** 音色候选（与 sounds/voice-lines 下的基础音色一致；可手输其他 key）。 */
    // 可下载/可选的音色清单（**只列审核通过的**）。
    //
    // ⚠️ 2026-10-18：移除 kasukabe-tsumugi 与 mochiko ——
    //   · 春日部つむぎ：官方规约第 6 条禁止「二次配布」
    //   · もち子さん：官方规约禁止「音声素材を無償配布」
    // 审核结论见 docs/audio-audit/README.md。
    //
    // 注意：这个列表只影响 GUI 下拉里的候选项。真正的分发拦截在
    // release-build.ps1 的 $NeverShipVoicePrefixes（构建期硬阻断），
    // 两处都要维护，但**构建期那道是安全网**。
    var VOICE_KEYS = [
      'zundamon-normal', 'zundamon-amama', 'ankomon', 'goki-nuigurumi',
      'kyushu-sora', 'manbetsu-hanamaru-genki', 'meimei-meria',
      'shikoku-metang', 'ameharu-hau', 'namiine-ritsu', 'shirakami-kotaro',
      // v0.5.6：补上漏登记的两个（issue #3 连带发现）。
      // 它们**早就**通过了许可审核（tools/build-voice-packs.ps1 的 $Approved
      // 与 docs/audio-audit/README.md 的"当前可发布清单"都有），
      // 只是这份前端清单忘了写 —— 于是下载了也在下拉里看不到。
      'tohoku-zunko', 'tohoku-kiritan',
      // ── 中文音色（v0.5.1）──────────────────────────────────────────────
      // 中文台词必须用中文音色念 —— 日语语音包念的是中文文本，会出戏。
      // 这 4 个由 EmotiVoice 合成，与上面 11 个 VOICEVOX 音色在分发机制上
      // **完全一样**（自带 1 个 + 其余下载），不引入第二套机制。
      // 同理，不放「主人」「ご主人様」这类称谓：中文语境里不自然。
      'zh-low-male', 'zh-mid-male', 'zh-clear-female', 'zh-soft-female',
    ]

    /**
     * 音色友好显示名（v0.4.55）。
     *
     * 用户反馈：下拉里显示 `zundamon-normal` 是**开发者内部标识**，
     * 普通用户看不懂。改为「角色名 · 风格名」；原 key 只在 title 悬停提示
     * 与诊断日志里出现。
     *
     * ⚠️ 只影响**显示**：保存提交的仍是原 key（voiceName / kindVoiceName），
     * 配置格式、默认值、后端一字未动。
     *
     * ⚠️ 名字与 `tools/build-voice-packs.ps1` 的 $Approved.Name 同源，
     * 由测试 cross-check 防漂移（见 test/voice-label.test.mjs）。
     */
    var VOICE_LABELS = {
      'zundamon-normal': 'ずんだもん · ノーマル',
      'zundamon-amama': 'ずんだもん · あまあま',
      'ankomon': 'あんこもん',
      'goki-nuigurumi': '後鬼 · ぬいぐるみ',
      'kyushu-sora': '九州そら',
      'manbetsu-hanamaru-genki': '満別花丸 · 元気',
      'meimei-meria': '冥鳴ひまり',
      'shikoku-metang': '四国めたん',
      'ameharu-hau': '雨晴はう',
      'namiine-ritsu': '波音リツ',
      'shirakami-kotaro': '白上虎太郎',
      'tohoku-zunko': '東北ずん子',
      'tohoku-kiritan': '東北きりたん',
      // 中文音色。后半段标「中文」是为了让下拉里一眼看出语种 ——
      // 用户装了 15 个音色时，光看「温柔女声 / ずんだもん」分不出哪个念中文。
      'zh-low-male': '低沉男声 · 中文',
      'zh-mid-male': '平稳男声 · 中文',
      'zh-clear-female': '清亮女声 · 中文',
      'zh-soft-female': '温柔女声 · 中文',
    }

    /**
     * key → 友好名。未知 key **原样返回**（不猜、不美化）——
     * 用户手填的自定义 key 显示成它自己，比显示一个错的别名安全。
     */
    function voiceLabel(key) {
      if (!key) return ''
      return VOICE_LABELS[key] || key
    }

    /**
     * 语音包元数据里的官方名（`ずんだもん（ノーマル）`）
     * → 统一成「角色名 · 风格名」，与 VOICE_LABELS 风格一致。
     *
     * 否则「语音包列表」用括号、「音色下拉」用点，同一件事两种叫法。
     */
    function prettyPackName(name) {
      var s = String(name || '')
      var m = /^(.+?)（(.+?)）$/.exec(s)
      return m ? (m[1] + ' · ' + m[2]) : s
    }

    /** 事件开关定义（键 → 中文名）。 */
    // 事件开关：[键, 名称, 一句话说明]。
    //
    // 说明文案是给**不了解内部术语**的人看的：
    //   - "空闲门" 是内部叫法，必须在界面上解释清楚它在防什么；
    //   - 其余各项也用"什么时候会响"的口语描述，而不是复述配置键的含义。
    // 事件开关：[键, 名称, 一句话说明, 分组, (可选)更长的解释]。
    //
    // 分组（v0.4.54 第二阶段 UI）—— 八个开关平铺太长，按「什么时候会用到」分三组：
    //   result  任务结果：跑完了 / 出错了 / 被拦了 / 你停了
    //   action  需要你操作：AI 在等你
    //   collab  子任务与协作：跟子代理、空闲门有关
    //
    // 第 3 项保持「一至两行」；更长的解释放第 5 项，渲染时作为 title 提示，
    // 悬停可见、不占版面（信息不丢，版面不乱）。
    var TOGGLES = [
      ['notifyOnComplete', '回合完成', '这一轮正常跑完时提醒你', 'result'],
      ['notifyOnError', '回合出错', '这一轮以错误结束时提醒（会播道歉语音）', 'result'],
      ['notifyOnBlocked', '被拦截', '还没开始就被拦下时提醒', 'result',
        '这一轮还没开始就被 AI 拦下时提醒（例如钩子拒绝了指令）。'],
      ['notifyOnAborted', '已中止', '你按了停止、或超出长度限制时提醒', 'result'],

      ['notifyOnApproval', '待批准', 'AI 要做敏感操作、等你点同意时提醒', 'action'],
      ['notifyOnQuestion', '要提问', 'AI 有问题问你、等你回答时提醒', 'action'],

      ['subagents', '子代理也提醒', '子代理每轮结束也提醒', 'collab',
        '连子代理自己的每一轮结束也提醒；默认只提醒你直接对话的那个会话。'],
      ['idleGate', '等真正干完再提醒', '子代理还在跑时先不响，全部结束再响一次', 'collab',
        '别被半路打断的「完成」骗了：AI 派出去的子任务还在跑时先不响，' +
        '等全部结束再响一次。关掉的话，一结束就响（即使还有子任务在跑）。'],
    ]

    /**
     * 设置卡片：**真控件**。
     *
     * 状态全部来自 host route；每次改动立刻 POST，成功后用返回的合并值刷新本地态。
     * 任何一步失败只显示一行错误，不让整卡崩掉。
     */
    function SettingsCard() {
      if (!React) return null
      var h = React.createElement
      // 初值只是"占位"，让控件首屏就有内容、可交互（避免闪一屏"读取中"）。
      // ⚠️ 真实值必须以 host 返回的**生效值**为准（见下方 useEffect 的 merge）。
      // 这些占位数字**不代表实际配置**：例如 patch 里 volume 可能是 100，
      // 这里写 80 只是防 undefined；生效值到达后会被覆盖。
      // 版本与更新（v0.4.48）—— **独立 state**，与主 state 隔离。
      //
      // 为什么不用主 state：主 state 有 25 处 set() 逐字段重建，
      // 加一个字段要改 25 处，已因此出过 4 次 bug。
      // 独立 useState 能彻底避开这个坑。
      var vst = React.useState({
        // null = 还没查过；失败时是 { ok:false, error }
        info: null,
        loading: false,
        copied: false,
      })
      var vset = vst[1]
      var vs = vst[0]

      // 高级设置内部四个二级分组的展开状态（v0.4.54）。
      //
      // 同样用**独立 state**：主 state 有 25 处 set() 逐字段重建，
      // 往里加字段要改 25 处（已因此踩过 4 次坑）。
      // 分组展开状态与配置无关，放独立 state 也不会因保存配置被重置。
      // 试听状态（v0.4.54）：记住「正在试听哪个事件」，让按钮有忙碌反馈。
      //
      // 为什么需要：原来点试听后按钮没有任何变化，要等下面的提示行才
      // 知道有没有执行；而试听是"要听才知道"的操作，没有即时反馈会让人
      // 反复点（还会撞上 3 秒限流）。独立 state，与主 state 无关。
      var pvst = React.useState({ kind: "" })
      var pvset = pvst[1]
      var pvState = pvst[0]

      var avst = React.useState({})
      var avset = avst[1]
      var advSec = avst[0]

      // 高级子组标题的悬停/焦点高亮（v0.4.55）。
      // 独立 state：它纯粹是瞬时交互反馈，与配置无关，
      // 也不该因为保存配置（25 处 set 重建主 state）被重置。
      var hvst = React.useState({ id: "" })
      var hvset = hvst[1]
      var advHover = hvst[0].id || ""

      // 声音设置区的展开状态（v0.4.56）。
      //
      // `null` = 跟随默认：声音提醒开着就展开、关了就收起。
      // 用户手动点过之后才固定成 true/false（不覆盖用户的显式选择）。
      //
      // ⚠️ 收起**只是隐藏**，配置一律保留；试听也在里面，
      // 用户想看随时能展开 —— 不禁用任何操作。
      var sndst = React.useState({ open: null })
      var sndset = sndst[1]
      var sndPref = sndst[0].open

      // 一次性重载的界面状态（v0.4.57）。独立 state：与配置无关，
      // 也不该因为保存配置（主 state 25 处 set 重建）被清掉。
      var rlst = React.useState({ busy: false, msg: "", err: "" })
      var rlset = rlst[1]
      var rlState = rlst[0]

      var st = React.useState({
        loaded: false,
        values: {
          voice: true, voiceMode: 'fixed', voiceName: 'zundamon-normal', volume: 80,
          notifyOnComplete: true, notifyOnError: true, notifyOnBlocked: true,
          notifyOnAborted: false, notifyOnApproval: true, notifyOnQuestion: true,
          subagents: false, idleGate: true,
        },
        busy: false, msg: '', err: '',
      // 语音包清单：null = 还没加载过（用户点按钮才加载）
      packs: { loading: false, list: null, error: null },
      // 已确认过条款的音色 key（v0.4.40）。
      //
      // 只存在内存里，不落盘 —— 理由见 renderTermsPrompt 上方注释。
      termsAck: {},
      // 正在等待用户确认的音色（null = 没在问）
      termsPending: null,
        // 高级折叠区默认收起：多数人不需要，铺开只会劝退
        advOpen: false,
      })
      var s = st[0]
      var set = st[1]

      React.useEffect(function () {
        var alive = true
        // 版本信息：挂载时查一次（宿主侧有 24 小时缓存，很便宜）。
        //
        // ⚠️ 必须走 Promise：直接 set 会触发重渲染 → effect 重跑 → 死循环
        // （v0.4.33 语音包那块就是这么把 4GB 堆打满的）。
        // 异步 .then 里 set 是安全的 —— 那时 effect 已经跑完了。
        fetchVersion(false).then(function (r) {
          if (!alive || !r) return
          vset(function (p) { return { info: r, loading: false, copied: p.copied } })
        })
        loadConfig().then(function (v) {
          if (!alive) return
          set(function (p) {
            // 生效值覆盖占位值。注意这里**整体覆盖**而非只填缺失键：
            // host 返回的 values 已经是四层合并后的完整配置，
            // 它才是真的；本地占位值一律作废。
            var merged = {}
            var k
            for (k in p.values) merged[k] = p.values[k]
            if (v) for (k in v) merged[k] = v[k]
            return { loaded: true, values: merged, packs: p.packs, termsAck: p.termsAck, termsPending: p.termsPending, busy: false, msg: '', err: '' }
          })
        })
        return function () { alive = false }
      }, [])

      /**
       * 保存一个配置变更。
       *
       * ⚠️ 每次 set 都**必须带上 advOpen**：状态是一个整体对象，
       * 漏掉某个字段就等于把它重置成 undefined。第一版漏了 advOpen，
       * 表现是"点一下任意控件，高级折叠区就自己收起来"——很恼人且难查。
       */
      function apply(patch, label) {
        set(function (p) {
          return {
            loaded: p.loaded, values: p.values, packs: p.packs, advOpen: p.advOpen,
            termsAck: p.termsAck, termsPending: p.termsPending,
            busy: true, msg: '', err: '',
          }
        })
        saveConfig(patch).then(function (r) {
          if (r && r.ok) {
            set(function (p) {
              return {
                loaded: true,
                values: r.values || p.values,
                packs: p.packs,
                advOpen: p.advOpen,
                termsAck: p.termsAck, termsPending: p.termsPending,
                busy: false,
                msg: (label || '已保存') + '（立即生效）',
                err: '',
              }
            })
            // v0.4.63：告诉跳转模块「缓存作废」——它把开关缓存在闭包里，
            // 不发这个事件的话，改了「前台也跳」要刷新页面才生效（实测发现）。
            try {
              if (typeof document !== 'undefined' && typeof CustomEvent === 'function') {
                document.dispatchEvent(new CustomEvent('dsh-notify-say:config-changed'))
              }
            } catch (e) { /* 广播失败不影响保存结果 */ }
          } else {
            set(function (p) {
              return {
                loaded: p.loaded, values: p.values, packs: p.packs, advOpen: p.advOpen,
                termsAck: p.termsAck, termsPending: p.termsPending,
                busy: false, msg: '',
                err: '保存失败：' + ((r && r.reason) || '未知原因'),
              }
            })
          }
        })
      }
      // ── 语音包动作（v0.4.32）──────────────────────────────────────
      //
      // 下载要几秒（1~3 MB），所以：进 busy 挡重复点击；
      // 完成后重拉清单，让"已安装"标记更新。
      function loadPacks() {
        set(function (p) {
          return {
            loaded: p.loaded, values: p.values, packs: p.packs, advOpen: p.advOpen, busy: p.busy, msg: p.msg, err: p.err,
            packs: { loading: true, list: null, error: null },
            // ⚠️ 2026-10-18 第三轮审阅：原来 termsAck / termsPending
            // 被写在这里（packs 子对象内层），层级错了 → 刷新列表后
            // 顶层确认状态被清掉，用户被反复要求确认同一音色。
            termsAck: p.termsAck, termsPending: p.termsPending,
          }
        })
        fetchVoicePacks().then(function (doc) {
          var ok = doc && doc.ok && Array.isArray(doc.packs)
          // v0.5.6（issue #3）：清单里带 installed，顺势刷新下拉候选 ——
          // 否则用户刚下载完一个音色，还得再刷新一次设置页才看得到它。
          if (ok) {
            voiceInstalled = doc.packs.filter(function (p) {
              return p && p.installed && typeof p.key === 'string' && p.key
            }).map(function (p) { return p.key })
          }
          set(function (p) {
            return {
              loaded: p.loaded, values: p.values, packs: p.packs, advOpen: p.advOpen, busy: p.busy, msg: p.msg, err: p.err,
              packs: {
                loading: false,
                list: ok ? doc.packs : null,
                error: ok ? null : ((doc && (doc.indexError || doc.reason)) || "无法获取"),
              },
              // 顶层状态：必须与 packs 平级，不能被塞进 packs 内层
              termsAck: p.termsAck, termsPending: p.termsPending,
            }
          })
        })
      }

      function addPack(key, label) {
        set(function (p) {
          return {
            loaded: p.loaded, values: p.values, advOpen: p.advOpen, packs: p.packs, busy: true,
            termsAck: p.termsAck, termsPending: p.termsPending,
            msg: "正在下载 " + label + "…", err: "",
          }
        })
        installVoicePack(key).then(function (r) {
          var ok = r && r.ok
          set(function (p) {
            return {
              loaded: p.loaded, values: p.values, advOpen: p.advOpen, packs: p.packs, busy: false,
              termsAck: p.termsAck, termsPending: p.termsPending,
              msg: ok ? ("已安装 " + label + "（" + (r.files || 0) + " 个文件）") : "",
              err: ok ? "" : ("安装失败：" + ((r && (r.error || r.reason)) || "未知原因")),
            }
          })
          if (ok) loadPacks()
        })
      }

      function removePack(key, label) {
        set(function (p) {
          return {
            loaded: p.loaded, values: p.values, advOpen: p.advOpen, packs: p.packs, busy: true,
            termsAck: p.termsAck, termsPending: p.termsPending,
            msg: "正在卸载 " + label + "…", err: "",
          }
        })
        uninstallVoicePack(key).then(function (r) {
          var ok = r && r.ok
          set(function (p) {
            return {
              loaded: p.loaded, values: p.values, advOpen: p.advOpen, packs: p.packs, busy: false,
              termsAck: p.termsAck, termsPending: p.termsPending,
              msg: ok ? ("已卸载 " + label) : "",
              err: ok ? "" : ("卸载失败：" + ((r && (r.error || r.reason)) || "未知原因")),
            }
          })
          if (ok) loadPacks()
        })
      }
      // ── 下载前条款确认（v0.4.40）─────────────────────────────────────
      //
      // ## 为什么需要
      //
      // 这些语音由不同作者创作，各有各的**再分发与使用限制**：
      //   · 有的要求必须署名（VOICEVOX:ずんだもん 这类 credit）
      //   · 有的禁止二次配布（我们因此下架了两个音色）
      //   · 有的对商用/改作有额外条件
      //
      // 条款必须**下载前**可见。只靠 zip 里的 TERMS.md 不够 ——
      // 那时文件已经落到用户机器上了，"先告知再下载"就变成了"先下载再说"。
      //
      // ## 这不是把审核责任推给用户
      //
      // 我们仍然自己审核（docs/audio-audit/ 有 13 份官方原文快照）。
      // 这里的确认只是把「你用它时也要守这些条款」传达给用户，
      // 不能替代开发者的合规判断。
      //
      // ## 为什么确认状态不落盘
      //
      // 存配置里意味着"确认过一次就永久静默"。但用户可能：
      //   · 换人用这台机器
      //   · 过很久后忘了条款内容
      // 每次都问又很烦。折中：**只在本次会话内记住**。
      // 浏览器刷新后重新问一次 —— 成本很低（点一下），收益是条款不会被遗忘。
      // ── 条款确认弹窗（v0.4.43）──────────────────────────────────────
      //
      // ## 为什么从「内联面板」改成「居中覆盖」
      //
      // v0.4.40 把确认面板放在语音包列表**下面**。2026-10-18 用户实测反馈：
      // 点列表上面几个音色时，面板在下面看不见 ——
      // 用户以为已经在下载，实际在等一个他没看见的确认。
      //
      // 这不只是「位置靠下」，而是**不阻断**：后面所有按钮照常可点。
      // 覆盖式遮罩能挡住交互，用户必须先处理这个确认。
      //
      // ## 为什么用 position:fixed 而不是 portal
      //
      // 这个渲染环境没有 portal API。fixed 相对视口居中，
      // 不受设置卡片滚动影响。
      //
      // ## 为什么点遮罩就取消
      //
      // 弹窗惯例，也避免用户被「卡住不知道怎么办」。
      // 只有点遮罩本身才关（判断 target === currentTarget），点卡片内部不关。
      function renderTermsModal(tp) {
        return h('div', {
          key: 'terms-backdrop',
          style: {
            position: 'fixed',
            top: 0, right: 0, bottom: 0, left: 0,
            background: 'rgba(0,0,0,.45)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 9999,
          },
          onClick: function (e) {
            if (e && e.target === e.currentTarget) cancelTerms()
          },
        },
          h('div', {
            key: 'terms-card',
            style: {
              width: 'min(430px, calc(100vw - 48px))',
              maxHeight: 'calc(100vh - 64px)',
              overflowY: 'auto',
              background: '#2b2b2b',
              color: '#eee',
              border: '1px solid rgba(255,200,80,.5)',
              borderRadius: '8px',
              padding: '16px',
              boxShadow: '0 12px 48px rgba(0,0,0,.55)',
              display: 'flex', flexDirection: 'column', gap: '8px',
            },
          },
            h('div', { style: { fontSize: '15px', fontWeight: 600 } },
              '下载前请先看条款'),
            h('div', { style: { fontSize: '13px', opacity: 0.85 } },
              (tp.name || tp.key) + '（' + tp.key + '）'),

            // 条款区：只给署名 + 官方链接，不写我们自己转述的摘要（转述会失真）
            h('div', {
              style: {
                marginTop: '4px', padding: '10px',
                background: 'rgba(255,200,80,.10)',
                border: '1px solid rgba(255,200,80,.28)',
                borderRadius: '5px',
                display: 'flex', flexDirection: 'column', gap: '6px',
                fontSize: '12.5px',
              },
            },
              h('div', null,
                tp.credit
                  ? ('署名要求：' + tp.credit)
                  : h('span', { style: { color: '#e0a030' } }, '该音色未标注署名要求')),
              tp.termsUrl
                ? h('div', null,
                  '官方条款：',
                  h('a', {
                    href: tp.termsUrl,
                    target: '_blank',
                    rel: 'noreferrer noopener',
                    style: { color: '#6cf', wordBreak: 'break-all' },
                  }, tp.termsUrl),
                )
                : h('div', { style: { color: '#e0a030' } },
                  '该音色没有登记官方条款链接 —— 使用前请自行查证作者条款。'),
              h('div', { style: { opacity: 0.7 } },
                '下载后 zip 内也带 TERMS.md。你用它做的内容（视频、直播等）仍需遵守上述条款。'),
            ),

            h('div', { style: { opacity: 0.6, fontSize: '11.5px' } },
              '插件已按官方原文审核过该音色可用于本插件；'
                + '这里确认的是「你自己使用这些语音时也要守上述条款」。'),

            h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '6px' } },
              h('button', {
                type: 'button',
                style: S.btn,
                onClick: function () { cancelTerms() },
              }, '取消'),
              h('button', {
                type: 'button',
                style: Object.assign({}, S.btn, {
                  background: '#3a6', color: '#fff', border: '1px solid #3a6',
                }),
                onClick: function () { ackTerms() },
              }, '我已阅读，开始下载'),
            ),
          ),
        )
      }

      function askTerms(pack) {
        set(function (p) {
          return {
            loaded: p.loaded, values: p.values, advOpen: p.advOpen, packs: p.packs,
            termsAck: p.termsAck, busy: p.busy, msg: "", err: "",
            termsPending: pack,
          }
        })
      }

      function ackTerms() {
        var pack = st[0].termsPending
        if (!pack) return
        set(function (p) {
          var ack = {}
          for (var k in p.termsAck) ack[k] = p.termsAck[k]
          ack[pack.key] = true
          return {
            loaded: p.loaded, values: p.values, advOpen: p.advOpen, packs: p.packs,
            termsAck: ack, busy: p.busy, msg: "", err: "",
            termsPending: null,
          }
        })
        // 确认后直接开始下载（少一次点击）
        addPack(pack.key, pack.name || pack.key)
      }

      function cancelTerms() {
        set(function (p) {
          return {
            loaded: p.loaded, values: p.values, advOpen: p.advOpen, packs: p.packs,
            termsAck: p.termsAck, busy: p.busy, msg: "", err: "",
            termsPending: null,
          }
        })
      }
      // 导出诊断：成功后把路径显示出来（用户要能直接找到文件）。
      function doExportDiagnostics() {
        set(function (p) {
          return { loaded: p.loaded, values: p.values, advOpen: p.advOpen, packs: p.packs, termsAck: p.termsAck, termsPending: p.termsPending, busy: true, msg: '正在导出诊断…', err: '' }
        })
        exportDiagnostics().then(function (r) {
          var ok = r && r.ok
          set(function (p) {
            return {
              loaded: p.loaded, values: p.values, advOpen: p.advOpen, packs: p.packs, busy: false,
              termsAck: p.termsAck, termsPending: p.termsPending,
              msg: ok ? ("已导出：" + r.path + "（" + r.lines + " 行）") : "",
              err: ok ? "" : ("导出失败：" + ((r && (r.error || r.reason)) || "未知原因")),
            }
          })
        })
      }
      // ── 版本与更新（v0.4.48）────────────────────────────────────────
      //
      // 只检查、不安装。升级由用户自己执行 DSH 命令。
      // 详见 lib/update-check.js 头注释（为什么不自动更新）。
      /**
       * 一次性自重载（v0.4.57）。
       *
       * 用户要求：「点一下重载一下」，不要"开了就一直重载"。
       * 所以这是一次显式请求，服务端也只尝试一次、失败不重试。
       *
       * ⚠️ 成功后当前实例已被 dispose、新实例接管，**这个响应可能发不回来**。
       * 所以 .catch 与 !r 都按"可能已经重载"提示用户刷新页面，
       * 而不是报"失败" —— 否则用户会以为没生效，反复点。
       */
      function doReload() {
        rlset({ busy: true, msg: "", err: "" })
        fetch(cfgUrl('reload'), {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
          .then(function (r) { return r ? r.json().catch(function () { return null }) : null })
          .then(function (r) {
            if (!r) {
              rlset({ busy: false, msg: '', err: '没有收到回应 —— 可能已经重载，请刷新页面确认；若未生效请重启 DSH。' })
              return
            }
            if (r.ok && r.noop) {
              rlset({ busy: false, msg: '磁盘上的代码与正在运行的一致，无需重载。', err: '' })
              return
            }
            if (r.ok) {
              rlset({ busy: false, msg: '已重载。请刷新页面，让设置界面也用新代码。', err: '' })
              return
            }
            rlset({ busy: false, msg: '', err: r.hint || '重载没有成功 —— 请重启 DSH。' })
          })
          .catch(function () {
            rlset({ busy: false, msg: '', err: '请求失败 —— 可能已经重载，请刷新页面确认；若未生效请重启 DSH。' })
          })
      }

      function checkVersion(force) {
        vset(function (p) {
          return { info: p.info, loading: true, copied: false }
        })
        fetchVersion(force).then(function (r) {
          vset(function (p) {
            return { info: r || { ok: false, error: "无法连接" }, loading: false, copied: p.copied }
          })
        })
      }

      // 复制升级命令。失败就退回"显示命令让用户自己选"。
      function copyUpgradeCommand(cmd) {
        var done = function (ok) {
          vset(function (p) { return { info: p.info, loading: p.loading, copied: ok } })
          if (!ok) {
            // 复制失败：至少把命令显示出来（界面上本来就有）
            console.warn("[dsh-notify-say] 复制失败，请手动选择命令文本")
          }
        }
        try {
          if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(cmd).then(function () { done(true) }).catch(function () { done(false) })
            return
          }
        } catch (e) { /* 继续用兜底 */ }
        done(false)
      }

      var v = s.values || {}
      var rows = []

      // ── 分区标题（v0.4.53 第一阶段 UI）──────────────────────────────
      //
      // 五个分区：通知方式 / 声音设置 / 提醒规则 / 通知行为 / 高级设置。
      // 用「上边框 + 较大上间距」分隔，不用卡片或阴影 ——
      // 与 DSH 原生设置页的克制风格一致，也避免视觉噪音。
      // 条件插入：按当前音源决定某个区块显不显示。
      //
      // 为什么用 `pushIf(cond, node)` 而不是把整块包进 if { }：
      //   · 闭合括号完全不用改（`rows.push(h(...))` 与 `pushIf(c, h(...))` 同形）
      //   · 只改每块的开头一行，改动面最小
      //
      // ⚠️ 只影响**可见性**，不碰任何值：切换音源不会删除/重置别的音源的配置。
      function pushIf(cond, node) { if (cond) rows.push(node) }

      function section(key, title, desc) {
        return h('div', { key: 'sec-' + key },
          h('div', { style: S.sectionTitle }, title),
          desc ? h('div', { style: S.sectionDesc }, desc) : null,
        )
      }

      // 旧的整卡标题已由「通知方式」分区标题取代（v0.4.53）。
      // 注意：**不因"未加载完"就提前 return**。初值已按默认配置填好，
      // 控件立即可用；真实值到达后自动覆盖（见 useEffect 的 merge）。
      // 早期版本在这里 return 了一行"读取配置中…"，导致首屏只有文字没有控件。


      // ── 一、通知方式 ────────────────────────────────────────────────
      rows.push(section('notify', '通知方式', '怎么提醒你：弹窗与声音分别开关，声音来源决定播什么。'))

      // ── 弹窗开关（v0.4.4）────────────────────────────────────────────────
      // 有人只想听声音、嫌弹窗打断；也有人只要弹窗、不要声音。两者都要能关。
      rows.push(h('div', { key: 'toast', style: S.row },
        h('span', { style: S.label }, '显示通知弹窗'),
        h('input', {
          type: 'checkbox',
          checked: v.showToast !== false,
          disabled: s.busy,
          onChange: function (e) { apply({ showToast: !!e.target.checked }, '弹窗开关已更新') },
        }),
        h('span', { style: S.hint }, v.showToast === false ? '关闭后只有声音' : '关掉后只听声音、不弹窗'),
      ))

      // 语音开关
      rows.push(h('div', { key: 'voice', style: S.row },
        h('span', { style: S.label }, '语音播报'),
        h('input', {
          type: 'checkbox',
          checked: v.voice !== false,
          disabled: s.busy,
          onChange: function (e) { apply({ voice: !!e.target.checked }, '语音开关已更新') },
        }),
        h('span', { style: S.hint }, '关掉只弹 Toast'),
      ))

      // ⚠️ 两个都关掉 = 完全没有任何提醒（v0.4.55）。
      //
      // 用户指出这个歧义：不禁止这样设置（那是用户的选择），
      // 但必须**如实告知结果**，否则用户以为"我配过了怎么没反应"。
      // 用中性样式，不用红/黄 —— 这不是故障。
      if (v.showToast === false && v.voice === false) {
        rows.push(h('div', { key: 'all-silent', style: S.noticeBox },
          '弹窗与声音都已关闭 —— 插件不会产生任何可见或可听的提醒。'
            + '（提醒规则里的事件仍会照常触发，只是没有任何表现。）'))
      }

      // ── 音源选择（v0.4.4）─────────────────────────────────────────────────
      //
      // 这是本插件最核心的可配置项：用户想听系统语音、想听语音包、想要系统音效、
      // 还是干脆不出声 —— 四种人都存在，所以必须能选。
      // 「none」单独作为一项，比"关掉语音开关"更明确（后者语义是"不要声音但可能还有别的"）。
      var SOURCES = [
        ['tts', '系统语音合成（不用下载）'],
        ['bundled', '语音包（可下载音色）'],
        ['system', '系统提示音（短促音效）'],
        ['custom', '我自己的音频文件'],
        ['none', '不出声，只显示通知'],
      ]
      var curSource = v.audioSource || 'tts'
      rows.push(h('div', { key: 'src', style: S.row },
        h('span', { style: S.label }, '声音来源'),
        h('select', {
          style: S.select,
          value: curSource,
          disabled: s.busy,
          onChange: function (e) { apply({ audioSource: e.target.value }, '声音来源已更新') },
        }, SOURCES.map(function (p) { return h('option', { key: p[0], value: p[0] }, p[1]) })),
      ))
      // 说明：让用户知道当前选项意味着什么，不用去猜
      var SRC_HINT = {
        tts: '用 Windows 自带语音念一句中文，不占空间、装了就能用',
        bundled: '播放下载的语音包（日语 VOICEVOX / 中文 EmotiVoice）；没下载过音色时会退回系统提示音',
        system: '播放 Windows 的系统提示音，完成/失败/提问各用不同的音',
        custom: '播放你自己指定的音频文件（在下方设置）',
        none: '完全不发声，只弹通知',
      }
      rows.push(h('div', { key: 'srchint', style: S.subHint }, SRC_HINT[curSource] || ''))

      // 音量
      // ── 二、声音设置 ────────────────────────────────────────────────
      rows.push(section('sound', '声音设置', '音量、音色与试听；语音包可按需下载。'))

      // 声音提醒关掉时，把音频控件收起来（v0.4.56）。
      //
      // 用户指出：两个提醒都关了，下面还铺着整套 TTS 设置，视觉噪音大。
      // 但**不能删**配置 —— 用户可能只是暂时静音，回头还要用。
      var voiceOff = v.voice === false
      var sndOpen = sndPref === null ? !voiceOff : sndPref === true
      if (voiceOff) {
        rows.push(h('div', { key: 'snd-off-head', style: S.foldHead,
          onClick: function () { sndset({ open: !sndOpen }) },
          role: 'button', tabIndex: 0,
          'aria-expanded': sndOpen ? 'true' : 'false',
          onKeyDown: function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              sndset({ open: !sndOpen })
            }
          },
        },
          h('span', { style: { fontSize: '13px', opacity: 0.9 } },
            '声音提醒已关闭，原有配置已保留'),
          h('span', { style: S.foldArrow }, sndOpen ? '▾' : '▸'),
        ))
      }

      if (sndOpen) {
      pushIf(curSource !== 'none', h('div', { key: 'vol', style: S.row },
        h('span', { style: S.label }, '音量'),
        h('input', {
          type: 'range', min: 0, max: 100, step: 1,
          value: typeof v.volume === 'number' ? v.volume : 80,
          disabled: s.busy,
          style: S.slider,
          // onChange 必须有：React 对「有 value 无 onChange」的受控表单元素会
          // 降级成只读并告警（本机是 React 19，受控组件语义更严格）。
          // 拖拽过程只改本地显示，不写盘 —— 避免每像素一次请求。
          onChange: function (e) {
            var n = Number(e.target.value)
            set(function (p) {
              var nv = {}; for (var k in p.values) nv[k] = p.values[k]
              nv.volume = n
              return {
                loaded: p.loaded, values: nv, advOpen: p.advOpen, packs: p.packs,
                termsAck: p.termsAck, termsPending: p.termsPending,
                busy: p.busy, msg: '', err: p.err,
              }
            })
          },
          // 松手才写盘。用 pointerup 覆盖鼠标/触摸/触控笔；
          // 再补 onBlur 兜底（指针在元素外抬起时元素收不到 pointerup）。
          onPointerUp: function (e) { apply({ volume: Number(e.currentTarget.value) }, '音量已更新') },
          onBlur: function (e) { apply({ volume: Number(e.currentTarget.value) }, '音量已更新') },
          onKeyUp: function (e) { apply({ volume: Number(e.currentTarget.value) }, '音量已更新') },
        }),
        h('span', { style: S.value }, String(typeof v.volume === 'number' ? v.volume : 80)),
      ))

      // ── 语音包增益（v0.4.16）─────────────────────────────────────────────
      //
      // 为什么单独一个滑杆：Windows 的播放音量上限是"原始幅度 1.0 倍"，
      // 而本包语音包峰值中位只有 40.4%（实测 247 个文件），
      // 所以上面「音量」拉满也只到原始电平的 35%~40%，听感偏轻。
      // 这个滑杆做**数字增益**：把样本乘一个系数，绕开 1.0 倍上限。
      //
      // ps1 侧会按峰值自动限幅（不超过 95%），所以不用担心调大破音。
      pushIf(curSource === 'bundled', h('div', { key: 'vogain', style: S.row },
        h('span', { style: S.label }, '语音包增益'),
        h('input', {
          type: 'range', min: 1.0, max: 4.0, step: 0.1,
          value: typeof v.voiceGain === 'number' ? v.voiceGain : 2.0,
          disabled: s.busy,
          style: S.slider,
          onChange: function (e) {
            var n = Number(e.target.value)
            set(function (p) {
              var nv = {}; for (var k in p.values) nv[k] = p.values[k]
              nv.voiceGain = n
              return {
                loaded: p.loaded, values: nv, advOpen: p.advOpen, packs: p.packs,
                termsAck: p.termsAck, termsPending: p.termsPending,
                busy: p.busy, msg: '', err: p.err,
              }
            })
          },
          onPointerUp: function (e) { apply({ voiceGain: Number(e.currentTarget.value) }, '增益已更新') },
          onBlur: function (e) { apply({ voiceGain: Number(e.currentTarget.value) }, '增益已更新') },
          onKeyUp: function (e) { apply({ voiceGain: Number(e.currentTarget.value) }, '增益已更新') },
        }),
        h('span', { style: S.value }, 'x' + (typeof v.voiceGain === 'number' ? v.voiceGain.toFixed(1) : '2.0')),
        // ⚠️ 2026-10-18 第二阶段 UI 去掉这里的「试听」按钮：
        // 它调的是 `previewSound('done')`，与下方「试听」行的「完成」按钮
        // **完全同功能**；而用户在这里调的是增益/音色，容易以为试听的是
        // 当前事件（比如正在调失败音）。重复入口 + 语义误导，所以只保留
        // 下方那一处（它能分别试听五种事件）。
      ))
      pushIf(curSource === 'bundled', h('div', { key: 'vogainhint', style: S.subHint },
        '语音包素材本身录得偏轻，这里补上。自动限幅，调大不会破音。'))

      // ── 自定义音频标准化（v0.4.16）──────────────────────────────────────
      //
      // 默认关：那是用户自己的素材，可能特意做得轻或响，不该擅自改。
      // 打开后才按统一响度处理（只对 16-bit PCM wav 生效）。
      pushIf(curSource === 'custom', h('div', { key: 'normcust', style: S.row },
        h('span', { style: S.label }, '自定义音频标准化'),
        h('input', {
          type: 'checkbox',
          checked: v.normalizeCustomAudio === true,
          disabled: s.busy,
          onChange: function (e) {
            apply({ normalizeCustomAudio: !!e.target.checked }, '已更新')
          },
        }),
        h('span', { style: S.hint }, v.normalizeCustomAudio === true
          ? '开：统一响度（仅 wav 有效）'
          : '关：尊重你原文件的响度'),
      ))

      // 不出声时，音频相关的滑块/试听都隐藏了 —— 但要让用户知道为什么。
      if (curSource === 'none') {
        rows.push(h('div', { key: 'none-hint', style: S.subHint },
          '当前是「不出声，只显示通知」：音频相关设置已隐藏。'
            + '通知弹窗与下方「提醒规则」照常生效。'))
      }

      // ── 试听（v0.4.17）──────────────────────────────────────────────────
      //
      // 为什么单独一行放五种事件：用户常给不同事件配不同音源
      // （例如"完成听日语、失败听系统音"），必须能分别试听确认。
      //
      // 试听**只出声、不弹窗**（ps1 的 -Preview）——
      // 它的用途是"听效果"，不是验证通知通路（那是「测试通知」的事）。
      pushIf(curSource !== 'none', h('div', { key: 'pv-row', style: S.row },
        h('span', { style: S.label }, '试听'),
        (function () {
          var KINDS = [
            ['done', '完成'], ['fail', '失败'], ['question', '提问'],
            ['approval', '批准'], ['blocked', '拦截'],
          ]
                      return h('div', { style: S.pvGroup },
            KINDS.map(function (pair) {
              var isBusy = pvState.kind === pair[0]
              return h('button', {
                type: 'button',
                key: 'pv-' + pair[0],
                // 正在试听某个事件时，全部按钮先禁用 —— 避免连点撞上 3 秒限流
                disabled: s.busy || (pvState.kind !== ""),
                style: Object.assign({}, S.btn, isBusy ? {
                  borderColor: 'rgba(128,128,128,.8)',
                  background: 'rgba(128,128,128,.16)',
                } : null),
                onClick: function () {
                  // 立刻给反馈：按钮变「…」并禁用，用户知道点到了
                  pvset({ kind: pair[0] })
                  // 先写盘再试听：让试听用的就是刚才调的值
                  previewSound(pair[0]).then(function (r) {
                    pvset({ kind: "" })
                    var ok = Boolean(r && r.ok)
                    set(function (p) {
                      return {
                        loaded: p.loaded, values: p.values, packs: p.packs, advOpen: p.advOpen,
                        termsAck: p.termsAck, termsPending: p.termsPending,
                        busy: false,
                        // 成功写 msg、失败写 err —— 两者用不同颜色，不用猜
                        msg: ok
                          ? ('已试听「' + pair[1] + '」' + (r.source ? '（' + r.source + '）' : ''))
                          : '',
                        err: ok
                          ? ''
                          : ('试听「' + pair[1] + '」没有成功。可能是限流（3 秒一次）或播放失败，'
                            + '稍等一下再点，或查看诊断日志。'),
                      }
                    })
                  }).catch(function () {
                    pvset({ kind: "" })
                    set(function (p) {
                      return {
                        loaded: p.loaded, values: p.values, packs: p.packs, advOpen: p.advOpen,
                        termsAck: p.termsAck, termsPending: p.termsPending,
                        busy: false, msg: "", err: "试听请求失败（网络或路由不可用）。",
                      }
                    })
                  })
                },
              }, isBusy ? '…' : pair[1])
            }),
          )
        })(),
      ))
      pushIf(curSource !== 'none', h('div', { key: 'pv-hint', style: S.subHint },
        '试听只出声、不弹窗。调完增益或换了音色，点一下就能听效果。'))
      pushIf(curSource !== 'none', h('div', { key: 'pv-rate', style: S.subHint },
        '每 3 秒最多一次；点完按钮会短暂变「…」，那是在播放。'))

      // ── 语音包管理（v0.4.32）──────────────────────────────────────
      //
      // 核心包只带 2 个音色（1 日语 + 1 中文），其余按需下载。
      //
      // ⚠️ 刻意**不在挂载时自动加载**：set 会触发重渲染，
      // 而任何同步执行的 useEffect 都会让「加载 → set → 重渲染 → 加载」
      // 变成死循环（实测把 4GB 堆打满）。改为用户点按钮触发。
      if (curSource === 'bundled') {
        var vp = s.packs || { loading: false, list: null, error: null }
        rows.push(h('div', { key: 'vp-title', style: S.groupLabel }, '语音包'))

        if (vp.loading) {
          rows.push(h('div', { key: 'vp-loading', style: S.subHint }, '正在获取可下载音色…'))
        } else if (!vp.list) {
          rows.push(h('div', { key: 'vp-idle', style: S.subHint },
            vp.error
              ? '未能获取可下载列表：' + vp.error + '。已装的音色仍可正常使用。'
              : '核心包自带 2 个音色（1 日语 + 1 中文）。点下面的「加载列表」看看还有哪些可以下载。'))
          rows.push(h('div', { key: 'vp-load-row', style: S.row },
            h('button', {
              type: 'button',
              disabled: s.busy,
              style: S.btn,
              onClick: function () { loadPacks() },
            }, vp.error ? '重试' : '加载列表'),
          ))
        } else {
          var items = vp.list.filter(function (p) { return p.downloadable || p.installed })
          rows.push(h('div', { key: 'vp-list', style: { display: 'flex', flexDirection: 'column', gap: '4px', flex: '1' } },
            items.map(function (p) {
              var mb = p.bytes ? (p.bytes / 1048576).toFixed(1) + ' MB' : ''
              // 每个音色显示：名称 + 体积 + 署名 + 官方条款链接（v0.4.40）
              //
              // 为什么必须在这里显示：这些语音各有各的再分发与使用限制，
              // 条款要**下载前**可见 —— 不能只靠 zip 里的 TERMS.md（那要下载后才看得到）。
              return h('div', { key: 'vp-item-' + p.key, style: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '3px 0' } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                  h('span', { style: { flex: '1' }, title: p.key },
              (prettyPackName(p.name) || p.key) + (mb ? '（' + mb + '）' : '')),
                  p.installed ? h('span', { style: { color: '#2a7' } }, '已安装') : null,
                  h('button', {
                    type: 'button',
                    // ⚠️ 2026-10-18 第三轮审阅指出：原来的条件是
                    // `s.busy || !p.downloadable`，而离线时远程索引拿不到，
                    // 本地已装的包会是 installed=true / downloadable=false
                    // → **连卸载按钮都被禁用**。
                    //
                    // 卸载动的是本地文件，不该依赖 GitHub 在线状态。
                    disabled: s.busy || (!p.installed && !p.downloadable),
                    style: S.btn,
                    onClick: function () {
                      if (p.installed) { removePack(p.key, p.name || p.key); return }
                      // 没确认过条款 → 先问（见 askTerms）
                      if (!(s.termsAck && s.termsAck[p.key])) { askTerms(p); return }
                      addPack(p.key, p.name || p.key)
                    },
                  }, p.installed ? '卸载' : (p.downloadable ? '下载' : '不可用')),
                ),
                // 署名与条款：小字，不抢视觉但随时可查。
                //
                // ⚠️ 占位提示的判据是「**能下载却没有条款**」（v0.4.56）：
                // 那才是真的数据问题，值得提示。
                //
                // 原来判据是「没有 termsUrl 就提示」，于是**离线**时
                // （索引取不到 → 已安装的包也没有 termsUrl）界面会显示
                // 「条款链接待补」，看起来像插件发布缺字段 —— 虚报。
                //
                // 许可安全本身不受影响：下载按钮要求 p.downloadable，
                // 而 downloadable 只可能来自带 terms 的远程索引。
                h('div', { style: S.subHint },
                  (p.credit ? '署名：' + p.credit : '')
                  // 内联判断（这里是表达式上下文，不能写 var）
                  + ((p.downloadable && !p.termsUrl) ? '　（条款链接待补）' : ''),
                  p.termsUrl
                    ? h('a', {
                      href: p.termsUrl,
                      target: '_blank',
                      rel: 'noreferrer noopener',
                      style: { color: '#4a9', marginLeft: '6px' },
                    }, '官方条款 ↗')
                    : null,
                ),
              )
            }),
          ))
          rows.push(h('div', { key: 'vp-hint', style: S.subHint },
            '日语语音由 VOICEVOX 生成，中文语音由 EmotiVoice 生成；各有各的署名与用途限制，下载后会附 TERMS.md。'))
        }
      }
      // ── 语音包专属设置（仅 bundled 时显示）──────────────────────────────
      if (curSource === 'bundled') {
        // v0.5.3：语音语言。放在最前面，因为它决定下面「固定音色」列出哪一组。
        //
        // 为什么单独一项而不是给音色名加分组：随机模式下音色名是置灰的，
        // 用户看不到"现在随机会抽到哪种语言"。语言独立成一个选择器，
        // 两种模式下都有意义（fixed 决定选哪组音色，random 决定抽哪个池）。
        rows.push(h('div', { key: 'lang', style: S.row },
          h('span', { style: S.label }, '语音语言'),
          h('select', {
            style: S.select,
            value: v.voiceLang || 'ja',
            disabled: s.busy,
            onChange: function (e) {
              // 切语言时顺带把音色名换成该语言的默认音色 ——
              // 否则会出现「语言=中文，固定音色=ずんだもん」这种自相矛盾的组合
              // （那会让中文池里去找一个日语 key，直接落空）。
              var nextLang = e.target.value
              var fallback = nextLang === 'zh' ? 'zh-soft-female' : 'zundamon-normal'
              var curName = v.voiceName || ''
              var curBelongs = (curName.indexOf('zh-') === 0) === (nextLang === 'zh')
              apply({
                voiceLang: nextLang,
                voiceName: (curName && curBelongs) ? curName : fallback,
              }, '语音语言已更新')
            },
          },
            h('option', { value: 'ja' }, '日本語（VOICEVOX 音色）'),
            h('option', { value: 'zh' }, '中文（EmotiVoice 音色）'),
          ),
        ))

        // 音色模式
        rows.push(h('div', { key: 'mode', style: S.row },
          h('span', { style: S.label }, '音色模式'),
          h('select', {
            style: S.select,
            value: v.voiceMode || 'fixed',
            disabled: s.busy,
            onChange: function (e) { apply({ voiceMode: e.target.value }, '音色模式已更新') },
          },
            h('option', { value: 'fixed' }, '固定音色'),
            h('option', { value: 'random' }, '每次随机'),
          ),
        ))

        // 音色名（随机模式下置灰，避免误以为它仍生效）
        var fixedMode = (v.voiceMode || 'fixed') === 'fixed'
        // v0.5.3：下拉只列当前语言的音色。中日混排的列表里用户很难分辨，
        // 而且选错会直接落空（中文池里找日语 key）。
        var curLang = v.voiceLang || 'ja'
        var keyOpts = VOICE_KEYS.filter(function (k) {
          return (k.indexOf('zh-') === 0) === (curLang === 'zh')
        })
        // v0.5.6（issue #3）：用户后来**下载**的音色也要出现在这里。
        // 不追加的话，下载成功了、语音包列表写着「已安装」，
        // 但在音色下拉里根本找不到它 —— 等于白下。
        appendInstalled(keyOpts, curLang)
        // 当前生效的音色若不属于该语言（老配置 / 刚切语言），也要列出来。
        // 不列的话 <select> 会显示成第一项，用户以为音色被偷偷改了。
        if (v.voiceName && keyOpts.indexOf(v.voiceName) < 0) keyOpts.unshift(v.voiceName)
        rows.push(h('div', { key: 'name', style: S.row },
          h('span', { style: S.label }, '固定音色'),
          h('select', {
            style: S.select,
            value: v.voiceName || (curLang === 'zh' ? 'zh-soft-female' : 'zundamon-normal'),
            disabled: s.busy || !fixedMode,
            onChange: function (e) { apply({ voiceName: e.target.value }, '音色已更新') },
          }, keyOpts.map(function (k) {
            // value 仍是原 key（保存用它），只改显示文本；原 key 放 title
            return h('option', { key: k, value: k, title: k }, voiceLabel(k))
          })),
          // 随机模式下的提示要说清"随机的是哪种语言"，否则用户不知道按钮管什么用
          fixedMode ? null : h('span', { style: S.hint },
            (curLang === 'zh' ? '从中文台词里随机' : '从日语台词里随机')),
        ))
      }

      // ── TTS 专属设置（仅 tts 时显示）─────────────────────────────────────
      if (curSource === 'tts') {
        var TTS_VOICES = [['', '系统默认'], ['Microsoft Huihui Desktop', 'Huihui（中文女声）'],
          ['Microsoft Zira Desktop', 'Zira（英文女声）']]
        rows.push(h('div', { key: 'ttsv', style: S.row },
          h('span', { style: S.label }, '朗读声音'),
          h('select', {
            style: S.select,
            value: v.ttsVoice || '',
            disabled: s.busy,
            onChange: function (e) { apply({ ttsVoice: e.target.value }, '朗读声音已更新') },
          }, TTS_VOICES.map(function (p) { return h('option', { key: p[0], value: p[0] }, p[1]) })),
        ))
        rows.push(h('div', { key: 'ttsr', style: S.row },
          h('span', { style: S.label }, '语速'),
          h('input', {
            type: 'range', min: -10, max: 10, step: 1,
            value: typeof v.ttsRate === 'number' ? v.ttsRate : 0,
            disabled: s.busy,
            style: S.slider,
            onChange: function (e) {
              var n = Number(e.target.value)
              set(function (p) {
                var nv = {}; for (var k in p.values) nv[k] = p.values[k]
                nv.ttsRate = n
                return {
                loaded: p.loaded, values: nv, advOpen: p.advOpen, packs: p.packs,
                termsAck: p.termsAck, termsPending: p.termsPending,
                busy: p.busy, msg: '', err: p.err,
              }
              })
            },
            onPointerUp: function (e) { apply({ ttsRate: Number(e.currentTarget.value) }, '语速已更新') },
            onBlur: function (e) { apply({ ttsRate: Number(e.currentTarget.value) }, '语速已更新') },
            onKeyUp: function (e) { apply({ ttsRate: Number(e.currentTarget.value) }, '语速已更新') },
          }),
          h('span', { style: S.value }, (function () {
            var n = typeof v.ttsRate === 'number' ? v.ttsRate : 0
            return n === 0 ? '正常' : (n < 0 ? '慢 ' + Math.abs(n) : '快 ' + n)
          })()),
        ))

        // ── 自定义台词（v0.4.8）─────────────────────────────────────────────
        //
        // 用户 2026-10-17 要求："既然是这个 TTS 台词，是不是可以用户去输一段话呀？"
        // 留空 = 用内置台词库（每种事件 2~4 句随机，避免听腻）。
        //
        // 用受控 input + onBlur 保存（不是每次按键都写盘）：
        // 打字过程频繁 POST 没有意义，还会让光标位置闪。
        rows.push(h('div', { key: 'ttsTextHint', style: S.subHint },
          '想让它说别的话就填在这里（最多 60 字）。留空则每次从内置的几句里随机。'))
        var TTS_TEXT_ROWS = [
          ['Done', '任务完成'],
          ['Fail', '任务失败'],
          ['Question', '向你提问'],
          ['Approval', '待你批准'],
          ['Blocked', '被拦截'],
        ]
        TTS_TEXT_ROWS.forEach(function (pair) {
          var suffix = pair[0]
          var label = pair[1]
          var key = 'ttsText' + suffix
          rows.push(h('div', { key: 'tt-' + suffix, style: S.row },
            h('span', { style: S.label }, label),
            h('input', {
              type: 'text',
              maxLength: 60,
              placeholder: '留空 = 内置随机',
              value: typeof v[key] === 'string' ? v[key] : '',
              disabled: s.busy,
              style: S.textInput,
              // 打字时只更新本地显示，不发请求
              onChange: (function (k) {
                return function (e) {
                  var val = e.target.value
                  set(function (p) {
                    var nv = {}; for (var kk in p.values) nv[kk] = p.values[kk]
                    nv[k] = val
                    return {
                      loaded: p.loaded, values: nv, advOpen: p.advOpen, packs: p.packs,
                      termsAck: p.termsAck, termsPending: p.termsPending,
                      busy: p.busy, msg: '', err: p.err,
                    }
                  })
                }
              })(key),
              // 失去焦点 / 回车才写盘
              onBlur: (function (k) {
                return function (e) {
                  var o = {}
                  o[k] = e.target.value
                  apply(o, '台词已更新')
                }
              })(key),
              onKeyDown: function (e) {
                if (e.key === 'Enter') { try { e.target.blur() } catch (x) { /* ignore */ } }
              },
            }),
          ))
        })
      }

      // ── 自定义音频（仅 custom 时显示）────────────────────────────────────
      //
      // 按事件分别选文件：用户可能想让"完成"放自己的音乐、"失败"放另一段。
      // 保存的是扁平键（customFileDone / customFileFail …），因为 config-store
      // 的白名单只认标量；host 侧会拼成 audio-source 需要的 customFiles 字典。
      //
      // ⚠️ 只记录**路径**，不复制文件：用户改文件立即生效，也不占额外空间。
      if (curSource === 'custom') {
        rows.push(h('div', { key: 'custhint', style: S.subHint },
          '给每种提醒各挑一个 wav / mp3。文件不会被复制，插件只记住位置。'))
        var CUSTOM_KINDS = [
          ['Done', '任务完成'],
          ['Fail', '任务失败'],
          ['Question', '向你提问'],
          ['Approval', '待你批准'],
        ]
        CUSTOM_KINDS.forEach(function (pair) {
          var suffix = pair[0]
          var label = pair[1]
          var key = 'customFile' + suffix
          var cur = v[key] || ''
          rows.push(h('div', { key: 'cf-' + suffix, style: S.row },
            h('span', { style: S.label }, label),
            h('button', {
              type: 'button',
              disabled: s.busy,
              style: S.btn,
              onClick: (function (k) {
                return function () {
                  pickCustomFile().then(function (p) {
                    if (p) {
                      var patch = {}
                      patch[k] = p
                      patch.audioSource = 'custom'
                      apply(patch, '已选择音频文件')
                    } else {
                      set(function (prev) {
                        return {
                          loaded: prev.loaded, values: prev.values, advOpen: prev.advOpen, packs: prev.packs,
                          termsAck: prev.termsAck, termsPending: prev.termsPending,
                          busy: false, msg: '',
                          err: '没有取到文件路径。若点了没反应，可手动在配置里填该事件的 customFile。',
                        }
                      })
                    }
                  }).catch(function () { /* pickCustomFile 内部已兜底 */ })
                }
              })(key),
            }, cur ? '更换…' : '选择文件…'),
            h('span', { style: S.hint }, cur || '（未选择，将用系统提示音）'),
            cur ? h('button', {
              type: 'button',
              disabled: s.busy,
              style: S.btn,
              onClick: (function (k) {
                return function () {
                  var patch = {}
                  patch[k] = ''
                  apply(patch, '已清除')
                }
              })(key),
            }, '清除') : null,
          ))
        })
      }

      // 事件开关（未设置时用默认：aborted / subagents 默认关，其余默认开）
      var DEFAULTS = {
        notifyOnComplete: true, notifyOnError: true, notifyOnBlocked: true,
        notifyOnAborted: false, notifyOnApproval: true, notifyOnQuestion: true,
        subagents: false, idleGate: true,
      }
      }   // ← 声音设置区展开/收起（v0.4.56）

      // ── 三、提醒规则 ────────────────────────────────────────────────
      rows.push(section('rules', '提醒规则', '哪些事件要提醒你。默认只提醒需要你关注的那些。'))
      // 按「什么时候会用到」分三组渲染（v0.4.54）。
      // 每组一个小标题；组内仍是一行一个独立开关（开关语义与默认值完全不变）。
      var TOGGLE_GROUPS = [
        ['result', '任务结果'],
        ['action', '需要你操作'],
        ['collab', '子任务与协作'],
      ]
      TOGGLE_GROUPS.forEach(function (g) {
        var groupId = g[0]
        var groupName = g[1]
        var items = TOGGLES.filter(function (p) { return p[3] === groupId })
        if (items.length === 0) return
        rows.push(h('div', { key: 'tg-head-' + groupId, style: S.groupLabel }, groupName))

        items.forEach(function (pair) {
          var key = pair[0]
          var label = pair[1]
          var desc = pair[2] || ''
          var detail = pair[4] || ''
          var cur = (typeof v[key] === 'boolean') ? v[key] : DEFAULTS[key]
          // 名称独占一行（扫读先看到项目名），说明在下方弱化色。
          // 更长的解释放 title（悬停可见）—— 版面保持一至两行，信息不丢。
          rows.push(h('div', { key: 'tg-' + key, style: S.toggleRow, title: detail || desc },
            h('input', {
              type: 'checkbox',
              checked: cur === true,
              disabled: s.busy,
              style: S.toggleBox,
              onChange: (function (k) {
                return function (e) {
                  var o = {}
                  o[k] = !!e.target.checked
                  apply(o, '已更新')
                }
              })(key),
            }),
            h('div', { style: S.toggleText },
              h('div', { style: S.toggleLabel }, label),
              desc ? h('div', { style: S.toggleDesc }, desc) : null,
            ),
          ))
        })
      })

      // ── 四、通知行为 ────────────────────────────────────────────────
      rows.push(section('behavior', '通知行为', '什么时候跳回会话，以及多久算“重复提醒”。'))

      // ── 会话跳转（v0.4.6）──────────────────────────────────────────────
      //
      // 为什么这里是**两个**开关而不是一个：
      // 切回窗口有两种情形，用户诉求正好相反 ——
      //   · 后台完成 → 回来自动带到那条会话（省得自己翻侧栏）
      //   · 前台完成 → 有人想跳过去看一眼，有人**故意不想跳**
      //     （想自己按绿点逐个确认哪些完成了）
      // 所以不替用户选，两两组合出四种行为。
      //
      // ⚠️ 2026-10-20 更正：这里原本写着「Toast 的点击只能唤起窗口、
      // 带不了会话 id，所以点通知才跳做不到」。**那个结论已经过时** ——
      // v0.4.70 起通过注册自有协议 dshnotify-say:// 已能精确跳转，
      // 见下面新增的 toastJumpSession 开关。
      // 「只能靠窗口从后台回来作为信号」现在仅适用于**未开启**精准跳转时。
      rows.push(h('div', { key: 'sepHr2', style: { margin: '10px 0 4px', borderTop: '1px solid rgba(128,128,128,.25)' } }))
      rows.push(h('div', { key: 'jumpTitle', style: { fontWeight: 600, margin: '6px 0 2px' } }, '跳回对应会话'))
      rows.push(h('div', { key: 'jumpHint', style: S.subHint },
        '收到完成提醒后，自动带你回到那条会话。'))

      // ── 精准跳转开关（v0.4.83 补上）────────────────────────────────────
      //
      // 这个功能 v0.4.70 就实现了，却**一直没在设置页暴露** ——
      // 只能改配置文件才能开。而 README 写着「设置页打开它」，
      // 属于文档与实现不一致（发布前审查发现的 P2 缺陷）。
      //
      // 文案要点：必须让用户知道三件事，否则会困惑
      //   ① 这是**点了才跳**，与下面的自动跳不是一回事
      //   ② 开启会注册 Windows 自定义协议（有人会介意）
      //   ③ 关掉会把它清理干净（不留尾巴）
      rows.push(h('div', { key: 'jumpClick', style: S.toggleRow },
        h('input', {
          type: 'checkbox',
          checked: v.toastJumpSession === true,
          disabled: s.busy,
          style: S.toggleBox,
          onChange: function (e) { apply({ toastJumpSession: !!e.target.checked }, '已更新（立即生效）') },
        }),
        h('div', { style: S.toggleText },
          h('span', { style: S.toggleLabel }, '点击通知跳到对应会话'),
          h('span', { style: S.toggleDesc },
            ' — 点哪条通知就打开哪条会话，多会话时尤其有用。'
            + '开启后会在 Windows 注册 dshnotify-say:// 协议，关掉时自动清理。'
            + '这是「你点了才跳」，与下面的自动跳不是一回事。'),
        ),
      ))

      // 开了精准跳转 → 自动跳会被关掉。必须明确告诉用户，
      // 否则他调下面的开关没反应，会以为是 bug。
      if (v.toastJumpSession === true) {
        rows.push(h('div', { key: 'jumpClickNote', style: S.subHint },
          '已开启精准跳转：下面两个自动跳开关暂时不生效 —— 只有你点通知时才跳。'
          + '关掉精准跳转即恢复。'))
      } 

      rows.push(h('div', { key: 'jumpBg', style: S.toggleRow },
        h('input', {
          type: 'checkbox',
          checked: v.jumpWhenBackground !== false,
          disabled: s.busy,
          style: S.toggleBox,
          onChange: function (e) { apply({ jumpWhenBackground: !!e.target.checked }, '跳转设置已更新') },
        }),
        h('div', { style: S.toggleText },
          h('span', { style: S.toggleLabel }, '在后台完成时跳转'),
          h('span', { style: S.toggleDesc },
            ' — 你在别的窗口忙、任务完成了，回来时直接落到那条会话。'),
        ),
      ))

      rows.push(h('div', { key: 'jumpFg', style: S.toggleRow },
        h('input', {
          type: 'checkbox',
          checked: v.jumpWhenForeground === true,
          disabled: s.busy,
          style: S.toggleBox,
          onChange: function (e) { apply({ jumpWhenForeground: !!e.target.checked }, '跳转设置已更新') },
        }),
        h('div', { style: S.toggleText },
          h('span', { style: S.toggleLabel }, '窗口就在眼前时也跳转'),
          h('span', { style: S.toggleDesc },
            ' — 默认关。关掉时你正看着屏幕，它不会动你的位置；'
            + '打开则每次完成都带你过去看一眼。'),
        ),
      ))

      // ── 多会话规则（v0.4.62）───────────────────────────────────────────────
      //
      // 用户 2026-10-19 的洞察：跳走的动作本身会让"你正在看的那条会话"
      // 失去注意力 —— 如果它也是刚完成的，你回头就忘了看结果。
      // 所以默认改成"跳最早错过的"：你多半仍停在它上面，对它 openSession
      // 等于无操作，于是不打断；而你最先错过的那个正好被带过去。
      var JUMP_RULES = [
        ['clicked', '点哪个就跳哪个（推荐）'],
        ['earliest', '跳到最早错过的那个'],
        ['latest', '跳到最后一个'],
        ['none', '都不跳，靠侧栏绿点自己看'],
      ]
      var RULE_HINT = {
        clicked: '推荐。你点哪个 Toast 就跳到哪个会话（精确，不靠猜）。没点 Toast 直接切回来时，退回「最早错过的」那条。',
        earliest: '不点 Toast、直接切回来时，跳到最早错过的那个。',
        latest: '只在最后完成的那条会话上落脚。',
        none: '多个会话都完成时不跳，侧栏绿点一个个自己点。单会话时照常跳。',
      }
      var curRule = typeof v.multiJumpRule === 'string' ? v.multiJumpRule : 'clicked'
      rows.push(h('div', { key: 'jumpRule', style: S.row },
        h('span', { style: S.label }, '多个会话完成时'),
        h('select', {
          style: S.select,
          value: curRule,
          disabled: s.busy,
          onChange: function (e) { apply({ multiJumpRule: e.target.value }, '跳转规则已更新') },
        }, JUMP_RULES.map(function (p) { return h('option', { key: p[0], value: p[0] }, p[1]) })),
      ))
      rows.push(h('div', { key: 'jumpRuleHint', style: S.subHint }, RULE_HINT[curRule] || ''))

      // 两个都关 = 完全关闭。明确说出来，免得用户以为坏了。
      if (v.jumpWhenBackground === false && v.jumpWhenForeground !== true) {
        rows.push(h('div', { key: 'jumpOff', style: S.subHint }, '当前：两个都关，不会自动跳转。'))
      }

      // ── 冷却（v0.4.7）─────────────────────────────────────────────────────
      //
      // 用户 2026-10-17 明确要求："同一会话的冷却我们可以给它关了，
      // 甚至可以把不同会话的冷却给它加上。"
      //
      // 两类人诉求相反，所以两级都做成可调：
      //   同一会话：连续完成多次只提醒最后一次（防噪音）
      //   所有会话：任意会话响过之后，一段时间内其余会话都不出声
      //            （"我已经听到一个、过来了，别再叫"）
      //
      // 跨会话默认 0（关闭），保持"不同会话都会响" —— 想每个结果都听见的人不会漏。
      rows.push(h('div', { key: 'sepHr3', style: { margin: '10px 0 4px', borderTop: '1px solid rgba(128,128,128,.25)' } }))
      rows.push(h('div', { key: 'coolTitle', style: { fontWeight: 600, margin: '6px 0 2px' } }, '提醒频率'))
      rows.push(h('div', { key: 'coolHint', style: S.subHint },
        '嫌吵就拉开间隔；想每个结果都听见就把「同一会话」调成关闭。'))

      var COOLDOWN_CHOICES = [
        [0, '关闭（每次都提醒）'],
        [15, '15 秒'],
        [30, '30 秒'],
        [60, '1 分钟'],
        [120, '2 分钟'],
        [300, '5 分钟'],
      ]
      var curDeb = Math.round(typeof v.debounceSeconds === 'number' ? v.debounceSeconds : 60)
      var curGlb = Math.round(typeof v.globalCooldownSeconds === 'number' ? v.globalCooldownSeconds : 0)

      /** 造一个秒数下拉（当前值不在预设里时补一项，避免显示错乱）。 */
      var mkCooldownSelect = function (cur, key) {
        var opts = COOLDOWN_CHOICES.map(function (p) {
          return h('option', { key: String(p[0]), value: String(p[0]) }, p[1])
        })
        if (!COOLDOWN_CHOICES.some(function (p) { return p[0] === cur })) {
          opts = opts.concat([h('option', { key: 'custom', value: String(cur) }, cur + ' 秒')])
        }
        return h('select', {
          style: S.select,
          value: String(cur),
          disabled: s.busy,
          onChange: (function (k) {
            return function (e) {
              var patch = {}
              patch[k] = Number(e.target.value)
              apply(patch, '提醒频率已更新')
            }
          })(key),
        }, opts)
      }

      rows.push(h('div', { key: 'deb', style: S.row },
        h('span', { style: S.label }, '同一会话'),
        mkCooldownSelect(curDeb, 'debounceSeconds'),
        h('span', { style: S.hint }, curDeb === 0 ? '每次都响' : '这段时间内不重复'),
      ))

      rows.push(h('div', { key: 'glb', style: S.row },
        h('span', { style: S.label }, '所有会话'),
        mkCooldownSelect(curGlb, 'globalCooldownSeconds'),
        h('span', { style: S.hint }, curGlb === 0 ? '每个会话都会响' : '响一次后安静一会儿'),
      ))

      // ── 高级（折叠，v0.4.5）──────────────────────────────────────────────
      //
      // 放在折叠区而不是主界面，理由：
      //   - 大多数人永远不需要"给某一种提醒单独换音源"，铺开只会劝退；
      //   - 但真正需要的人（比如"完成听日语、失败听系统警告音"）又必须能用。
      //
      // 用法：每一行的下拉默认「跟随上面的声音来源」，改过才覆盖。
      // 只把**偏离默认的项**存进配置（kindSourceFail='system'），
      // 所以以后改全局默认，没单独改过的事件会跟着变 —— 符合直觉。
      var advOpen = st[0].advOpen === true

      // ── 五、高级设置（默认折叠）─────────────────────────────────────
      //
      // 折叠是刻意的：大多数人永远不需要「给某一种提醒单独换音源」。
      // 标题可点击展开/收起（保持原有交互，只是换成分区样式）。
      function toggleAdv() {
        set(function (p) {
          return {
            loaded: p.loaded, values: p.values, packs: p.packs, busy: p.busy, msg: p.msg, err: p.err,
            advOpen: p.advOpen !== true,
            termsAck: p.termsAck, termsPending: p.termsPending,
          }
        })
      }
      rows.push(h('div', { key: 'sec-adv' },
        h('div', {
          style: Object.assign({}, S.sectionTitle, {
            cursor: 'pointer',
            userSelect: 'none',
            borderTop: '1px solid rgba(128,128,128,.22)',
          }),
          onClick: toggleAdv,
        }, '高级设置' + (advOpen ? '  ▾' : '  ▸')),
        h('div', { style: S.sectionDesc },
          '给每种提醒单独设声音来源、看日志与诊断、检查版本更新。点标题展开。'),
      ))

      if (advOpen) {
        // ── 高级设置内部的二级分组（v0.4.54）──────────────────────────
        //
        // 用户要求：不能「点一次高级设置就把所有内容全展开」。
        // 但也别做太深 —— 只加一层：高级设置 → 四个子组 → 内容。
        //
        // 展开状态用**独立 state**（avst），不塞进主 state：
        // 主 state 有 25 处 set() 逐字段重建，加字段要改 25 处（已踩过 4 次）。
        var ADV_SECTIONS = [
          ['sound', '按事件定制声音', '给每种提醒单独指定音源；不改就跟随上面的「声音来源」。'],
          ['diag', '诊断与日志', '日志详细度，以及导出脱敏后的诊断文件。'],
          ['update', '版本与更新', '查看运行中的版本、检查有没有新版。'],
          // 开发者选项已合并（v0.4.58）：它原本只有「实验性提示 + 重载按钮」，
          // 重载搬进「版本与更新」后就没有内容了 —— 留一个空组是纯噪音。
        ]
        function toggleAdvSec(id) {
          avset(function (prev) {
            var n = {}
            for (var kk in prev) n[kk] = prev[kk]
            n[id] = prev[id] !== true
            return n
          })
        }

        ADV_SECTIONS.forEach(function (sec) {
          var id = sec[0]
          var isOpen = advSec[id] === true
          // 整行可点 + 箭头固定最右 + 悬停/焦点反馈 + 键盘可操作（v0.4.55）。
          //
          // 用户反馈：原来箭头跟在文字后面（`高级设置 ▸`），不明显能点。
          // 现在整行是点击区、箭头靠右、Enter/Space 也能展开 ——
          // 键盘用户与鼠标用户看到同一套反馈（foldHeadActive）。
          var headActive = advHover === id
          rows.push(h('div', {
            key: 'adv-sec-' + id,
            role: 'button',
            tabIndex: 0,
            'aria-expanded': isOpen ? 'true' : 'false',
            style: Object.assign({}, S.foldHead, headActive ? S.foldHeadActive : null),
            onClick: function () { toggleAdvSec(id) },
            onMouseEnter: function () { hvset({ id: id }) },
            onMouseLeave: function () { hvset({ id: advHover === id ? '' : advHover }) },
            onFocus: function () { hvset({ id: id }) },
            onBlur: function () { hvset({ id: advHover === id ? '' : advHover }) },
            onKeyDown: function (e) {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                toggleAdvSec(id)
              }
            },
          },
            h('span', { style: { fontWeight: 600, fontSize: '13px' } }, sec[1]),
            h('span', { style: S.foldArrow }, isOpen ? '▾' : '▸'),
          ))
          rows.push(h('div', { key: 'adv-sec-desc-' + id, style: S.subHint }, sec[2]))

          if (isOpen) {
            if (id === 'sound') {
              // ⚠️ 这两行原本在 if (advOpen) 块的开头（我重排时漏掉了，C19 抓到）：
              // 事件行与「跟随默认」哨兵值都依赖它们。
              var KIND_ROWS = [['Done', '任务完成'], ['Fail', '任务失败'],
                ['Question', '向你提问'], ['Approval', '待你批准'], ['Blocked', '被拦截']]
              var FOLLOW = '__follow__'
          // 内层不再重复标题 —— 二级分组已经叫「按事件定制声音」（v0.4.56）。
        // 只保留说明，直接接五个事件选择器。
          rows.push(h('div', { key: 'advhint', style: S.subHint },
            '默认跟随上面的「声音来源」。只有你改过的那几行才会单独生效。'))
          KIND_ROWS.forEach(function (pair) {
            var suffix = pair[0]
            var label = pair[1]
            // ⚠️ 读与写**用的字段名不同**，这是 v0.4.10 修的一个真 bug：
            //
            //   写入：扁平键 kindSourceFail = 'system'（config-store 白名单只认标量）
            //   读回：backend 的 normalizeConfig 会把它聚合成
            //         audioSourceByKind = { fail: 'system' }
            //         —— 生效值里**没有** kindSourceFail 这个键
            //
            // 原先前端读写都用扁平键，于是 GET 回来的 v 里取不到值，
            // 每行永远显示「跟随默认」，用户以为设置没生效（实际存进去了）。
            var writeKey = 'kindSource' + suffix
            var kindLower = suffix.toLowerCase()
            var byKind = (v.audioSourceByKind && typeof v.audioSourceByKind === 'object')
              ? v.audioSourceByKind : {}
            var cur = byKind[kindLower] || FOLLOW
            rows.push(h('div', { key: 'ks-' + suffix, style: S.row },
              h('span', { style: S.label }, label),
              h('select', {
                style: S.select,
                value: cur,
                disabled: s.busy,
                onChange: (function (k) {
                  return function (e) {
                    var patch = {}
                    // 选「跟随默认」就把键清空，让配置回到最小状态
                    patch[k] = e.target.value === FOLLOW ? '' : e.target.value
                    apply(patch, '已更新')
                  }
                })(writeKey),
              }, [
                h('option', { key: FOLLOW, value: FOLLOW }, '跟随默认（' + (SRC_NAME[curSource] || curSource) + '）'),
                h('option', { key: 'tts', value: 'tts' }, '系统语音合成'),
                h('option', { key: 'bundled', value: 'bundled' }, '语音包'),
                h('option', { key: 'system', value: 'system' }, '系统提示音'),
                h('option', { key: 'custom', value: 'custom' }, '我的音频文件'),
                h('option', { key: 'none', value: 'none' }, '不出声'),
              ]),
              cur === FOLLOW ? null : h('span', { style: S.hint }, '（已单独设置）'),
            ))

            // ── 该事件的**子设置**（v0.4.9）──────────────────────────────────
            //
            // 用户 2026-10-17 指出：只选了音源类型，但"念什么话、什么声音、
            // 什么音效"还得回上面用全局的，不合逻辑。所以每行在**覆盖了音源**时
            // 展开该音源自己的参数；「跟随默认」时不展开（避免界面爆炸）。
            //
            // 参数矩阵：
            //   tts     → 发音人 + 语速 + 台词
            //   bundled → 音色模式 + 音色名
            //   system  → 系统音效名
            //   custom  → 选择文件
            var effSrc = (cur === FOLLOW) ? curSource : cur
            if (cur === FOLLOW) return   // 跟随默认 → 不展开

            var sub = []
            var kKey = function (base) { return base + suffix }

            /**
             * 读按事件覆盖的值。
             *
             * ⚠️ 写入用**扁平键**（kindTtsVoiceDone），读回用**字典**
             * （values.kindTtsVoice.done）—— 因为 backend 的 normalizeConfig
             * 会把扁平键聚合成字典，生效值里没有扁平键。
             * 第一版读写都用扁平键，导致界面永远显示"跟随默认"（实际已存）。
             *
             * @param {string} dictName 字典名（如 'kindTtsVoice'）
             * @param {*} dflt 取不到时的默认值
             */
            var readKind = function (dictName, dflt) {
              var m = v[dictName]
              if (m && typeof m === 'object') {
                var got = m[kindLower]
                if (got !== undefined && got !== null && got !== '') return got
              }
              return dflt
            }

            if (effSrc === 'tts') {
              // 发音人
              var vNameKey = kKey('kindTtsVoice')
              var vNameCur = readKind('kindTtsVoice', '')
              sub.push(h('div', { key: 'ttsv-' + suffix, style: S.subRow },
                h('span', { style: S.subLabel }, '朗读声音'),
                h('select', {
                  style: S.select,
                  value: vNameCur,
                  disabled: s.busy,
                  onChange: (function (k) {
                    return function (e) {
                      var o = {}; o[k] = e.target.value; apply(o, '已更新')
                    }
                  })(vNameKey),
                }, [
                  h('option', { key: '', value: '' }, '跟随全局'),
                  h('option', { key: 'hui', value: 'Microsoft Huihui Desktop' }, 'Huihui（中文女声）'),
                  h('option', { key: 'zira', value: 'Microsoft Zira Desktop' }, 'Zira（英文女声）'),
                ]),
              ))
              // 语速
              var vRateKey = kKey('kindTtsRate')
              var vRateCur = Number(readKind('kindTtsRate', 0)) || 0
              sub.push(h('div', { key: 'ttsr-' + suffix, style: S.subRow },
                h('span', { style: S.subLabel }, '语速'),
                h('input', {
                  type: 'range', min: -10, max: 10, step: 1,
                  value: vRateCur,
                  disabled: s.busy,
                  style: S.slider,
                  onChange: (function (k) {
                    return function (e) {
                      var n = Number(e.target.value)
                      set(function (p) {
                        var nv = {}; for (var kk in p.values) nv[kk] = p.values[kk]
                        nv[k] = n
                        return {
                          loaded: p.loaded, values: nv, advOpen: p.advOpen, packs: p.packs,
                          termsAck: p.termsAck, termsPending: p.termsPending,
                          busy: p.busy, msg: '', err: p.err,
                        }
                      })
                    }
                  })(vRateKey),
                  onPointerUp: (function (k) {
                    return function (e) {
                      var o = {}; o[k] = Number(e.currentTarget.value); apply(o, '已更新')
                    }
                  })(vRateKey),
                  onBlur: (function (k) {
                    return function (e) {
                      var o = {}; o[k] = Number(e.currentTarget.value); apply(o, '已更新')
                    }
                  })(vRateKey),
                }),
                h('span', { style: S.value }, vRateCur === 0 ? '跟随全局' : (vRateCur < 0 ? '慢' : '快')),
              ))
              // 台词（这个字段本来就按事件，直接复用）
              var txtKey = 'ttsText' + suffix
              var txtCur = String(readKind('ttsTexts', '') || '')
              sub.push(h('div', { key: 'ttst-' + suffix, style: S.subRow },
                h('span', { style: S.subLabel }, '台词'),
                h('input', {
                  type: 'text',
                  maxLength: 60,
                  placeholder: '留空 = 内置随机',
                  value: txtCur,
                  disabled: s.busy,
                  style: S.textInput,
                  onChange: (function (k) {
                    return function (e) {
                      var val = e.target.value
                      set(function (p) {
                        var nv = {}; for (var kk in p.values) nv[kk] = p.values[kk]
                        nv[k] = val
                        return {
                          loaded: p.loaded, values: nv, advOpen: p.advOpen, packs: p.packs,
                          termsAck: p.termsAck, termsPending: p.termsPending,
                          busy: p.busy, msg: '', err: p.err,
                        }
                      })
                    }
                  })(txtKey),
                  onBlur: (function (k) {
                    return function (e) {
                      var o = {}; o[k] = e.target.value; apply(o, '已更新')
                    }
                  })(txtKey),
                  onKeyDown: function (e) { if (e.key === 'Enter') { try { e.target.blur() } catch (x) { /* ignore */ } } },
                }),
              ))
            } else if (effSrc === 'bundled') {
              // 音色模式
              var mKey = kKey('kindVoiceMode')
              var mCur = readKind('kindVoiceMode', '')
              sub.push(h('div', { key: 'km-' + suffix, style: S.subRow },
                h('span', { style: S.subLabel }, '音色模式'),
                h('select', {
                  style: S.select,
                  value: mCur,
                  disabled: s.busy,
                  onChange: (function (k) {
                    return function (e) { var o = {}; o[k] = e.target.value; apply(o, '已更新') }
                  })(mKey),
                }, [
                  h('option', { key: '', value: '' }, '跟随全局'),
                  h('option', { key: 'fixed', value: 'fixed' }, '固定音色'),
                  h('option', { key: 'random', value: 'random' }, '每次随机'),
                ]),
              ))
              // 音色名
              var nKey = kKey('kindVoiceName')
              var nCur = readKind('kindVoiceName', '')
              // v0.5.3：与全局那处同口径 —— 只列当前语言的音色。
              // 事件级覆盖用的是**全局**的语音语言（没有"按事件切语言"，
              // 那会让同一件事的提示音语言不一致，属于过度设计）。
              var kLang = v.voiceLang || 'ja'
              var kOpts2 = VOICE_KEYS.filter(function (x) {
                return (x.indexOf('zh-') === 0) === (kLang === 'zh')
              })
              // v0.5.6：与全局那处同口径 —— 已下载的音色也要能选到
              appendInstalled(kOpts2, kLang)
              if (nCur && kOpts2.indexOf(nCur) < 0) kOpts2.unshift(nCur)
              sub.push(h('div', { key: 'kn-' + suffix, style: S.subRow },
                h('span', { style: S.subLabel }, '音色'),
                h('select', {
                  style: S.select,
                  value: nCur,
                  disabled: s.busy || mCur === 'random',
                  onChange: (function (k) {
                    return function (e) { var o = {}; o[k] = e.target.value; apply(o, '已更新') }
                  })(nKey),
                }, [h('option', { key: '', value: '' }, '跟随全局')].concat(
                  kOpts2.map(function (x) {
                    return h('option', { key: x, value: x, title: x }, voiceLabel(x))
                  }),
                )),
                mCur === 'random' ? h('span', { style: S.hint }, '随机模式下不生效') : null,
              ))
            } else if (effSrc === 'system') {
              // 系统音效名
              var sKey = kKey('kindSystemSound')
              var sCur = readKind('kindSystemSound', '')
              sub.push(h('div', { key: 'kss-' + suffix, style: S.subRow },
                h('span', { style: S.subLabel }, '音效'),
                h('select', {
                  style: S.select,
                  value: sCur,
                  disabled: s.busy,
                  onChange: (function (k) {
                    return function (e) { var o = {}; o[k] = e.target.value; apply(o, '已更新') }
                  })(sKey),
                }, [
                  h('option', { key: '', value: '' }, '按事件自动选'),
                  h('option', { key: 'Asterisk', value: 'Asterisk' }, '提示音（轻快）'),
                  h('option', { key: 'Question', value: 'Question' }, '询问音'),
                  h('option', { key: 'Exclamation', value: 'Exclamation' }, '感叹音'),
                  h('option', { key: 'Hand', value: 'Hand' }, '警告音（低沉）'),
                  h('option', { key: 'Beep', value: 'Beep' }, '哔声'),
                ]),
              ))
            } else if (effSrc === 'custom') {
              // 选择文件（复用已有的 customFile* 键）
              var cKey = 'customFile' + suffix
              var cCur = readKind('customFiles', '')
              sub.push(h('div', { key: 'kc-' + suffix, style: S.subRow },
                h('span', { style: S.subLabel }, '音频'),
                h('button', {
                  type: 'button',
                  disabled: s.busy,
                  style: S.btn,
                  onClick: (function (k) {
                    return function () {
                      pickCustomFile().then(function (p) {
                        if (p) { var o = {}; o[k] = p; apply(o, '已选择音频') }
                      }).catch(function () { /* 内部已兜底 */ })
                    }
                  })(cKey),
                }, cCur ? '更换…' : '选择文件…'),
                h('span', { style: S.hint }, cCur || '（未选择，将用系统提示音）'),
              ))
            }

            if (sub.length) {
              rows.push(h('div', { key: 'sub-' + suffix, style: S.subBox }, sub))
            }
          })
            }
            if (id === 'diag') {
          // ── 日志级别（v0.4.34）──────────────────────────────────────────────
          //
          // 默认 info：只记元数据（事件、音源、成败、数量）。
          // debug：额外记台词正文与 Toast 标题正文 —— **可能含敏感信息**。
          //
          // 为什么放在高级区：多数人不需要改，但排查问题时要能开。
          rows.push(h('div', { key: 'll-row', style: S.row },
            h('span', { style: S.label }, '日志详细度'),
            h('select', {
              style: S.select,
              value: v.logLevel || 'info',
              disabled: s.busy,
              onChange: function (e) { apply({ logLevel: e.target.value }, '日志级别已更新') },
            },
              h('option', { value: 'info' }, '只记元数据（默认）'),
              h('option', { value: 'debug' }, '含台词正文（可能敏感）'),
            ),
          ))
          rows.push(h('div', { key: 'll-hint', style: S.subHint },
            v.logLevel === 'debug'
              ? '⚠️ debug 档会把台词和通知正文写进日志。日志在 %TEMP%\\dsh-notify-say\\notify.log，'
                + '提 Issue 前请先切回「只记元数据」或自行删改。'
              : '日志只记事件类型、音源、成败与数量，不含台词正文。排查问题时可切到 debug。'))

          // ── 导出诊断（v0.4.35）───────────────────────────────────────────
          //
          // 用户提 Issue 时最需要的东西：一份**已脱敏**的日志。
          // 让他自己去 %TEMP% 找、手动删用户名，多数人不会做。
          rows.push(h('div', { key: 'dg-row', style: S.row },
            h('span', { style: S.label }, '诊断'),
            h('button', {
              type: 'button',
              disabled: s.busy,
              style: S.btn,
              onClick: function () { doExportDiagnostics() },
            }, '导出诊断文件'),
          ))
          rows.push(h('div', { key: 'dg-hint', style: S.subHint },
            '导出到日志同目录（%TEMP%\\dsh-notify-say\\）。会自动把用户名替换为 <user>、'
              + '绝对路径替换为 <path>，但仍请自己再看一遍再上传。'))
            }
            if (id === 'update') {
          // ── 版本与更新（v0.4.48）─────────────────────────────────────
          //
          // 只显示版本状态 + 给升级指引。**不自动下载、不覆盖文件**：
          // 本机可能是 Junction 指向开发源码，自动覆盖会直接毁掉源码；
          // 而且 DSH 官方 CLI 已经能升级插件。
          // 内层不再重复「版本与更新」标题 —— 它已经是二级分组的标题了（v0.4.54）。
          var vi = vs.info

          // 运行中版本 vs 磁盘安装版本（v0.4.51）
          //
          // 两者可能不同：用户在 DSH 运行期间升级了插件 ——
          // 磁盘 package.json 已是新版，但进程里跑的还是旧 JS 模块。
          // 只显示磁盘版本会让人以为"已生效"，其实要重启。
          var vRun = vi && vi.running ? vi.running : ''
          var vIns = vi && vi.installed ? vi.installed : vRun
          var vLat = vi && vi.latest ? vi.latest : null

          rows.push(h('div', { key: 'up-cur', style: S.row },
            h('span', { style: S.label }, '运行中版本'),
            h('span', null, vRun ? 'v' + vRun : '(未知)')))

          // 磁盘装了但没重启 → 明确告诉他该做什么
          if (vi && vi.needsRestart) {
            rows.push(h('div', { key: 'up-restart', style: {
              marginTop: '4px', padding: '8px', borderRadius: '4px',
              background: 'rgba(255,200,80,.12)',
              border: '1px solid rgba(255,200,80,.4)', fontSize: '12.5px',
            } },
              '磁盘上已是 v' + vIns + '，但当前运行的还是 v' + vRun + '。',
              h('div', { style: { marginTop: '4px' } },
                '请重启 DSH 让新版本生效。')))
          }

          if (vs.loading) {
            rows.push(h('div', { key: 'up-loading', style: S.subHint }, '正在检查…'))
          } else if (!vi) {
            rows.push(h('div', { key: 'up-idle', style: S.subHint },
              '还没检查过。点下面的按钮查一下有没有新版本。'))
          } else if (!vi.ok) {
            rows.push(h('div', { key: 'up-err', style: S.subHint },
              '暂时无法检查（' + (vi.error || '网络不可用') + '）。'
                + '本地通知和语音不依赖它，照常工作。'))
          } else {
            // 两个来源各自报的版本（可能不同：npm 有暂存队列会落后）
            var vNpm = vi.npmLatest || ''
            var vGh = vi.githubLatest || ''
            var differ = vNpm && vGh && vNpm !== vGh

            if (vi.hasUpdate === true) {
              rows.push(h('div', { key: 'up-new', style: S.row },
                h('span', { style: S.label }, '最新版本'),
                h('span', { style: { color: '#e0a030', fontWeight: 600 } }, 'v' + vLat + '（有新版）')))
            } else if (vi.hasUpdate === false) {
              rows.push(h('div', { key: 'up-same', style: S.row },
                h('span', { style: S.label }, '最新版本'),
                h('span', { style: { color: '#2a7' } }, 'v' + vLat + '（已是最新）')))
            } else {
              rows.push(h('div', { key: 'up-unknown', style: S.subHint },
                '最新版本 v' + vLat + '（本地版本格式无法比较）'))
            }

            // ⚠️ 两个来源不一致时如实说明：
            // 只报一个合并后的 latest，会出现"提示有新版，但 npm 安装的用户
            // 执行升级命令装不到那个版本"。
            if (differ) {
              rows.push(h('div', { key: 'up-sources', style: S.subHint },
                'npm: v' + vNpm + '　|　GitHub: v' + vGh
                  + '　（两个来源不同步时以较高的为准，但升级方式可能受限）'))
            }

            if (vi.hasUpdate === true) {
              if (vi.command) {
                rows.push(h('div', { key: 'up-cmd', style: {
                  marginTop: '4px', padding: '8px', borderRadius: '4px',
                  background: 'rgba(255,255,255,.06)',
                  fontFamily: 'monospace', fontSize: '12px', wordBreak: 'break-all',
                } }, vi.command))
              }
              rows.push(h('div', { key: 'up-note', style: S.subHint }, vi.note || ''))
            } else if (vi.note) {
              rows.push(h('div', { key: 'up-mode', style: S.subHint }, vi.note))
            }
          }

          rows.push(h('div', { key: 'up-btn', style: S.row },
            h('button', {
              type: 'button',
              disabled: vs.loading,
              style: S.btn,
              onClick: function () { checkVersion(true) },
            }, vs.loading ? '检查中…' : '检查更新'),
            vi && vi.hasUpdate === true && vi.command
              ? h('button', {
                type: 'button',
                style: S.btn,
                onClick: function () { copyUpgradeCommand(vi.command) },
              }, vs.copied ? '已复制' : '复制命令')
              : null,
            vi && vi.changelogUrl
              ? h('a', {
                href: vi.changelogUrl,
                target: '_blank',
                rel: 'noreferrer noopener',
                style: { color: '#4a9', fontSize: '12px' },
              }, '更新日志 ↗')
              : null,
          ))
          rows.push(h('div', { key: 'up-offline', style: S.subHint },
            '检查更新会访问 npm registry 与 GitHub（每 24 小时最多一次）。'
              + '通知与语音不依赖它；网络不可用时照常工作。'))

              // ── 让新版本生效（v0.4.58 起从开发者选项搬来）──────────────
              //
              // 用户 2026-10-18 指出：既然重载改成"点一下试一次"了，
              // 那它就该在**更新流程**里，而不是藏在开发者选项。
              //
              // 这个判断是对的 —— 需要的时刻正是"我刚装完新版本，
              // 想让它生效"。**位置本身就是信息**。
              //
              // ⚠️ 能力边界写在旁边，不能让人以为点一下就能替代重启。
              rows.push(h('div', { key: 'rl-row', style: S.row },
                h('button', {
                  type: 'button',
                  disabled: rlState.busy,
                  style: S.btn,
                  onClick: function () { doReload() },
                }, rlState.busy ? '重载中…' : '重载现在生效'),
                h('span', { style: S.hint },
                  (vi && vi.needsRestart)
                    ? ('磁盘上是 v' + vIns + '，运行中是 v' + vRun + ' —— 点这里试着直接换过来')
                    : '点一次试一次，不会自动重复'),
              ))
              if (rlState.msg) {
                rows.push(h('div', { key: 'rl-msg', style: S.ok }, rlState.msg))
              }
              if (rlState.err) {
                rows.push(h('div', { key: 'rl-err', style: S.err }, rlState.err))
              }
              rows.push(h('div', { key: 'rl-hint', style: S.subHint },
                '⚠️ 实验性：依赖宿主内部结构与 Node 模块加载机制，DSH 升级后可能失效；'
                  + '失效时只报错，不影响播报。它只能重新导入「同一路径上的」代码 —— '
                  + '若刚用 dsh plugin update 升级，新版本装在另一个路径，'
                  + '这一步做不到，必须重启 DSH。'
                  + '重载会重建插件实例，已打开的会话引用会失效，成功后请刷新页面。'))
            }
          }
        })
      }

      if (s.msg) rows.push(h('div', { key: 'msg', style: S.ok }, s.msg))
      if (s.err) rows.push(h('div', { key: 'err', style: S.err }, s.err))
      rows.push(h('div', { key: 'foot', style: S.foot },
        '改动立即生效，无需重启。以上为运行时覆盖，优先级高于 cordis.patch.yml。'))

      // ── 根渲染：设置本体 + 可能出现的确认弹窗（v0.4.43）──────────────
      //
      // 弹窗作为**兄弟节点**挂在这里，而不是塞进 rows：
      //   · 塞进 rows 会跟着设置卡片滚动，位置不固定（这正是 v0.4.40 的问题）
      //   · 用 position:fixed 才能稳定居中覆盖
      var rootKids = [h('div', { key: 'root-box', style: S.box }, rows)]
      if (s.termsPending) rootKids.push(renderTermsModal(s.termsPending))
      return h('div', { key: 'root-wrap' }, rootKids)
    }

    /**
     * 注册设置页分区。
     *
     * 已通过 `inject = ['slots']` 声明硬依赖，理论上此刻 slots 一定就绪；
     * 但仍保留软判断：**宁可少一个分区，也不要让整个 client 激活失败**
     * （激活失败会连跳转一起丢掉）。
     *
     * @returns {Function|null} 清理函数（解除注册），没有注册则 null
     */
    function registerSettingsSection(ctx) {
      try {
        var slots = ctx.get('slots', false)
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          try {
            console.warn('[dsh-notify-say] slots 不可用，设置页分区未注册（跳转仍可用）')
          } catch (e) { /* ignore */ }
          return null
        }
        var dispose = null
        slots.inject('settings.section', function () {
          try {
            // register 会返回一个 disposer —— 收好它，否则热重载会重复注册
            // （独立审查 2026-10-17 指出：原实现丢弃了返回值）
            var d = slots.register({
              name: 'settings.section',
              id: 'dsh-notify-say',
              order: 60,
              label: '通知',
            }, SettingsCard)
            if (typeof d === 'function') dispose = d
          } catch (e) { /* 注册失败不影响跳转 */ }
        })
        return function () { try { if (typeof dispose === 'function') dispose() } catch (e) { /* ignore */ } }
      } catch (e) { return null }
    }

    // ── 2) 完成播报后跳回对应会话 ──────────────────────────────────────────
    //
    // ## 为什么不是"点 Toast 才跳"
    //
    // Windows Toast 的 `launch` 是固定串 `dsh://open`（ps1 里 activationType="protocol"），
    // 官方只支持唤窗，且 main.ts 是整串精确匹配 —— **拿不到"点的是哪条通知"**。
    // 所以只能折中：用「窗口从不可见变为可见」作为信号。
    //
    // ## 判定规则
    //
    //   通知到达时窗口**不可见** → 用户回来时**跳**   （结果还没看，带他过去）
    //   通知到达时窗口**可见**   → **不跳**            （他正看着，别动他的位置，让他自己看绿点）
    //
    // 判定的实现形式：记录"用户最后一次离开的时刻"，
    // 若通知时间 >= 离开时刻，说明通知是在用户离开期间到达的。
    //
    // **不设时效**：10 分钟后才回来看，结果仍然没看过，跳过去依然合理。
    //
    // ## 已知边界（已写进 GUI 的折叠说明）
    //
    // 用户直接点任务栏图标而非点 Toast 时，信号完全相同，无法区分 —— 也会跳。
    // 不接受就关掉这个开关。
    //
    // ⚠️ client 是**经典脚本**（__ModuleLoader__ 包裹），不能 import ESM。
    // 所以这里内联了 lib/session-jump.js 的两个纯函数。**两处必须保持一致**，
    // session-jump.test.mjs 测的是 lib 那份，client 这份由 client-bundle.test.mjs 校验一致性。

    /** 与 lib/session-jump.js 的 isHidden 等价。 */
    function isHiddenDoc(doc) {
      try {
        if (!doc) return true
        if (typeof doc.visibilityState === 'string') return doc.visibilityState === 'hidden'
        if (typeof doc.hidden === 'boolean') return doc.hidden
        return false
      } catch (e) { return true }
    }

    /**
     * 与 lib/session-jump.js 的 decideJump 等价（只保留判定，不带决策常量）。
     *
     * 两个独立开关组合出四种行为（用户 2026-10-17 要求的）：
     *   bg=true,  fg=false → 后台跳、前台不跳（默认）
     *   bg=true,  fg=true  → 都跳
     *   bg=false, fg=true  → 只前台跳
     *   bg=false, fg=false → 都不跳（自己按绿点确认）
     *
     * ⚠️ 判定用**区间** [leftAt, returnedAt)，不能只比 leftAt ——
     * 只比 leftAt 会导致"用户离开过一次之后，前台判定永久失效"
     * （独立审查 2026-10-17 抓到的严重缺陷）。
     */
    function shouldJump(inp) {
      var i = inp || {}
      var bg = i.jumpWhenBackground === undefined ? true : i.jumpWhenBackground !== false
      var fg = i.jumpWhenForeground === true
      if (!bg && !fg) return false                          // 两个都关 = 功能关闭
      if (!i.sessionId) return false
      if (i.consumed === true) return false
      var left = Number(i.leftAt)
      var at = Number(i.notifiedAt)
      // Number(undefined) 是 NaN，而 `NaN <= 0` 为 false —— 必须显式归一成 0
      var retRaw = Number(i.returnedAt)
      var ret = isFinite(retRaw) ? retRaw : 0
      if (!isFinite(left) || left <= 0) return false         // 不知何时离开 → 保守不跳
      if (!isFinite(at) || at <= 0) return false
      // 通知落在「用户不在的那段时间」内 → 后台完成
      var inAway = at >= left && (ret <= 0 || at < ret)
      if (inAway) return bg
      return fg                                              // 前台完成
    }

    /** 与 lib/session-jump.js 的 createLeaveTracker 等价。 */
    /**
     * 与 lib/session-jump.js 的 createLeaveTracker 等价。
     *
     * 同时记 `leftAt`（离开）与 `returnedAt`（回来）—— 只记离开会让
     * "前台不跳"永久失效（见 shouldJump 的注释）。
     */
    function makeLeaveTracker() {
      var leftAt = 0
      var returnedAt = 0
      var wasHidden = false
      var seen = false
      return {
        onVisibility: function (doc, now) {
          var hidden = isHiddenDoc(doc)
          var t = isFinite(now) ? now : Date.now()
          if (!seen) {
            seen = true
            wasHidden = hidden
            if (hidden) leftAt = t
            return
          }
          if (hidden && !wasHidden) {
            leftAt = t
            returnedAt = 0        // 新一轮离开，旧的回来说明作废
          } else if (!hidden && wasHidden) {
            returnedAt = t        // 用户回来了
          }
          wasHidden = hidden
        },
        leftAt: function () { return leftAt },
        returnedAt: function () { return returnedAt },
        reset: function () { leftAt = 0; returnedAt = 0 },
      }
    }

    /**
     * 从候选队列里挑一个要跳的会话（v0.4.62，纯函数）。
     *
     * 三种规则：
     *   earliest —— 挑**最早完成**的那个。默认，也是最贴功能的：
     *     你回来往往仍停在那条会话上，对它 openSession 等于无操作，
     *     所以"正在看的会话不被打断"自动成立，而你最先错过的那个被带过去。
     *   latest   —— 挑最后完成的（v0.4.61 及更早的行为）。
     *   none     —— 不挑，返回 null（多个时靠侧栏绿点自己看）。
     *
     * 只有一个候选时，三种规则都返回它（"多会话规则"不该影响单会话场景）。
     *
     * @param {Array<{sessionId: string, at: number}>} list
     * @param {string} rule
     * @returns {{sessionId: string, at: number} | null}
     */
    function pickJumpTarget(list, rule) {
      if (!list || !list.length) return null
      if (list.length === 1) return list[0]
      if (rule === 'none') return null
      var sorted = list.slice().sort(function (a, b) { return a.at - b.at })
      if (rule === 'latest') return sorted[sorted.length - 1]
        // clicked：精确命中在更上层（pendingJump）已处理；走到这里说明用户没点 Toast，
        // 那就退回「最早错过的」——至少带他去看一条，而不是什么都不做。
        return sorted[0]
    }

    /**
     * 只确认某一条已完成（v0.4.63）：从服务端队列里摘掉它。
     *
     * 与 consumeLastSession 的区别：那个是"我回来处理完了"（清空整个队列），
     * 这个是"这一条我已经跳过去看了"（只摘一条，其余的留着等你回来）。
     *
     * 为什么必须有：前台长轮询跳一条后如果不 ack，切回来时
     * /consume 还会把同一条再给你 —— 同一个会话跳两次。
     */
    function ackSession(sessionId) {
      if (!sessionId) return Promise.resolve(null)
      return fetch(apiUrl('ack'), {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId }),
      }).then(function (res) {
        return res && res.ok ? res.json().catch(function () { return null }) : null
      }).catch(function () { return null })
    }

    /**
     * GUI 保存配置后广播的事件名（v0.4.63）。
     *
     * 为什么要广播：前台长轮询把跳转开关缓存在闭包里（否则每轮都要打一次
     * /config，长轮询「零空转」的优势就没了）。所以用户改了开关后必须有人
     * 告诉它「缓存作废」—— 用浏览器原生 CustomEvent 最省事，不引入新依赖。
     */
    var CONFIG_CHANGED_EVENT = 'dsh-notify-say:config-changed'

    function armSessionJump(ctx) {
      var leave = makeLeaveTracker()
      var busy = false

      /** 从 host 取配置里的开关（拿不到就当关闭，绝不擅自跳）。 */
      /**
       * 从 host 取两个跳转开关。
       *
       * 拿不到配置时：**两个都返回 false**（不跳）。
       * 宁可少跳一次，也不要在用户没同意的情况下动他的界面。
       */
      function jumpEnabled() {
        return loadConfig().then(function (v) {
          // ⚠️ 2026-10-18 外部审阅指出逻辑矛盾：loadConfig 失败返回 {}，
          // 而 {}.jumpWhenBackground !== false 求值为 true —— 与"拿不到就不跳"正好相反。
          // 现在显式区分"读到了"与"没读到"。
          if (!v || typeof v !== "object" || Object.keys(v).length === 0) {
            return { jumpWhenBackground: false, jumpWhenForeground: false }
          }
          return {
            // 只有明确读到 true 才跳；缺失或 null 都不跳
            jumpWhenBackground: v.jumpWhenBackground === true,
            jumpWhenForeground: v.jumpWhenForeground === true,
            // v0.4.62：缺失时按默认 earliest（与服务端 FIELD_DEFAULTS 一致）
            multiJumpRule: typeof v.multiJumpRule === 'string' ? v.multiJumpRule : 'earliest',
        // v0.4.75：精准跳转开关。开着时禁用旧的「自动跳」路径 ——
        // 否则一从别的窗口切回来就自动跳走，用户根本没机会点 Toast。
        toastJumpSession: v.toastJumpSession === true,
          }
        }).catch(function () {
          return { jumpWhenBackground: false, jumpWhenForeground: false }
        })
      }

      // ── 前台长轮询（v0.4.63）──────────────────────────────────────────
      //
      // 只在**窗口可见 + 开了前台跳转**时运行。窗口一隐藏立刻中止，
      // 避免后台空转（用户切走后由 visibilitychange 逻辑接手）。
      //
      // 停止方式：把 generation 递增 + abort 当前 fetch。用 generation 而不是
      // 单纯 abort，是因为 abort 后循环还会跑一轮 catch —— 没有代际校验的话
      // 会出现"以为停了其实又发了一个请求"。
      var pollGen = 0
      var pollAbort = null
      var pollRunning = false
      var lastSeenAt = 0        // 已处理过的最大 at，避免同一条跳两次

      // 配置缓存（问题 2）：避免每轮长轮询前都打一次 /config。
      // null 表示"还没读过"，第一次会去读。
      var enCache = null
      // 关闭前台跳转时的探活间隔：只读一次缓存过的配置，不发 /wait。
      // 5 秒足够快（用户改完开关最多 5 秒生效），又几乎没有开销。
      var IDLE_RECHECK_MS = 5000

      /** 刷新配置缓存（挂载 / 重新可见 / GUI 保存后 调用）。 */
      function refreshJumpConfig() {
          return jumpEnabled().then(function (en) { enCache = en; uiLog(`jumpEnabled bg=${!!en.jumpWhenBackground} fg=${!!en.jumpWhenForeground} toastJump=${!!en.toastJumpSession} rule=${en.multiJumpRule}`); return en })
      }

      function stopForegroundPoll() {
        pollGen += 1
        pollRunning = false
        try { if (pollAbort) pollAbort.abort() } catch (e) { /* ignore */ }
        pollAbort = null
      }

      /**
       * 启动前台长轮询（幂等：已在跑就不重复启动）。
       *
       * ⚠️ 必须在「回来时跳转」那条路径**跑完之后**调用 ——
       * 否则两条路径可能对同一条信号各跳一次。
       */
      /**
       * 当前是否具备"前台长轮询"的运行条件。
       *
       * ⚠️ 缺一条就**不启动**：宁可没有前台跳转，也不要在非浏览器环境里
       * 发真实请求 / 留下无限循环的定时器（那会让 node --test 永远退不出去）。
       */
      function canPollForeground() {
        try {
          if (typeof document === 'undefined' || !document) return false
          if (typeof fetch !== 'function') return false
          if (typeof AbortController !== 'function') return false
          return true
        } catch (e) { return false }
      }

      function startForegroundPoll(ctx2) {
        if (pollRunning) return
        if (!canPollForeground()) return
        pollRunning = true
        foregroundPollLoop(ctx2)
      }

      function foregroundPollLoop(ctx2) {
        var myGen = pollGen
        function again() {
          if (myGen !== pollGen) return            // 已被 stop（代际不符）

          // 首次进入先读一次配置；之后一直用缓存。
          var ready = enCache ? Promise.resolve(enCache) : refreshJumpConfig()

          ready.then(function (en) {
            if (myGen !== pollGen) return
            // 没开前台跳 → **不挂连接**，但定时回来看开关是否打开。
            // （问题 1 的修法：不能 return 就走，否则改了配置要刷新页面才生效。）
            // v0.4.75：精准跳转开启时不挂这条自动跳的连接 —— 否则窗口在前台时，
            // 一来通知就直接 openSession，用户没机会点 Toast（实测「还没点就跳回来了」）。
            if (!en || !en.jumpWhenForeground || en.toastJumpSession) {
              setTimeout(function () {
                if (myGen !== pollGen) return
                // ⚠️ v0.4.76：探活时**必须同时检查 pending-jump**。
                //
                // 之前这里只调 refreshJumpConfig()，于是：
                //   · 点 Toast → 协议处理器写入 pending-jump ✓
                //   · 但前端只靠 window.focus / mousedown 去读
                //   · 而点 Toast 时焦点事件不一定传到页面 → 永远读不到 → 不跳
                // 2026-10-20 实测：pending-jump 里有数据，前端零次 openSession。
                //
                // 兜底：每 5 秒也读一次，最多延迟 5 秒必然能跳。
                refreshJumpConfig()
                  .then(function () { try { tryTopJump() } catch (e) { /* 静默 */ } })
                  .catch(function () { /* 静默 */ })
                  .then(function () { again() })
              }, IDLE_RECHECK_MS)
              return
            }
            var hidden = false
            try { hidden = (typeof document !== 'undefined' && document.visibilityState === 'hidden') } catch (e) { hidden = false }
            // 窗口隐藏时不能靠"发一次请求就返回"来停止 —— 那个请求可能是挂着的。
            // 所以这里只判断：隐藏就不继续发起**新的**循环。
            if (hidden) return

            var ctrl = null
            try { ctrl = new AbortController() } catch (e) { ctrl = null }
            pollAbort = ctrl
            var q = apiUrl('wait') + '?after=' + encodeURIComponent(String(lastSeenAt))
            fetch(q, {
              method: 'GET',
              cache: 'no-store',
              credentials: 'same-origin',
              signal: ctrl ? ctrl.signal : undefined,
            }).then(function (r) {
              if (myGen !== pollGen) return null
              if (!r || r.status === 204) return null      // 25 秒超时，正常重连
              if (!r.ok) return null
              return r.json().catch(function () { return null })
            }).then(function (doc) {
              if (myGen !== pollGen) return
              if (doc && doc.sessionId) {
                var at = Number(doc.at) || 0
                // 只处理"比上次更新的"，防同一条反复跳。
                if (at > lastSeenAt) {
                  lastSeenAt = at
                  // ⚠️ 先 ack 再跳：ack 失败也不该阻止跳转（跳转是用户能感知的价值）。
                  ackSession(doc.sessionId).then(function () {
                    openSession(ctx2, doc.sessionId)
                  })
                }
              }
              // 无论有没有信号都立刻续一轮（长轮询在 host 侧挂着，不占 CPU）。
              again()
            }).catch(function () {
              if (myGen !== pollGen) return
              // 失败（含 abort）→ 停 1 秒再试，避免断网时疯狂重连。
              setTimeout(again, 1000)
            })
          }).catch(function () { /* 配置读失败：静默，不跳 */ })
        }
        again()
      }

      /** GUI 保存配置后：作废缓存并刷新（开关改了立刻生效，无需刷新页面）。 */
      var onConfigChanged = function () {
        enCache = null
        refreshJumpConfig().catch(function () { /* 读不到就等下次探活 */ })
      }

      var onVisibility = function () {
        try {
          var now = Date.now()
          leave.onVisibility(typeof document !== 'undefined' ? document : null, now)

          // 窗口隐藏：停掉前台长轮询（由下面的 visibilitychange 路径接手）
          var nowHidden = false
          try { nowHidden = (typeof document !== 'undefined' && document.visibilityState === 'hidden') } catch (e) { nowHidden = false }
          if (nowHidden) { stopForegroundPoll(); return }
          // 窗口重新可见：先刷新配置缓存（用户可能在别处改了设置），再继续。
          enCache = null
          // 窗口可见：启动前台长轮询（幂等 —— 已在跑时 pollGen 不变，会另开一条）
          // ⚠️ 这里不直接启动，而是交给下面的既有可见逻辑判定后再启动，
          //    避免"刚可见就立刻跳"与"回来时跳"两条路径打架。
        } catch (e) { return }
        if (busy) return
        busy = true

        jumpEnabled().then(function (en) {
          if (!en) { busy = false; return null }

          // ⚠️ v0.4.70：**先试精确跳转** —— 用户点的是哪个 Toast 就跳哪个。
          // 命中就直接跳，不再走「按队列猜最早那条」的旧路径。
          return fetchPendingJump().then(function (pj) {
            if (pj && pj.sessionId) {
              // 过期保护：超过 120 秒的点击不再跳（避免久等后切窗口突然跳走）
              var age = Date.now() - Number(pj.at || 0)
              if (isFinite(age) && age >= 0 && age <= 120000) {
                busy = false
                leave.reset()
                if (typeof openSession === 'function') {
                  openSession(ctx, pj.sessionId)
                  return null
                }
              }
            }

            // 没命中精确记录 → 退回旧路径（按最近播报队列猜）。
            // 单会话时两条路径结果相同；多会话时旧的会取最早的。
            // ⚠️ v0.4.75：**精准跳转开启时，不走这条自动跳路径**。
            //
            // 用户反馈（2026-10-20）：「还没点就跳回来了」。
            // 根因是两条路径并存 —— 一从别的窗口切回来，这条旧路径就先把人带走，
            // 用户根本没机会点 Toast。
            //
            // 语义划分：
            //   toastJumpSession = true  → 只认「点了 Toast」（pending-jump）
            //   toastJumpSession = false → 保留自动跳（不想开协议的用户）
            if (en.toastJumpSession) {
              busy = false
              return null
            }

            return consumeLastSession().then(function (list) {
              busy = false
              if (!list || !list.length) return
              // 先按规则挑一个（多会话时才有区别；单会话三种规则都挑它）。
              var target = pickJumpTarget(list, en.multiJumpRule)
              if (!target) return
              if (shouldJump({
                jumpWhenBackground: en.jumpWhenBackground,
                jumpWhenForeground: en.jumpWhenForeground,
                consumed: false,
                sessionId: target.sessionId,
                notifiedAt: Number(target.at),
                leftAt: leave.leftAt(),
                returnedAt: leave.returnedAt(),
              })) {
                leave.reset()
                openSession(ctx, target.sessionId)
              }
            })
          })
        }).catch(function () { busy = false; startForegroundPoll(ctx) })
        .then(function () { startForegroundPoll(ctx) })
      }

      /**
       * 读一次「待跳转」并执行（v0.4.71）。
       *
       * 与 onVisibility 里的逻辑同源，但**不依赖可见性变化** ——
       * 前台点 Toast 时窗口本来就不隐藏，visibilitychange 不会触发。
       *
       * 防误跳：pending-jump 只有「用户真的点了 Toast」才会写入；
       * 服务端读取即清空；超过 120 秒不跳；800ms 节流。
       */
      var lastTopJumpCheck = 0
      function tryTopJump() {
        try {
          var now = Date.now()
          if (now - lastTopJumpCheck < 800) return
          lastTopJumpCheck = now
          jumpEnabled().then(function (en) {
            if (!en) return null
            return fetchPendingJump().then(function (pj) {
              if (!pj || !pj.sessionId) return null
              var age = Date.now() - Number(pj.at || 0)
              if (!isFinite(age) || age < 0 || age > 120000) return null
              leave.reset()
              if (typeof openSession === "function") openSession(ctx, pj.sessionId)
              return null
            })
          }).catch(function () { /* 精确跳转失败不影响其它功能 */ })
        } catch (e) { /* 同上 */ }
      }

      try {
        if (typeof document !== 'undefined' && document.addEventListener) {
          document.addEventListener('visibilitychange', onVisibility)
          // v0.4.71：**前台点 Toast 也要跳**。
          //
          // visibilitychange 只在「隐藏↔可见」时触发；窗口一直在前台时
          // 用户点 Toast 拿不到那个事件，于是跳不过去。补两个监听：
          //   · window focus   窗口获得焦点
          //   · document mousedown 用户点了窗口里任何地方（有些壳不转 focus）
          // 两者都只读一次 pending-jump，靠它「只有点 Toast 才有」来防误跳。
          if (typeof window !== 'undefined' && window.addEventListener) {
            window.addEventListener('focus', tryTopJump)
          }
          if (typeof document !== 'undefined' && document.addEventListener) {
            document.addEventListener('mousedown', tryTopJump, { passive: true })
          }
          document.addEventListener(CONFIG_CHANGED_EVENT, onConfigChanged)
        }
      } catch (e) { /* 拿不到 document 就算了 */ }

      // 首次挂载：如果窗口本来就是可见的，visibilitychange 永远不会触发，
      // 所以这里主动启动一次前台轮询。
      try {
        // startForegroundPoll 内部会先过 canPollForeground()，
        // 所以非浏览器环境（含 node --test 直接执行 factory）不会启动。
        var startHidden = (typeof document !== 'undefined' && document.visibilityState === 'hidden')
        if (!startHidden) startForegroundPoll(ctx)
      } catch (e) { /* ignore */ }

      return function () {
        stopForegroundPoll()
        try {
          if (typeof document !== 'undefined' && document.removeEventListener) {
            document.removeEventListener('visibilitychange', onVisibility)
            document.removeEventListener(CONFIG_CHANGED_EVENT, onConfigChanged)
            document.removeEventListener('mousedown', tryTopJump)
          }
          if (typeof window !== 'undefined' && window.removeEventListener) {
            window.removeEventListener('focus', tryTopJump)
          }
        } catch (e) { /* ignore */ }
      }
    }

    function apply(ctx) {
      // v0.4.76：**启动即上报**。刷新页面后应立刻看到这条 ——
      // 它是判断「前端跑的是哪一版代码」最可靠的方法。
      // （2026-10-20 排查「自动跳转」时，因为没有任何启动标记，
      //   反复在「代码没生效」和「逻辑写错」之间打转。）
      //
      // ⚠️ v0.4.84：版本号**不再硬编码**。
      //
      // 原来写的是 `CLIENT-BOOT v0.4.76`，之后就忘了随版本更新 ——
      // 结果到 v0.4.84 时日志还报 0.4.76，让我误判"前端没加载新代码"，
      // 白折腾一轮。硬编码的版本标记会腐烂，必须从真实来源读。
      //
      // 这里先打一条不带版本的（保证即使接口挂了也有 boot 痕迹），
      // 再异步补一条带真实版本的。
      uiLog('CLIENT-BOOT build=20261020c')
      try {
        fetchVersion(false).then(function (r) {
          var v = r && (r.running || r.current)
          uiLog(`CLIENT-BOOT version=${v || 'unknown'}`
            + (r && r.running && r.current && r.running !== r.current
              ? ` (on-disk=${r.current})` : ''))
        }).catch(function () { /* 拿不到版本不影响 boot 标记 */ })
      } catch (e) { /* 同上 */ }

      // 两件事分别 try/catch：任一失败都不该拖累另一件。
      var disposeSection = null
      try { disposeSection = registerSettingsSection(ctx) } catch (e) { disposeSection = null }

      var disposeJump = null
      try { disposeJump = armSessionJump(ctx) } catch (e) { disposeJump = null }

      return function () {
        uiLog('CLIENT-DISPOSE')
        try { if (typeof disposeJump === 'function') disposeJump() } catch (e) { /* ignore */ }
        try { if (typeof disposeSection === 'function') disposeSection() } catch (e) { /* ignore */ }
      }
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return module.exports
  },
})
