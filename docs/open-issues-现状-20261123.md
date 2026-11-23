# Open Issues 现状梳理（2026-11-23）

当前仓库 `unifilitence/dsh-notify-say` 有 **3 个 open issue**，都是 2026-10-25 ~ 10-27 提的，
三个都**没修**。本文按「能不能复现 / 根因是否确认 / 改哪里 / 风险」逐条梳理，
所有判断都标了验证方式，未验证的明确写"未验证"。

> 时点事实：仓库最新发版 npm `0.5.3`；源码 `0.5.4`（只含测试日志隔离，未发 npm）。
> 三个 issue 之后仓库只动过 3 个提交（`424f3b0` 测试隔离、`8405339`/`ecb9f75` 文档），
> **没有一条修的是 issue**。

---

## 一、总览

| # | 标题 | 能否复现 | 根因 | 严重度 | 建议 |
|---|---|---|---|---|---|
| **#1** | 选未安装的中文音色时静默播日语母带 | **已复现**（发布包） | **已确认** | 高（听到语义相反的语言） | 优先修，改动小 |
| **#3** | 下载音色在下拉看不到 + 深色模式看不见 | 部分复现 | **已确认**（下拉）；深色模式**未验证** | 中 | 分两块处理 |
| **#5** | PTC / code-mode 下「提问」通知永不触发 | 契约已确认，**当前环境无法复现** | **已确认**（代码路径） | 中（只影响 PTC 用户） | 修，但要加回归测试 |

---

## 二、#1 选未安装的中文音色时静默播日语母带

### 复现（已做，对**发布包 0.5.3** 验证）

把 npm tarball 解开、在解压目录里跑 `-Preview -NoSound`：

```
dsh-notify.ps1 -Kind done -Voice zh-clear-female   → pick=master-voice.wav   ← 日语
dsh-notify.ps1 -Kind done -Voice zh-soft-female    → pick=zh-soft-female.wav ← 中文
dsh-notify.ps1 -Kind question -Voice zh-clear-female → pick=master-voice.wav ← 日语
```

### 根因链（三段事实，均已实测）

**① 发布包只带 2 个音色。** `npm pack dsh-notify-say@0.5.3` 解出的 tarball 里，
`sounds/voice-lines/` 只有 27 个 wav，其中中文只有 `zh-soft-female` 一族：

```
zh-soft-female.wav / -extra-1 / -extra-2
zundamon-normal.wav / -extra-1 / -extra-2 / -kansai-1..3
```

**② `master-voice.wav` 与 `zundamon-normal.wav` 是同一个文件**（实测 sha256 相同）：

```
e47e13c780933462ff739db8e0b0e5178f21404d8a43320b462c5687ee939908  sounds/master-voice.wav
e47e13c780933462ff739db8e0b0e5178f21404d8a43320b462c5687ee939908  sounds/voice-lines/zundamon-normal.wav
```

`sounds/README.md:16` 明说它是「主人、任務完了です！」。

**③ 选曲链找不到指定音色时直接落到 master-voice。**
`dsh-notify.ps1:288-312`：先找 `<voice>~*.wav`，再找 `<voice>.wav`；
都没命中且**不是** fail/chime 时，`$picked = Join-Path $SoundDir 'master-voice.wav'`（L308-311）。
**全程不打任何日志**，用户无从知道"换过音色"。

### 当前源码是否已修？**没有。**

`dsh-notify.ps1` 里搜不到 `voice-miss` 之类的留痕；
`lib/client.js:540` 的 `VOICE_KEYS` 仍是静态 15 项（11 日语 + 4 中文），
**不管装没装都列出来**。issue 里提的三处修复建议一处都没做。

### 一个 issue 没写全的细节（新发现）

fail / question / approval 三个子池**都有 4 个中文音色**（每池 4 个 key × 3 变体），
所以：

- `-Kind fail -Voice zh-clear-female` → `zundamon-normal~2.wav`（**池内随机兜底，仍是日语**）
- `-Kind question -Voice zh-clear-female` → `master-voice.wav`（日语）

也就是说**问题不止 done 一种**，只是 done 最常见。`-Lang zh` 时 done 仍落到 master-voice
（因为 master 兜底在语言过滤之后、不再过滤一次）。

TD;LR：**修复必须同时覆盖 done / question / approval / fail 四类，且兜底也要尊重语言。**

### 建议改法（三处，任一处都止血，建议都做）

1. **ps1 侧：同语系回退 + 留痕**
   `-Voice` 找不到时，先在**同一个池**里找同语系前缀（`zh-` / 非 `zh-`）的已装音色；
   找不到才允许落 master-voice，并写 `[voice-miss] requested=X -> Y`。
2. **前端：音色下拉按已安装过滤**
   `lib/voice-pack-store.js:169` 的 `mergeVoices()` **已经返回 `installed` 标志**
   （实测存在，`voice-pack-route.js:118` 的 `handleIndex` 也在用它），
   但 `lib/client.js` 的音色下拉（L1583-1592）**完全没用这个字段**——只用 `VOICE_KEYS`。
   把 `installed` 透下去，未装的标「未安装」，当前选中但没装的保留但标灰。
3. **随机模式同样受影响**：`voiceMode=random` 时池子里中日混放。
   `Select-WavByLang`（`dsh-notify.ps1:227`）已经做语言过滤，但**过滤后为空会退回未过滤**
   （宁可放别的语言也不静音）——这个策略本身合理，问题在于 master-voice 那条路没被覆盖。

### 风险

- 改 ps1 选曲链是**核心路径**，现有 `test/fail-voice.test.mjs` 会真跑 ps1 断言 `pick=`，
  改完必须重跑；另需补 `test/voice-fallback.test.mjs`（issue 作者已在他的 PR 里给了，可直接取用）。
- ⚠️ 改 `.ps1` 后必须复查 UTF-8 BOM（`head -c 3 | od -An -tu1` 应为 `239 187 191`），
  否则 PS 5.1 读中文乱码、`voice-label.test.mjs:294` 红 12 条。

---

## 三、#3 下载音色在下拉看不到 + 深色模式看不见

issue 里有**三个独立诉求**，严重度和确定性都不一样，不要一起处理。

### 3a 下拉里看不到已下载的音色 —— **已确认，就是 bug**

`lib/client.js:540` 的 `VOICE_KEYS` 是**静态硬编码 15 项**，下拉（L1583-1592）只从这里取：

```js
var keyOpts = VOICE_KEYS.filter(function (k) {
  return (k.indexOf('zh-') === 0) === (curLang === 'zh')
})
```

**与磁盘上装了什么完全无关**。所以用户下载了新音色包，下拉里也不会出现。

更进一步（新发现，issue 没提）：**`VOICE_KEYS` 还漏了两个可下载包**。
拿可下载包清单（`packs.json` 的 17 个 key）与之对账：

```
IN PACKS BUT NOT IN VOICE_KEYS: tohoku-kiritan | tohoku-zunko
IN VOICE_KEYS BUT NOT A PACK: (none)
```

即 **`tohoku-kiritan` / `tohoku-zunko` 两个包整个 17 → 15 丢了**。
（`packs.json` 里确实有这两个 zip，release 上 `tohoku-kiritan.zip` 41 次、`tohoku-zunko.zip` 36 次下载——
有人下到了，但设置页里选不到。）

**建议**：下拉候选改成 `VOICE_KEYS ∪ packStore.installed ∪ 当前值`。
`handleIndex`（`lib/voice-pack-route.js:118-140`）已经把 `installed` 和 `source` 算好了，
前端 `v.packs` 里也有这份列表（`lib/client.js:751` 已经把它塞进 state），**只差下拉没消费**。
**这条改动只在 client 侧，不动后端，风险低。**

### 3b 深色模式下下拉看不见 —— **未验证**

现状：`lib/client.js:292-297` 的 `select` 样式是

```js
background: 'transparent', color: 'inherit',
```

`<option>` 一个都没设样式（全文搜索 `option:` 0 处），也没有任何 `color-scheme` 声明。

**推断**（标明是推断，未实测）：Chromium 的原生下拉弹层在 Windows 上按系统主题绘制，
`transparent` 背景 + 继承色在深色宿主里可能让弹层文字与背景接近。

**为什么没验证**：这需要真机打开设置页截图；本会话没有做。
**建议**：先让用户复现截一张图，再决定是加 `option { background:#222; color:#eee }`
还是给 `<select>` 加 `colorScheme`。**不要凭推断改样式**。

### 3c 「会受 DSH-Market 新装/升级插件影响，重新覆盖通知功能」—— **未验证，且不像本插件能修的**

用户原话是「疑似」。目前**没有证据**能定位到本插件的哪段代码。
可能相关的事实：本插件在 profile 里是 `link:E:/0Deepseek/tools/plugins/dsh-notify-say`（源码直连），
市场重装 profile 依赖时可能把 bundle 列表或符号链接改掉。
**这属于部署形态问题，不是插件代码问题**，需要单独的排查证据（升级前后的
`profiles/desktop/package.json` + `node_modules` 链接状态对比）。
**建议**：向提 issue 的人要「升级前后 `package.json` 的 diff」，拿到再判断。

---

## 四、#5 PTC / code-mode 下「提问」通知永不触发

### 根因确认（代码 + 宿主契约双证据）

**插件侧**（`lib/index.js`）：

- L2728 `ctx.on('session/event', ...)` 只处理 `tool/call`（L2809 附近调用 `handleQuestionCall`）
- L2682 `if (!QUESTION_TOOLS.has(d.name)) return;` —— **静默 return，不留日志**
- L316 `QUESTION_TOOLS = new Set(['ask_user_question', 'exit_plan_mode'])`

在 PTC（code-mode）会话里，宿主记录的 `tool/call` 事件 `data.name` 恒为 `run_code`，
真实工具名只在 `tool/ptc-dispatch-start` 的 `data.name` 上 —— **插件没订阅这个事件**。

**宿主契约确认**（读了运行时的类型声明，不是猜的）：

`D:\Program Files (x86)\DSH\.runtime\node_modules\@deepseek-ai\dsh-tools\lib\types\types.d.ts`

```ts
export interface PtcDispatchStartEventData {
    rootCallId: ToolCallId;
    parentCallId: ToolCallId;
    subCallId: ToolCallId;
    name: string;
    arguments: unknown;
}
// SessionEventMap:
'tool/ptc-dispatch-start': PtcDispatchStartEventData;
'tool/ptc-dispatch':       PtcDispatchEventData;   // = Start + isError + content
```

所以 issue 里说的「事件存在、挂在 session/event 上、插件没订阅」**全部属实**。
当前 DSH 是 0.2.2-rc.1（issue 报的是 0.2.1-rc.3），这个契约**仍在**，问题仍有效。

### 当前环境为什么复现不了

扫了 `--E-Codex--` / `--E-0Deepseek--` / `--E-promo-demo--` 下 27 个最近会话：

```
run_code 事件 = 0，tool/ptc-dispatch-start = 0
```

本机现在的会话都是**直接调用一级工具**（`ops_bash` 160 次、`ops_glob`…），
没有走 `run_code` 外壳。所以这是**特定配置下的问题**，不是普遍失效。

顺带一提：`profiles/desktop/cordis.patch.yml:1028` 里 `ptc.enabled: true`、`ops-ptc.enabled: true`，
但 `global.forceDefaultOpsPtc: false`，本机默认预设是 standard —— 这就是为什么没走 PTC。

### 修复要点

```js
// 订阅 tool/ptc-dispatch-start，用 data.name 判定
ctx.on('session/event', (session, event) => {
  if (event.type === 'tool/ptc-dispatch-start') handleQuestionCall(session, event.data, { ptc: true });
  ...
});
```

三个必须注意的点：

1. **幂等键要区分**：`tool/call` 用 `callId`；PTC 的 `subCallId` 是 `<parent>:ptc:<n>`，
   两者不能混用同一个幂等 map，否则同一次提问可能提醒两次或漏提醒。
2. **别把 `run_code` 本身当提问**：`run_code` 的 arguments 里可能含 `ask_user_question` 字样，
   按名字判定不受影响，但别去解析 arguments。
3. **补回归测试**：现在 `test/` 下**没有任何 PTC 相关测试**（`grep -rn "ptc\|run_code" test/*.mjs` 为 0）。
   建议加 `test/ptc-question.test.mjs`，用假 `session/event` 事件断言 `handleQuestionCall` 被调用。

### 风险

低。这是**纯新增订阅**，不碰现有 `tool/call` 路径；`QUESTION_TOOLS` 白名单不变。
唯一要小心的是幂等键不能复用（见上）。

---

## 五、建议的处理顺序

| 顺序 | 事项 | 理由 | 预估 |
|---|---|---|---|
| 1 | **#1 修 ps1 选曲链 + client 过滤** | 用户听得到错误、改动局部、测试可复现 | 小 |
| 2 | **#3a 下拉 = VOICE_KEYS ∪ installed ∪ 当前值**（顺带补上 tohoku-kiritan / tohoku-zunko） | 纯 client 改动，风险最低 | 小 |
| 3 | **#5 订阅 ptc-dispatch-start** | 独立订阅，加测试 | 小~中 |
| 4 | #3b 深色模式下拉 | **先要用户截图**，不凭推断改 | 待证据 |
| 5 | #3c 市场覆盖问题 | **先要升级前后 package.json diff** | 待证据 |

前三条可以合成一次发版（版本号前推一格，把 v0.5.4 一起带上）。

---

## 六、本文的验证清单（可复算）

| 结论 | 验证方式 |
|---|---|
| 发布包只带 2 个音色 | `npm pack dsh-notify-say@0.5.3` + `tar tzf` 看 `voice-lines/` |
| master-voice 与 zundamon-normal 同文件 | `sha256sum` 两者（已列哈希） |
| #1 可复现 | 解压 tarball 后跑 `-Preview -NoSound`（命令见第二节） |
| VOICE_KEYS 漏 2 个包 | 脚本比对 `lib/client.js:540` 的 `VOICE_KEYS` 与 packs.json 的 17 key |
| #5 事件契约存在 | 读 `dsh-tools/lib/types/types.d.ts:9-52` |
| #5 当前环境无 PTC | 解压 27 个会话统计 `tool/ptc-dispatch-start` = 0 |
| 三个 issue 都没修 | `git log --since=2026-10-25 -- tools/plugins/dsh-notify-say` 只有 3 个文档/测试提交 |
