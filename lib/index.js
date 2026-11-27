/**

 * dsh-notify-say — Host half（官方插件规范形态）。
 *
 * 证据基础（0.1.7-rc.2 app.asar 一手抽取，均存 scratch/asar-extract/）：
 *  - 导出形态：references/host-plugin.md「Host plugin export forms」——
 *    `export function apply(ctx, config) {}`，资源用 ctx.effect/ctx.on 注册。
 *  - 事件：@deepseek-ai/dsh-agent-preset-registry/lib/typert.host.js SessionEventMap（:647）——
 *      'turn/end': { turn: number; reason: TurnEndReason }（turn 是数字序号，不是对象）
 *      TurnEndReasonMap（:803）：completed / aborted / blocked / error / max-tokens /
 *      interrupted / forked，均为 { kind: ... } 对象 → 用 reason.kind 判分支。
 *      'approval/asked': { id, toolName, callId?, reason? }
 *      'approval/decided': { id, outcome }            （审批审计事件对）
 *    SessionHeader（:655）：parentSession? / origin?: 'subagent' / delegationDepth? → 子代判定。
 *  - 审批接缝：@deepseek-ai/dsh-user-approval/lib/index.js:176 —— approval/request 是
 *    waterfall，fail-closed 默认（无应答者 → 'unavailable'）。本插件 listener 必须
 *    return next() 并透传返回值，绝不阻断、不改写决定。
 *  - 事件消费方式：SessionEventMap 事件经 session/event 流观测（旧 dsh-notify-done 在
 *    同源 Cordis 事件系统上实证的做法；practices.md 亦把 session/event 订阅与
 *    sessionProjections 并列为观测手段）。turn/end 不是独立 ctx 事件名。
 *
 * 行为（v1 规格，见 CARD.md）：
 *  - F1 回合完成：仅 reason.kind==='completed' 播「完成」；error/blocked 换文案 +
 *    系统蜂鸣（无对应语句池资产，不播"完成"语音以免误导）；aborted/max-tokens/
 *    interrupted/forked 默认静默（notifyOnAborted）。按会话去抖（默认 60s）。
 *  - F2 审批：监听 approval/request waterfall（放行 + 提醒）与 approval/asked/
 *    approval/decided 审计对（幂等 + 对账：同一 id 只提醒一次，decided 后清除，
 *    连串审批按同会话同工具去抖，默认 15s）。替代旧插件的手工 pending 缓存。
 *  - F3 语音/Toast：spawn 本包自带 dsh-notify.ps1（fire-and-forget，带并发上限 +
 *    超时强杀，沿用旧插件加固逻辑）。
 *  - F4：无 client 半侧（references 无文档明载 client↔host 通道），Toast 按钮走
 *    官方 dsh://open 仅唤起窗口。
 *
 * 不做的事：不注册 Config schema（references 未给出 `export const Config` 的
 * schema 方言，臆造有激活失败风险）；config 只在本函数规范化，改配置 = 改
 * profile 补丁层的行 config 后重启/重载（practices.md 的推荐落点）。
 *
 * ───────────────────────────────────────────────────────────────────────────
 * v0.3.0「空闲门（idle gate）」——修正误报（用户 2026-10-16 反馈）
 * ───────────────────────────────────────────────────────────────────────────
 * 问题：主会话这一轮跑完（turn/end completed）时，它派生的子代理或后台任务
 * 可能**仍在运行**；旧实现只看 reason.kind，于是弹出"任务完成"误导用户。
 *
 * 根因：`turn/end completed` 的语义是「这一轮对话跑完了」，不是「整个工作树空闲了」。
 *
 * 本机一手证据（0.1.7-rc.2 `.runtime` 源码）：
 *  - ctx.jobs（@deepseek-ai/dsh-jobs Service Definition）：
 *      list(caller) → JobSnapshot[]，status ∈ running|stopping|completed|killed|failed
 *        （dsh-jobs-local/lib/index.js:178）
 *      onJobsChanged(listener) → 可见集变化时回调，返回 disposer（同上 :264）
 *  - ctx.agents（@deepseek-ai/dsh-agent AgentRegistry）：
 *      list() → 全部活 agent；get(id)；isOwnedBy(id, owner)
 *        （dsh-agent/lib/types/index.d.ts:341,350,355）
 *  - agent/status：idle ⇄ running 边沿；文档原文「idle means no driver remains
 *    scheduled or active」（dsh-agent/lib/types/runtime-types.d.ts:247）——
 *    比 turn/end 更接近"真空闲"，故用作**主触发点**。
 *  - 子代理判定：SessionHeader.origin==='subagent' + parentSession 链
 *    （dsh-session/lib/types/types.d.ts:71,81,87）。
 *    ⚠️ **不能单用 parentSession**：sessions.fork 的分叉会话 header 也带
 *    parentSession 但 origin 为空，仍是顶层会话（dsh-messager src/index.ts:278-280
 *    同款结论，其注释明确点出这个坑）。
 *  - ⚠️ **continuable 子代理不注册 job**：dsh-base/cordis.patch.yml:354 的 subagent
 *    工具默认 backgroundMode=continuable，走 subagents.startContinuable →
 *    ctx.agents.create({parentAgent})（dsh-subagent/lib/index.js:1077）。
 *    只有 one-shot 后台子代理与后台 pwsh 走 jobs.start
 *    （dsh-tool-subagent/lib/index.js:538、dsh-tool-pwsh/lib/index.js:387）。
 *    ⇒ 空闲门必须**同时**查 jobs 与 agents 两路，否则漏判最常用的 continuable 子代理。
 *
 * 业界对照（2026-10-16 实读源码，非二手转述）：
 *  - Claude Code 官方 Stop hook 输入直接携带 `background_tasks` 与 `session_crons`，
 *    文档原文：这两个数组让 hook 区分 "session is done" 与 "session is paused waiting
 *    for background work to wake it back up"（code.claude.com/docs/en/hooks）。本实现的
 *    「空闲门」与它同构。
 *  - DSH 生态同类插件（dsh-notifier ★24 / dsh-messager ★9 / dsh-perlica-ding ★7 /
 *    dsh-workmate ★5 / dsh-plugin-notify ★7）**均只过滤子代理自身的完成事件，
 *    无一等待子代理结束**——即本问题在整个生态尚未被解决。
 *  - 借鉴其两处已验证细节：① 触发用 agent/status 的 running→idle 边沿；
 *    ② 子代理判定失败时走主任务分支（"宁可多报一条 done，不静默用户自己的任务"，
 *    dsh-notifier src/server/events/impl/session/index.ts:70-77 注释）。
 *
 * 设计：completed 时先过空闲门 → 有在飞工作则**挂起**（不播），订阅
 * onJobsChanged + agent/status 重估，全部清空后播**一次**（天然合并多个子代理）；
 * 超过 idleGateTimeoutSeconds 兜底播报（防子代理卡死导致永不播报）；
 * 主会话重新进入 running（用户已开始新一轮）则取消挂起。
 * 失败一律 fail-visible：判定异常时走主任务分支照常播报，不静默用户。
 */
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { readConfig, mergeConfig, describe as describeConfig, describeHome } from './config-store.js';
import { loadSchema, buildConfig, readConfig as readSchemaConfig, FIELD_DEFAULTS } from './config-schema.js';
import { createSessionBridge, ROUTE_PREFIX } from './session-bridge.js';
import { createConfigRoute } from './config-route.js';
import {
  audioKindOf, resolveSource, effectiveSource, resolveCustomFile,
} from './audio-source.js';
import { checkLocalOrigin, throttle } from './http-guard.js';
// v0.4.83：协议归属判定 + 同步决策抽成纯函数，便于测试且只有一处规则。
import { classifyProtocolOwner, planProtocolSync, isLegacyRegistration, OWNER_VALUE_NAME, OWNER_ID } from './protocol-ownership.js';
import { poolSummary, installedVoiceKeys } from './voice-pack-store.js';
import { notifyLogPath as resolveNotifyLogPath } from './log-path.js';
import { voiceRootsArg as computeVoiceRootsArg } from './voice-regions.js';
import { checkForUpdate } from './update-check.js';
import { createVoicePackRoute } from './voice-pack-route.js';
// v0.6.0：渲染进程播放通道（SSE 推送 + 一次性 token + 自动回退 PowerShell）。
// 为什么要有它：见 lib/audio-channel.js 头部 —— powershell.exe 被用户在混音器里
// 调到 1% 后，插件会**永久静默且毫无提示**（2026-11-27 真实踩坑）。
import { createAudioChannel } from './audio-channel.js';
import { isDebug, redactText } from './log-privacy.js';
import { exportDiagnostics } from './diagnostics.js';
// ⚠️ 不再导入 watchPackage（v0.4.57）：自动监听重载已移除，见 dev-reload.js 末尾注释。
import { selfReload, computeFingerprint, planReload } from './dev-reload.js';
import { pickTtsText, sanitizeTtsText, MAX_TEXT_LEN } from './tts-lines.js';

const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 加载那一刻插件根的**真实路径**（解开 Junction / 符号链接）。
 *
 * 用途：判断"自重载还能不能救"。
 *
 * 自重载只能重新导入「**同一路径上的**」代码。`dsh plugin update` 升级后，
 * pnpm 会把包装到新的 `.pnpm/<name>@<ver>/` 下，而这里的 PLUGIN_ROOT
 * 在加载时就已解析成旧路径 —— 那时从旧路径重新导入，拿到的仍是旧代码。
 * 所以点按钮时比一次，路径变了就**如实说"必须重启"**，不给假希望。
 */
const RESOLVED_PLUGIN_ROOT = (() => {
  try { return realpathSync(PLUGIN_ROOT); } catch { return PLUGIN_ROOT; }
})();


// 检查更新的宿主侧缓存（v0.4.48）。
//
// 为什么放宿主侧而不是浏览器：
//   · 一天最多查一次 —— 不管用户开几次设置页，都不该反复打 npm/GitHub
//   · 报错也不影响功能：查不到就是查不到，通知与语音照常
//   · 缓存跨会话存活（模块级），设置页重开不必重新联网
const UPDATE_CACHE = { at: 0, result: null };
// 插件版本（诊断导出用）。读 package.json，失败就返回 unknown ——
// 这只是个信息字段，不值得为它抛异常。
const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
})();
const SCRIPT_PATH = join(PLUGIN_ROOT, 'dsh-notify.ps1');

/**
 * 语音包候选根目录，拼成 ps1 能吃的字符串（分号分隔，**前面的优先**）。
 *
 * 为什么由 Node 算而不是 ps1 自己拼：
 *   用户下载的音色在 %LOCALAPPDATA%，内置的在插件目录，两处都要查且优先级不同。
 *   这套规则只应存在一份（lib/voice-pack-store.js），ps1 只接收排好序的路径串，
 *   否则两边各维护一份、迟早漂移 —— 那正是这次重构要消除的问题。
 *
 * @returns {string} 空串表示不传（ps1 退回只看插件目录）
 */
function voiceRootsArg() {
  // ⚠️ 2026-10-18 修 P0：这里原本调用了一个**不存在**的 `regions()`。
  //
  // 后果链：
  //   regions 未定义 → ReferenceError → catch → 返回空串
  //   → `if (roots)` 永远为假 → `-VoiceRoot` 从来没传给过 ps1
  //   → ps1 退回内置 sounds/voice-lines
  //   → **用户下载的音色根本播不到**
  //
  // 更麻烦的是它"看起来能工作"：内置目录里也有 ameharu-hau.wav 这类文件，
  // 所以测试时能听到声音，但那不是用户下载的版本。
  // 外部审阅对照公开源码直接指出了这一点（此前我的端到端测试是手动传
  // -VoiceRoot 做的，恰好绕过了这个断裂 —— 又一次"手动构造不等于真实路径"）。
  //
  // 现在交给 lib/voice-regions.js：它把「用户目录下每个音色子目录」
  // 和「内置平铺目录」都作为独立的根返回（ps1 不递归子目录，必须这样给）。
  try {
    return computeVoiceRootsArg(PLUGIN_ROOT);
  } catch {
    return '';   // 算不出来就让 ps1 走默认路径，不因为新逻辑影响播放
  }
}
/** Windows 自带 TTS 的脚本（零下载也能说话）。 */
const TTS_PATH = join(PLUGIN_ROOT, 'tts-speak.ps1');

/**
 * 与 ps1 共用的日志文件路径（`%TEMP%\dsh-notify-say\notify.log`）。
 *
 * 让 host 侧的 `[skip]` 记录与 ps1 侧的 `[toast]` / `[preview]` 落在同一文件，
 * 事后能按时间顺序看出「这一刻到底播了还是没播、没播是因为什么」。
 *
 * @returns {string} 绝对路径
 */
function notifyLogPath() {
  // 实现搬进 log-path.js：由宿主侧、diagnostics 与两个 ps1 共用同一份口径。
  // 直接原因（v0.5.4）：原来只读 process.env.TEMP，而测试只隔离了 DSH_HOME、
  // 没隔离 TEMP，于是 `npm test` 把 Z:\__no_such_root__ 的 play-fail 写进了
  // 用户**真实**日志，让后来排查误以为真机起不来 PowerShell。见 lib/log-path.js。
  return resolveNotifyLogPath();
}

/**
 * 追加一行到 notify.log。**永不抛异常**（日志失败不能影响播报）。
 * @param {string} message
 */
/**
 * 日志轮转阈值（字节）与保留策略。
 *
 * 加轮转的原因：本次新增的 `[skip]` 记录把"没播"也写进日志后，写入频率显著上升
 * （每次跳过都一行）。不轮转的话，长时间运行会无限增长。
 *
 * 策略：超过 1 MB 就改名为 `notify.log.1`（覆盖旧的），新日志重新开始。
 * 只保留 1 份历史，够事后排查，也不会占太多空间。
 */
/**
 * 热重载漏报诊断（v0.4.36）。
 *
 * ## 为什么需要
 *
 * 2026-10-18 实测：开发期开着 devReload=true 时，我改代码触发热重载，
 * 正好在这几秒内完成的回合**没有播报**，日志里也查不到任何痕迹 ——
 * 排查时无法区分"事件没进来"和"进来了但没播"。
 *
 * 这个计数器给出一个可查的信号：
 *   · 每次事件处理入口 +1（存 globalThis，跨实例存活）
 *   · 重载完成后对比"重载前计数"，差值就是重载期间可能漏掉的事件数
 *
 * ## 为什么用 globalThis 而不是模块变量
 *
 * 重载后是新模块、新变量，旧值全丢。只有 globalThis 能在实例之间传。
 * key 带插件名，避免与其它插件冲突。
 */
const EVENT_COUNTER_KEY = Symbol.for('dsh-notify-say.eventCount');

/** 记一次"事件进来了"（在任何可能播报的入口调用）。 */
function bumpEventCount() {
  try {
    globalThis[EVENT_COUNTER_KEY] = (Number(globalThis[EVENT_COUNTER_KEY]) || 0) + 1;
  } catch { /* ignore */ }
}

/** 读当前累计事件数。 */
function readEventCount() {
  try {
    return Number(globalThis[EVENT_COUNTER_KEY]) || 0;
  } catch {
    return 0;
  }
}


const LOG_MAX_BYTES = 1024 * 1024;

/** 超过阈值时轮转一次（尽力而为，失败不影响写入）。 */
function rotateNotifyLogIfNeeded(p) {
  try {
    if (!existsSync(p)) return;
    if (statSync(p).size < LOG_MAX_BYTES) return;
    renameSync(p, p + '.1');
  } catch { /* 轮转失败就继续往原文件追加 */ }
}

/**
 * 追加一行到 notify.log。**永不抛异常**（日志失败不能影响播报）。
 * @param {string} message
 */
function appendNotifyLog(message, opts) {
  try {

    // 含用户内容的行：非 debug 档直接丢弃（不是脱敏，是不记）。
    // 见 log-privacy.js 头注释：那些内容对诊断「为什么不响」没帮助，
    // 却可能带出项目名、人名，而用户提 Issue 时常直接上传日志。
    if (opts && opts.detail && !isDebug(cfg.logLevel)) return;
    const p = notifyLogPath();
    if (!p) return;
    mkdirSync(dirname(p), { recursive: true });
    rotateNotifyLogIfNeeded(p);
    const d = new Date();
    const pad = (n, w = 2) => String(n).padStart(w, '0');
    const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
      + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    appendFileSync(p, `${ts} ${message}\n`, 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
}

// 审查建议采纳：不依赖宿主 PATH，直接定位 System32 的 Windows PowerShell 5.1
// （Toast 用 WinRT 投影，只在 5.1 可用；用 env 兜底避免硬编码盘符）。
const POWERSHELL_EXE =
  `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

// 默认值**单一来源**：用户可见项全部来自 config-schema.js 的 FIELD_DEFAULTS
// （独立审查 B5 指出原先把它们抄了两份，注释里自己写着"勿各写一份"）。
// 这里只补 2 个**不对外暴露**的内部节流值 —— 它们不进 settings 表单。
const DEFAULTS = Object.freeze({
  ...FIELD_DEFAULTS,
  // 毫秒形态的运行时值，由秒换算而来（FIELD_DEFAULTS 里是秒，schema 也是秒）。
  // ⚠️ 不在这里写死 60_000 —— 默认值的唯一来源是 FIELD_DEFAULTS.debounceSeconds。
  debounceMs: FIELD_DEFAULTS.debounceSeconds * 1000,
  globalCooldownMs: FIELD_DEFAULTS.globalCooldownSeconds * 1000,
  // 下面两个不对外暴露，只留在本文件。
  approvalDebounceMs: 15_000,
  idleGateTimeoutMs: 600_000,     // 兜底：挂起超过此时长仍播报（防子代理卡死）
});

// ── 资源保护（移植自旧 dsh-notify-done lib/index.js:70-83 的实测加固）────────
// spawn 并发上限 + 30s 超时强杀（音频驱动/Toast 偶发 hang，旧踩坑 #13）；
// 去抖 Map 带 TTL 清理与条目上限，防会话 id 无限增长。
const SPAWN_TIMEOUT_MS = 30_000;
const MAX_PENDING_SPAWNS = 4;
const MAP_TTL_MS = 30 * 60_000;
const MAP_MAX = 512;
/** 子代理祖先链最大回溯跳数（防御性上界，正常深度远小于此）。 */
const MAX_ANCESTOR_HOPS = 64;

// ── 方案C：提问提醒（老壳时代功能补齐，2026-09-25）────────────────────────
// 提问期间回合不结束（turn/end 永不触发），须只读观测 session/event 的 tool/call。
// 工具名依据旧 dsh-notify-done（:64-67）：ask_user_question（dsh-tool-ask-user）、
// exit_plan_mode（dsh-plan-mode；/plan 是斜杠命令不是工具，见踩坑 #84）。
const QUESTION_TOOLS = new Set(['ask_user_question', 'exit_plan_mode']);
const QUESTION_TTL_MS = MAP_TTL_MS; // 同一提问 callId 只提醒一次的幂等窗口

/**
 * 老用户向迁移：把「已经在用中文音色但配置里没有 voiceLang」推断成 `zh`。
 *
 * ## 为什么需要它（真实的回退，不是理论问题）
 *
 * `voiceLang` 是 v0.5.3 新增字段，默认 `'ja'`。老用户磁盘上的配置长这样：
 *
 * ```json
 * {"version":1,"values":{"voiceName":"zh-soft-female","voiceMode":"random"}}
 * ```
 *
 * 没有 `voiceLang`。若直接按默认 `'ja'` 走，随机池会从「中日混播」
 * （v0.5.2 的既有行为）变成**只有日语** —— 对本就选了中文音色的用户，
 * 这比修复前更糟。用户升级后会发现「我明明选的温柔女声，怎么再也听不到了」。
 *
 * ## ⚠️ 为什么不能写在 normalizeConfig 里（第一版就是这么写错的）
 *
 * 真实链路是：
 * ```
 * apply() → refreshConfig() → entryFromSchema() → readSchemaConfig(rawConfig)
 *         → mergeConfig(...) → normalizeConfig(merged)
 * ```
 * 而 `config-schema.js:readConfig` 对**所有缺失键填 `FIELD_DEFAULTS`**，
 * `FIELD_DEFAULTS.voiceLang === 'ja'`。所以 `merged.voiceLang` **恒等于 `'ja'`**，
 * 写在 normalizeConfig 里的 `raw.voiceLang !== 'ja'` 判断**永远短路**。
 *
 * 那版代码是「测试绿、功能死」：L9 直接调 `normalizeConfig({})` 绕过了 schema 层，
 * 所以测试通过；真实宿主下迁移一次都不会执行。
 *
 * ## 正确的位置：合并之前，用「用户显式设置过的来源」判断
 *
 * 谁才代表用户的显式选择？
 *   · `rawConfig`（cordis patch）—— 用户在 patch 里写的，**最权威**
 *   · `fileValues`（CLI/设置页写进 config.json）—— 也是用户显式动作
 *   · `fromSchema` —— **不算**：它含 schema 默认值，无法区分「用户选的 ja」
 *     和「默认给的 ja」
 *
 * 所以判据是：`rawConfig` 与 `fileValues` 里都**没有** `voiceLang` 键，
 * 且最终音色以 `zh-` 开头 → 推断 `zh`。
 *
 * @param {object} rawPatch cordis patch 传来的原始配置（用户写的）
 * @param {object} fileValues `$DSH_HOME/storages/.../config.json` 里的值（用户写的）
 * @param {string|undefined} voiceName 合并后的最终音色 key
 * @returns {'zh'|undefined} 推断出的语言；不需要迁移时返回 undefined
 */
export function inferLegacyVoiceLang(rawPatch, fileValues, voiceName) {
  // ⚠️ 注意：**`rawPatch` 在真机上无法区分「用户选了默认值」与「用户没设」**。
  //
  // 早期版本假设 rawPatch 是「用户写的那几个键」，所以 `readLang(rawPatch)`
  // 能代表用户的显式选择。**这个假设在真机上是错的**（2026-10-24 复核实测）：
  //
  //   真机链路：Config schema 存在 → 宿主把 **59 个字段全部**包成 schemastery ref
  //   → rawPatch.voiceLang 恒为一个 `{ get: fn }` 对象，其 `get()` 返回
  //     **schema 默认值 `'ja'`**（config-schema.js 的 voiceLang 定义）。
  //
  // 实测「显式设 ja」与「完全没设」两份 ref **逐字段完全相同**：
  //   own props 都是 ['get']，get() 都返回 'ja'，无任何可区分信息。
  // 于是 `readLang(rawPatch)` 恒为 'ja' → 早退恒成立 → 迁移在真机上是死代码。
  //
  // 那个版本测试是绿的，因为测试用 `{ get: () => v }` 自己造的假 ref 只放 1 个键，
  // 而真机是 59 个键全在、且值来自 schema 默认填充。
  //
  // ✅ 唯一可靠的判据：`fileValues` —— 它是 `config-store.readConfig()` 读出的
  // **纯 JSON**（用户/设置页真正写进 config.json 的内容），没有 schema 填充。
  //    · 老用户（无该键）→ 可推断
  //    · 显式写 ja / zh → 尊重用户，不覆盖
  //
  // 代价：若用户只在 cordis patch（宿主配置界面）里设了 voiceLang、config.json 里没有，
  // 我们会把它当成「没设」而做推断。但这只会发生在「中文音色 + 没写过 config.json」时，
  // 且推断结果是 zh —— 与该用户的实际选择（中文音色）一致，不会造成错误覆盖。
  // 反过来（patch 显式 ja + 中文音色）确实会被推断成 zh，属于已知取舍：
  // 真机无法区分，宁可让中文音色的用户听到中文。
  const readLang = (src) => {
    if (src == null || typeof src !== 'object') return undefined;
    const slot = src.voiceLang;
    if (slot == null) return undefined;
    let v = slot;
    if (typeof slot === 'object' && typeof slot.get === 'function') {
      try { v = slot.get(); } catch { return undefined; }
    }
    return v === 'ja' || v === 'zh' ? v : undefined;
  };
  // 只看 config.json 里用户真正写过的值。
  // `rawPatch` 已排除 —— 见上，真机上它恒带 schema 默认值。
  if (readLang(fileValues)) return undefined;
  // 没有显式设置，再看音色是不是中文。
  // 用 startsWith 而非 includes：只有前缀才是语言标识（L1 已在钉这一点）。
  //
  // 大小写：ps1 那边 `-like 'zh-*'` 不区分大小写；这里先 toLowerCase 对齐语义
  // （复核 P3：现状全小写无 bug，但两处语义分歧靠约定维持太脆）。
  if (typeof voiceName === 'string' && voiceName.toLowerCase().startsWith('zh-')) return 'zh';
  return undefined;
}

/**
 * 从「已合并的三层配置」得出最终生效的 cfg。**唯一出口**。
 *
 * ## 为什么要有这个函数（而不是在 refreshConfig 里直接写两行）
 *
 * 第一版把「normalizeConfig + 迁移」两步直接内联在 `refreshConfig` 里，
 * 测试则在自己文件里**复刻**了一遍链路。结果是：删掉 refreshConfig 里的
 * 迁移调用，测试仍然全绿 —— 因为测试跑的是它自己那份复刻，不是生产代码。
 * 这是比「判据恒绿」更隐蔽的一层假绿：**判据测的是副本，不是本体**。
 *
 * 所以把这段抽成导出函数，生产与测试走**同一段代码**。
 * 任何删改都会真的影响测试，而不是只影响副本。
 *
 * @param {object} merged 三层合并后的原始配置（可能含 schema 默认值）
 * @param {object} rawPatch 用户写的 patch 层（用于判断「显式设置过」）
 * @param {object} fileValues 用户写的 config.json 层（同上）
 * @returns {object} 最终 cfg
 */
export function resolveEffectiveConfig(merged, rawPatch, fileValues) {
  const cfg = normalizeConfig(merged);
  const inferred = inferLegacyVoiceLang(rawPatch, fileValues, cfg.voiceName);
  // 迁移只补一个键，不动其余 —— 避免把 normalizeConfig 的其它产物覆盖掉。
  return inferred ? { ...cfg, voiceLang: inferred } : cfg;
}

/**
 * 三层配置 → 生效 cfg 的**完整**流程（合并 + 迁移）。
 *
 * 为什么单独抽出来：v0.5.3 之前，`refreshConfig()` 里手写着
 *   mergeConfig(mergeConfig(rawConfig, fromSchema||{}), fileValues)
 *   → resolveEffectiveConfig(...)
 * 而它在闭包里，测试驱动不了。于是 L9d 只能对源码写
 * `body.includes('resolveEffectiveConfig(')` 这种**形状断言**。
 *
 * 2026-10-25 第三份独立复核实测：下面五种坏写法都能让 L9d 全绿，
 * 而真实行为已经坏掉（`-Lang` 恒为 `["ja"]`，老用户听不到中文）：
 *   · 调用后丢弃结果
 *   · 塞进 `if (false) … else cfg = normalizeConfig(merged)`
 *   · 整行注释掉
 *   · 传错参数（把 fromSchema 当 fileValues）
 *   · mergeConfig 顺序对调
 * 只有「整行删除」能红。也就是说 L9d 当时是**半个空过滤**。
 *
 * 抽成纯函数后，测试直接驱动生产代码本身，任何一条坏写法都会真的影响返回值。
 *
 * @param {object|null} rawPatch cordis patch（真机上是已 schema 化的对象）
 * @param {object|null} fromSchema entryFromSchema() 的结果（无 schema 时为 null）
 * @param {object} fileValues config.json 的纯 JSON 值
 * @returns {object} 最终生效 cfg
 */
export function computeEffectiveConfig(rawPatch, fromSchema, fileValues) {
  // 合并顺序：patch(原始) → schema 值 → 文件值
  const merged = mergeConfig(
    mergeConfig(rawPatch, fromSchema || {}),
    fileValues || {},
  );
  return resolveEffectiveConfig(merged, rawPatch, fileValues || {});
}

/**
 * 把「用户配置的原始形状」规范化为内部 cfg。
 *
 * v0.5.3.1 起导出：为的是让行为测试能直接驱动它（而不是对源码文本写正则，
 * 那种判据在锚点失配时恒绿 —— 踩坑 #469 的形态）。
 *
 * ⚠️ 老用户迁移**不**在这里做，见 `inferLegacyVoiceLang` 的注释：
 * 本函数拿到的 raw 已被 schema 层填过默认值，在这里判断必然恒假。
 *
 * 生产调用点不变（apply → refreshConfig → normalizeConfig）。
 */
export function normalizeConfig(raw) {
  const out = { ...DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  for (const k of ['notifyOnComplete', 'notifyOnError', 'notifyOnBlocked', 'notifyOnAborted',
    'notifyOnApproval', 'notifyOnQuestion', 'voice', 'subagents', 'idleGate',
    // v0.4.68：子代理出错单独开关（完成可以合并，错误不能合并掉）
    'notifyOnSubagentError', 'notifyOnMaxTokens', 'toastJumpSession',
    // v0.4.2
    'showToast', 'jumpWhenBackground', 'jumpWhenForeground', 'multiJumpRule',
    // v0.4.3：开发开关
    'devReload']) {
    if (typeof raw[k] === 'boolean') out[k] = raw[k];
  }
  if (raw.voiceMode === 'fixed' || raw.voiceMode === 'random') out.voiceMode = raw.voiceMode;
  // v0.5.3：语音包语言。与 config-store 的 RULES 同口径（只认 ja / zh）。
  if (raw.voiceLang === 'ja' || raw.voiceLang === 'zh') out.voiceLang = raw.voiceLang;
  if (typeof raw.voiceName === 'string' && /^\w[\w-]*$/.test(raw.voiceName)) out.voiceName = raw.voiceName;
  // ⚠️ 老用户向迁移**不在这里做**，见模块级 inferLegacyVoiceLang（L360 附近）的注释。
  // 原因：本函数拿到的 raw 已经过 schema 层填默认值，voiceLang 永远存在。此处做
  // 判断必然恒假，是个「测试绿、功能死」的假修复（第一版就是这么写错的）。
  const v = Number(raw.volume);
  if (Number.isFinite(v) && v >= 0 && v <= 100) out.volume = Math.round(v);
  const d = Number(raw.debounceSeconds);
  if (Number.isFinite(d) && d >= 0 && d <= 3600) out.debounceMs = Math.round(d * 1000);
  const a = Number(raw.approvalDebounceSeconds);
  if (Number.isFinite(a) && a >= 0 && a <= 3600) out.approvalDebounceMs = Math.round(a * 1000);
  const g = Number(raw.idleGateTimeoutSeconds);
  if (Number.isFinite(g) && g >= 0 && g <= 86400) out.idleGateTimeoutMs = Math.round(g * 1000);
  // v0.5.11：空闲门静默期（毫秒）。存在理由见 config-schema.js 的
  // FIELD_DEFAULTS.idleGateQuietMs 考古注释（DSH 先 idle、139ms 后才投递结算消息）。
  // 缺省/非法 → 1500（不能因为老配置文件没有这个键就退回旧行为）。
  const qm = Number(raw.idleGateQuietMs);
  out.idleGateQuietMs = Number.isFinite(qm) && qm >= 0 && qm <= 60000 ? Math.round(qm) : 1500;
  // v0.4.7：跨会话冷却（0 = 关闭）
  const gc = Number(raw.globalCooldownSeconds);
  if (Number.isFinite(gc) && gc >= 0 && gc <= 3600) out.globalCooldownMs = Math.round(gc * 1000);

  // ── v0.4.2：音源与 TTS ───────────────────────────────────────────────────
  if (typeof raw.audioSource === 'string'
    && ['tts', 'bundled', 'system', 'custom', 'none'].includes(raw.audioSource)) {
    out.audioSource = raw.audioSource;
  }
  if (typeof raw.ttsVoice === 'string' && raw.ttsVoice.length <= 120) out.ttsVoice = raw.ttsVoice;
  const r = Number(raw.ttsRate);
  if (Number.isFinite(r) && r >= -10 && r <= 10) out.ttsRate = Math.round(r);
  // v0.6.0：播放通道（'auto' = 渲染进程优先 + 自动回退；'powershell' = 一键回滚）
  if (raw.audioTransport === 'powershell' || raw.audioTransport === 'auto') {
    out.audioTransport = raw.audioTransport;
  }

  // ── v0.4.16：语音包数字增益 ──────────────────────────────────────────────
  //
  // 为什么需要：实测 247 个语音包峰值 最小 24.7% / 中位 40.4% / 最大 84.4%，
  // 素材录得偏轻；而 MCI 音量上限只等于原始幅度 1.0 倍、**无法超过**，
  // 所以 GUI 拉满仍偏小。只能靠数字增益补（ps1 侧按峰值限幅，不会破音）。
  const vg = Number(raw.voiceGain);
  if (Number.isFinite(vg) && vg >= 1.0 && vg <= 4.0) out.voiceGain = Math.round(vg * 10) / 10;
  if (typeof raw.normalizeCustomAudio === 'boolean') out.normalizeCustomAudio = raw.normalizeCustomAudio;
  
  // ── v0.4.34：日志级别 ────────────────────────────────────────────────
  //
  // ⚠️ 漏过很多次的地方：新字段必须同时改 normalizeConfig + effectiveForClient。
  // 只改一边的话，写盘成功但读回是默认值 —— GUI 看着像"改了没生效"，
  // 而且极难查（磁盘上明明是对的）。
  if (raw.logLevel === 'info' || raw.logLevel === 'debug') out.logLevel = raw.logLevel;

  // v0.4.4：自定义音频。
  // 存储是扁平的 customFileDone / customFileFail / …（config-store 白名单只认标量），
  // 这里拼成 audio-source.js 期望的 `customFiles: { done: 路径 }`。
  // 路径合法性已在 config-store.sanitize 里校验过，这里只做搬运。
  const cf = {};
  for (const kind of ['done', 'fail', 'question', 'approval', 'blocked']) {
    const key = 'customFile' + kind.charAt(0).toUpperCase() + kind.slice(1);
    const val = raw[key];
    if (typeof val === 'string' && val.trim()) cf[kind] = val.trim();
  }
  out.customFiles = cf;

  // v0.4.5：按事件覆盖音源。
  // 存的是扁平键（kindSourceFail = 'system'），拼成 audio-source.js 期望的
  // `audioSourceByKind: { fail: 'system' }`。
  // 空串表示"跟随全局默认"，故不写进字典（保持配置最小）。
  const byKind = {};
  for (const kind of ['done', 'fail', 'question', 'approval', 'blocked']) {
    const key = 'kindSource' + kind.charAt(0).toUpperCase() + kind.slice(1);
    const val = raw[key];
    if (typeof val === 'string') {
      const s = val.trim().toLowerCase();
      if (s && ['tts', 'bundled', 'system', 'custom', 'none'].includes(s)) byKind[kind] = s;
    }
  }
  out.audioSourceByKind = byKind;

  // v0.4.8：TTS 自定义台词（每种事件可覆盖内置台词库）。
  // 存储是扁平键（ttsTextDone / ttsTextFail …），拼成 tts-lines.js 要的
  // `ttsTexts: { done: '...' }`。空值不写进字典（保持"用内置库"）。
  const tt = {};
  for (const kind of ['done', 'fail', 'question', 'approval', 'blocked']) {
    const key = 'ttsText' + kind.charAt(0).toUpperCase() + kind.slice(1);
    const val = sanitizeTtsText(raw[key]);
    if (val) tt[kind] = val;
  }
  out.ttsTexts = tt;

  // ── v0.4.9：每种音源的参数按事件覆盖 ─────────────────────────────────────
  //
  // 存储是扁平键（kindSystemSoundFail / kindTtsVoiceDone …），这里拼成
  // 几个按事件索引的字典，供 notify() 在组装参数时查。
  //
  // ⚠️ 只收**标量**（v0.4.13 修，2026-10-17 实测踩到）。
  //
  // merged 里的值可能来自 schema 层，而 schemastery 的值是 **ref 对象**
  // （带 .get() 的包装）。若原样存进字典，notify() 取出来就是对象，
  // 传给 PowerShell 变成字符串 "[object Object]" → SAPI 合成失败 → **没声音**。
  //
  // 实测症状：日志里 `voice=[object Object] rate=[object Object]`，
  // 播放静默失败，但弹窗正常 —— 极难从表象定位。
  //
  // 空串/缺失/无法解包的对象一律视为"跟随全局"，不写进字典。
  const scalarOf = (v) => {
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    if (typeof v === 'boolean') return v;
    if (v && typeof v === 'object') {
      // schemastery ref
      if (typeof v.get === 'function') {
        try {
          const inner = v.get();
          if (typeof inner === 'string') return inner;
          if (typeof inner === 'number') return Number.isFinite(inner) ? inner : undefined;
          if (typeof inner === 'boolean') return inner;
        } catch { /* ignore */ }
      }
      // 其它可解包对象
      if (typeof v.valueOf === 'function') {
        try {
          const inner = v.valueOf();
          if (inner !== v) {
            if (typeof inner === 'string') return inner;
            if (typeof inner === 'number') return Number.isFinite(inner) ? inner : undefined;
          }
        } catch { /* ignore */ }
      }
    }
    return undefined;
  };

  const pick = (prefix) => {
    const m = {};
    for (const kind of ['done', 'fail', 'question', 'approval', 'blocked']) {
      const key = prefix + kind.charAt(0).toUpperCase() + kind.slice(1);
      const val = scalarOf(raw[key]);
      if (val === undefined || val === '') continue;
      m[kind] = val;
    }
    return m;
  };
  out.kindTtsVoice = pick('kindTtsVoice');
  out.kindTtsRate = pick('kindTtsRate');
  out.kindVoiceMode = pick('kindVoiceMode');
  out.kindVoiceName = pick('kindVoiceName');
  out.kindSystemSound = pick('kindSystemSound');

  return out;
}

/**
 * 取某事件的按事件覆盖值；没有或不是标量就用全局默认。
 *
 * ⚠️ 必须只返回**标量**（v0.4.13）。
 * 上游 normalizeConfig 已经过滤过一遍，但这里再挡一层：
 * 一旦对象漏到 PowerShell 参数里就变成 "[object Object]"，
 * SAPI 会静默失败（弹窗有、没声音），极难排查。
 *
 * @param {object} map 按事件索引的字典（如 cfg.kindSystemSound）
 * @param {string} kind done|fail|question|approval|blocked
 * @param {*} fallback 全局默认值
 */
function kindOr(map, kind, fallback) {
  if (map && typeof map === 'object') {
    const v = map[kind];
    if (typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return fallback;
}

/** 去抖 Map 记账：写入前清 TTL 过期项；条目超上限时整体重置（宁可漏一条通知）。 */
function rememberAt(map, key, now) {
  if (map.size >= MAP_MAX) {
    for (const [k, at] of map) if (now - at > MAP_TTL_MS) map.delete(k);
    if (map.size >= MAP_MAX) map.clear();
  }
  map.set(key, now);
}

/**
 * 有界记账（值不是时间戳的 Map 用这个）。
 *
 * `lastTurnEnd`（值 {kind, at}）与 `prevStatus`（值 'idle'|'running'）不能走
 * `rememberAt`（它写的是裸时间戳），但同样必须防无限增长：宿主进程长期运行下，
 * 每个见过 turn/end 的会话、每个注册过的 agent 都会留一条，只增不减。
 *
 * 策略：超上限时先按 `tsOf` 清过期的，仍超就整体重置——与 `rememberAt` 同口径
 * （宁可漏一条通知，也不让内存无界增长）。
 *
 * @param map - 目标 Map。
 * @param key - 键。
 * @param value - 值。
 * @param now - 当前时间戳（ms）。
 * @param tsOf - 从值取时间戳（用于判过期）。
 */
function rememberBounded(map, key, value, now, tsOf) {
  if (map.size >= MAP_MAX) {
    for (const [k, v] of map) {
      const at = tsOf(v);
      if (typeof at === 'number' && now - at > MAP_TTL_MS) map.delete(k);
    }
    if (map.size >= MAP_MAX) map.clear();
  }
  map.set(key, value);
}

function isRecent(map, key, now, windowMs) {
  const at = map.get(key);
  return at !== undefined && now - at < windowMs;
}

/** 从 tool/call 的原始参数提取通知文案（arguments 是模型产出的 JSON 字符串；移植自旧插件 :117-131）。 */
function questionSummary(toolName, rawArgs) {
  let args = {};
  try { args = typeof rawArgs === 'string' ? (JSON.parse(rawArgs || '{}') || {}) : (rawArgs || {}); } catch { args = {}; }
  if (toolName === 'exit_plan_mode') {
    const plan = typeof args.plan === 'string' ? args.plan : '';
    const first = plan.split(/\r?\n/).find((l) => l.trim().length > 0) || '计划已就绪';
    return { text: first.replace(/^#+\s*/, '').slice(0, 60), hint: '（计划待审阅）' };
  }
  const qs = Array.isArray(args.questions) ? args.questions : [];
  const first = qs[0] || {};
  const text = String(first.question || first.header || '有事情需要你确认').replace(/\s+/g, ' ').slice(0, 60);
  const n = Array.isArray(first.options) ? first.options.length : 0;
  const more = qs.length > 1 ? `（共 ${qs.length} 个问题）` : '';
  return { text, hint: (n > 0 ? `（${n} 个选项）` : '') + more };
}

/** 子代判定：SessionHeader 线谱字段（typert.host.js:655，与旧插件同构）。 */
function isSubagent(session) {
  try {
    const h = session && session.header;
    if (!h) return false;
    // ⚠️ v0.4.59 修正（外部审阅指出的规则矛盾）：
    //
    //   原来只要有 `parentSession` 就判为子代理。但本文件 `isDescendantOf()`
    //   的注释已经写明：`sessions.fork` 产生的**普通分叉会话** header 也携带
    //   parentSession（指向源会话），而 origin 为空、是用户自己的顶层会话。
    //
    //   后果很实际：默认 `subagents: false` 时，普通 fork 会话的完成
    //   通知会被当成"子代理的"过滤掉 —— 用户会发现"我这个会话怎么不响"。
    //
    //   现在与 isDescendantOf 用同一套语义：只有 origin === 'subagent'
    //   或 delegationDepth > 0 才算子代理。
    //
    //   为什么不是简单删掉 parentSession：真正的子代理关系仍需识别，
    //   只是**不能仅凭** parentSession 认定 —— 它的语义是「派生自谁」，
    //   不是「谁的子代理」。
    if (h.origin === 'subagent') return true;
    if ((h.delegationDepth || 0) > 0) return true;
    return false;
  } catch {
    return false;
  }
}

function sessionKey(session) {
  try {
    return session && session.id !== undefined ? String(session.id) : '__unknown__';
  } catch {
    return '__unknown__';
  }
}

/** turn/end 的 reason.kind（reason 是 { kind } 对象；字符串仅作向前兼容容错）。 */
export function reasonKindOf(data) {
  return data && data.reason && typeof data.reason === 'object'
    ? String(data.reason.kind || '')
    : String((data && data.reason) || '');
}

/**
 * 一个活 agent 是否为 rootId 的**子代理后代**（任意深度）。
 *
 * 判定分两步，缺一不可：
 *  ① 沿 parentSession 链向上回溯到 rootId；
 *  ② 链上每一跳的 header.origin 必须是 'subagent'。
 *
 * 第 ② 步是必需的：`sessions.fork` 产生的分叉会话 header 也携带 parentSession
 * （指向源会话），但 origin 为空、且它是用户自己的**顶层**会话——把它算作后代会让
 * 主会话的完成通知被另一个独立会话拖住。dsh-messager 在 src/index.ts:278-280
 * 记录了同款结论。
 *
 * @param agent - 待判定的活 agent。
 * @param rootId - 根会话 id。
 * @param byId - id → agent 的索引（Map）。
 * @returns 是后代则为 true；任何异常一律返回 false（调用方按"非后代"处理）。
 */
export function isDescendantOf(agent, rootId, byId) {
  try {
    const root = String(rootId);
    let cur = agent;
    let hops = 0;
    while (cur && hops < MAX_ANCESTOR_HOPS) {
      const h = cur.session && cur.session.header;
      if (!h || h.origin !== 'subagent') return false;
      const p = h.parentSession;
      if (p === undefined || p === null) return false;
      if (String(p) === root) return true;
      cur = byId && typeof byId.get === 'function' ? byId.get(String(p)) : undefined;
      hops += 1;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 汇总"仍在飞"的工作（纯函数，便于单测）。
 *
 * 两路缺一不可（见文件头 continuable 说明）：
 *  - jobSnapshots：后台任务（one-shot 子代理、后台 pwsh、PTY），running/stopping 即在飞。
 *  - agentList：活 agent 中，本会话的**子代理后代**且 status==='running' 即在飞
 *    （覆盖不注册 job 的 continuable 子代理）。
 *
 * @param jobSnapshots - ctx.jobs.list(caller) 的结果。
 * @param agentList - ctx.agents.list() 的结果。
 * @param rootId - 根会话 id。
 * @returns 在飞项数组（空数组 = 工作树空闲）。
 */
export function collectInFlight(jobSnapshots, agentList, rootId) {
  const items = [];
  const jobs = Array.isArray(jobSnapshots) ? jobSnapshots : [];
  for (const j of jobs) {
    if (!j) continue;
    if (j.status === 'running' || j.status === 'stopping') {
      items.push({ kind: 'job', id: String(j.id), label: String(j.label || '') });
    }
  }
  const list = Array.isArray(agentList) ? agentList : [];
  const byId = new Map();
  for (const a of list) {
    if (a && a.id !== undefined) byId.set(String(a.id), a);
  }
  for (const a of list) {
    if (!a || a.id === undefined) continue;
    if (String(a.id) === String(rootId)) continue;
    if (a.status !== 'running') continue;
    if (!isDescendantOf(a, rootId, byId)) continue;
    items.push({ kind: 'subagent', id: String(a.id), label: '' });
  }
  return items;
}

/**
 * 静默期到点时的裁决（v0.5.11）。**纯函数**：不读时钟、不碰定时器、无副作用，
 * 所以 ABA 这类时序问题能直接断言"确切状态 + 确切原因码"，不必起真实流程。
 *
 * 返回（每个值都只有一种含义，便于日志与测试对账）：
 *   · 'quiet-disabled'    静默期被关（quietMs<=0）→ 立刻放行（v0.5.10 行为）
 *   · 'activity-since-arm' 起窗之后又有活动（含"瞬间启动又结束"的 ABA）→ 重新计时
 *   · 'still-busy'        窗口期内虽然没序号变化，但判据复查发现还忙 → 继续等
 *   · 'release'           期间无人动 + 判据全干净 → 允许播报
 *
 * ⚠️ 顺序不能换：必须先判"期间有没有动过"，再跑判据。反过来的话，
 * "动过但恰好又回到空闲"会被当成干净放行 —— 那正是误播本身。
 *
 * @param {{armedSeq:number, activitySeq:number, holdReason:string|null, quietMs:number}} a
 * @returns {'quiet-disabled'|'activity-since-arm'|'still-busy'|'release'}
 */
export function quietVerdict(a) {
  const s = a && typeof a === 'object' ? a : {};
  const quietMs = Number(s.quietMs);
  if (!Number.isFinite(quietMs) || quietMs <= 0) return 'quiet-disabled';
  if (Number(s.armedSeq) !== Number(s.activitySeq)) return 'activity-since-arm';
  if (s.holdReason) return 'still-busy';
  return 'release';
}

/**
 * 静默期"再等一会儿"的退避长度（v0.5.11）。**纯函数**。
 *
 * 为什么需要它：到点复查发现还忙（`still-busy`）时，不能"撂挑子等下一次事件"——
 * `gateHoldReason` 会返回 `agent-unavailable` / `turn-boundary-unavailable`
 * 这类"当下读不到"的原因，而它们**没有**必然后续边沿事件；一味等下去，
 * 这条挂起项就饿到 `onIdleGateTimeout`（默认 10 分钟）才动，而超时播的是
 * 进度提醒，不是完成语音。
 *
 * 上限 500ms 是"轮询的安全上限"（既不空转，也远小于静默期），
 * 且永远不超过 quietMs 本身 —— `quietMs=0` 时由调用方走即时放行分支。
 *
 * @param {number} quietMs 静默期长度
 * @returns {number} 退避毫秒数
 */
export function quietBackoffMs(quietMs) {
  const n = Number(quietMs);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(n, 500);
}

/**
 * 把内部 `cfg` 映射成**给前端看的 schema 形状**。
 *
 * ## 为什么需要这一层
 *
 * 内部 cfg 用"运行时友好"的字段名（`debounceMs` 毫秒、`voiceMode` 等），
 * 而设置页 GUI 收发的是 schema 键名（`debounceSeconds` 秒、`audioSource` …）。
 * 两者**不是同一个东西**。直接把 cfg 交给前端会导致：
 *
 *   cfg 里没有 `debounceSeconds` 这个键 → 前端从 DEFAULTS 展开拿到默认 60
 *   → 用户把冷却调成 0（关闭），界面却显示 60 秒，看起来"改了没生效"。
 *   （2026-10-17 用户实测反馈，就是这么来的。）
 *
 * ## 为什么不复用 config-store 的 describe()
 *
 * 那个函数只覆盖 v0.4.0 时代的 12 个老字段，此后新增的
 * audioSource / 冷却 / 台词 / 按事件覆盖全都没有 —— 复用它等于一半字段丢失。
 *
 * @param {object} c normalizeConfig 的产物
 * @returns {object} schema 键名的扁平对象
 */
export function effectiveForClient(c) {
  const g = c && typeof c === 'object' ? c : {};
  const out = {
    voice: g.voice,
    voiceMode: g.voiceMode,
    // v0.5.3：语音包语言，前端要靠它决定下拉列哪些音色。
    // 兜底 'ja'：老配置文件里没有这个键时，前端也要能确定显示哪一组。
    voiceLang: g.voiceLang === 'zh' ? 'zh' : 'ja',
    voiceName: g.voiceName,
    volume: g.volume,
    notifyOnComplete: g.notifyOnComplete,
    notifyOnError: g.notifyOnError,
    notifyOnSubagentError: g.notifyOnSubagentError,
    notifyOnMaxTokens: g.notifyOnMaxTokens,
    toastJumpSession: g.toastJumpSession,
    notifyOnBlocked: g.notifyOnBlocked,
    notifyOnAborted: g.notifyOnAborted,
    notifyOnApproval: g.notifyOnApproval,
    notifyOnQuestion: g.notifyOnQuestion,
    subagents: g.subagents,
    idleGate: g.idleGate,
    // v0.4.2+
    audioSource: g.audioSource,
    showToast: g.showToast,
    ttsVoice: g.ttsVoice,
    ttsRate: g.ttsRate,
    jumpWhenBackground: g.jumpWhenBackground,
    jumpWhenForeground: g.jumpWhenForeground,
    multiJumpRule: g.multiJumpRule,
    // v0.4.7 冷却：毫秒 → 秒（前端下拉用的是秒）
    debounceSeconds: Math.round((Number(g.debounceMs) || 0) / 1000),
    globalCooldownSeconds: Math.round((Number(g.globalCooldownMs) || 0) / 1000),
    // v0.5.11：空闲门静默期（毫秒，原样回传）
    //
    // ⚠️ 加配置项必须同时进三处，漏一处就是 v0.4.18 那个"用户改了不生效"：
    //   ① config-store.js 的 RULES（保存时不丢）② normalizeConfig（读进来）③ 这里（前端拿得到）
    idleGateQuietMs: Math.round(Number(g.idleGateQuietMs) || 0),
    // v0.6.0：播放通道（'auto' | 'powershell'）
    audioTransport: g.audioTransport === 'powershell' ? 'powershell' : 'auto',
    // v0.4.3
    devReload: g.devReload,
    // v0.4.34 日志级别（info / debug）
    logLevel: g.logLevel,
    // v0.4.16：音量增益与自定义音频标准化。
    //
    // ⚠️ 这两个漏过一次（v0.4.18 补）：normalizeConfig 里算了，
    // 但没加到这里，于是前端 GET 拿不到 → 滑杆显示默认值 →
    // 用户拖动后写回的又是旧值，看起来"增益功能不存在"。
    // 这是 v0.4.10 那个"内部形状未映射到前端形状"的同类错误 ——
    // 每加一个配置项，**必须同时**改 normalizeConfig 和 effectiveForClient。
    //
    // 兜底给 2.0：即使 g 里没有这个字段（老配置文件 / 只读场景），
    // 前端也要能确定滑杆位置。用 undefined 会让滑杆跳到最左端（1.0），
    // 看起来像"增益被关了"。
    voiceGain: typeof g.voiceGain === 'number' ? g.voiceGain : 2.0,
    normalizeCustomAudio: g.normalizeCustomAudio === true,
  };

  // 按事件的字典 → 扁平键（与 config-store 白名单的键名一致）
  //
  // ⚠️ 同 normalizeConfig 的道理：**只输出标量**。
  // 这里是"给前端看"的形状，若混进 ref 对象，前端写回时又会被存成对象，
  // 下一轮就变成 "[object Object]" 传给 PowerShell（v0.4.13 修）。
  const KINDS = ['done', 'fail', 'question', 'approval', 'blocked'];
  const cap = (k) => k.charAt(0).toUpperCase() + k.slice(1);
  const asScalar = (v) => {
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    if (typeof v === 'boolean') return v;
    if (v && typeof v === 'object') {
      if (typeof v.get === 'function') {
        try {
          const inner = v.get();
          if (typeof inner === 'string') return inner;
          if (typeof inner === 'number') return Number.isFinite(inner) ? inner : undefined;
          if (typeof inner === 'boolean') return inner;
        } catch { /* ignore */ }
      }
      if (typeof v.valueOf === 'function') {
        try {
          const inner = v.valueOf();
          if (inner !== v) {
            if (typeof inner === 'string') return inner;
            if (typeof inner === 'number') return Number.isFinite(inner) ? inner : undefined;
          }
        } catch { /* ignore */ }
      }
    }
    return undefined;
  };
  const dictToFlat = (dict, prefix) => {
    const d = dict && typeof dict === 'object' ? dict : {};
    for (const k of KINDS) {
      const val = asScalar(d[k]);
      if (val === undefined || val === '') continue;
      out[prefix + cap(k)] = val;
    }
  };
  dictToFlat(g.ttsTexts, 'ttsText');
  dictToFlat(g.kindTtsVoice, 'kindTtsVoice');
  dictToFlat(g.kindTtsRate, 'kindTtsRate');
  dictToFlat(g.kindVoiceMode, 'kindVoiceMode');
  dictToFlat(g.kindVoiceName, 'kindVoiceName');
  dictToFlat(g.kindSystemSound, 'kindSystemSound');
  dictToFlat(g.customFiles, 'customFile');

  // audioSourceByKind 两种形态都给：
  //   · 字典 —— GUI 的「按事件覆盖音源」读它（v0.4.10 的修法）
  //   · 扁平 kindSource<Kind> —— 与其它按事件键一致，便于排查
  const abk = (g.audioSourceByKind && typeof g.audioSourceByKind === 'object')
    ? { ...g.audioSourceByKind } : {};
  out.audioSourceByKind = abk;
  for (const k of KINDS) {
    if (abk[k] !== undefined && abk[k] !== '') out['kindSource' + cap(k)] = abk[k];
  }

  return out;
}

export function apply(ctx, config) {
  // 一次性自重载的实现槽（v0.4.57）。
  //
  // 路由在 apply 中段注册、实现挂在 apply 末尾 —— 用 let 槽连接两者。
  // （不写成函数声明：它包在 try 块里，严格模式下块级作用域不会提升出去。）
  let reloadOnce = null;
  // ── 配置来源（v0.4.0 起三源合并）──────────────────────────────────────────
  //
  // 优先级（后覆盖前）：
  //   1. DEFAULTS（本文件常量）
  //   2. schemastery Config 的解析值（官方 settings 层：schema 默认 + base(patch) + 用户设置页）
  //   3. `$DSH_HOME/storages/dsh-notify-say/config.json`（CLI 写的运行时覆盖）
  //
  // 为什么还要第 3 层：设置页要开浏览器点，而用户在终端里想「一条命令把音量调到 40」
  // 时 CLI 更顺手。CLI 走 config-store，GUI 走官方 settings，两者最终都汇进 cfg，
  // 不会出现「改了 A 但 B 还是旧值」的分裂。
  //
  // 稳定性设计（本插件的首要目标）：
  //   - 任一配置源出问题（缺 $DSH_HOME / JSON 坏 / schema 解析失败）都**静默降级**，
  //     插件行为退回到「只有 patch 配置」的旧语义，绝不因配置层导致通知丢失。
  //   - 整体 try/catch；失败时保持上一次成功解析的 cfg。
  //   - 只在生效值真的变化时记日志，避免每次播报刷屏。
  const rawConfig = config;
  const schemaLog = (m) => console.warn('[dsh-notify-say] ' + m);

  /**
   * 从 schema 化 config 取普通值；拿不到就退回原始对象。
   *
   * ⚠️ 注意（独立审查 B4 指出的注释与实现不符，已更正）：
   * `readSchemaConfig` 对**缺失的键会填 FIELD_DEFAULTS**，因此它**恒返回 12 个键**，
   * 不能用「键数 > 0」判断 schema 是否真的生效 —— 那样判定恒真。
   *
   * 正确的判据：看**输入对象本身**是否带 schemastery ref（字段有 `.get` 方法）。
   * 官方语义下 `apply(ctx, config)` 收到的是 ref；未接管时是普通值。
   */
  function entryFromSchema() {
    try {
      if (rawConfig == null || typeof rawConfig !== 'object') return null;
      // 以「输入里有没有 ref」判断，而不是看输出键数
      const looksLikeRefs = Object.keys(FIELD_DEFAULTS).some((k) => {
        const slot = rawConfig[k];
        return slot != null && typeof slot === 'object' && typeof slot.get === 'function';
      });
      if (!looksLikeRefs) return null;
      return readSchemaConfig(rawConfig);
    } catch {
      return null;
    }
  }

  // 初始值：**必须走 resolveEffectiveConfig**，不能直接 normalizeConfig。
  // 原因：refreshConfig() 若在 entryFromSchema()/readConfig() 处抛异常，
  // catch 分支会「保持上一次的值」—— 而首次调用时「上一次的值」就是这行。
  // 于是老用户（中文音色、无 voiceLang）会在整个进程生命周期里停在未迁移状态，
  // 随机池只剩日语 —— 恰是本次要修的那个回退。
  // refreshConfig() 正常返回时这行会被立即覆盖，所以正常路径没有行为变化。
  let cfg = resolveEffectiveConfig(normalizeConfig(config), config, {});
  let lastConfigSig = '';

  /** 重新解析生效配置；失败时保持上一次的值（绝不因配置问题丢通知）。 */
  function refreshConfig() {
    try {
      // 第 2 层：官方 settings（schema）解析值
      const fromSchema = entryFromSchema();
      // 第 3 层：CLI 写的 storages 覆盖
      const file = readConfig();
      const fileValues = file.ok ? file.value : {};

      // 解析逻辑抽到模块级的 computeEffectiveConfig（见下），
      // 这样测试能**直接驱动生产代码本身**，而不必对着源码写正则。
      cfg = computeEffectiveConfig(rawConfig, fromSchema, fileValues);

      const sig = JSON.stringify(describeConfig(cfg));
      if (sig !== lastConfigSig) {
        lastConfigSig = sig;
        if (!file.ok && file.reason !== 'no-home') {
          console.warn(`[dsh-notify-say] config.json 读取失败(${file.reason})，已回退到上层配置`);
        }
        console.log(`[dsh-notify-say] config: voice=${cfg.voice} mode=${cfg.voiceMode} name=${cfg.voiceName} vol=${cfg.volume}`);
      }
    } catch (e) {
      console.warn('[dsh-notify-say] refreshConfig failed, keeping previous config: '
        + String((e && e.message) || e));
    }
  }
  refreshConfig();

  // 会话状态桥实例：notify() 往里写，HTTP route 往外读（client 半侧消费）。
  // 进程内、不落盘 —— 重启后"刚才那条通知"就该失效，这是正确语义。
  const bridge = createSessionBridge();
  // ⚠️ v0.4.63：长轮询的挂起响应必须在卸载时结束，
  // 否则热重载会留下永远等不到响应的连接（2026-10-18 那次崩溃同源）。

  // 配置 route：client 设置卡片读写音量/音色/开关。
  // onChanged 立刻重读配置 —— 让"点一下即生效"成立，不必重启宿主。
  const configRoute = createConfigRoute({
    // 配置变了 → 重读 + **同步协议状态**。
    //
    // ⚠️ v0.4.84：原来这里只调 refreshConfig()，于是用户在设置页
    // 切换「点击通知跳到对应会话」后，**注册表根本没动** ——
    // 必须重启 DSH 才生效。而 README 写的是"立即生效"。
    //
    // 2026-10-20 真机验收实测：开→关→热重载，注册表仍在（本应被删），
    // 日志里也没有新的 [jump-proto]。查下来 syncJumpProtocol()
    // 只在 apply() 里被调用过一次。
    //
    // 现在配置一改就同步：开=注册、关=清理，才是真正的"立即生效"。
    onChanged: () => {
      try { refreshConfig(); } catch { /* ignore */ }
      try { syncJumpProtocol(); } catch { /* 协议同步失败不影响其余配置生效 */ }
    },
    // 返回**给前端看的形状**（schema 键名），而不是内部 cfg。
    //
    // ⚠️ 这里踩过一个隐蔽的坑（2026-10-17）：
    // 原先直接返回 `cfg`，但 cfg 是 normalizeConfig 的产物，用的是**内部字段名**：
    //   cfg.debounceMs = 0（毫秒）
    // 而前端读的是 schema 键名 `debounceSeconds`。cfg 里**没有**这个键，
    // 于是从 DEFAULTS 展开拿到 60 —— 用户把冷却调成 0（关闭），
    // 界面却显示 60 秒，看起来"改了没生效"。
    //
    // 正确做法：把内部值**映射回 schema 形状**再给前端。
    // 注意必须把当前 cfg 传进去 —— 写成 effectiveForClient() 会得到全空对象，
    // 表现为"所有设置都显示默认值"（2026-10-17 实测踩到）。
    getEffective: () => effectiveForClient(cfg),
    // v0.5.6（issue #3）：把"已下载的音色"一并告诉前端。
    //
    // 为什么放在 config 响应里：音色下拉在设置页首屏就要画出来，
    // 而语音包清单（要联网）是用户点「加载列表」才拉的。
    // 下拉需要的只是"本地额外装了哪些"，读一次用户目录即可，零网络。
    getInstalled: () => installedVoiceKeys(),
  });
  // 语音包管理路由（v0.4.31）。
  //
  // 单独一个模块而不是塞进这里：下载安装是唯一写盘的功能，
  // 集中在一处便于安全审查（zip-slip / SSRF / 哈希校验都在那边）。
  const voicePackRoute = createVoicePackRoute({ pluginRoot: PLUGIN_ROOT, logger: console });

  // 渲染进程播放通道（v0.6.0）。
  //
  // 只做"把字节送到前端 + 没人接就回退"这一件事；选音与增益仍由
  // `dsh-notify.ps1 -Resolve` 决定 —— 选音规则只准存在一份。
  const audioChannel = createAudioChannel({ log: (m) => appendNotifyLog(m) });

  // 临时 wav 兜底清扫（v0.6.0）：`-Resolve` 超时被杀、或插件在文件刚写完
  // 就被卸载，都会把 dsh-gain-* / dsh-tts-* 留在 %TEMP%。只清一小时前的
  // ——正在播的那条绝不动。
  try {
    const tdir = tmpdir();
    for (const name of readdirSync(tdir)) {
      if (!/^dsh-(gain|tts)-[0-9a-z]+\.wav$/i.test(name)) continue;
      const p = join(tdir, name);
      try {
        if (Date.now() - statSync(p).mtimeMs > 3600 * 1000) unlinkSync(p);
      } catch { /* 被占用/已删，下一轮再说 */ }
    }
  } catch { /* 目录不可读就算了，不影响播放 */ }

  let pendingSpawns = 0;
  const lastTurnNotify = new Map(); // sessionId -> ts  // 跨会话冷却用：**任意**会话最近一次播报的时刻。
  // 与 lastTurnNotify（按会话）是不同粒度，故单独一个标量而非 Map。
  let lastAnyNotifyAt = 0;
  const approvalSeen = new Map();   // 'id:<approvalId>' | 'session:<sid>|<tool>' -> ts
  const questionSeen = new Map();   // 'sid:callId' -> ts（同一提问只提醒一次；answered 即清）
  const lastTurnEnd = new Map();    // sessionId -> { kind, at }（agent/status idle 时取用）
  const pendingDone = new Map();    // sessionId -> { session, psKind, title, body, timer, inflight, quietTimer, quietResets }
  const prevStatus = new Map();     // agentId -> 'idle' | 'running'（边沿判定）
  /**
   * 单调活动序号（v0.5.11，静默期的 Epoch）。
   *
   * 只在"状态真的变了"的边沿递增，绝不读墙钟。原因：静默窗要判的是
   * 「从起窗到现在有没有人动过」，用 `Date.now()` 差值算剩余时间会受
   * 系统时间跳变影响（NTP 校时/用户改表 → 窗口瞬间到期或永不到期），
   * 而序号只有单调递增一个方向，ABA 也能被识别（seq 变了 = 期间动过）。
   */
  let activitySeq = 0;
  /** fire-and-forget spawn：并发上限 + 超时 taskkill /T 兜底（旧插件实测加固的移植）。 */
  /**
   * 播放失败后是否已经降级过一次蜂鸣。
   *
   * 只降级**一次**：如果连蜂鸣都失败，说明环境本身有问题，
   * 反复重试只会变成通知风暴。插件卸载时重置。
   */
  let beepFallbackUsed = false;

  /**
   * 启动一次通知脚本，并**记录它的真实结果**（第 2 批 P1）。
   *
   * ## 为什么必须记录退出码
   *
   * 原先 stdio 全 ignore、只听 exit 事件减计数，于是：
   *   · PowerShell 起不来 → 只有 console.warn（notify.log 里查不到）
   *   · ps1 内部报错退出非 0 → 完全不知道
   * 用户侧表现就是「有时候没声音，但不知道为什么」。
   *
   * ## 三态留痕
   *   [play-start] 已启动（含 pid）
   *   [play-ok]    退出码 0
   *   [play-fail]  非零退出 / 启动失败 / 超时被杀（含 stderr 尾部）
   *
   * @param {string[]} args PowerShell 参数
   * @param {string} [psKind] 通知种类，仅用于日志定位
   */
  function spawnNotify(args, psKind) {
    const which = (() => {
      try {
        const i = args.indexOf('-File');
        return i >= 0 ? String(args[i + 1]).split(/[\\/]/).pop() : '?';
      } catch { return '?'; }
    })();

    if (pendingSpawns >= MAX_PENDING_SPAWNS) {
      // 并发上限：必须能定位"是哪条通知被丢了"，否则用户只会觉得"插件没反应"。
      appendNotifyLog(`[spawn-drop] ${which} kind=${psKind || '?'} `
        + `pending=${pendingSpawns}/${MAX_PENDING_SPAWNS} (throttled)`);
      console.warn(`[dsh-notify-say] spawn throttled (${pendingSpawns} pending), dropping ${which}`);
      return;
    }

    pendingSpawns += 1;
    let child;
    try {
      // stderr 收成 pipe：非零退出时能看到 ps1 的真实报错。
      // stdout 仍 ignore —— 脚本不往 stdout 输出有意义内容，收了也没用。
      child = spawn(POWERSHELL_EXE, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (e) {
      pendingSpawns -= 1;
      appendNotifyLog(`[play-fail] ${which} kind=${psKind || '?'} spawn-threw: `
        + String((e && e.message) || e).slice(0, 200));
      console.warn('[dsh-notify-say] spawn failed: ' + String((e && e.message) || e));
      fallbackBeep(which);
      return;
    }

    // 收集 stderr 尾部（限 2KB，防止脚本刷屏把日志撑爆）。
    let stderrTail = '';
    try {
      if (child.stderr) {
        child.stderr.on('data', (buf) => {
          try {
            stderrTail = (stderrTail + String(buf)).slice(-2048);
          } catch { /* 收集失败不影响主流程 */ }
        });
      }
    } catch { /* stderr 不可用就算了 */ }

    let settled = false;
    let timedOut = false;
    const settle = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      pendingSpawns = Math.max(0, pendingSpawns - 1);
      // 只有真的异常才写日志：正常退出（code 0）不刷屏，
      // 但保留 [play-ok] 供 detail 级排查。
      if (timedOut) {
        appendNotifyLog(`[play-fail] ${which} kind=${psKind || '?'} timeout `
          + `after ${SPAWN_TIMEOUT_MS}ms`);
        fallbackBeep(which);
      } else if (code === 0) {
        appendNotifyLog(`[play-ok] ${which} kind=${psKind || '?'}`);
      } else {
        const tail = stderrTail ? ' stderr=' + stderrTail.replace(/\s+/g, ' ').slice(-300) : '';
        appendNotifyLog(`[play-fail] ${which} kind=${psKind || '?'} `
          + `exit=${code === null ? 'null' : code}${signal ? ' sig=' + signal : ''}${tail}`);
        fallbackBeep(which);
      }
    };

    const killer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* ignore */ }
      try {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } catch { /* ignore */ }
      setTimeout(() => settle(null, 'SIGKILL'), 1000);
    }, SPAWN_TIMEOUT_MS);

    child.once('exit', (code, signal) => settle(code, signal));
    child.once('error', (err) => {
      appendNotifyLog(`[play-fail] ${which} kind=${psKind || '?'} error: `
        + String((err && err.message) || err).slice(0, 200));
      fallbackBeep(which);
      settle(null, null);
    });
  }

  /**
   * 播放失败时**降级一次**系统蜂鸣（第 2 批 P1）。
   *
   * 约束：
   *   · 只降级一次（beepFallbackUsed 标志），**绝不重试** —— 否则
   *     播放器持续失败时会变成通知风暴
   *   · 异步、忽略结果（蜂鸣也失败就真没办法了）
   *
   * ## v0.5.3：必须显式禁止在测试环境真蜂鸣
   *
   * 原来这里没有任何环境守卫，唯一"让测试不出声"的机制是调用方传
   * `-Volume 0` 给 ps1 —— 而蜂鸣是 **JS 层**的 `[console]::beep`，
   * 完全不经过 ps1，`-Volume 0` 管不到它。
   *
   * 目前测试没吵到人，靠的是一个**巧合**：测试把 `SystemRoot` 指到
   * `Z:\__no_such_root__`，于是 `POWERSHELL_EXE` 也失效，蜂鸣 spawn 失败。
   * 但那是"顺带没响"，不是约定 —— 与 wiring.test.mjs:41 里记录的
   * `cleanupLegacyProtocols()` 是同一类隐患：桩一改（比如改成走 PATH 查找
   * powershell.exe），测试就会开始在用户桌面上滴滴响，而没人会想到是测试。
   *
   * 所以这里按既有的 `__STUB_CHILD_PROCESS__` 约定显式挡一道。
   *
   * @param {string} which 失败的脚本名，仅用于日志
   */
  function fallbackBeep(which) {
    if (beepFallbackUsed) return;
    beepFallbackUsed = true;
    // 测试环境：loader 已把 child_process 换桩，真蜂鸣只会在用户耳边响，
    // 对断言毫无帮助。保留日志行，便于测试仍能观察到"降级发生过"。
    const stubbed = typeof globalThis !== 'undefined' && globalThis.__STUB_CHILD_PROCESS__ === true;
    appendNotifyLog(`[play-fallback] beep once after ${which} failed${stubbed ? ' (stubbed: not played)' : ''}`);
    if (stubbed) return;
    try {
      const c = spawn(POWERSHELL_EXE, [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', '[console]::beep(880,300)',
      ], { stdio: 'ignore', windowsHide: true });
      c.once('error', () => { /* 蜂鸣也失败就算了 */ });
    } catch { /* 同上 */ }
  }

  /** 跑 TTS 脚本（与 spawnNotify 共用并发上限与超时兜底）。 */
  function spawnTts(args, psKind) {
    spawnNotify(args, psKind);
  }

  /**
   * 某个事件在 TTS 音源下该念什么台词。
   *
   * 委托给 lib/tts-lines.js（多条随机 + 用户自定义 + 文本校验），
   * 这样"念什么"这件事有独立的一方负责，也能单独测。
   *
   * @param {string} psKind done | fail | chime | approval | question
   * @returns {string}
   */
  function ttsTextFor(psKind) {
    const kind = audioKindOf(psKind) || 'done';
    try {
      return pickTtsText(kind, cfg);
    } catch {
      // 台词选取失败不该让整条通知哑掉，退回简短兜底
      return '有新消息';
    }
  }

  /** 组参并 spawn 本包自带 ps1（Toast + 可选语音；kind 决定语句池/chime）。 */
  /**
   * @param {string} psKind done | fail | chime | approval | question
   * @param {string} title
   * @param {string} body
   * @param {object} [session] 可选；用于记录"这条通知属于哪个会话"，
   *   client 半侧在窗口被唤到前台时据此跳转。缺失则该能力不生效，通知本身不受影响。
   */
  // ── 渲染进程播放通道（v0.6.0）──────────────────────────────────────────
  //
  // 为什么不在这里重新实现"选哪个 wav"：`dsh-notify.ps1` 里的
  // `Pick-RandomWav*` 那一套（音色/语言/模式/事件池/自定义路径）有 200 行，
  // 且被大量测试锁着。在 JS 里重写一份，两套规则必然漂移。
  //
  // 所以给 ps1 加了 `-Resolve`：照常选音 + 应用增益，只把结果打印出来就退出
  // —— 不播、不弹窗、不写 toast 日志。JS 拿到绝对路径后把字节喂给渲染进程。
  // 增益烘进临时 wav（与现版逐字节一致），前端只负责 `audio.volume`。

  /** 解析选音的超时。ps1 启动 ~300ms + 增益，8s 足够，超时即回退。 */
  const RESOLVE_TIMEOUT_MS = 8000;

  /**
   * 跑一次 ps1 并收 stdout（`-Resolve` 用）。
   *
   * 不复用 `spawnNotify`：那个把 stdout 设成 ignore 且只关心退出码，
   * 而这里**唯一的信息就在 stdout 上**（RESOLVE=… 三行）。
   */
  function spawnResolve(args) {
    return new Promise((resolve) => {
      let out = '';
      let child;
      // 与 spawnNotify 共用同一份并发预算：选音进程同样是 powershell，
      // 不设上限时机器一卡就会雪崩（每条通知多一个常驻子进程）。
      if (pendingSpawns >= MAX_PENDING_SPAWNS) {
        appendNotifyLog(`[spawn-drop] resolve pending=${pendingSpawns}/${MAX_PENDING_SPAWNS} (throttled)`);
        resolve('');
        return;
      }
      try {
        child = spawn(POWERSHELL_EXE, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      } catch {
        resolve('');
        return;
      }
      pendingSpawns += 1;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killer);
        pendingSpawns = Math.max(0, pendingSpawns - 1);
        resolve(out);
      };
      const killer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        finish();
      }, RESOLVE_TIMEOUT_MS);
      try { killer.unref && killer.unref(); } catch { /* ignore */ }
      try {
        if (child.stdout) child.stdout.on('data', (b) => { out = (out + String(b)).slice(-8192); });
        // stderr 必须读掉：不读会让管道写满、子进程卡住直到超时。
        if (child.stderr) child.stderr.on('data', () => {});
      } catch { /* 管道不可用就走超时 */ }
      child.once('exit', finish);
      child.once('error', finish);
    });
  }

  /** 解析 `RESOLVE=…` / `RESOLVE_KIND=…` / `RESOLVE_GAINED=0|1` 三行。 */
  function parseResolve(out) {
    const grab = (key) => {
      const m = new RegExp('^' + key + '=(.*)$', 'm').exec(String(out || ''));
      return m ? m[1].trim() : '';
    };
    return {
      file: grab('RESOLVE'),
      kind: grab('RESOLVE_KIND'),
      gained: grab('RESOLVE_GAINED') === '1',
    };
  }

  /** 自定义音频的 Content-Type（与现版一致：按扩展名，不转码）。 */
  function contentTypeOf(file) {
    const ext = String(file || '').toLowerCase().split('.').pop();
    if (ext === 'mp3') return 'audio/mpeg';
    if (ext === 'm4a' || ext === 'mp4') return 'audio/mp4';
    if (ext === 'ogg' || ext === 'oga') return 'audio/ogg';
    if (ext === 'flac') return 'audio/flac';
    return 'audio/wav';
  }

  /**
   * 走渲染进程播放（失败/超时自动回退 PowerShell）。
   *
   * 分工（用户 2026-11-27 指定）：
   *   · Toast 单独 spawn（带 `-NoSound`）—— 声音已经不走 ps1 了，
   *     再让它出声就是双重播放。
   *   · `system` 与 `chime` 不是 wav 文件，压根不进这里（见 notify 的分流）。
   *   · 需要增益时 ps1 产出临时 wav，字节读完即删；不需要增益时直接读原文件。
   */
  async function playThroughChannel(j) {
    const { psKind, title, body, detail, notifySid, wantToast, source, aKind } = j;

    // Toast 与声音彻底解耦：先弹窗（不阻塞），声音交给渲染进程。
    if (wantToast) {
      try {
        spawnNotify(notifyArgs(psKind, title, body, true, false, detail, notifySid), psKind);
      } catch { /* 弹窗失败绝不影响声音 */ }
    }

    let file = '';
    let fileToDelete = '';
    let contentType = 'audio/wav';
    let fallback = () => {};

    if (source === 'tts') {
      const line = ttsTextFor(psKind);
      const vVoice = kindOr(cfg.kindTtsVoice, aKind, cfg.ttsVoice);
      const vRate = kindOr(cfg.kindTtsRate, aKind, cfg.ttsRate || 0);
      const tmp = join(tmpdir(), `dsh-tts-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}.wav`);
      const base = [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File',
        TTS_PATH, '-Text', line, '-Volume', String(cfg.volume), '-Rate', String(vRate),
      ];
      if (vVoice) base.push('-VoiceName', vVoice);
      const r = parseResolve(await spawnResolve(base.concat(['-OutFile', tmp])));
      file = r.file || tmp;
      fileToDelete = file;   // TTS 的 wav 一定是我们的临时文件
      // 回退：走原路径（TTS 自己 MCI 播），零改动。
      fallback = () => { try { spawnTts(base.slice(), psKind); } catch { /* ignore */ } };
    } else if (source === 'custom') {
      const kind = audioKindOf(psKind);
      const cf = resolveCustomFile(kind, cfg);
      const a = baseNotifyArgs(psKind, title, body, false, true, detail, notifySid);
      a.push('-CustomFile', cf);
      // 用户素材默认不擅自改响度，只有显式开了标准化才加 -Gain（与现版一致）
      if (cfg.normalizeCustomAudio === true) {
        a.push('-Gain', String(Number(cfg.voiceGain) > 1 ? Number(cfg.voiceGain) : 2.0));
      }
      const r = parseResolve(await spawnResolve(a.concat(['-Resolve'])));
      if (!r.file) {
        // ps1 的闸门把这份自定义音频判成"不能播"（超过 8MB / 30 秒，
        // 或文件不存在）—— 它只打印 `RESOLVE=` 和 `RESOLVE_KIND=chime`，
        // 真实行为是换系统提示音。**不能**在这里回落到 `cf`：那会把
        // 一个超长/超大的原文件整段读进内存再喂给 <audio>，既没有中途
        // 停止手段，也和 v0.5.11 的听感不一致。与 bundled 分支同口径。
        appendNotifyLog(`[play] via=ps-fallback reason=no-file kind=${aKind} source=custom`);
        try { spawnNotify(a.slice(), psKind); } catch { /* ignore */ }
        return;
      }
      file = r.file;
      // 只有增益产物才是"要删的临时文件"，用户原文件绝不能删。
      if (r.gained) fileToDelete = file;
      contentType = contentTypeOf(file);
      fallback = () => { try { spawnNotify(a.slice(), psKind); } catch { /* ignore */ } };
    } else {
      // bundled：让 ps1 选音（可能产出增益后的临时 wav）
      const a = notifyArgs(psKind, title, body, false, true, detail, notifySid);
      const r = parseResolve(await spawnResolve(a.concat(['-Resolve'])));
      if (!r.file) {
        // chime / 选音失败：本来就没有文件可喂，直接回原路，绝不静默。
        appendNotifyLog(`[play] via=ps-fallback reason=no-file kind=${aKind} source=bundled`);
        try { spawnNotify(a.slice(), psKind); } catch { /* ignore */ }
        return;
      }
      file = r.file;
      if (r.gained) fileToDelete = file;
      fallback = () => {
        try { spawnNotify(notifyArgs(psKind, title, body, false, true, detail, notifySid), psKind); } catch { /* ignore */ }
      };
    }

    try {
      await audioChannel.play({
        file,
        contentType,
        fileToDelete,
        volume: cfg.volume,
        meta: { kind: aKind, source },
        fallback,
      });
    } catch (e) {
      // 通道自身炸了（不该发生）：按回退处理，宁可多响一次也不要静默。
      appendNotifyLog(`[play] channel-threw: ${String((e && e.message) || e).slice(0, 160)}`);
      try { fallback(); } catch { /* ignore */ }
    }
  }

  function notify(psKind, title, body, session) {
    // 播报前现读配置：让 CLI/GUI 改的值立即生效，无需重载宿主。
    refreshConfig();

    // v0.4.70：本条通知对应的会话 id（精准跳转用）。
    // 只在开关开着且协议已注册时才会被 args 构造器采用；否则降级 dsh://open。
    const notifySid = session && session.id !== undefined ? String(session.id) : '';

    // Toast 第三行：项目名（v0.4.62）。
    //
    // 只在"标题里没包含它"时才给 —— 否则标题已经是「优化0Deepseek…」，
    // 再显示一遍 "0Deepseek" 就是重复。单项目用户看不到第三行，
    // 多项目并行的用户能靠它区分。
    let detail = projectNameOf(session);
    if (detail && String(title || '').toLowerCase().includes(detail.toLowerCase())) detail = '';

    // 记下"这条通知属于哪个会话"，供 client 半侧点击后跳转。
    // 失败绝不影响通知本身（跳会话是增强功能）。
    try {
      const sid = session && session.id !== undefined ? String(session.id) : '';
      if (sid) bridge.setLast(sid);
    } catch { /* ignore */ }

    // ── 音源分流（v0.4.2）────────────────────────────────────────────────
    //
    // 判定交给 lib/audio-source.js（纯函数，17 条测试锁住），
    // 这里只负责"按结果执行"。核心是：**任何配置组合都要有合理结果**，
    // 拿不到就按回退链降级，绝不静默。
    //
    // 注意初值：不能用 `let source = 'tts'` 这种"看着像默认值"的写法 ——
    // 它在 try 成功时被覆盖、失败时被设成 none，永远用不到，属于误导性死代码
    // （自测时发现：把它改成 'bundled' 所有测试仍然全绿，说明它确实无效）。
    // 这里显式用 null 表示"还没有结论"，解析失败才落到 none。
    let source = null;
    try {
      const kind = audioKindOf(psKind);
      const eff = effectiveSource(resolveSource(kind, cfg), {
        hasTtsVoice: true,                    // Windows 一定有可用 TTS（实测）
        hasBundledVoice: hasVoiceLine(psKind),
        hasCustomFile: !!resolveCustomFile(kind, cfg),
      });
      source = eff.source;
      if (eff.fellBack) {
        appendNotifyLog(`[audio] fallback ${eff.from}->${eff.source} kind=${psKind}`);
      }
    } catch {
      source = 'none';   // 解析本身炸了：宁可只弹窗，也不要乱出声
    }

    // 只有 "none" 是完全不出声；其余都走声音路径
    const wantSound = cfg.voice && source !== 'none';
    // ── 视觉通道（v0.4.59）────────────────────────────────────────────
    //
    // ⚠️ 外部审阅指出的真 bug：原来只有 TTS 分支看 `cfg.showToast`，
    // 语音包 / 系统提示音 / 自定义音频一律让 ps1 弹窗 —— 于是
    // **关掉「显示通知弹窗」后仍会弹 Toast**。
    //
    // 更糟的是两个都关的情况：旧代码照样 spawn ps1（带 -NoSound），
    // ps1 在没有 -SoundOnly 时就会弹窗 —— 与设置页刚加的
    // 「弹窗与声音都已关闭」提示直接矛盾。
    //
    // 现在把两个通道彻底分开：
    //   wantToast=false → 传 -SoundOnly（只出声，不弹窗）
    //   wantSound=false → 传 -NoSound（只弹窗，不出声）
    //   两个都 false   → **不启动任何进程**
    //
    // 默认值按 `!== false` 判：配置缺字段时按"开着"处理，
    // 不会因为 undefined 把用户的提醒静默掉。
    const wantToast = cfg.showToast !== false;
    if (!wantToast && !wantSound) {
      appendNotifyLog('[skip] 弹窗与声音都已关闭，不启动提醒进程');
      return;
    }
    // 本事件对应的事件类（done/fail/question/approval/blocked），
    // 用于查"按事件覆盖"的各种参数（v0.4.9）。
    const aKind = audioKindOf(psKind) || 'done';

    // 可观测性（v0.4.12）：每一步决策都留痕。
    // 2026-10-17 排查"有弹窗没声音"时，最耗时的就是分不清
    // "没走 TTS 分支" 还是 "走了但 spawn 被丢"，因为两种情况的日志一样。
    appendNotifyLog(`[plan] kind=${aKind} source=${String(source)} `
      + `audioSource=${String(cfg.audioSource)} voice=${String(cfg.voice)} `
      + `wantSound=${String(wantSound)} showToast=${String(cfg.showToast)} `
      + `byKind=${JSON.stringify(cfg.audioSourceByKind || {})}`
        // v0.4.65：带上会话 id —— 之前没有，"哪个会话播的"只能靠时间猜。
        // 空闲门 flush 与直接播报都走到这里，演示也用它当证据。
        + ` sess=${sessionKey(session)}`);

    // ── 播放通道分流（v0.6.0）────────────────────────────────────────────
    //
    // 满足三个条件才走渲染进程：
    //   ① 开关是 auto（`powershell` = 一键回滚到今天的行为）
    //   ② 至少有一个 GUI 窗口连着 SSE（没有就没什么可推的，别白跑 ps1）
    //   ③ 音源是"文件"（tts / custom / bundled）；`system` 与 chime 不是 wav
    //      —— 它们继续走 ps1，这是用户 2026-11-27 明确指定的分工。
    //
    // ② 这条也是性能护栏：窗口关着时**完全不产生额外进程**，
    // 与 v0.5.11 的行为逐字节相同（只是多一行日志）。
    const channelConnected = audioChannel.stats().connected;
    const wantChannel = cfg.audioTransport !== 'powershell'
      && channelConnected > 0
      && source !== 'system' && source !== 'none';

    if (wantSound && wantChannel) {
      // 不 await：播报链路一直是 fire-and-forget，等它会拖慢事件回调。
      playThroughChannel({ psKind, title, body, detail, notifySid, wantToast, source, aKind })
        .catch((e) => {
          appendNotifyLog(`[play] channel-failed: ${String((e && e.message) || e).slice(0, 160)}`);
        });
      return;
    }
    if (wantSound && cfg.audioTransport !== 'powershell' && source !== 'system' && source !== 'none') {
      // 没有窗口在听 → 明确记一条，否则"为什么走了 PowerShell"又要靠猜。
      appendNotifyLog(`[play] via=ps-fallback reason=no-client kind=${aKind} connected=0`);
    }

    // ── TTS：零下载也能说话 ──────────────────────────────────────────────
    if (wantSound && source === 'tts') {
      const line = ttsTextFor(psKind);
      // 发音人与语速都可以按事件覆盖（kindTtsVoice*/kindTtsRate*），
      // 没设就用全局 ttsVoice / ttsRate。
      const vVoice = kindOr(cfg.kindTtsVoice, aKind, cfg.ttsVoice);
      const vRate = kindOr(cfg.kindTtsRate, aKind, cfg.ttsRate || 0);

      // 可观测性（v0.4.12）：把"决定走 TTS"和"槽位是否够"写进日志。
      // 2026-10-17 排查"弹窗有、声音无"时，卡在无法区分
      //   (a) 没走 TTS 分支  (b) 走了但 spawn 被并发上限丢弃
      // 这两者日志长得一样（都只有一条 [toast]），只能靠猜。
      // 现在明确留痕，后续同类问题一眼可辨。
      // 台词正文只在 debug 档记录。
      // 默认档只留长度 —— 足以判断"有没有走到 TTS"，但不泄露用户写了什么。
      if (isDebug(cfg.logLevel)) {
        appendNotifyLog(`[tts-plan] text=${JSON.stringify(line)} voice=${vVoice || '(默认)'} rate=${vRate} pending=${pendingSpawns}/${MAX_PENDING_SPAWNS}`, { detail: true });
      } else {
        appendNotifyLog(`[tts-plan] text=${redactText(line, cfg.logLevel)} voice=${vVoice || '(默认)'} rate=${vRate} pending=${pendingSpawns}/${MAX_PENDING_SPAWNS}`);
      }

      const ttsArgs = [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File',
        TTS_PATH, '-Text', line, '-Volume', String(cfg.volume), '-Rate', String(vRate),
      ];
      if (vVoice) ttsArgs.push('-VoiceName', vVoice);
      // TTS 自己会出声，所以 notify.ps1 只负责弹窗（-NoSound）
      if (wantToast) spawnNotify(notifyArgs(psKind, title, body, true, false, detail, notifySid), psKind);
      spawnTts(ttsArgs, psKind);
      return;
    }

    // ── 系统提示音：不碰语音池 ───────────────────────────────────────────
    //
    // 默认传 `-SystemSound auto`，由 ps1 按 `-Kind` 映射：
    //   失败/拦截 → Hand/Exclamation（警告感）
    //   提问/审批 → Question
    //   完成     → Asterisk（轻快）
    // 这样"失败"和"完成"听起来不一样，不会被误判。
    //
    // v0.4.9：如果用户给这个事件单独指定了音效（kindSystemSoundFail 等），
    // 就传那个具体的名字，不再用 auto。
    //
    // **不传 -Voice/-Mode**，并且 ps1 侧见到 -SystemSound 就跳过语音池
    // （否则 -Kind fail 会先选中 fail 池的 wav，永远走不到系统音效）。
    if (wantSound && source === 'system') {
      const a = baseNotifyArgs(psKind, title, body, false, !wantToast, detail, notifySid);
      const explicitTone = kindOr(cfg.kindSystemSound, aKind, '');
      a.push('-SystemSound', explicitTone || 'auto');
      spawnNotify(a);
      return;
    }

    // ── 自定义音频：播放用户指定的文件 ───────────────────────────────────
    //
    // 路径来自 `cfg.customFiles[kind]`（normalizeConfig 已把扁平键拼好）。
    // 播放交给 dsh-notify.ps1 的 -CustomFile：它直接用 MCI 播这个文件，
    // 不碰语音池，也不回落（用户明确指定了要放什么）。
    if (wantSound && source === 'custom') {
      const kind = audioKindOf(psKind);
      const file = resolveCustomFile(kind, cfg);
      if (file) {
        const a = baseNotifyArgs(psKind, title, body, false, !wantToast, detail, notifySid);
        a.push('-CustomFile', file);
        // v0.4.16：自定义音频的"标准化"是**可选**的。
        //
        // 默认不做 —— 那是用户自己的素材，可能特意做得轻或响，不该擅自改。
        // 打开后按统一目标峰值处理（ps1 侧对 16-bit PCM wav 生效）。
        if (cfg.normalizeCustomAudio === true) {
          a.push('-Gain', String(Number(cfg.voiceGain) > 1 ? Number(cfg.voiceGain) : 2.0));
        }
        spawnNotify(a);
        return;
      }
      // 没配文件：不要静默无声，退到系统提示音（audio-source 的回退链已算过，
      // 但这里再兜一次，防止 effectiveSource 的 hasCustomFile 判断与读取不一致）
      const a2 = baseNotifyArgs(psKind, title, body, false, !wantToast, detail, notifySid);
      a2.push('-SystemSound', 'auto');
      spawnNotify(a2);
      return;
    }

    // ── 其余音源（bundled）走 dsh-notify.ps1 ──────────────────────────────
    // 第 5 个参数是 soundOnly（v0.4.59）。原来这里传的是 source，
    // 而 notifyArgs 只认 4 个参数 —— 那个多传的值一直被静默忽略。
    spawnNotify(notifyArgs(psKind, title, body, !wantSound, !wantToast, detail, notifySid), psKind);
  }

  /** 只有基础参数的 notify 调用（供 system 音源拼装）。 */
  function baseNotifyArgs(psKind, title, body, noSound, soundOnly, detail, sessionIdForArgs) {
      // v0.4.70：只在协议可用时才把会话 id 传给 ps1；否则继续用 dsh://open（降级）。
      const jumpSid = (cfg.toastJumpSession && jumpProtoState === 'ok' && sessionIdForArgs) ? sessionIdForArgs : '';
    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File',
      SCRIPT_PATH, '-Kind', psKind, '-Title', title, '-Body', body,
    ];
    // 第三行可选（v0.4.62）：空就不传，ps1 侧相应不加 <text>。
    if (detail) args.push('-Detail', detail);
    if (noSound) args.push('-NoSound');
    // 只出声不弹窗（v0.4.59）。与 -NoSound 互斥，调用方保证。
    if (soundOnly) args.push('-SoundOnly');

  // v0.4.29：把「用户目录;插件目录」传给 ps1，让它两个区域都查
  const roots = voiceRootsArg();
  if (roots) args.push('-VoiceRoot', roots);
  // v0.4.34：把日志级别传给 ps1（它决定要不要把标题/正文写进日志）
  args.push('-LogLevel', cfg.logLevel === 'debug' ? 'debug' : 'info');
    args.push('-Volume', String(cfg.volume));
      // v0.4.70：会话 id 传给 ps1，让它写进 Toast 的 launch（精准跳转用）。
      if (jumpSid) args.push('-SessionId', String(jumpSid));
    return args;
  }

  /** 构造 dsh-notify.ps1 的参数。noSound=true 表示只弹窗不出声。 */
  function notifyArgs(psKind, title, body, noSound, soundOnly, detail, sessionIdForArgs) {
      // v0.4.70：只在协议可用时才把会话 id 传给 ps1；否则继续用 dsh://open（降级）。
      const jumpSid = (cfg.toastJumpSession && jumpProtoState === 'ok' && sessionIdForArgs) ? sessionIdForArgs : '';
    const args = [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File',
      SCRIPT_PATH, '-Kind', psKind, '-Title', title, '-Body', body,
    ];
    // 第三行可选（v0.4.62）：空就不传，ps1 侧相应不加 <text>。
    if (detail) args.push('-Detail', detail);
    if (noSound) args.push('-NoSound');
    // 只出声不弹窗（v0.4.59）。与 -NoSound 互斥，调用方保证。
    if (soundOnly) args.push('-SoundOnly');
  // v0.4.29：把「用户目录;插件目录」传给 ps1，让它两个区域都查
  const roots = voiceRootsArg();
  if (roots) args.push('-VoiceRoot', roots);
  // v0.4.34：把日志级别传给 ps1（它决定要不要把标题/正文写进日志）
  args.push('-LogLevel', cfg.logLevel === 'debug' ? 'debug' : 'info');
    // v0.4.9：音色模式与音色名都可按事件覆盖（kindVoiceMode*/kindVoiceName*），
    // 没设就用全局 voiceMode / voiceName。
    const aKind = audioKindOf(psKind) || 'done';
    const mode = kindOr(cfg.kindVoiceMode, aKind, cfg.voiceMode);
    const name = kindOr(cfg.kindVoiceName, aKind, cfg.voiceName);
    // v0.5.3：语言必须传下去 —— 否则 ps1 不知道随机时该抽哪个语言的池子，
    // 会退回「整个目录随便抓一个」（= 中日混播，正是本次要修的问题）。
    args.push('-Lang', cfg.voiceLang === 'zh' ? 'zh' : 'ja');
    if (mode === 'random') args.push('-Mode', 'random');
    else if (name) args.push('-Voice', name);
    args.push('-Volume', String(cfg.volume));
    // v0.4.16：语音包数字增益。
    // MCI 的音量上限只等于原始幅度 1.0 倍，而本包素材峰值中位仅 40.4%，
    // 所以"GUI 拉满仍偏轻"是必然 —— 只能靠数字增益补。
    // 只对语音包（bundled）生效；自定义音频默认原样，由用户单独开标准化。
    const g = Number(cfg.voiceGain);
    if (Number.isFinite(g) && g > 1) args.push('-Gain', String(g));
    // ⚠️ v0.4.76：**必须在这里也推 -SessionId**。
    //
    // 之前只加在了 baseNotifyArgs 里（那个函数构造的是 TTS/纯声音的参数），
    // 而**实际弹 Toast 走的是 notifyArgs** —— 所以 ps1 永远收不到 -SessionId，
    // Toast 的 launch 永远是 dsh://open，点了一点都不跳。
    // 2026-10-20 实测：jump-click = 0，就是这个原因。
    if (jumpSid) args.push('-SessionId', String(jumpSid));
    return args;
  }

  /**
   * 某个事件是否有可用的语音包文件。
   *
   * 只做"够不够决定走哪条路"的粗判，不做精确选曲
   * （精确选曲在 ps1 里，那里才知道 -Voice/-Mode 的完整语义）。
   */
function hasVoiceLine(psKind) {
  try {
    const sub = (psKind === 'question' || psKind === 'approval' || psKind === 'fail') ? psKind : '';
    const summary = poolSummary(PLUGIN_ROOT, sub);

    // 读不到目录（宿主沙箱限制）→ 乐观放行，交给 ps1 裁决。
    //
    // 2026-10-17 实测：宿主进程里 existsSync=true 但 readdirSync 抛异常，
    // 于是被判成"没有语音包" → fallback bundled->system → 用户选了语音包
    // 却只听到蜂鸣。而 ps1 是独立子进程、不受沙箱限制，明明能正常播放。
    // 结论：判断不了 ≠ 没有，宁可放行。
    if (summary.unreadable) return true;

    appendNotifyLog(`[voice-check] pool=${sub || 'done'} wav=${summary.total}`);
    return summary.total > 0;
  } catch (e) {
    appendNotifyLog(`[voice-check] error(${(e && e.message) || e}) -> assume-yes`);
    return true;
  }
}

  function shouldNotifySession(session) {
    return cfg.subagents || !isSubagent(session);
  }

  /**
   * 项目名（cwd 最后一段），用作 Toast 第三行（v0.4.62）。
   * 只在"标题里没有它"时才显示，避免重复。
   */
  function projectNameOf(session) {
    try {
      const cwd = session && session.header && session.header.cwd;
      if (!cwd) return '';
      const parts = String(cwd).split(/[\\/]+/).filter(Boolean);
      return parts.length ? parts[parts.length - 1] : '';
    } catch {
      return '';
    }
  }

  /** 读宿主服务（非 strict：容许由其它作用域提供；任何失败都返回 undefined）。 */
  /**
   * 读 turnBoundary 投影 —— 空闲门的**权威**判定依据（v0.4.65）。
   *
   * 返回形态（2026-10-19 实测，真实宿主数据）：
   *     { openTurnStartSeq: number|null, lastStepStartSeq, lastStepBoundary, lastTurn }
   *
   * 实测对照：idle 会话 openTurnStartSeq=null；running 会话 openTurnStartSeq=16165。
   * 两者完全一致，所以拿它代替不可靠的 agent.status 判断。
   *
   * @returns {{open: number|null, lastTurn: number}|null}
   *   null 表示读不到 —— 调用方**必须**当"未知"处理，绝不能当"空闲"。
   */
  function turnBoundaryOf(session) {
    try {
      const proj = svc('sessionProjections');
      if (!proj || typeof proj.stateOf !== 'function') return null;
      const b = proj.stateOf(session, 'turnBoundary');
      if (!b || typeof b !== 'object') return null;
      return {
        open: b.openTurnStartSeq === null || b.openTurnStartSeq === undefined
          ? null
          : b.openTurnStartSeq,
        lastTurn: typeof b.lastTurn === 'number' ? b.lastTurn : 0,
      };
    } catch {
      return null;
    }
  }

  /**
   * 自定义协议名。Toast 的 launch 用它携带 session id（第 4 批）。
   *
   * 为什么不用 dsh:// —— DSH 本体是精确匹配 `dsh://open`，加参数连窗口都不拉。
   *
   * ## 为什么是 `dshnotify-say` 而不是原来的 `dshnotify`（v0.5.0）
   *
   * 归属判定必须能回答"这条注册是不是我们写的"。旧实现用**插件目录**比对，
   * 而目录名不是身份 —— npm 上确实存在**别人的** `dsh-notify-desktop` 包
   * （author=paleech0，2026-10-17 发布），所以"命令串里出现某个目录名"
   * 无法区分"我们的旧路径"与"别人的安装路径"。
   *
   * 把协议名做成**与本包一一对应**的唯一标识后，注册表里出现这个词就必然是我们。
   * 这样目录改名/搬迁后仍判得出归属，不会退化成 `foreign`（既不清理也不重建，
   * Toast 精准跳转永久降级为"只唤窗"，且用户关掉开关也修不好）。
   */
  const JUMP_PROTOCOL = 'dshnotify-say';

  /**
   * 历史协议名（v0.5.0 之前用的）。
   *
   * 升级后老的 `dshnotify` 键会残留在 HKCU。它指向的处理器文件通常还在原处
   * （同一台机器上没删），所以既不报错也不失效 —— 但它指向**旧版本**的脚本。
   * 正确处理：新键建好后把它当 `stale` 清掉，不留尾巴。
   */
  const LEGACY_JUMP_PROTOCOLS = ['dshnotify'];

  /**
   * 协议注册状态（进程内缓存，避免每次播报都查注册表）。
   *
   *   unknown  还没检查过
   *   ok       已注册且指向我们的处理器（可以用 dshnotify-say://）
   *   failed   注册失败或指向别处（**必须降级到 dsh://open**）
   *   off      开关关闭（用户没启用这个功能）
   */
  let jumpProtoState = 'unknown';

  /** 待跳转的会话（Toast 点击写入，前端读取并消费）。v0.4.70 */
  let pendingJump = null;

  /**
   * 读某个协议键的命令值与身份标记。读不到时命令值为 ''。
   *
   * 抽出来是因为 v0.5.0 要读**历史协议**（dshnotify）来判断是否该清理，
   * 而原先读注册表的代码是内联在 probeJumpProtocol 里的。
   *
   * ## 为什么用 .NET Registry API 而不是 `HKCU:`
   *
   * 2026-10-20 排查结论：从 Node 的 execFileSync 调 PowerShell 读
   * `HKCU:\Software\Classes\...` 时，**返回空字符串但 status=0**
   * （PSDrive 在非交互环境下初始化时机的问题）。而：
   *   · 同样的命令从 pwsh 直接跑 → 正常
   *   · `reg query` 从 Node 跑 → 正常
   *   · `[Microsoft.Win32.Registry]::CurrentUser` → **正常**
   *
   * 所以改走 .NET Registry API，不依赖 PSDrive。
   *
   * ⚠️ 命令值和标记必须在**同一次** PowerShell 调用里读，否则两次读取
   * 之间注册表可能变（热重载会注销重注册），会拿到自相矛盾的组合。
   *
   * @param {string} protocol 协议名（不含 `://`）
   * @returns {{ commandValue: string, ownerValue: string }}
   */
  function readProtocolRegistration(protocol) {
    const empty = { commandValue: '', ownerValue: '' };
    try {
      // 测试环境守卫：单元测试大量调用 apply()，不能每次都碰注册表。
      if (typeof globalThis !== "undefined" && globalThis.__STUB_CHILD_PROCESS__ === true) {
        return empty;
      }
      if (process.env.DSH_NOTIFY_NO_REGISTRY === "1") return empty;

      // 用 .NET Registry API：不受 PSDrive 初始化影响（见下方 register 注释）。
      // 输出两行：第一行命令值，第二行标记值。用 -join "`n" 保证顺序。
      const path = `Software\\Classes\\${protocol}\\shell\\open\\command`;
      const root = `Software\\Classes\\${protocol}`;
      const ps = [
        // 强制 UTF-8 输出：PS 5.1 经管道输出非 ASCII 走控制台代码页（中文系统是 GBK），
        // 而 Node 侧按 utf8 解码 → 中文路径会变成替换字符 → existsSync 必 false → 误判 stale。
        `[Console]::OutputEncoding = [Text.Encoding]::UTF8;`,
        `$c = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${path}');`,
        `$r = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${root}');`,
        `$cmd = if ($c) { $c.GetValue('') } else { '' };`,
        `$own = if ($r) { $r.GetValue('${OWNER_VALUE_NAME}') } else { '' };`,
        `@($cmd, $own) -join "\`n"`,
      ].join(' ');

      const out = execFileSync(POWERSHELL_EXE, [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps,
      ], { encoding: 'utf8', windowsHide: true, timeout: 8000 });

      const lines = String(out || '').replace(/\r/g, '').split('\n');
      return {
        commandValue: (lines[0] || '').trim(),
        ownerValue: (lines[1] || '').trim(),
      };
    } catch {
      return empty;
    }
  }

  /**
   * 探测 dshnotify-say 协议当前状态（不依赖内存状态）。
   *
   * 返回值比原来细，因为「注销」必须知道**归属**：
   *
   * ```
   * missing  —— 没注册
   * ok       —— 是我们的处理器，且文件存在（可正常用）
   * stale    —— 是我们的处理器，但**文件已不存在**（插件被删/换路径）
   * foreign  —— 键存在但指向别人的程序（绝不能碰）
   * ```
   *
   * `stale` 是启动自清理的判据：只有它才允许删。
   *
   * ## 为什么必须 probe
   *
   * `jumpProtoState` 是模块级变量，热重载后重置；而 `cfg` 也重置成默认值
   * （toastJumpSession: false）→ 旧实现会误判成「关着」并把协议注销掉。
   *
   * ## 归属判据（v0.5.0 改）
   *
   * 光看 "jump-handler.vbs" 这几个字不够 —— 别的插件也可能叫同名文件。
   * 旧实现靠比对**插件目录**，这在目录改名后会让老用户永久坏掉
   * （判成 foreign → 既不清理也不重建）。
   *
   * 现在：
   *   ① 键里的 `DSHNotifyOwner` 值 === OWNER_ID → 确定是我们的
   *   ② 没有标记但有我们的 handler 文件名 → 也认（旧版本写的注册）
   *   ③ 都没有 → foreign，绝不碰
   *
   * 规则只维护在 lib/protocol-ownership.js 一处，这里只负责取数据。
   *
   * ## ⚠️ `missing` 不区分「没注册」与「读不到」（只读审查 S3）
   *
   * `readProtocolRegistration` 的 catch 会把「PowerShell 起不来 / 超时 / 被策略
   * 挡住」也变成空值，于是这里返回 `missing` —— 两种完全不同的现实被压成同
   * 一个状态码。后果分两种情况：
   *
   *   · 开关**开**着 → plan 给 `register` → 重建（无害，本来就想让它存在）
   *   · 开关**关**着 → plan 给 `none` → 既不注销、也不清老键，直接置 off
   *     （"该修的没修"，不构成新故障，但会让排查的人困惑）
   *
   * 这个缺陷**暂时不修**：区分 `missing` / `unreadable` 要改四态枚举，波及
   * planProtocolSync 与所有调用点，收益（仅日志可读性）不抵风险。这条注释
   * 的作用是让下一个排查者先想到"可能是读不到，而不是真没注册"。
   *
   * @returns {'missing'|'ok'|'stale'|'foreign'}
   */
  function probeJumpProtocol() {
    try {
      // 测试环境守卫：单元测试大量调用 apply()，不能每次都碰注册表。
      if (typeof globalThis !== "undefined" && globalThis.__STUB_CHILD_PROCESS__ === true) {
        return "missing";
      }
      if (process.env.DSH_NOTIFY_NO_REGISTRY === "1") return "missing";

      const reg = readProtocolRegistration(JUMP_PROTOCOL);

      // 判定交给纯函数（lib/protocol-ownership.js）：
      // 身份标记 → 文件存在性 → 四态。规则只在该文件里维护一份。
      return classifyProtocolOwner(reg, { exists: existsSync, pluginRoot: RESOLVED_PLUGIN_ROOT });
    } catch {
      // 读不到注册表就当没注册（不抛错，让调用方走注册流程）
      return 'missing';
    }
  }
  /**
   * 注册自定义协议（HKCU，无需管理员）。
   *
   * ⚠️ 2026-10-20 实测踩坑：**不能用 `-WindowStyle Hidden`**。
   * `-WindowStyle` 只对 `-File` 有效，配 `-Command` 会让 powershell.exe
   * 直接以 exit=-1 退出且无任何输出 —— 表现为"注册总是失败"。
   * 隐藏窗口交给 Node 的 `windowsHide: true` 就够了。
   *
   * @returns {boolean} 注册成功且可用
   */
  function registerJumpProtocol() {
    try {
      // 测试环境守卫：与 probe / cleanup 同口径。
      //
      // ⚠️ 这个守卫原本**漏了**（v0.5.0 自查发现）：probe 在测试里固定返回
      // 'missing'，planProtocolSync 于是给出 action='register'，接着这里就
      // 真的去 Set-ItemProperty 写 HKCU —— 单测会往开发者机器上写注册表。
      // 只补 cleanup 不留这个，等于只堵了一半。
      if (typeof globalThis !== "undefined" && globalThis.__STUB_CHILD_PROCESS__ === true) return false;
      if (process.env.DSH_NOTIFY_NO_REGISTRY === "1") return false;

      // ⚠️ v0.4.78：改用 VBS(wscript) 而不是 powershell.exe。
      //
      // 为什么（2026-10-20 用户多次实测）：
      //   · `powershell.exe ... -WindowStyle Hidden -File ...` 在**协议调起**
      //     场景下仍会弹出一个可见的命令行窗口。用户原话：「点了以后打开了
      //     一个命令行窗口一样的东西」。
      //   · `-WindowStyle` 只影响 PowerShell 自己的宿主窗口，不改父进程传下来
      //     的 console —— 走协议启动时那个 console 已经存在了。
      //
      // wscript.exe 是 **GUI 子系统**程序，根本不创建控制台，从根本上消除弹窗；
      // 顺带比 PowerShell 冷启动快得多（几毫秒 vs 数百毫秒）。
      const vbsHandler = join(PLUGIN_ROOT, 'jump-handler.vbs');
      const ps1Handler = join(PLUGIN_ROOT, 'jump-handler.ps1');
      const useVbs = existsSync(vbsHandler);
      const handler = useVbs ? vbsHandler : ps1Handler;
      if (!existsSync(handler)) { jumpProtoState = 'failed'; return false; }

      // Toast 点击时 Windows 会调起这个命令，%1 是完整 URL。
      const wscriptExe = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\wscript.exe`;
      const cmd = useVbs
        ? `"${wscriptExe}" "${handler}" "%1"`
        : `"${POWERSHELL_EXE}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${handler}" "%1"`;
      if (useVbs) appendNotifyLog('[jump-proto] 使用 wscript+vbs（无控制台窗口）');

      const ps = [
        `$k = 'HKCU:\\Software\\Classes\\${JUMP_PROTOCOL}';`,
        'if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }',
        'Set-ItemProperty -Path $k -Name "(default)" -Value "URL:DSH Notify Jump" -Force;',
        'Set-ItemProperty -Path $k -Name "URL Protocol" -Value "" -Force;',
        // v0.5.0 身份标记：这个键是谁建的。
        // 归属判定靠它（命令串里没有协议名，见 protocol-ownership.js 头注释）。
        `Set-ItemProperty -Path $k -Name "${OWNER_VALUE_NAME}" -Value "${OWNER_ID}" -Force;`,
        `$c = Join-Path $k 'shell\\open\\command';`,
        'if (-not (Test-Path $c)) { New-Item -Path $c -Force | Out-Null }',
        'Set-ItemProperty -Path $c -Name "(default)" -Value $env:DSH_JUMP_CMD -Force;',
      ].join(' ');

      execFileSync(POWERSHELL_EXE, [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps,
      ], {
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, DSH_JUMP_CMD: cmd },
        timeout: 15000,
      });

      // 写完立刻 probe 确认（不信任"命令没报错"就等于成功）
      const after = probeJumpProtocol();
      if (after !== 'ok') {
        jumpProtoState = 'failed';
        appendNotifyLog(`[jump-proto] register写入了但 probe=${after}`);
        return false;
      }

      jumpProtoState = 'ok';
      appendNotifyLog(`[jump-proto] registered ${JUMP_PROTOCOL}:// -> ${useVbs ? 'jump-handler.vbs' : 'jump-handler.ps1'}`);
      return true;
    } catch (e) {
      jumpProtoState = 'failed';
      appendNotifyLog(`[jump-proto] register FAILED: ` + String((e && e.message) || e).slice(0, 200));
      return false;
    }
  }

  /**
   * 注销自定义协议（开关关闭 / 插件卸载时调用）。
   *
   * 只删自己那个键，绝不动别人的；删不掉也只记日志（不阻塞卸载）。
   */
  function unregisterJumpProtocol() {
    try {
      // 测试环境守卫：同 probe / register / cleanup。
      // 漏了它的话，开关关着的单测会真的 Remove-Item 掉开发者的键。
      if (typeof globalThis !== "undefined" && globalThis.__STUB_CHILD_PROCESS__ === true) return;
      if (process.env.DSH_NOTIFY_NO_REGISTRY === "1") return;

      // ⚠️ 同 register：-Command 不能配 -WindowStyle Hidden（会让 powershell 直接失败）。
      const ps = `$k = 'HKCU:\\Software\\Classes\\${JUMP_PROTOCOL}'; if (Test-Path $k) { Remove-Item $k -Recurse -Force }`;
      execFileSync(POWERSHELL_EXE, [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps,
      ], { stdio: 'ignore', windowsHide: true, timeout: 10000 });
      const after = probeJumpProtocol();
      if (after === 'missing') {
        jumpProtoState = 'off';
        appendNotifyLog(`[jump-proto] unregistered ${JUMP_PROTOCOL}://`);
      } else {
        appendNotifyLog(`[jump-proto] unregister 后 probe=${after}（可能被占用）`);
      }
    } catch (e) {
      appendNotifyLog(`[jump-proto] unregister failed: ` + String((e && e.message) || e).slice(0, 120));
    }
  }

  /**
   * 历史协议是否已经查过（进程内缓存）。
   *
   * 为什么需要：`syncJumpProtocol()` 会被**每次配置变更**调用（设置页每改一项
   * 触发一次），而清理要开两个 PowerShell 读注册表，实测约 200 ms/次。
   * 迁移是一次性动作，查过一次（清掉了或确认不是我们的）就不必再查。
   *
   * 反过来也正确：真有老键是**后来**才出现的（用户装了旧版本），那也要等
   * 下次进程启动才会被清 —— 这一样可接受，因为跨版本安装本来就伴随重启。
   */
  let legacyProtocolsChecked = false;

  /**
   * 清理历史协议注册（v0.5.0：`dshnotify` → `dshnotify-say` 的迁移）。
   *
   * ## 为什么要清
   *
   * 老键指着**旧版本目录**里的 jump-handler。升级后有两份注册同时存在，
   * 而 Windows 只按 URL 里的协议词分派 —— 老词仍然可用，于是"点通知到底
   * 走哪个脚本"取决于 Toast 里写的是哪个词，取决于当时跑的插件版本。
   * 这种"双活"状态很难排查（日志里两套 handler 混着出现），所以迁完就删。
   *
   * ## 为什么删得安全（判据在 lib/protocol-ownership.js:isLegacyRegistration）
   *
   * 老键名 `dshnotify` 是我们独占过的词，且还要求命令串里出现我们的
   * handler 文件名。两条同时成立才删 —— 万一将来别人真用了这个词，不误伤。
   *
   * ## 和开关的关系
   *
   * `syncJumpProtocol()` 会在**两个**时机调本函数：新键确认可用之后（reuse /
   * 注册成功），以及开关关着且已确认注销之后。所以「关着开关」的用户的老键
   * 也会被清 —— 这正是要修的故障路径（用户关掉再打开也修不好）。
   *
   * 但**注册失败 / 被别人占用降级时不清**：那种情况下老键也许还能用，
   * 删掉会让用户从"降级"变成"完全没反应"，比不修还糟。
   *
   * 任何失败都只记日志，绝不影响启动。
   */
  function cleanupLegacyProtocols() {
    if (!LEGACY_JUMP_PROTOCOLS.length) return;
    if (legacyProtocolsChecked) return;
    // 测试环境守卫：与 probe 同口径，别在单测里碰注册表。
    if (typeof globalThis !== "undefined" && globalThis.__STUB_CHILD_PROCESS__ === true) return;
    if (process.env.DSH_NOTIFY_NO_REGISTRY === "1") return;

    // 先置位再看：即使中途抛异常也不要每次配置变更都重试一遍。
    // （下面每个 legacy 各自 try/catch，不会让异常逃出去。）
    legacyProtocolsChecked = true;

    for (const legacy of LEGACY_JUMP_PROTOCOLS) {
      try {
        const reg = readProtocolRegistration(legacy);
        if (!reg.commandValue) continue;         // 没这个键，正常
        if (!isLegacyRegistration(reg)) {
          // 键在但不像我们的 —— 别人的东西，绝不碰
          appendNotifyLog(`[jump-proto] 遗留键 ${legacy}:// 不属于本插件，跳过清理`);
          continue;
        }

        const ps = `$k = 'HKCU:\\Software\\Classes\\${legacy}'; if (Test-Path $k) { Remove-Item $k -Recurse -Force }`;
        execFileSync(POWERSHELL_EXE, [
          '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps,
        ], { stdio: 'ignore', windowsHide: true, timeout: 10000 });

        // 写完立刻确认，不信任"命令没报错"
        const after = readProtocolRegistration(legacy).commandValue;
        if (after) {
          appendNotifyLog(`[jump-proto] 遗留键 ${legacy}:// 清理后仍在（可能被占用），放弃`);
        } else {
          appendNotifyLog(`[jump-proto] 已清理历史协议 ${legacy}://（迁移到 ${JUMP_PROTOCOL}://）`);
        }
      } catch (e) {
        appendNotifyLog(`[jump-proto] 清理 ${legacy}:// 失败（忽略）: ` + String((e && e.message) || e).slice(0, 120));
      }
    }
  }

  /**
   * 按当前开关 + 旧注册的归属，同步协议状态。
   *
   * ## 规则（v0.4.83 重写，核心是「谁的东西谁能处理」）
   *
   * | probe     | 开关开 | 开关关 |
   * |-----------|--------|--------|
   * | `ok`      | 直接用（不重写注册表） | 注销（是我们的，可以清） |
   * | `stale`   | **先清理失效项**再注册 | 注销 |
   * | `foreign` | **不动它**，降级 dsh://open | **不动它** |
   * | `missing` | 注册 | 什么都不做 |
   *
   * `foreign` 那一行是 v0.4.83 的关键修正：原来会把别人的注册注销掉。
   * 别人的东西不该由我们删 —— 宁可自己降级成「只唤窗不跳会话」。
   *
   * `stale` 那一行是「卸载后不留尾巴」的实现：注册还在但处理器文件
   * 已不存在（插件被删/换路径）→ 清掉。热重载时文件一直在，不会被误删。
   *
   * ## v0.5.0 附加：清历史协议（**新键确认可用之后**才清）
   *
   * 协议名从 `dshnotify` 换成 `dshnotify-say`。老键要清掉，避免两份注册双活
   *（见 cleanupLegacyProtocols 注释）。
   *
   * ⚠️ 顺序很关键：**先**确保新键可用（或至少已尝试并确定失败），**再**清老键。
   *
   * 反过来（先清后建）会造成一个新的故障：如果新键注册失败（PowerShell 被
   * 策略挡住、注册表被占用……），老键已经删了、新键又没有 → 用户从"降级但能
   * 唤窗"变成"点了完全没反应"。而我们这次改动本来就是为了修"点了没反应"。
   *
   * 所以下面三条路径分别处理：
   *   · reuse / 新注册成功 → 清老键（此时新键已 confirmed ok）
   *   · 开关关着且确认注销 → 清老键（我们本来就不要任何注册）
   *   · 注册失败 / 被别人占用降级 → **保留**老键（它也许还能用，删了更糟）
   *
   * @returns {boolean} 是否可用（决定 Toast 用哪种 launch）
   */
  function syncJumpProtocol() {
    const probed = probeJumpProtocol();
    const plan = planProtocolSync(probed, cfg.toastJumpSession === true);

    // ── 别人的协议：一律不碰（决策来自 planProtocolSync，只有一处规则）────
    if (plan.downgrade) {
      jumpProtoState = 'failed';
      appendNotifyLog(
        `[jump-proto] ${JUMP_PROTOCOL}:// 已被其他程序占用，不覆盖、不注销；`
        + '本次降级为 dsh://open（只唤窗不跳会话）'
      );
      return false;
    }

    if (plan.action === 'unregister') {
      unregisterJumpProtocol();
      jumpProtoState = 'off';
      // 开关关着、且确认注销了自己的键 —— 此时我们不要任何注册，老键也该清。
      cleanupLegacyProtocols();
      return false;
    }

    if (plan.action === 'reuse') {
      // 已是我们的且文件在 —— 热重载/重启后走这条，不必重复写注册表
      jumpProtoState = 'ok';
      // 新键已 confirmed ok，现在清老键才是安全的
      cleanupLegacyProtocols();
      return true;
    }

    if (plan.action === 'register') {
      if (plan.cleanupFirst) {
        // v0.4.83 启动自清理：注册还在但处理器文件已不存在
        // （插件被删或换了路径）—— 这正是「卸载后留尾巴」的情形。
        appendNotifyLog('[jump-proto] 发现失效注册（指向的处理器已不存在），清理后重新注册');
        unregisterJumpProtocol();
      }
      const okReg = registerJumpProtocol();
      // ⚠️ 只有真的注册成功才清老键 —— 失败时留着它，别让用户两头落空。
      if (okReg) cleanupLegacyProtocols();
      else {
        // 注册失败 → 有意保留老键。必须留一行日志，否则用户升级后"精准跳转还是不灵"时，
        // 日志里看不出我们是有意保留的（只读审查 Q3 指出）。
        appendNotifyLog(
          `[jump-proto] 新键 ${JUMP_PROTOCOL}:// 注册失败，**故意保留**历史协议`
          + `（${LEGACY_JUMP_PROTOCOLS.map((p) => p + '://').join(', ')}）—— `
          + '留着它用户至少还能跳，删了两头落空'
        );
      }
      return okReg;
    }

    // action === 'none'（开关关着且没注册）
    jumpProtoState = 'off';
    return false;
  }

  function svc(name) {
    try { return ctx.get(name, false); } catch { return undefined; }
  }

  /**
   * 当前"仍在飞"的工作快照。
   * 只读旁路：任一路取不到就退化为空（fail-visible —— 宁可多播一条完成，
   * 也不因为读不到服务而静默用户自己的任务）。
   */
  function inFlightOf(agent) {
    let jobs = [];
    let agents = [];
    try {
      const js = svc('jobs');
      if (js && typeof js.list === 'function') {
        // ⚠️ 必须传 **agent.id 字符串**，不能传 agent 对象。
        // DSH 官方用法是 jobs.list(agent?.id)（见 app.asar 的 updateTaskControl），
        // 传对象会让它返回空数组 → 空闲门永远判定「没有在飞工作」→
        // 回合一结束就播报（2026-10-19 用户演示空闲门时实测抓到）。
        // 单测没发现：测试直接喂 collectInFlight 的假数据，绕过了本函数。
        //
        // 另照官方做法补查「无 agent 的全局任务」——有些后台任务不属于任何 agent。
        const aid = agent && agent.id !== undefined ? agent.id : undefined;
        const mine = js.list(aid) || [];
        const glob = aid === undefined ? [] : (js.list(undefined) || []);
        jobs = mine.concat(glob);
      }
    } catch (e) {
      console.warn('[dsh-notify-say] jobs.list failed: ' + String((e && e.message) || e));
    }
    try {
      const as = svc('agents');
      if (as && typeof as.list === 'function') agents = as.list() || [];
    } catch (e) {
      console.warn('[dsh-notify-say] agents.list failed: ' + String((e && e.message) || e));
    }
      // ⚠️ v0.4.65：对齐 DSH 官方的 hasDesktopActiveTasks ——
      // 它还检查 agent.inbox 里有没有排队的下一轮/下一步：
      //     agent.status === "running"
      //     || agent.inbox.nextTurn.length > 0
      //     || agent.inbox.nextStep.length > 0
      // 后两个表示"马上要干活"（比如子任务返回后主 Agent 立刻续跑）。
      // 不查它们就会出现"刚播完成，Agent 又开始干"的误报。
      //
      // inbox 的形状不确定（可能是包装对象，nextTurn/nextStep 在原型链上），
      // 所以**读不到就不算有活** —— 宁可少拦一次，也不能因为读不到而永远不播。
      try {
        const ib = agent && agent.inbox;
        if (ib) {
          const nt = ib.nextTurn;
          const ns = ib.nextStep;
          if ((Array.isArray(nt) && nt.length > 0) || (Array.isArray(ns) && ns.length > 0)) {
            jobs.push({ id: "inbox", label: "queued", status: "running" });
          }
        }
      } catch { /* inbox 不可读：忽略，不因此判定有活 */ }

      return collectInFlight(jobs, agents, agent && agent.id);
  }

  /**
   * 记录「为什么这一次没有播报」。
   *
   * ## 为什么需要它
   *
   * 用户 2026-10-17 问「刚才那次完成了怎么没响」。当时我查不出来，因为：
   *   - 去抖拦下 → **完全不写日志**
   *   - 事件开关关闭 → **完全不写日志**
   *   - 空闲门挂起 → 只写 console（宿主 stdout，不在 notify.log）
   *
   * 也就是说，只有「播了」才有记录，「没播」是黑盒。这条缺陷比任何功能都更该先修：
   * 看不到原因，就无法判断是配置问题还是代码问题，也没法回答用户的疑问。
   *
   * ## 统一格式
   *
   *   YYYY-MM-DD HH:MM:SS [skip] <reason> kind=<kind> sess=<id> <detail>
   *
   * 与 ps1 写的 `[toast]` / `[preview]` 行共用同一个 notify.log，便于对照阅读。
   *
   * @param {string} reason 简短的机器可读原因：debounce / switch-off / subagent / idle-gate / ...
   * @param {string} kind   事件类别（completed/error/blocked/...）
   * @param {object} session
   * @param {string} [detail] 附加说明（如具体时长、哪个开关）
   */
  function skipLog(reason, kind, session, detail) {
    try {
      const sid = session && session.id !== undefined ? String(session.id) : '?';
      const line = `[skip] ${reason} kind=${kind || '?'} sess=${sid}${detail ? ' ' + detail : ''}`;
      // 与 ps1 相同的落点，便于在同一文件里对照「播了 / 没播」
      appendNotifyLog(line);
    } catch { /* 日志失败绝不影响主流程 */ }
  }

  /** 实际播报（按会话去抖 + 可选跨会话冷却；返回是否真的发出）。 */
  /**
   * 已完成播报的事件键（会话 → 最近一个已播的 turn）。
   *
   * 用途：**事件级互斥**。同一个完成的 evKey 只允许播一次，
   * 防止「空闲门 flush」和「agent/status 直接播」两条路径各播一遍
   * （2026-10-19 真机实测：用户听到了两个语音）。
   *
   * 为什么不用时间去抖：时间窗口语义模糊 —— 分不清"同一件事"和
   * "两件相邻的事"。事件键能精确区分。
   */
  const lastEmittedKey = new Map();
  /**
   * 已经提醒过失败的 job（防重复）。
   *
   * 用「job 粒度」而不是「轮次粒度」：一个轮次里可能有多个 job 失败，
   * 每个都该被提醒一次，但同一个 job 只提醒一次。
   */
  const failedJobNotified = new Set();

  /**
   * 后台 job 最终失败 → 独立失败提醒（第 2 批 P0-②）。
   *
   * ## 为什么必须独立于主回合的 error 链路
   *
   * 官方文档说 job 结算时会往 owning agent 的会话投一条 in-session 消息，
   * 但**那不等于主会话的 turn/end 会带 error**。所以两件事分开处理：
   *   · 主回合 error   → handleDone 的 fail 分支（已有）
   *   · 后台 job failed → 这里（新增）
   *
   * 修复前：全文件搜不到 failed / killed 的处理，jobs 事件只用来重估空闲门，
   * 所以后台任务失败了，只要主回合没报错，用户听不到任何声音。
   *
   * @param {object} event jobs.events.subscribe 收到的事件
   */
  function handleJobFailure(event) {
    if (!event || event.type === 'output') return;
    const job = event.job;
    if (!job || job.id === undefined) return;

    // 只关心「最终失败」。running / stopping / completed / killed 都不进这里。
    if (String(job.status || '') !== 'failed') return;

    const jobId = String(job.id);
    if (failedJobNotified.has(jobId)) return;
    failedJobNotified.add(jobId);
    // 有界：超过 200 条丢最旧的（Set 保持插入序）。
    if (failedJobNotified.size > 200) {
      const first = failedJobNotified.values().next().value;
      if (first !== undefined) failedJobNotified.delete(first);
    }

    // 找这个 job 属于哪个会话（用于合并去抖 + Toast 标题）。
    const ownerId = job.owner !== undefined ? String(job.owner) : undefined;
    let session;
    try {
      const as = svc('agents');
      if (as && typeof as.get === 'function' && ownerId) {
        const a = as.get(ownerId);
        if (a) session = a.session;
      }
    } catch { /* 拿不到会话就按全局提醒 */ }

    const label = job.label ? String(job.label) : jobId;
    const kindTxt = job.kind ? String(job.kind) : 'job';
    appendNotifyLog(`[job-fail] id=${jobId} kind=${kindTxt} label=${label} `
      + `owner=${ownerId || '-'} sess=${session ? sessionKey(session) : '-'}`);

    // 走 fail 语音池（与主回合错误同档），**不受空闲门约束**：
    // 错误必须先叫醒用户，不能等「工作树空了」再播。
    emitDone(
      session,
      'fail',
      'DSH 后台任务失败',
      `后台任务 ${label} 失败了，回来看看`,
      // evKey 用 job 粒度：同一 job 只播一次（emitDone 的互斥层再兜一次底）。
      `jobfail:${jobId}`,
    );
  }


  /**
   * 播报统一的**唯一出口**。
   *
   * @param {object} session
   * @param {string} psKind   done / fail / chime
   * @param {string} title
   * @param {string} body
   * @param {string} [evKey] 事件标识（同一事件只播一次）；缺省则不去重
   * @returns {boolean} 是否真的播了
   */
  function emitDone(session, psKind, title, body, evKey) {
    const key = sessionKey(session);
    const now = Date.now();

    // ⚠️ v0.4.66（第 2 批 P0-①）：去抖**按通知等级分桶**。
    //
    // 2026-10-19 外部审查指出：原先 lastTurnNotify 只记「这个会话最近一次
    // 播报的时间」，不区分等级。默认去抖 60 秒，于是「完成」后 60 秒内的
    // 「失败」会被直接吞掉 —— 错误发生却没有声音，比完成晚播严重得多。
    //
    // 分桶后：完成+失败都播（失败不能被吞）；两个完成只播最后；
    // 两个连续失败仍去抖（避免错误轰炸）。
    const tier = psKind === 'fail' ? 'fail' : 'done';
    const tierKey = key + '\u0000' + tier;

    // ── 第零级：事件级互斥（v0.4.65）─────────────────────────────────────
    // 同一个完成事件，不管从哪条路径进来，只播一次。
    if (evKey) {
      const seen = lastEmittedKey.get(key);
      if (seen === evKey) {
        skipLog('duplicate-event', psKind, session, `evKey=${evKey} already emitted`);
        return false;
      }
    }

    // ── 第一级：同会话去抖 ────────────────────────────────────────────────
    // 语义：同一会话连续完成多次，只提醒最后一次（几乎是噪音）。
    // 可调为 0 表示关闭 —— 有人希望"每个结果都听见"。
    if (cfg.debounceMs > 0 && isRecent(lastTurnNotify, tierKey, now, cfg.debounceMs)) {
      // 去抖拦下时**必须留痕**：这是最容易被误判成"插件坏了"的情形
      skipLog('debounce', psKind, session,
        `same tier(${tier}) within ${Math.round(cfg.debounceMs / 1000)}s`);
      return false;
    }

    // ── 第二级：跨会话冷却（v0.4.7）──────────────────────────────────────
    //
    // 语义完全不同，所以是**独立**的一级：
    //   · 同会话去抖 = "这次和上次是同一件事，别重复"
    //   · 跨会话冷却 = "我已经被叫过来了，不必再叫"
    //
    // 用户 2026-10-17 指出两类人诉求相反：
    //   A 型：每个结果都要听见，否则不知道做完了 → 默认关闭（0）
    //   B 型：听到一个就过来盯着了，再响就烦 → 自己打开
    // 所以默认值为 0（关闭），保持现有行为不变。
    if (cfg.globalCooldownMs > 0) {
      const lastAny = Number(lastAnyNotifyAt) || 0;
      if (lastAny > 0 && now - lastAny < cfg.globalCooldownMs) {
        skipLog('global-cooldown', psKind, session,
          `any session within ${Math.round(cfg.globalCooldownMs / 1000)}s `
          + `(last ${Math.round((now - lastAny) / 1000)}s ago)`);
        return false;
      }
    }

    rememberAt(lastTurnNotify, tierKey, now);
    lastAnyNotifyAt = now;
    if (evKey) lastEmittedKey.set(key, evKey);
    notify(psKind, title, body, session);
    return true;
  }

  /** 清除某个会话的挂起项（含计时器）。 */
  function clearPending(id) {
    const p = pendingDone.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    if (p.recheckTimer) clearTimeout(p.recheckTimer);
    if (p.quietTimer) { clearTimeout(p.quietTimer); p.quietTimer = null; }
    pendingDone.delete(id);
  }

  /** 兑现挂起项：播报一次。viaTimeout 表示是超时兜底（文案加提示，不误导为"全部完成"）。 */
    /**
     * 放行一个挂起项并播报。
     *
     * ## viaTimeout = true 时的行为（v0.4.65 重写）
     *
     * 超时不等于完成。必须**当场复查**工作树：
     *   · 真的空了  → 正常播"完成"
     *   · 还在跑    → 播**不同的提醒文案**，绝不谎报完成
     *   · 状态未知  → 播提醒 + 记诊断
     *
     * 用户方案原话：「超时先重新检查工作树。如果仍有任务运行，不得朗读
     * "任务已完成"。状态未知时记录诊断信息；如需要超时提醒，使用与
     * "全部完成"不同的提示文案。」
     */
    /**
     * 放行挂起项并播报「完成」。**只有确认工作树真的空了才允许调用。**
     *
     * 超时路径不走这里 —— 超时走 notifyProgress（不消耗完成通知）。
     */
    function flushPending(id, quiet) {
      const p = pendingDone.get(id);
      if (!p) return;
      clearTimeout(p.timer);
      if (p.recheckTimer) clearTimeout(p.recheckTimer);
      if (p.quietTimer) { clearTimeout(p.quietTimer); p.quietTimer = null; }
      pendingDone.delete(id);
      // v0.5.11：记下这次放行走过多长的静默期、期间被重置过几次。
      // 排查误播/延迟时，"quiet=0" 说明静默期没生效（旧行为），
      // "resets>0" 说明窗口期间确实有活动（正常且期望）。
      const quietMs = quiet && Number.isFinite(quiet.quiet) ? quiet.quiet : 0;
      const resets = quiet && Number.isFinite(quiet.resets) ? quiet.resets : 0;
      appendNotifyLog(`[flush] idle-gate kind=${p.psKind} sess=${sessionKey(p.session)} worktree-idle quiet=${quietMs} resets=${resets}`);
      // evKey 用「这一轮的序号」：同一轮无论哪条路径都算同一个事件。
      emitDone(p.session, p.psKind, p.title, p.body, p.evKey || undefined);
    }

    /**
     * 超时兜底：**发进度提醒，但不消耗完成通知**（v0.4.65 第 1 批 1.7）。
     *
     * 规则（用户方案）：
     *   · 超时先复查工作树
     *   · 若真的空了 → 直接走 flush（这就是正常完成）
     *   · 仍在跑 / 状态未知 → 播**进度提醒**（文案明确不含"完成"），
     *     最多一次；pending **保留**，等真正空闲时再播完成
     *
     * 进度提醒之后仍会留一个周期性复查，保证最终空闲时能播完成。
     */
    function onIdleGateTimeout(id) {
      const p = pendingDone.get(id);
      if (!p) return;

      // 先复查：也许刚好已经空了
      let stillBusy = null;   // null = 未知
      try {
        const as = svc('agents');
        const agent = as && typeof as.get === 'function' ? as.get(id) : undefined;
        if (agent) {
          const inflight = inFlightOf(agent);
          const tb = turnBoundaryOf(agent.session);
          if (tb && tb.open !== null) {
            stillBusy = true;
          } else {
            stillBusy = inflight.length > 0;
          }
          if (inflight.length > 0) p.inflight = inflight;
        }
      } catch { stillBusy = null; }

      if (stillBusy === false) {
        // 复查确认真空闲 → 这是正常完成，走 flush
        appendNotifyLog(`[idle-gate] timeout recheck: idle now id=${id}`);
        // 账目照实传：`quiet=0` 的语义是"静默期没参与这次放行"，
        // 不能因为这次走的是超时复查就永远记 0（否则事后对账分辨不出来）。
        flushPending(id, { quiet: quietMsOf(), resets: p.quietResets || 0 });
        return;
      }

      // 仍在跑或未知 → 进度提醒（最多一次），pending 保留
      const reason = stillBusy === true ? 'timeout-still-running' : 'timeout-unknown';
      const n = (p.inflight && p.inflight.length) || 0;

      if (!p.progressNotified) {
        p.progressNotified = true;
        const txt = stillBusy === true
          ? `已经跑了一段时间，还有 ${n} 个任务在进行中 —— 这不是完成提醒`
          : '已经跑了一段时间，暂时查不到进度 —— 这不是完成提醒';
        appendNotifyLog(`[progress] idle-gate kind=${p.psKind} sess=${sessionKey(p.session)} ${reason} inflight=${n}`);
        // 进度提醒走独立的 kind 语义：ps1 里用 chime（不播"完成"语音）
        notify('chime', p.title, txt, p.session);
      } else {
        appendNotifyLog(`[idle-gate] timeout again, progress already sent id=${id}`);
      }

      // 留一个复查定时器：等它真正空闲时还能播完成。
      // 间隔用 idleGateTimeoutMs 的一半（下限 60 秒），避免太频繁。
      const again = Math.max(60_000, Math.round(cfg.idleGateTimeoutMs / 2));
      p.recheckTimer = setTimeout(() => {
        try { onIdleGateTimeout(id); } catch { /* 单次失败不影响后续 */ }
      }, again);
      if (p.recheckTimer && typeof p.recheckTimer.unref === 'function') p.recheckTimer.unref();
    }

  /**
   * 空闲门：工作树空闲就播报，否则挂起等待。
   * 挂起期间新的同类完成会重置挂起项（合并为一次播报）。
   */
  function scheduleOrNotify(session, agent, psKind, title, body) {
    const id = sessionKey(session);

    // 事件标识：同一轮的完成必须用同一个 evKey，
    // 这样「空闲门 flush」与「agent/status 直接播」两条路径才会互斥。
    const tbNow = turnBoundaryOf(session);
    const evKey = tbNow ? `turn:${id}:${tbNow.lastTurn}` : undefined;

    const inflight = inFlightOf(agent);

    // ⚠️ v0.4.65：**合并**，不是各播一次。
    // 同一会话已有挂起项时，说明这次完成是「上一轮的后继」
    // （子任务返回后 Agent 内部续跑完成）。两条路径各播一次就会重复 ——
    // 2026-10-19 真机实测：用户听到了两个语音。
    // 正确做法：更新挂起项的内容，最终只播一次（用户方案要求）。
    const existing = pendingDone.get(id);
    if (existing) {
      existing.psKind = psKind;
      existing.title = title;
      existing.body = body;
      existing.inflight = inflight;
      if (inflight.length === 0) {
        // 工作树已空 → 合并后播一次（内容用最新的）。
        // v0.5.11：走静默期，不立刻 flush —— 合并路径同样是"看到空闲就播"，
        // 一样会掉进「先 idle、139ms 后才投递结算消息」那条缝（见 armQuiet 注释）。
        armQuiet(id);
      } else {
        skipLog('idle-gate-merge', psKind, session,
          `merged into pending, still ${inflight.length} inflight`);
      }
      return;
    }

    if (inflight.length === 0) {
      clearPending(id);
      emitDone(session, psKind, title, body, evKey);
      return;
    }

    clearPending(id);
    const timer = setTimeout(() => { try { onIdleGateTimeout(id); } catch { /* 兜底失败不影响主流程 */ } }, cfg.idleGateTimeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    pendingDone.set(id, {
      session, psKind, title, body, timer, inflight,
      // 挂起时就把 evKey 定下来：flush 时用它做互斥键。
      evKey,
    });
    // 双写：console（宿主 stdout，开发/测试断言用）+ notify.log（用户与事后排查用）。
    console.log(`[dsh-notify-say] idle-gate: 挂起完成播报，等待 ${inflight.length} 项在飞工作 `
      + `(${inflight.map((i) => i.kind + ':' + i.id).join(', ')})`);
    skipLog('idle-gate-hold', psKind, session,
      `waiting ${inflight.length} inflight (${inflight.map((i) => i.kind + ':' + i.id).join(', ')})`);
  }

  /**
   * 重估所有挂起项（由 jobs 变化 / agent 状态变化触发）。
   * 三种归宿：① 主会话已重新 running → 取消（用户已在交互）；② 工作树空闲 → 播报；
   * ③ agent 已消失 → 视为结束，播报。
   */
    /**
     * 重估所有挂起项（由 jobs 事件 / agent/status 触发）。
     *
     * ## 判定顺序（v0.4.65 重写）
     *
     * 每个挂起项按下面顺序判，**任何一步"不确定"都不许放行**：
     *
     *   ① 拿 agent；拿不到 → 不是"完成"，记诊断，保留待下次（原先误 flush）
     *   ② 读 turnBoundary；读不到 → 同上，保留
     *   ③ lastTurn > 挂起时的 lastTurn → 新一轮开始了 → 作废（不是播报）
     *   ④ openTurnStartSeq !== null → 有轮次进行中 → 保留等待
     *   ⑤ 还有在飞工作 → 保留等待
     *   ⑥ 以上都过（真空闲且无活）→ flush 播报一次
     *
     * ## 为什么"agent 拿不到"不能当完成
     *
     * 原先写 `if (!agent) flushPending(...)` —— 把"查不到状态"当成"工作树空了"。
     * 用户方案明确要求："状态无法查询时不得当成工作树完成"。
     * 现在改为保留 + 记诊断，由超时兜底或下次事件重试。
     */
    /**
     * 复查一个挂起项：现在能不能播？返回 null = 真空闲可放行；返回原因码 = 继续等。
     *
     * v0.5.11 从 reevaluatePending 里抽出来，因为静默期到点后**必须再跑一遍
     * 同一套判据**才能放行；两处写两份判据必然漂移（本项目栽过"双份真相源"）。
     */
    function gateHoldReason(id, trigger) {
      // ① agent
      let agent;
      try {
        const as = svc('agents');
        agent = as && typeof as.get === 'function' ? as.get(id) : undefined;
      } catch { agent = undefined; }
      if (!agent) {
        // 不等于完成 —— 可能只是注册表暂时读不到。保留，等下次或超时。
        appendNotifyLog(`[idle-gate] pending kept: agent unavailable id=${id} trigger=${trigger}`, { detail: true });
        return 'agent-unavailable';
      }

      // ② turnBoundary（权威信号）
      const tb = turnBoundaryOf(agent.session);
      if (!tb) {
        appendNotifyLog(`[idle-gate] pending kept: turnBoundary unavailable id=${id} trigger=${trigger}`, { detail: true });
        return 'turn-boundary-unavailable';
      }

      // ⚠️ v0.4.65：**不再**用 lastTurn 递增判断「用户发了新消息」。
      // 实测证伪：主 Agent 处理子任务返回时内部续跑，lastTurn 也会递增
      // （2026-10-19 日志：pending dropped turn 9->10，但用户什么都没发）。
      // 按需求约定「不能用间接信号猜测用户输入」→ 保守退化：保留 pending，
      // 后续结果合并，最终稳定空闲时最多播一次。
      // 代价：用户真发新消息时旧通知会补播一次（危害小于误作废）。

      // ④ 轮次还开着 → 还在干，留着
      if (tb.open !== null) {
        return 'turn-open';
      }

      // ⑤ 还有在飞工作 → 留着（把最新快照记下来，日志与超时判断都用它）
      const inflight = inFlightOf(agent);
      if (inflight.length > 0) {
        const p = pendingDone.get(id);
        if (p) p.inflight = inflight;
        return 'inflight';
      }

      // ⑥ 判据全过 —— 但**还不播**：交给静默期再观察一段（起窗是调用方的事）
      return null;
    }

    /** 静默期长度：0 = 关闭（退回 v0.5.10 即时释放），非法值按默认 1500。 */
    function quietMsOf() {
      const n = Number(cfg.idleGateQuietMs);
      return Number.isFinite(n) && n >= 0 ? Math.min(n, 60000) : 1500;
    }

    /**
     * 记录一次"真的动过了"的活动（静默期的重置信号）。
     *
     * 只允许在**状态真的变化**的边沿调用（agent/status 值改变、jobs 事件到达）。
     * 绝不能对"重复推送同一个状态"的心跳调用 —— 否则静默窗永远等不到尾沿，
     * 完成通知会被无限期推迟（这是防抖类实现的经典事故）。
     */
    function markActivity() {
      activitySeq += 1;
      let cleared = false;
      for (const p of pendingDone.values()) {
        if (p.quietTimer) { clearTimeout(p.quietTimer); p.quietTimer = null; cleared = true; }
      }
      // ⚠️ 只清定时器 = 这条挂起项失去窗口 → 若之后再也没有边沿事件，
      // 它要等到 onIdleGateTimeout（10 分钟）才动，而那播的是"进度提醒"，
      // 不是完成语音。所以清完必须**重新起窗**（异步，避免在事件回调里递归
      // 跑一整轮判据）。reevaluatePending 内部有 has() 守卫，不会双播。
      if (cleared) {
        queueMicrotask(() => {
          try { reevaluatePending('activity'); } catch { /* 重估失败不该影响事件链 */ }
        });
      }
    }

    /**
     * 进入静默期（尾沿防抖）等待。
     *
     * ## 为什么需要这一层（考古注释，别删）
     *
     * DSH 的时序是「子代理 turn/end + agent/status=idle 先到，结算消息
     * 139~172ms 之后才投进父代理 inbox」（2026-11-23 原始会话日志实测 3 例：
     * 139 / 155 / 159ms；`dsh-subagent` 的 sendWaking 也只在父代理 idle 时
     * 才用 queue→next-turn）。那一刻从**任何单一快照**看都是"真空闲"：
     * 子代理已 idle、jobs 为空、父轮次也已关闭。旧实现据此立刻播「完成」，
     * 而父代理紧接着就被这条消息叫起来继续干活 —— 用户听到的就是
     * "主代理还没开始就播了"。只靠快照判定，这个问题不可能修对：缺的不是
     * 更多判据，而是"再等一会儿看它会不会动"。
     *
     * 所以：不写子代理特判（保持正交），改成任何活动都重置的静默窗；
     * 顺带覆盖 job settled→宿主延迟投递这类同形竞态。
     */
    function armQuiet(id, delayMs) {
      const p = pendingDone.get(id);
      if (!p) return;
      const quietMs = quietMsOf();
      if (!(quietMs > 0)) {
        // 关掉静默期 → 保持 v0.5.10 行为（一步回退开关）
        flushPending(id, { quiet: 0, resets: 0 });
        return;
      }
      // 已经在窗口里就不重置：窗口只由 markActivity 重置。
      // （若这里也重置，jobs 事件的高频重估会把窗口越推越远 → 永不播报）
      if (p.quietTimer) return;
      const armedSeq = activitySeq;
      const wait = Number.isFinite(Number(delayMs)) && delayMs >= 0
        ? Math.min(Number(delayMs), quietMs)
        : quietMs;
      p.quietTimer = setTimeout(() => {
        p.quietTimer = null;
        try { verifyQuiet(id, armedSeq); } catch { /* 兜底失败不影响主流程 */ }
      }, wait);
      if (p.quietTimer && typeof p.quietTimer.unref === 'function') p.quietTimer.unref();
    }

    /**
     * 静默期到点：先验"期间没人动过"（防 ABA），再重跑判据，全干净才播。
     *
     * ABA 场景：窗口期内"瞬间启动又结束"（子代理刚被唤醒又立刻 idle），
     * 前后快照可能完全一样，只有 activitySeq 能证明"中间动过"。
     */
    function verifyQuiet(id, armedSeq) {
      const p = pendingDone.get(id);
      if (!p) return;
      // 先跑判据，再交给纯函数裁决（顺序由 quietVerdict 保证：先验序号，再认 still-busy）
      const why = gateHoldReason(id, 'quiet-verify');
      const verdict = quietVerdict({
        armedSeq, activitySeq, holdReason: why, quietMs: quietMsOf(),
      });
      if (verdict === 'quiet-disabled') {
        // 挂起期间用户把静默期关了 → 回到即时放行（一步回退不卡死）
        flushPending(id, { quiet: 0, resets: p.quietResets || 0 });
        return;
      }
      if (verdict === 'activity-since-arm') {
        // 起窗后动过（含 ABA：瞬间启动又结束，快照看不出差别）→ 重新计时
        p.quietResets = (p.quietResets || 0) + 1;
        appendNotifyLog('[idle-gate] quiet reset '
          + `sess=${sessionKey(p.session)} seq=${armedSeq}->${activitySeq}`, { detail: true });
        armQuiet(id);
        return;
      }
      if (verdict === 'still-busy') {
        // 这 1.5 秒里又忙起来了：**短退避**再看一眼，而不是"撂挑子等事件"。
        // 原因：gateHoldReason 可能返回 agent-unavailable / turn-boundary-unavailable
        // 这类"读不到"的原因，而它们**没有**必然后续边沿事件 → 一旦只等事件，
        // 这条挂起项就饿到 10 分钟超时兜底（那时播的是进度提醒，不是完成语音）。
        // 退避取 min(quietMs, 500)：既是轮询的安全上限，也不会退化成高频空转。
        appendNotifyLog(`[idle-gate] quiet keep sess=${sessionKey(p.session)} reason=${why}`, { detail: true });
        armQuiet(id, quietBackoffMs(quietMsOf()));
        return;
      }
      flushPending(id, { quiet: quietMsOf(), resets: p.quietResets || 0 });
    }

    function reevaluatePending(trigger) {
      if (pendingDone.size === 0) return;
      for (const id of [...pendingDone.keys()]) {
        // 上一项的处理可能已经把它从表里删了（放行后即出表）
        if (!pendingDone.has(id)) continue;
        if (gateHoldReason(id, trigger) !== null) continue;
        // 判据全过 ≠ 立刻播：先进静默期，到点且期间没人动才播（v0.5.11）
        armQuiet(id);
      }
    }

  /** completed / error / blocked / 其它 四分支 → 文案 + 门控 → 交给空闲门。 */
  function handleDone(session, agent, kind, evKey) {
    let gate;
    let psKind;
    let title;
    let body;
    if (kind === 'completed') {
      gate = cfg.notifyOnComplete; psKind = 'done';
      title = 'DSH 任务完成'; body = '一轮任务跑完了，回来看看结果吧';
    } else if (kind === 'error') {
      // v0.3.1：error 改播 fail 语句池（日语道歉语音，用户 2026-10-17 拍板）。
      // 池缺失时由 ps1 侧落到系统蜂鸣——**不**回落到 done 池（否则会播成"完成了"）。
      gate = cfg.notifyOnError; psKind = 'fail';
      title = 'DSH 回合出错'; body = '上一轮回合以错误结束，回来看看出了什么问题';
    } else if (kind === 'blocked') {
      // blocked = 消息/目标轮次被 preStep 拦下、**根本没跑起来**（见 dsh-agent-loop:941），
      // 不是"跑了但失败"，故维持蜂鸣而非 fail 池的"失败"台词（语义不同，别混）。
      // 实测：近 20 天 932 个会话中 "kind":"blocked" 命中 0 次，属极罕见路径。
      gate = cfg.notifyOnBlocked; psKind = 'chime';
      title = 'DSH 回合被阻塞'; body = '回合已阻塞，可能需要你介入处理';
      } else if (kind === 'max-tokens') {
        // ⚠️ v0.4.68（第 3 批 3.3）：max-tokens **单独一档，默认提醒**。
        // 原先它和 aborted/interrupted/forked 一起走 notifyOnAborted（默认关），
        // 于是「Agent 没干完就没 token 了」被完全静默 —— 用户以为它在正常跑。
        // 数据：2195 个会话里出现 5 次，罕见但每次都是静默停摆。
        gate = cfg.notifyOnMaxTokens; psKind = 'chime';
        title = 'DSH 回合因长度上限中断';
        body = '这一轮没跑完就撞到 token 上限了，任务可能没完成';
      } else {
        // aborted / interrupted / forked：用户主动取消或会话分叉，默认静默。
        gate = cfg.notifyOnAborted; psKind = 'chime';
        title = 'DSH 回合提前结束'; body = '回合结束原因：' + (kind || 'unknown');
    }
    // ── Toast 标题改用会话标题（v0.4.62）─────────────────────────────────
    //
    // 用户指出：既然点 Toast 跳不到对应会话，那至少让标题告诉用户
    // "是哪个会话完成了"。DSH 的侧栏标题就是首句话摘要，比「DSH 任务完成」有用。
    // 只用「看起来像标题」的结果 —— 拿不到真标题时 sessionTitleOf 会退回
    // 会话 id 前缀（如 session-2cc3），那东西当 Toast 标题毫无意义，还不如通用文案。
    const sTitle = sessionTitleOf(session);
    if (sTitle && !/^session[-_]?/i.test(sTitle) && sTitle !== '未知会话') title = sTitle;

    // 事件类别开关关闭 → 不播
    if (!gate) {
      // 必须报**真实生效的配置键**，不能从 kind 名拼。
      // 独立审查 2026-10-17 指出：原先用 `notifyOn${kind首字母大写}`，
      // 对 max-tokens/interrupted/forked 会拼出 `notifyOnMax-tokens` 这类不存在的键。
      const gateKey = kind === 'completed' ? 'notifyOnComplete'
        : kind === 'error' ? 'notifyOnError'
          : kind === 'blocked' ? 'notifyOnBlocked'
            : kind === 'max-tokens' ? 'notifyOnMaxTokens'
              : 'notifyOnAborted';
      skipLog('switch-off', kind, session, `${gateKey}=false`);
      return;
    }
    // 空闲门只对「完成」生效：error/blocked 是**当下就需要人介入**的信号，
    // 等子代理结束再报会延误处理；它们立即播报（error 走 fail 语句池，不进空闲门）。
    if (cfg.idleGate && kind === 'completed' && agent) {
      scheduleOrNotify(session, agent, psKind, title, body);
      return;
    }
    emitDone(session, psKind, title, body, evKey);
  }

  /** 审批提醒正文。 */
  function approvalBody(toolName, reason) {
    return '待批准：' + (toolName || '未知') + (reason ? '，' + reason : '');
  }

  /**
   * approval/asked（SessionEventMap 审计事件，带稳定 id）：主提醒路径。
   * 幂等：同 id 只提醒一次；同会话同工具在去抖窗内只响一次（连串审批）。
   */
  function handleApprovalAsked(session, data) {
    // 审批提醒：开关关闭、或该会话被过滤（子代理）→ 不播
    if (!cfg.notifyOnApproval || !shouldNotifySession(session)) {
      skipLog(cfg.notifyOnApproval ? 'subagent-filtered' : 'switch-off', 'approval', session,
        cfg.notifyOnApproval ? 'subagents=false' : 'notifyOnApproval=false');
      return;
    }
    const id = data && data.id ? 'id:' + String(data.id) : '';
    const toolName = (data && data.toolName) || '未知';
    const reason = data && data.reason ? String(data.reason) : '';
    const now = Date.now();
    const stKey = 'session:' + sessionKey(session) + '|' + toolName;
    if (isRecent(approvalSeen, stKey, now, cfg.approvalDebounceMs)) {
      skipLog('debounce', 'approval', session, `same tool within ${Math.round(cfg.approvalDebounceMs / 1000)}s`);
      return;
    }
    if (id && approvalSeen.has(id)) {
      skipLog('dedupe', 'approval', session, `already-notified id=${id}`);
      return;
    }
    rememberAt(approvalSeen, stKey, now);
    if (id) rememberAt(approvalSeen, id, now);
    notify('approval', 'DSH 需要你确认', approvalBody(toolName, reason), session);
  }

  /** approval/decided：清除该请求的幂等标记，之后的同类新审批可再次提醒。 */
  function handleApprovalDecided(data) {
    const id = data && data.id ? 'id:' + String(data.id) : '';
    if (id) approvalSeen.delete(id);
  }

  /**
   * 会话标题（正文线索 + v0.4.62 起兼作 Toast 标题）。
   *
   * 三级来源（前一级拿不到就试下一级）：
   *   ① `sessionTitle` 服务 —— 宿主自己维护的标题（支持 rename），最权威；
   *   ② `sessionProjections` 的 `title` 投影 —— 2026-10-19 实测 436 个会话全部有，
   *      内容通常就是用户首句摘要（「优化Deepseek Harness配置与插件」）；
   *   ③ 会话 id 前 12 位 —— 丑陋但至少能区分（旧插件 :433-439 同构）。
   *
   * ⚠️ 为什么要有 ②：① 在某些宿主版本/时机下取不到（服务缺失或尚未生成），
   * 而投影缓存里已经有标题了。两者都拿不到才退回 id。
   */
  function sessionTitleOf(session) {
    try {
      const svcTitle = svc('sessionTitle');
      const snap = svcTitle && typeof svcTitle.get === 'function' ? svcTitle.get(session) : undefined;
      if (snap && snap.title) return String(snap.title);
    } catch { /* 服务不可用 → 试下一级 */ }
    try {
      const proj = svc('sessionProjections');
      if (proj && typeof proj.stateOf === 'function') {
        const v = proj.stateOf(session, 'title');
        // 防御两种形状：直接字符串，或 { ver, seq, val } 行。
        const s = typeof v === 'string' ? v : (v && typeof v.val === 'string' ? v.val : '');
        const t = String(s || '').trim();
        if (t) return t;
      }
    } catch { /* 投影不可用 → 退回 id */ }
    const k = sessionKey(session);
    return k === '__unknown__' ? '未知会话' : k.slice(0, 12);
  }

  /** 提问提醒（方案C）：tool/call 命中提问工具 → kind=question（question 语句池语音）。
   *
   * v0.5.7（issue #5）：多一个 `idOverride`。
   * PTC/code-mode 下提问工具不是顶层 `tool/call`，而是 `run_code` 里的子调用，
   * 它没有自己的 callId，唯一标识是 `tool/ptc-dispatch-start` 的 `subCallId`。
   */
  function handleQuestionCall(session, d, idOverride) {
    if (!d || !QUESTION_TOOLS.has(d.name)) return;
    if (!cfg.notifyOnQuestion || !shouldNotifySession(session)) {
      skipLog(cfg.notifyOnQuestion ? 'subagent-filtered' : 'switch-off', 'question', session,
        cfg.notifyOnQuestion ? 'subagents=false' : 'notifyOnQuestion=false');
      return;
    }
    const callId = String(idOverride !== undefined && idOverride !== null ? idOverride : (d.callId || ''));
    const key = sessionKey(session) + ':' + callId;
    const now = Date.now();
    if (isRecent(questionSeen, key, now, QUESTION_TTL_MS)) {
      skipLog('dedupe', 'question', session, `same callId=${callId} already notified`);
      return;
    }
    rememberAt(questionSeen, key, now);
    const q = questionSummary(d.name, d.arguments);
    notify('question', 'DSH 在等你回答', '[' + sessionTitleOf(session) + '] ' + q.text + q.hint, session);
  }

  /** tool/result 配对（content[0].toolCallId ↔ tool/call.callId）→ 清理标记（回答已产生）。 */
  function handleQuestionResult(session, d) {
    const cid = d && d.message && d.message.content && d.message.content[0] && d.message.content[0].toolCallId;
    if (cid) questionSeen.delete(sessionKey(session) + ':' + String(cid));
  }

  /**
   * PTC / code-mode 的提问提醒（v0.5.7，issue #5）。
   *
   * 背景：PTC 模式下模型拿到的是 `run_code` 这一个工具，提问工具是在 JS 程序里
   * 被派发的**子调用**。所以顶层 `tool/call` 的 `name` 恒为 `run_code`，
   * `handleQuestionCall` 的 `QUESTION_TOOLS` 判定永远不命中 —— 通知一声不响，
   * 用户只能干等（issue #5 原话："在 code-mode 下永远不会触发"）。
   *
   * 真名与真参数只在 `tool/ptc-dispatch-start` 里（宿主
   * `dsh-tools/lib/types/types.d.ts` 的 `PtcDispatchStartEventData`）。
   * 它没有 callId，唯一标识是 `subCallId`（形如 `<parent>:ptc:<n>`），
   * 所以幂等键换成它 —— 与顶层路径共用同一个 `questionSeen`，
   * 两条路径不会互相顶掉（键前缀不同：callId vs subCallId）。
   *
   * ⚠️ 该事件是 log-only（`deriveMessages()` 忽略它），不会被旧宿主"补发"，
   * 所以没这个能力的宿主上这段就是死代码，不影响任何现有行为。
   */
  function handlePtcDispatchStart(session, d) {
    if (!d) return;
    handleQuestionCall(session, d, d.subCallId);
  }

  /**
   * 子调用结算 → 清理幂等标记（与 `handleQuestionResult` 同理）。
   *
   * 为什么必须清：`questionSeen` 的 TTL 是 30 分钟，而同一次 `run_code` 里
   * 反复调用同名工具很常见。不清的话，"上一轮问过"会挡住"这一轮又问"
   * —— 表现就是第二条提问静默消失，比完全不响更难排查。
   */
  function handlePtcDispatchSettled(session, d) {
    const sid = d && d.subCallId;
    if (sid) questionSeen.delete(sessionKey(session) + ':' + String(sid));
  }

  console.log(`[dsh-notify-say] active (complete=${cfg.notifyOnComplete} error=${cfg.notifyOnError} `
    + `blocked=${cfg.notifyOnBlocked} aborted=${cfg.notifyOnAborted} approval=${cfg.notifyOnApproval} `
    + `question=${cfg.notifyOnQuestion} voice=${cfg.voice}/${cfg.voiceMode} debounce=${Math.round(cfg.debounceMs / 1000)}s `
    + `idleGate=${cfg.idleGate} idleGateTimeout=${Math.round(cfg.idleGateTimeoutMs / 1000)}s)`);

  // ── 精准跳转：启动时同步协议注册状态（v0.4.70）────────────────────────
  //
  // 开关开着就注册 dshnotify-say://（HKCU，无需管理员）；关着就确保已注销。
  // 注册失败会被降级为 dsh://open —— 「点了没反应」比「跳不到会话」更糟。
  try {
    // ⚠️ 必须先 refreshConfig：apply 刚跑时 cfg 还是模块初始值，
    // 用户在设置页开的 toastJumpSession 还没读进来 —— 不刷新会误判成关着
    // （2026-10-19 实测：日志出现 state=off，协议没注册）。
    refreshConfig();
    const okProto = syncJumpProtocol();
    appendNotifyLog(`[jump-proto] state=${jumpProtoState} usable=${okProto}`);
  } catch (e) {
    jumpProtoState = 'failed';
    appendNotifyLog('[jump-proto] sync failed: ' + String((e && e.message) || e));
  }

  // ── 会话事件流：turn/end 记 reason + approval/asked、approval/decided 审计对 + 提问 ──
  ctx.on('session/event', (session, event) => {
    // v0.4.36：记一次"事件到达"。
    //
    // 用途只在排查：热重载窗口内如果有事件到达但没播报，
    // 重载完成后会打印差值，让"漏播"可被区分出来。
    // 不影响任何播报行为。
    bumpEventCount()
    // v0.4.65 诊断：记录事件类型与关键字段，用于判断 turn/start 的来源
    try {
      recentEvents.push({
        t: Date.now(),
        type: event && event.type,
        sess: session && session.id,
        // 只保留小的标量字段，避免把正文也记进去
        data: (() => {
          const d = event && event.data;
          if (!d || typeof d !== 'object') return d;
          const out = {};
          for (const k of Object.keys(d)) {
            const v = d[k];
            if (v === null || ['string','number','boolean'].includes(typeof v)) out[k] = v;
            else if (typeof v === 'object') out[k] = '{obj:' + Object.keys(v).slice(0,6).join(',') + '}';
          }
          return out;
        })(),
      });
      if (recentEvents.length > 40) recentEvents.shift();
    } catch { /* 诊断不影响主流程 */ }
    try {
      const type = event && event.type;
      if (type === 'turn/end') {
        // ⚠️ v0.4.68（第 3 批）：**error / blocked 当场播报，不等 idle 边沿**。
        //
        // 原先是「turn/end 只记账 → 等 agent/status 转 idle 再读记账播报」。
        // 这条链多了一个脆弱依赖：那个 idle 边沿若没来（或晚来、或被别的状态
        // 穿插），错误就永远不播。用户 2026-10-19 的实测正是如此 —— 出错时没
        // 有语音，是他自己看到界面红色提示、手动发了「继续工作」才开始下一轮。
        //
        // 数据支撑（2195 个真实会话 / 6262 条 turn/end）：
        //   同一 turn 出现多条 turn/end: 0   ← 提前播不会重复
        //   同一 turn 出现多种 kind:     0   ← 不会与 completed 冲突
        //
        // 分工：
        //   error / blocked → 当场播（错误要立刻叫人，等 idle 没意义）
        //   completed / 其它 → 仍记账等 idle（合并多轮 + 走空闲门）
        const endTurn = event && event.data && typeof event.data.turn === 'number'
          ? event.data.turn
          : undefined;
        const endKind = reasonKindOf(event.data);

        if (endKind === 'error' || endKind === 'blocked') {
          // 随手拿 agent（用于 shouldNotifySession 的子代理判定）；拿不到也行。
          let a;
          try {
            const as = svc('agents');
            if (as && typeof as.get === 'function') a = as.get(sessionKey(session));
          } catch { a = undefined; }

          if (!shouldNotifySession(session) && endKind === 'error') {
            // 子代理的 error：受独立开关控制（v0.4.68 新增 notifyOnSubagentError）。
            if (!cfg.notifyOnSubagentError) {
              skipLog('subagent-error-off', endKind, session, 'notifyOnSubagentError=false');
              return;
            }
          }

          const evKey = endTurn !== undefined ? `turn:${sessionKey(session)}:${endTurn}` : undefined;
          // 直接走 handleDone：它内部对非 completed 的 kind 是立即 emitDone，
          // 不进空闲门。evKey 与 idle 路径同键，万一两条都走到会被互斥层拦住。
          try {
            handleDone(session, a, endKind, evKey);
          } catch (e) {
            console.warn('[dsh-notify-say] turn/end immediate notify failed: ' + String((e && e.message) || e));
          }
          // 不写 lastTurnEnd —— 避免 idle 路径再播一次。
          return;
        }

        // completed 及以后的其他 kind：仍记账，等 idle 边沿统一处理。
        // （v0.4.66：带 turn 号，消费时校验，防止复用上一轮的 reason。）
        rememberBounded(lastTurnEnd, sessionKey(session),
          { kind: endKind, turn: endTurn, at: Date.now() },
          Date.now(), (v) => v && v.at);
      } else if (type === 'approval/asked') handleApprovalAsked(session, event.data);
      else if (type === 'approval/decided') handleApprovalDecided(event.data);
      else if (type === 'tool/call') handleQuestionCall(session, event.data);
      else if (type === 'tool/result') handleQuestionResult(session, event.data);
      else if (type === 'tool/ptc-dispatch-start') handlePtcDispatchStart(session, event.data);
      else if (type === 'tool/ptc-dispatch') handlePtcDispatchSettled(session, event.data);
    } catch (e) {
      // 只读旁路：观测/提醒失败绝不影响会话
      console.warn('[dsh-notify-say] session/event handler failed: ' + String((e && e.message) || e));
    }
  }, { global: true });

  // ── 收件箱入队边沿：消息进队列 = "马上要干活"的最早信号（v0.5.11）─────────
  // 为什么需要它：交接那条结算消息走的正是 inbox 投递，它比 agent/status 晚
  // 139~172ms（见 armQuiet 的考古注释）。父代理从 idle 被唤醒之前，先有这个
  // 边沿；只靠"父代理变 running"来兜底太晚 —— 静默窗若恰好在这一瞬到点，
  // 就会在消息落地前放行。多这一路信号是正交的：不认子代理、不看 jobs，
  // 只认"有东西进了收件箱"。
  ctx.on('agent/inbox/inserted', () => {
    try { markActivity(); } catch { /* 记账失败不该影响投递本身 */ }
  }, { global: true });

  // ── agent 状态边沿：running→idle 判完成；任何变化都重估挂起项 ────────────
  // 依据：agent/status 文档「idle means no driver remains scheduled or active」
  // （dsh-agent/lib/types/runtime-types.d.ts:247）。
  // ⚠️ v0.5.11 修正：旧注释把"子代理 idle"当成唤醒信号，那正是误播的根源 ——
  // 子代理 idle 时父代理的收件箱**还没**收到结算消息，此刻的快照看起来是
  // 真空闲。现在它只算"一次活动"（重置静默窗），不再等于"可以播了"。
  ctx.on('agent/status', (payload) => {
    try {
      const agent = payload && payload.agent;
      if (!agent) return;
      const status = payload.status;
      const id = String(agent.id);
      const prev = prevStatus.get(id);
      // 有界记账（值带时间戳，供 TTL 清理用；读边沿时取 .status）
      rememberBounded(prevStatus, id, { status, at: Date.now() }, Date.now(), (v) => v && v.at);
      // v0.5.11：只有**状态值真的变了**才算一次活动（静默窗的重置信号）。
      // 重复推送同一状态不能重置窗口，否则窗口永远等不到尾沿。
      if (!prev || prev.status !== status) markActivity();
        // ⚠️ v0.4.65：done-edge 事件**不能**先 reevaluate，否则同一事件里
        // 会先 flush 旧挂起项（播一次）、再走 handleDone（又播一次）——
        // 2026-10-19 实测用户听到两个语音，就是这么来的。
        // 规则：本轮结束的边沿 → 交给 handleDone 统一处理（它会创建或合并 pending）；
        // 其它状态变化（子代理结束等）→ 重估挂起项，唤醒等待中的通知。
        const isDoneEdge = status === 'idle' && prev && prev.status === 'running';
        const willHandleDone = isDoneEdge && shouldNotifySession(agent.session);
        if (!willHandleDone) {
          reevaluatePending('agent/status');
        }
      if (status !== 'idle' || !prev || prev.status !== 'running') return;
      if (!shouldNotifySession(agent.session)) {
        // 这是**最常见**的一类"不播"：子代理会话完成、而 subagents=false。
        // 独立审查 2026-10-17 指出这里原先漏了留痕，恰是用户最想在日志里看到的。
        const rec0 = lastTurnEnd.get(sessionKey(agent.session));
        skipLog('subagent-filtered', rec0 && rec0.kind ? rec0.kind : 'completed',
          agent.session, 'subagents=false');
        return;
      }
      const rec = lastTurnEnd.get(sessionKey(agent.session));
      // ⚠️ v0.4.66：**不能**再「取不到 reason 就当 completed」。
      //
      // 外部审查指出两个方向性风险：
      //   ① agent/status idle 早于 turn/end: error 到达 → 错误被播成「完成」
      //   ② lastTurnEnd 从不消费 → 某轮没有 turn/end 时会复用上一轮的 reason
      //
      // 两条都会把「出错」说成「完成」，比不播更糟（用户以为成功就不去看了）。
      // 所以：消费即删除；轮次对不上视为未知；未知**不播完成**。
      lastTurnEnd.delete(sessionKey(agent.session));

      // 校验轮次：turnBoundary 的 lastTurn 是权威的「这是第几轮」。
      const tbDone = turnBoundaryOf(agent.session);
      const curTurn = tbDone ? tbDone.lastTurn : undefined;
      // 只有两边都能拿到轮次时才校验。拿不到时 turnOk = undefined，
      // 下面按「放行」处理 —— 否则没有 sessionProjections 的环境会丢掉所有通知
      // （2026-10-19 回归实测：audio-wiring 的 11 条用例因此失败）。
      const canVerifyTurn = !!(rec && rec.turn !== undefined && curTurn !== undefined);
      const turnOk = canVerifyTurn ? rec.turn === curTurn : undefined;

      if (!rec || !rec.kind) {
        // 没有结束原因：不播「完成」，只留痕。
        appendNotifyLog(`[skip] reason-missing id=${id} `
          + `(not treated as completed; turn/end may arrive later)`);
        return;
      }

      if (turnOk === false) {
        // reason 属于别的轮次 —— 绝不能用（否则上一轮的 error 会污染本轮）。
        appendNotifyLog(`[skip] reason-stale id=${id} rec.turn=${rec.turn} curTurn=${curTurn}`);
        return;
      }

      handleDone(agent.session, agent, rec.kind);
    } catch (e) {
      console.warn('[dsh-notify-say] agent/status handler failed: ' + String((e && e.message) || e));
    }
  }, { global: true });

  // ── 后台任务可见集变化 → 重估挂起项（"最后一个任务结束"的唤醒路径）────────
  //
  // ⚠️ 2026-10-19 实测修正：ctx.jobs **没有 onJobsChanged 方法**。
  // 之前写 `if (typeof js.onJobsChanged === "function")` 条件永远不成立，
  // 于是订阅被静默跳过 → 空闲门挂起后没有任何唤醒路径 →
  // 只能等 idleGateTimeoutMs（10 分钟）兜底，产出的是 timeout-fallback。
  //
  // DSH 官方用法（app.asar 的 streamJobRows）：
  //     registry.events.subscribe({ owners: "all" }, (event) => { ... })
  // `events` 是**属性**不是方法。
  //
  // 保留 onJobsChanged 旧路径：万一别的 DSH 版本提供它，照样能用。
  try {
    const js = svc('jobs');
    const onAny = () => {
      try { reevaluatePending('jobs-changed'); } catch (e) {
        console.warn('[dsh-notify-say] jobs-changed reevaluate failed: ' + String((e && e.message) || e));
      }
    };
    if (js && js.events && typeof js.events.subscribe === 'function') {
      ctx.effect(() => js.events.subscribe({ owners: 'all' }, (event) => {
        // 输出流事件太频繁，与"任务是否结束"无关，直接忽略。
        if (event && event.type === 'output') return;
        // v0.5.11：jobs 的每个非 output 事件都是状态边沿（启动/结束/中止）
        // → 重置静默窗。output 已在上行 return，不会被高频输出饿死窗口。
        markActivity();
          // ⚠️ v0.4.66（第 2 批 P0-②）：后台 job 失败要有**独立提醒**。
          // 原先这里只调 onAny()（重估空闲门），完全不看 job 的结算状态，
          // 于是「后台任务失败、主回合没产生 error」时用户听不到任何声音。
          try { handleJobFailure(event); } catch (e) {
            console.warn('[dsh-notify-say] job failure handling failed: ' + String((e && e.message) || e));
          }
        onAny();
      }), 'dsh-notify-say: jobs-events');
    } else if (js && typeof js.onJobsChanged === 'function') {
      // 旧版兜底路径（实测当前 DSH 没有，但保留以防版本差异）。
      ctx.effect(() => js.onJobsChanged(onAny), 'dsh-notify-say: jobs-changed');
    } else {
      console.warn('[dsh-notify-say] 订阅 jobs 变化失败：既没有 jobs.events.subscribe，也没有 onJobsChanged。'
        + ' 空闲门将只能依赖 idleGateTimeoutMs 兜底（会产出 timeout-fallback）。');
    }
  } catch (e) {
    console.warn('[dsh-notify-say] 订阅 jobs 变化抛错: ' + String((e && e.message) || e));
  }

  // ── 卸载清理：挂起计时器与状态（监听器由插件 fiber 自动回收）──────────────
  ctx.effect(() => () => {
    for (const p of pendingDone.values()) {
      clearTimeout(p.timer);
      // v0.5.11：静默期定时器必须一起清 —— 热重载时旧实例若留着它会
      // 在卸载后照样 flush 一次（幽灵播报），用户以为"插件都关了还响"。
      if (p.recheckTimer) clearTimeout(p.recheckTimer);
      if (p.quietTimer) clearTimeout(p.quietTimer);
    }
    pendingDone.clear();
    prevStatus.clear();
    lastTurnEnd.clear();
      // ⚠️ v0.4.73：**不在这里注销协议**。
      //
      // 这个清理函数在**热重载时也会执行**（旧实例 dispose），
      // 于是会把用户刚注册好的协议注销掉 —— 2026-10-20 00:21 实测：
      //     [jump-proto] unregistered dshnotify-say://
      // 之后所有 Toast 的 launch 又变回 dsh://open，点了一点反应没有。
      //
      // 正确的注销时机只有两个：
      //   ① 用户在设置里关掉 toastJumpSession（syncJumpProtocol 负责）
      //   ② 插件真的被卸载（不在此 hook，靠用户重装/卸载动作）
      //
      // 留一条注释在这里，防止后人又把它加回来。
    // v0.4.63：长轮询的挂起响应也要结束掉。不做的后果是热重载后
    // 旧连接永远等不到响应，客户端不会再发新的 /wait（它以为还在等）。
    try { bridge.disposeAllWaiters(); } catch { /* 卸载期失败不影响退出 */ }
    // v0.6.0：播放通道也要收干净 —— 关掉所有 SSE 长连、清 claim/ack 定时器、
    // 删掉没被消费的临时 wav。不做的话热重载后旧 SSE 还挂着，
    // 前端会以为通道可用，而旧实例早已不再广播（"看着连着、其实没人推"）。
    try { audioChannel.dispose(); } catch { /* 卸载期失败不影响退出 */ }
  }, 'dsh-notify-say: pending timers');

  // ── 审批 waterfall：必须 next() 放行并透传返回值，绝不阻断、不改写 ──────
  // 接缝证据：dsh-user-approval/lib/index.js:176（fail-closed 默认保持官方语义）。
  // 主要提醒路径是 approval/asked；本 listener 是放行同刻的兜底提醒（asked 先于
  // waterfall 入账，正常情况下会被上面的去抖去重，只在 asked 不可观测时兜底）。
  ctx.on('approval/request', (req, next) => {
    try {
      const session = req && req.agent && req.agent.session;
      if (cfg.notifyOnApproval && shouldNotifySession(session)) {
        const toolName = req && req.toolName;
        const reason = req && req.reason ? String(req.reason) : '';
        const now = Date.now();
        const stKey = 'session:' + sessionKey(session) + '|' + (toolName || '未知');
        if (!isRecent(approvalSeen, stKey, now, cfg.approvalDebounceMs)) {
          rememberAt(approvalSeen, stKey, now);
          notify('approval', 'DSH 需要你确认', approvalBody(toolName, reason), session);
        }
      }
    } catch {
      // 通知侧任何失败都不影响审批链；next() 在 try 外调用
    }
    return next();
  }, { global: true });

  // ── host → client 桥（两条 route，同一前缀）────────────────────────────────
  //
  // client 跑在 sandbox 渲染进程里（无 process、无 fs），既拿不到"刚才是哪个会话
  // 通知的"，也改不了配置。官方正路：host 注册 /api/… route，client 用 fetch
  // （本机先例 dsh-our-free-model）。
  //
  //   1. session bridge：点 Toast 后跳到对应会话
  //   2. config route ：设置卡片里直接读写音量/音色/开关（改完立即生效）
  //
  // 稳定性：`webServer` 是**可选依赖**，拿不到就整体跳过；
  // Toast 与语音完全不受影响 —— 这两条都是增强，不是主功能。
  try {
    if (ctx && typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (scoped) => {
        try {
          const server = scoped && scoped.webServer;
          if (!server || typeof server.register !== 'function') return;

          // v0.4.76：把**当前端口**写进 port.txt，供 jump-handler.ps1 读取。
          //
          // ⚠️ 为什么必须写：DSH 每次启动端口都变（实测见过 53523 / 50061 /
          // 59525 / 58163），而 handler 只能靠"猜几个常见端口"——猜不到就
          // 写不进 pending-jump，点 Toast 毫无反应（2026-10-20 实测踩到）。
          try {
            const portCandidates = [];
            for (const k of ['port', 'listenPort', 'actualPort']) {
              const v = server && server[k];
              if (typeof v === 'number' && v > 0) portCandidates.push(v);
            }
            try {
              if (typeof server.address === 'function') {
                const a = server.address();
                if (a && typeof a.port === 'number' && a.port > 0) portCandidates.push(a.port);
              }
            } catch { /* ignore */ }
            for (const k of ['DSH_PORT', 'DSH_WEB_PORT', 'PORT']) {
              const v = Number(process.env[k]);
              if (Number.isFinite(v) && v > 0) portCandidates.push(v);
            }
            const detectedPort = portCandidates[0];
            if (detectedPort) {
              const dir = join(process.env.LOCALAPPDATA || process.env.TEMP || '.', 'dsh-notify-say');
              try { mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
              writeFileSync(join(dir, 'port.txt'), String(detectedPort), 'utf8');
              appendNotifyLog(`[jump-proto] port.txt -> ${detectedPort}`);
            } else {
              appendNotifyLog('[jump-proto] 拿不到端口，port.txt 未写（handler 只能猜）');
            }
          } catch (e) {
            appendNotifyLog('[jump-proto] 写 port.txt 失败: ' + String((e && e.message) || e));
          }

          const reg = () => server.register(
            { kind: 'prefix', path: ROUTE_PREFIX, handler: (req, res) => {
              // 同一前缀下按路径分流：`/config…` 走配置读写，其余走会话桥。
              //
              // ⚠️ 必须按**路径段**判断，不能用 `url.indexOf('/config') >= 0`：
              // 子串匹配会被查询串里的内容骗到（例如 `/consume?next=/config`）。
              // 这里取 pathname 再去掉前缀，只比较第一段。
              try {
                const raw = String((req && (req.url || req.path)) || '');
                const pathname = raw.split('?')[0].split('#')[0];
                const rest = pathname.startsWith(ROUTE_PREFIX)
                  ? pathname.slice(ROUTE_PREFIX.length)
                  : pathname;
                const head = rest.replace(/^\/+/, '').split('/')[0];
                // ── 本地来源防护（v0.4.24）─────────────────────────────────
                //
                // ⚠️ 实测 2026-10-18：宿主 /api 网关有鉴权（无凭据 401），
                // 但插件 webServer.register 的路由**不在保护范围内** ——
                // 不带凭据 POST config/set 返回 200 且真的改了配置。
                // 恶意网页可用 <img>/<form> 触发本机回环请求（不触发 CORS 预检）。
                //
                // 防护逻辑见 lib/http-guard.js。这里做"分流前的总闸"，
                // 各端点内部的限流用 throttle()。

                // ── 写操作判定（v0.4.39 扩展）──────────────────────────────
              //
              // ⚠️ 原来只认 config/set 与 consume，而 v0.4.32+ 新增的三个接口
              // **都会写本机文件**却没被标成写操作：
              //   · voicepacks/install    下载并解压到用户目录
              //   · voicepacks/uninstall  删除用户目录下的音色
              //   · diagnostics           把日志脱敏后写入磁盘
              //
              // 后果：这些请求按「只读」放行 —— 不做 Origin/跨站检查，
              // 也不强制 JSON content-type，与模块自己的安全契约不符。
              // （外部审阅 2026-10-18 指出。）
                // ── 精准跳转：Toast 点击的待跳转会话（v0.4.70）────────────────
                //
                // jump-handler.ps1 收到 dshnotify-say://jump?session=xxx 后 POST 到这里，
                // 前端在窗口可见时 GET 并消费。
                //
                // 为什么需要它：点 Toast 走自有协议能**精确知道**是哪个会话，
                // 而 dsh://open 无法携带参数（DSH 本体硬编码精确匹配）。

                // ══ 来源防护总闸（v0.4.83 位置修正）══════════════════════════
                //
                // ⚠️ **这段必须在任何端点处理之前**。
                //
                // 2026-10-20 实测发现（真机复现，不是推测）：
                // `/log` 与 `/pending-jump` 原本写在 guard 之前、各自 `return`，
                // 于是**完全绕过了来源检查**。跨站网页只要发一个请求：
                //
                //     fetch('http://127.0.0.1:<port>/api/dsh-notify-say/pending-jump',
                //           { method:'POST', mode:'no-cors',
                //             body: '{"sessionId":"session-attacker"}' })
                //
                // 就能让 DSH **自动跳到攻击者指定的会话**（实测日志：
                // `[jump-click] ... from=https://evil.example.com`，1 秒后
                // `openSession CALL`）。`/log` 同理可被用来刷日志。
                //
                // 所以这里把 guard 提到最前面：先过闸，再分流。
                // 顺序错了就等于没有防护 —— 这正是"安全检查写在错误的位置"
                // 这类缺陷最难靠读代码发现的地方（写是写了，但没挡住）。
                //
                // 已知的合法调用方（都要能通过）：
                //   · DSH 前端（同源 fetch，带 Origin: http://127.0.0.1:<port>）
                //   · jump-handler.vbs（显式带 Origin + JSON content-type）
                // 两者都满足 `checkLocalOrigin` 的契约，不会被误拦。
                //
                // ⚠️ 「写操作」必须按**方法**细分，不能只按路由名判断。
                // `/pending-jump` 同时支持：
                //     POST → 写入待跳转（写操作，必须 JSON）
                //     GET  → 读取并消费（**前端就是这么调的，不带 content-type**）
                // 若把整个路由标成 write，GET 会因为「缺 JSON content-type」
                // 被 403 拦掉 —— 跳转链路当场断掉（2026-10-20 修安全时踩到，
                // 幸好回归测试立刻发现：jump-click 有、jump-consume 没有）。
                const reqMethod = String((req && req.method) || 'GET').toUpperCase();
                const isWriteRoute =
                  (head === 'config' && /\/set\b/.test(pathname))
                  || head === 'consume'
                  // v0.4.63：/ack 只摘一条（前台跳转后确认），同样是写操作
                  || head === 'ack'
                  // v0.4.70：Toast 点击写入待跳转 —— **只有 POST 才是写**
                  || (head === 'pending-jump' && reqMethod === 'POST')
                  // v0.4.76：前端诊断日志（写 notify.log，也是写操作）
                  || head === 'log'
                  || head === 'diagnostics'
                  || (head === 'voicepacks' && (/\/install\b/.test(pathname) || /\/uninstall\b/.test(pathname)))
                  // v0.4.57：一次性自重载会 dispose 当前实例并重新求值模块，
                  // 是不可逆副作用，按写操作处理。
                  || head === 'reload'
                  // v0.6.0：/audio/ack 与 /audio/visible 都是 POST JSON 写操作。
                  // GET 的 stream / t/<token> 不算写 —— 它们没有副作用
                  // （token 认领是"消费"，但由服务端原子控制，且前端拿不到
                  //  额外能力：没有 token 就是 204）。
                  || (head === 'audio' && reqMethod === 'POST');

                const guard = checkLocalOrigin(req, { write: isWriteRoute });
                if (!guard.ok) {
                  try {
                    res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                    res.end(JSON.stringify({ ok: false, reason: guard.reason }));
                  } catch { /* 响应已发出 */ }
                  return;
                }
                // ══ 来源防护结束，以下才是各端点自己的逻辑 ═══════════════════

                // ── 前端诊断日志（v0.4.76）──────────────────────────────
                //
                // ⚠️ 这段曾经被回滚冲掉，导致前端所有 uiLog 静默丢失 ——
                // 排查「自动跳转」时因此完全看不到前端状态，白查了好几轮。
                // 前端 POST { msg } → 原样写进 notify.log，前缀 [ui]。
                if (head === 'log') {
                  try {
                    let rawBody = '';
                    req.on('data', (c) => { if (rawBody.length < 2048) rawBody += c; });
                    req.on('end', () => {
                      try {
                        const o = JSON.parse(rawBody || '{}');
                        const msg = String(o.msg || '').slice(0, 500);
                        if (msg) appendNotifyLog(`[ui] ${msg}`);
                        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                        res.end(JSON.stringify({ ok: true }));
                      } catch {
                        try { res.writeHead(400); res.end('{}'); } catch { /* ignore */ }
                      }
                    });
                    return;
                  } catch {
                    try { res.writeHead(500); res.end('{}'); } catch { /* ignore */ }
                    return;
                  }
                }

                if (head === 'pending-jump') {
                  const isPost = String((req && req.method) || 'GET').toUpperCase() === 'POST';
                  try {
                    if (isPost) {
                      // 读 body（小 JSON）
                      let rawBody = '';
                      req.on('data', (c) => { if (rawBody.length < 4096) rawBody += c; });
                      req.on('end', () => {
                        try {
                          const o = JSON.parse(rawBody || '{}');
                          const sid = String(o.sessionId || '');
                          // 白名单校验：只接受像会话 id 的字符串
                          if (/^[A-Za-z0-9_-]{4,128}$/.test(sid)) {
                            pendingJump = { sessionId: sid, at: Date.now() };
                            // v0.4.76：记来源，排查「谁写的 pending-jump」。
                            // 正常只有 jump-handler.ps1（点击 Toast）会写；
                            // 如果出现别的来源，说明有代码在自动触发。
                            const fromHdr = String((req.headers && req.headers.origin) || '-').slice(0, 40);
                            appendNotifyLog(`[jump-click] session=${sid} from=${fromHdr}`);
                            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                            res.end(JSON.stringify({ ok: true }));
                          } else {
                            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
                            res.end(JSON.stringify({ ok: false, reason: 'bad-session-id' }));
                          }
                        } catch {
                          try { res.writeHead(400); res.end('{}'); } catch { /* ignore */ }
                        }
                      });
                      return;
                    }

                    // GET：读并消费（一次性）
                    const now = Date.now();
                    let out = null;
                    if (pendingJump && now - pendingJump.at <= 120000) {
                      out = { sessionId: pendingJump.sessionId, at: pendingJump.at };
                      pendingJump = null;   // 消费即清，防重复跳
                      appendNotifyLog(`[jump-consume] session=${out.sessionId} age=${Math.round((now - out.at) / 1000)}s`);
                    } else if (pendingJump) {
                      appendNotifyLog(`[jump-expired] session=${pendingJump.sessionId} `
                        + `age=${Math.round((now - pendingJump.at) / 1000)}s (>120s)`);
                      pendingJump = null;
                    }
                    if (out) {
                      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                      res.end(JSON.stringify(out));
                    } else {
                      res.writeHead(204, { 'cache-control': 'no-store' });
                      res.end();
                    }
                  } catch {
                    try { res.writeHead(500); res.end('{}'); } catch { /* ignore */ }
                  }
                  return;
                }

                // ── 检查更新（v0.4.48）──────────────────────────────────
        //
        // **只读**：不下载、不覆盖文件、不执行命令。
        // 也刻意不放进 isWriteRoute —— 它没有任何副作用。
        //
        // 为什么不接受客户端传 URL：那等于让本机访问任意地址（SSRF）。
        // 查询地址固定在 update-check.js 里。
        // ── 一次性自重载（v0.4.57）──────────────────────────────────
        //
        // 用户 2026-10-18 明确要求：「点一下重载一下」，不要"开了就一直重载"。
        // 所以这里是**纯显式动作**：没有任何自动触发（watcher 已删除）。
        //
        // 只接受 POST —— 它不可逆。
        if (head === 'reload') {
          if (String((req && req.method) || 'GET').toUpperCase() !== 'POST') {
            try {
              res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', allow: 'POST' });
              res.end(JSON.stringify({ ok: false, reason: 'method-not-allowed' }));
            } catch { /* 响应已发出 */ }
            return;
          }
          if (!reloadOnce) {
            try {
              res.writeHead(503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
              res.end(JSON.stringify({ ok: false, reason: 'reload-unavailable' }));
            } catch { /* 响应已发出 */ }
            return;
          }
          // 限流：5 秒内只允许一次（防连点、也防脚本反复触发 dispose）
          const rlGate = throttle('reload', 5000);
          if (!rlGate.ok) {
            try {
              res.writeHead(429, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'retry-after': String(Math.ceil((rlGate.retryAfterMs || 1000) / 1000)) });
              res.end(JSON.stringify({ ok: false, reason: 'throttled', retryAfterMs: rlGate.retryAfterMs }));
            } catch { /* 响应已发出 */ }
            return;
          }
          // ⚠️ 成功后当前实例已被 dispose、新实例接管 ——
          // 这个响应**可能发不出去**。客户端必须把"请求失败"也当作
          // "可能已重载"，提示用户刷新页面。
          Promise.resolve()
            .then(() => reloadOnce())
            .then((r) => {
              try {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                res.end(JSON.stringify(r));
              } catch { /* 响应已发出 */ }
            })
            .catch((e) => {
              try {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                res.end(JSON.stringify({ ok: false, reason: 'exception', error: String((e && e.message) || e) }));
              } catch { /* 响应已发出 */ }
            });
          return;
        }

        if (head === 'version') {
          // ?force=1 表示用户手动点了「检查更新」，绕过 24 小时缓存
          const force = /[?&]force=1\b/.test(String((req && req.url) || ''));
          //
          // ⚠️ 必须包一层 catch：检查更新永远不该把设置页弄崩。
          // 网络不通是常态（用户可能在离线环境），此时只报错误，
          // 通知与语音完全不受影响。
          Promise.resolve()
            .then(() => checkForUpdate({
              pluginRoot: PLUGIN_ROOT,
              // ⚠️ 传「正在运行的代码版本」（PLUGIN_VERSION 在模块加载时读一次）。
              // 与磁盘 package.json 分开：用户可在 DSH 运行期间升级插件，
              // 那时磁盘是新的、跑的还是旧的 —— 界面该提示「重启生效」而非「已是最新」。
              runningVersion: PLUGIN_VERSION,
              force,
              cache: UPDATE_CACHE,
            }))
            .then((r) => {
              try {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                res.end(JSON.stringify(r));
              } catch { /* 响应已发出 */ }
            })
            .catch((e) => {
              try {
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
              } catch { /* 响应已发出 */ }
            });
          return;
        }

        // 渲染进程播放通道（v0.6.0）：SSE / 一次性 token / ack / 可见性上报。
        if (head === 'audio') return audioChannel.handler(req, res);

        if (head === 'config') return configRoute.handler(req, res);

                // ── 自测端点（v0.4.11）────────────────────────────────────
                //
                // 从 HTTP 直接触发一次真实 notify()，**绕开会话事件**。
                //
                // 为什么需要：2026-10-17 遇到"完成任务完全没反应、连弹窗都没有"。
                // 此时无法区分是
                //   ① 会话事件没进插件（事件处理器丢了）
                //   ② 事件进来了但 notify() 坏了
                // 有了这个端点就能二分：/selftest 能弹窗出声 → notify 好、问题在事件；
                // 否则 → notify 链路坏了。
                // ── 诊断导出（v0.4.35）────────────────────────────────────
        //
        // 读日志 → 脱敏（用户名/路径/长 token）→ 写到日志同目录，
        // 返回路径给界面显示。
        //
        // 为什么必须 POST：它会**写文件**。用 GET 的话，
        // 任意网页放个 <img src=".../diagnostics"> 就能让本机反复生成文件。
        // ── 服务方法探针（v0.4.65 诊断用，只读）──────────────────────
        //
        // 空闲门的唤醒依赖 js.onJobsChanged 回调。若该方法不存在，
        // 订阅处会静默跳过 → 挂起项永远醒不过来（只能等 10 分钟超时）。
        // 这个端点把真实可用的方法名列出来，避免靠猜。
        // 诊断：验证 agents.get(会话id) 能不能拿到 agent（reevaluatePending 依赖它）
        // 诊断：turnBoundary 投影的真实结构（空闲门要用它判轮次）
        // 诊断：agent.inbox 能否读（空闲门要对齐官方 hasDesktopActiveTasks）
        if (head === 'diagnostics') {
          if (String((req && req.method) || 'GET').toUpperCase() !== 'POST') {
            try {
              res.writeHead(405, { 'content-type': 'application/json; charset=utf-8', allow: 'POST' });
              res.end(JSON.stringify({ ok: false, reason: 'method-not-allowed' }));
            } catch { /* 响应已发出 */ }
            return;
          }
          try {
            const r = exportDiagnostics({
              version: PLUGIN_VERSION,
              logLevel: (cfg && cfg.logLevel) || 'info',
              // v0.4.89：把 home 的来历一并导出 —— `no-home` 只能从
              // 「走哪条分支 / 算出的路径是什么」看出来，光有日志看不出来。
              home: describeHome(process.env),
            });
            res.writeHead(r.ok ? 200 : 500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify(r));
          } catch (e) {
            try {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
            } catch { /* 响应已发出 */ }
          }
          return;
        }

        // 语音包管理（异步：会下载与写盘）
        if (head === 'voicepacks') {
          Promise.resolve(voicePackRoute.handle(req, res, head, pathname))
            .catch((e) => {
              try {
                res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ ok: false, reason: 'internal', error: String((e && e.message) || e) }));
              } catch { /* 响应已发出 */ }
            });
          return;
        }

        if (head === 'selftest') {
                  // ── 限流（v0.4.24）──────────────────────────────────────────
                  // preview / selftest 会真的出声、真的起子进程。恶意网页可以用
                  // <img src=".../preview"> 反复触发 —— 既骚扰又是资源放大。
                  // 3 秒一次：够用户手点试听，又不足以被刷。
                  const gate = throttle(head === 'selftest' ? 'selftest' : 'preview', 3000)
                  if (!gate.ok) {
                  try {
                  res.writeHead(429, {
                  'content-type': 'application/json; charset=utf-8',
                  'cache-control': 'no-store',
                  'retry-after': String(Math.ceil((gate.retryAfterMs || 1000) / 1000)),
                  })
                  res.end(JSON.stringify({ ok: false, reason: 'throttled', retryAfterMs: gate.retryAfterMs }))
                  } catch { /* 响应已发出 */ }
                  return
                  }
                  try {
                    const q = raw.split('?')[1] || '';
                    const km = /kind=([a-z]+)/.exec(q);
                    const tk = km ? km[1] : 'done';
                    notify(tk, '插件自测', '看到这个弹窗说明 notify 通路正常', null);
                    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true, kind: tk }));
                  } catch (e) {
                    try {
                      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
                      res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
                    } catch { /* ignore */ }
                  }
                  return;
                }

                // ── 试听端点（v0.4.17）──────────────────────────────────────
                //
                // **只出声，不弹窗**（ps1 的 -Preview）。用途：
                //   · 调「语音包增益」时听效果 —— 不然只能盲调
                //   · 换发音人/音色后确认是想要的
                //   · 换自定义音频后确认选对了文件
                //
                // 与 /selftest 的区别：selftest 走完整 notify()（含 Toast），
                // 用来验证"通知通路"；这里只验证"声音对不对"。
                //
                // 支持 ?kind=done|fail|question|approval|blocked|chime，
                // 默认 done。参数按**当前生效配置**组装，所以听到的就是
                // 真实播报的效果（含增益、发音人、按事件覆盖）。
                if (head === 'preview') {
                  // ── 限流（v0.4.24）──────────────────────────────────────────
                  // preview / selftest 会真的出声、真的起子进程。恶意网页可以用
                  // <img src=".../preview"> 反复触发 —— 既骚扰又是资源放大。
                  // 3 秒一次：够用户手点试听，又不足以被刷。
                  const gate = throttle(head === 'selftest' ? 'selftest' : 'preview', 3000)
                  if (!gate.ok) {
                  try {
                  res.writeHead(429, {
                  'content-type': 'application/json; charset=utf-8',
                  'cache-control': 'no-store',
                  'retry-after': String(Math.ceil((gate.retryAfterMs || 1000) / 1000)),
                  })
                  res.end(JSON.stringify({ ok: false, reason: 'throttled', retryAfterMs: gate.retryAfterMs }))
                  } catch { /* 响应已发出 */ }
                  return
                  }
                  try {
                    const q = raw.split('?')[1] || '';
                    const km = /kind=([a-z]+)/.exec(q);
                    const pk = km ? km[1] : 'done';
                    refreshConfig();
                    const aKind = audioKindOf(pk) || 'done';
                    // 试听统一走 bundled 语义（选曲 + 增益），
                    // 这样"调增益听效果"这件事对语音包最直接。
                    // 若用户当前音源是 tts/custom，则按各自参数试听。
                    const src = resolveSource(aKind, cfg);
                    if (src === 'tts') {
                      const line = ttsTextFor(pk);
                      const vVoice = kindOr(cfg.kindTtsVoice, aKind, cfg.ttsVoice);
                      const vRate = kindOr(cfg.kindTtsRate, aKind, cfg.ttsRate || 0);
                      const ttsArgs = [
                        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File',
                        TTS_PATH, '-Text', line, '-Volume', String(cfg.volume), '-Rate', String(vRate),
                      ];
                      if (vVoice) ttsArgs.push('-VoiceName', vVoice);
                      spawnTts(ttsArgs, pk);
                    } else if (src === 'custom') {
                      const file = resolveCustomFile(aKind, cfg);
                      const a = baseNotifyArgs(pk, '试听', '', false);
                      a.push('-Preview');
                      if (file) {
                        a.push('-CustomFile', file);
                        if (cfg.normalizeCustomAudio === true) {
                          a.push('-Gain', String(Number(cfg.voiceGain) > 1 ? Number(cfg.voiceGain) : 2.0));
                        }
                      } else {
                        a.push('-SystemSound', 'auto');
                      }
                      spawnNotify(a);
                    } else if (src === 'system') {
                      const a = baseNotifyArgs(pk, '试听', '', false);
                      a.push('-Preview', '-SystemSound', 'auto');
                      spawnNotify(a);
                    } else if (src === 'none') {
                      // 静音模式：不折腾，直接告知
                      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                      res.end(JSON.stringify({ ok: true, kind: pk, source: 'none', note: '当前设为不出声' }));
                      return;
                    } else if (src === 'bundled') {
                      // 语音包：选曲 + 按峰值限幅的增益
                      const a = baseNotifyArgs(pk, '试听', '', false);
                      a.push('-Preview');
                      // ⚠️ v0.4.87 修复：试听**必须把音色传下去**。
                      //
                      // baseNotifyArgs 只构造「标题/正文/音量」这类公共参数，
                      // 音色（-Voice / -Mode）原本只在 notifyArgs 里加 ——
                      // 于是试听时 ps1 收不到 -Voice，按随机池挑曲：
                      // 用户在界面上选的是「九州そら」，试听放出来的却是
                      // 「満別花丸」，改音色对试听毫无作用（2026-10-20 实拍发现）。
                      //
                      // 语义与真实播报保持一致：看 kind 级覆盖，再退回全局。
                      const vMode = kindOr(cfg.kindVoiceMode, aKind, cfg.voiceMode);
                      const vName = kindOr(cfg.kindVoiceName, aKind, cfg.voiceName);
                      // v0.5.3：试听同样要带语言，否则「试听听到的」和
                      // 「真实播报听到的」可能不是同一语言 —— 试听就失去意义了。
                      a.push('-Lang', cfg.voiceLang === 'zh' ? 'zh' : 'ja');
                      if (vMode === 'random') a.push('-Mode', 'random');
                      else if (vName) a.push('-Voice', vName);
                      const g = Number(cfg.voiceGain);
                      if (Number.isFinite(g) && g > 1) a.push('-Gain', String(g));
                      spawnNotify(a);
                    } else {
                      // 未知音源：退回系统提示音，绝不静默（试听没声音最让人困惑）
                      const a = baseNotifyArgs(pk, '试听', '', false);
                      a.push('-Preview', '-SystemSound', 'auto');
                      spawnNotify(a);
                    }
                    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
                    res.end(JSON.stringify({ ok: true, kind: pk, source: src, gain: cfg.voiceGain }));
                  } catch (e) {
                    try {
                      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
                      res.end(JSON.stringify({ ok: false, error: String((e && e.message) || e) }));
                    } catch { /* ignore */ }
                  }
                  return;
                }
              } catch { /* 分流失败就落到默认分支 */ }
              return bridge.handler(req, res);
            } },
            'dsh-notify-say: api',
          );
          if (scoped && typeof scoped.effect === 'function') scoped.effect(reg, 'dsh-notify-say: api');
          else reg();
        } catch (e) {
          console.warn('[dsh-notify-say] api route 注册失败（跳会话/设置卡片不可用，其余功能正常）：'
            + String((e && e.message) || e));
        }
      });
    }
  } catch {
    // webServer 不存在 / inject 不支持：静默降级
  }

  // ── 开发期自热重载（默认关闭）────────────────────────────────────────────
  //
  // 背景（2026-10-17 实测教训）：宿主只在启动时加载一次本文件，之后改磁盘上的
  // 代码**不会**生效 —— 我改了 audioSource 默认值，磁盘是新的，宿主仍按旧逻辑
  // 走 bundled→system，导致每次完成都静默。那时唯一解是重启 DSH。
  //
  // 机制移植自本机 dsh-our-free-model 的 src/reload.js（详见 lib/dev-reload.js
  // 的模块注释，含"必须用 Map.prototype.delete"这个关键点）。
  //
  // **默认关闭**：
  //   - 生产安装不会重写自己的文件，开着只是多一条可能出错的路径；
  //   - 它依赖 ctx.loader.internal / ctx.registry / ctx.fiber 三个非公开对象，
  //     DSH 升级可能变；关着就不会受影响。
  //
  // 开启方式：cordis.patch.yml 或 config.json 里设 `devReload: true`。
  //
  // ⚠️ 防无限循环：重载后新实例的 apply 会**再次**读到 devReload=true，
  // 若不做标记就会重载→重载→…。故用 globalThis 上的时间戳做冷却：
  // 30 秒内已重载过就跳过。key 带插件名，避免与其它插件冲突。
  // ── 一次性自重载的实现（v0.4.57）──────────────────────────────────────
  //
  // 用户要求：点一下重载一次；不点就不动。这里只是**把能力准备好**，
  // 不做任何自动触发 —— 触发点只有 `POST /reload`（设置页的按钮）。
  //
  // ## 为什么删掉 watcher
  //
  // 2026-10-18 实测它把宿主拖崩，崩溃日志两条硬证据：
  //   ① 45 条「fingerprint unchanged（旧代码仍在运行）」
  //      —— 那天为调 UI 改了 40 多次文件，每次保存触发一次注定失败的尝试；
  //   ② 同一时刻反复「Session reference "..." is released」
  //      —— 每次重载都 dispose 旧实例，而 dispose 会释放渲染进程仍在用的
  //         会话引用；反复几十次后渲染进程拿到损坏的 client 包，
  //         抛 SyntaxError，宿主退出。
  //
  // 结论：危险的不是"失败"，是"**反复**"。一次点击一次尝试，不再累积。
  reloadOnce = async function () {
    // ① 前置：磁盘内容与当前实例相同 → 什么都不做
    //
    // 同一件事的"没变"判断放在最前面，因为它最省钱也最安全：
    // 代码没变就不该 dispose 任何东西。
    let diskFingerprint = '';
    try { diskFingerprint = computeFingerprint(PLUGIN_ROOT); } catch { /* 读不到就继续 */ }
    // ② 决策抽在 dev-reload.js 的 planReload() —— 纯函数，可完整测试。
    //
    //    代码没变            → noop（一次 dispose 都不做）
    //    插件根真实路径变了  → 拒绝，告知必须重启
    //    确实变了            → reload（一次）
    let nowReal = '';
    try { nowReal = realpathSync(PLUGIN_ROOT); } catch { /* 解不开就不比 */ }
    const plan = planReload({
      diskFingerprint,
      runningFingerprint: fingerprint,
      resolvedRootAtLoad: RESOLVED_PLUGIN_ROOT,
      resolvedRootNow: nowReal,
    });
    if (plan.action === 'noop') {
      return { ok: true, noop: true, reason: plan.reason, fingerprint };
    }
    if (plan.action === 'refuse-path-changed') {
      return { ok: false, reason: plan.reason, hint: plan.hint };
    }

    // ③ 一次尝试。失败**不重试**，直接如实返回让用户去重启。
    const eventsBefore = readEventCount();
    let r;
    try {
      r = await selfReload(ctx, {
        logger: console,
        expectedFingerprint: undefined,
        differFrom: fingerprint,
        diskFingerprint,
      });
    } catch (e) {
      return { ok: false, reason: 'exception', error: String((e && e.message) || e) };
    }

    if (r && r.ok) {
      // 重载窗口内是否观察过事件（只作排查参考，不是漏报数 ——
      // 口径见 EVENT_COUNTER_KEY 的注释）。
      let observed = 0;
      try { observed = readEventCount() - eventsBefore; } catch { /* ignore */ }
      appendNotifyLog('[reload] OK by-user' + (observed > 0 ? ' observed=' + observed : ''));
      return {
        ok: true,
        reason: 'reloaded',
        fibers: r.fibers,
        busted: !!r.busted,
        verified: !!r.verified,
        observed,
      };
    }

    const err = String((r && r.error) || 'unknown');
    appendNotifyLog('[reload] FAILED ' + err);
    return {
      ok: false,
      reason: 'reload-failed',
      error: err,
      restored: !!(r && r.restored),
      hint: '自重载没有成功，旧代码仍在运行 —— 请重启 DSH。',
    };
  };

}

// ── 官方 Config schema 导出（v0.4.0）─────────────────────────────────────────
//
// 这是「设置页 GUI」的官方入口：DSH 0.1.7+ 的 Loader 自动接管插件导出的 `Config`，
// 在设置页生成表单，无需自建 client 半侧、无需 `slots`（未文档化、历史上被无声改过）。
//
// 源码侧契约（本机 app.asar 实证）：
//   - `volatileForm(schema)` 为 undefined 时抛 `Plugin entry "<ns>" has no volatile fields`
//   - 写入非 volatile 路径时抛 `Config field "<path>" is not volatile`
//   → 故 lib/config-schema.js 里**每个字段**都调了 `.volatile()`。
//
// 关键：**schema 加载失败时不能导出坏对象**，否则插件可能整体加载失败。
// 拿不到 schemastery 时导出 `undefined`（等价于「本插件不提供表单」），
// 插件功能完全不受影响，只是设置页不出现。宁可少一个页面，不可少一个插件。
const _schema = (() => {
  try {
    const z = loadSchema(process.env, { log: (m) => console.warn('[dsh-notify-say] ' + m) });
    if (!z) return undefined;
    return buildConfig(z);
  } catch (e) {
    try {
      console.warn('[dsh-notify-say] Config schema 构建失败，设置页将不出现（插件功能不受影响）：'
        + String((e && e.message) || e));
    } catch { /* 连日志都失败就算了 */ }
    return undefined;
  }
})();

export const Config = _schema;

/**
 * 本模块所在代码的"代际指纹"（v0.4.20）。
 *
 * ## 为什么需要
 *
 * 热重载要能回答一个问题：**刚才那次重载，真的把新代码换上了吗？**
 *
 * 只检查"re-import 返回了新对象"是不够的 —— 那只证明**入口**被重新求值了，
 * 不证明它 import 的依赖也换了。2026-10-17 实测就出现过
 * "config-store.js 换了、index.js 没换"（或反之）的半新半旧状态，
 * 而重载照样报 ok:true，排查时被误导了好几轮。
 *
 * ## 它是什么
 *
 * 一个**在模块求值时就固定下来**的标记：
 *   · 由本模块的 import.meta.url 派生（含代际查询串）
 *   · 加上加载时间戳
 *
 * 关键在于：它是**模块顶层的 const**，一旦求值就冻结。
 * 所以：
 *   · 如果重载真的重新求值了本模块 → 得到**新的** fingerprint
 *   · 如果还是旧模块（缓存没清掉）→ 读到**旧的** fingerprint
 *
 * 重载流程拿它和"磁盘期望值"比对，两者一致才算真生效。
 *
 * 注意：它**不是**文件内容哈希（那要读盘，太重）。
 * 它只证伪"没换"，不证明"内容对" —— 内容对不对由文件系统负责。
 */
/**
 * 本模块**代码内容**的指纹（v0.4.20）。
 *
 * ## 为什么需要
 *
 * 热重载要能回答：**刚才那次重载，真的把新代码换上了吗？**
 *
 * 只检查"re-import 返回了新对象"是不够的 —— 那只证明**入口**被重新求值了，
 * 不证明它 import 的依赖也换了。2026-10-17 实测就出现过
 * "config-store.js 换了、index.js 没换"（或反之）的半新半旧状态，
 * 而重载照样报 ok:true，排查时被误导了好几轮。
 *
 * ## 为什么是"源码哈希"而不是"代际标记"
 *
 * 第一版用的是 `import.meta.url`（含代际查询串），结果**判断力反了**：
 * 代际一变 URL 就变、指纹就变，于是"代码没改但重新求值了"也被判成
 * "新代码已生效" —— 校验形同虚设（S2 测试当场抓到）。
 *
 * 现在改为对**本模块文件自身的字节**做哈希：
 *   · 代码没改 → 无论如何重新求值，指纹都一样 → 拒绝了假成功 ✅
 *   · 代码改了 → 指纹不同 → 认可生效 ✅
 *
 * 读盘成本可接受：只在模块求值那一刻做一次（几 KB~几十 KB）。
 *
 * ## 依赖了什么
 *
 * `import.meta.url`（去掉查询串）+ `node:fs`。若沙箱读不到文件，
 * 退化为空串，`verifyReload` 会据此判失败（宁可报错也不假成功）。
 */
export const fingerprint = (() => {
  try {
    // ⚠️ 必须覆盖**整个 lib/ 目录**，不能只算 index.js。
    //
    // 2026-10-18 实测踩到：只算 index.js 时，改 http-guard.js /
    // client.js / config-store.js 都不会改变指纹 —— 而 verifyReload 的
    // differFrom 规则要求「新指纹必须不同于旧实例」，于是热重载每次报
    // `fingerprint unchanged`，而代码其实已经改了。
    //
    // 当时没暴露，是因为那几次改的都是 index.js 本身。
    //
    // 复用 dev-reload.js 的 computeFingerprint：
    // 它覆盖 package.json + lib/*.js，用大小与 mtime 混合哈希，
    // 足够灵敏又不必每次读几百 KB 全文。
    const pkgDir = fileURLToPath(new URL('..', import.meta.url));
    return computeFingerprint(pkgDir);
  } catch {
    return '';
  }
})();



