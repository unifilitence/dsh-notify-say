/**
 * dsh-notify-say 的可持久配置层（host 半侧，无外部依赖）。
 *
 * ## 为什么需要它
 *
 * 本插件的配置原本只来自 `cordis.patch.yml`（profile 补丁层）。改一个音量都要
 * 编辑 YAML 再重启宿主，成本太高；而 GUI/CLI 又**绝不能写** profile 补丁层
 * —— 同族的 `dsh-model-seat-favorites` 在源码注释里把这条写成了硬规则：
 *
 *   > the profile patch layer is the one file this project must not start writing to.
 *
 * 所以本模块拥有**恰好一个文件**：`$DSH_HOME/storages/dsh-notify-say/config.json`。
 * 其它任何文件（凭据、patch、别的插件数据）一概不读不写。
 *
 * ## 三层优先级（后覆盖前）
 *
 *   1. 内置 DEFAULTS（lib/index.js 的 DEFAULTS）
 *   2. `cordis.patch.yml` 传入的 config      ← 用户手写的静态默认值
 *   3. 本文件 `storages/.../config.json`     ← GUI/CLI 运行时改的值
 *
 * 这样职责分离：patch 层是「出厂/手写默认」，storages 层是「运行时偏好」。
 * 两者不打架，也不产生「改了 GUI 但 patch 里还是旧值」的分裂。
 *
 * ## fail-closed 契约
 *
 * - 每个方法**永不抛异常**，失败一律返回 `{ ok: false, reason }`；
 * - 磁盘上的文档格式不对 → 报 `corrupt` 且**不回写**（保留用户原文件，便于人工救）；
 * - 写入前先做形状校验，调用方的 bug 不会把文件写成半截文档；
 * - 未知键**丢弃**（白名单），防止 GUI 传进来污染配置文件。
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { resolveDshHome, resolveDshHomeWithSource } from './dsh-home.js';

/** 相对 `$DSH_HOME` 的持久文件路径（本插件唯一拥有的文件）。 */
export const CONFIG_RELATIVE_PATH = 'storages/dsh-notify-say/config.json';

/** 写入文档的 schema 版本。 */
export const CONFIG_VERSION = 1;

/**
 * 允许持久化的键（白名单）与其值校验器。
 *
 * 只收「用户在 GUI/CLI 里真会改」的东西。刻意**不收** debounce / idleGateTimeout
 * 这类内部节流值 —— 它们改错了只会让人困惑，且不属于界面想解决的问题。
 */
const BOOL_KEYS = ['voice', 'notifyOnComplete', 'notifyOnError', 'notifyOnBlocked',
  'notifyOnAborted', 'notifyOnApproval', 'notifyOnQuestion', 'subagents', 'idleGate',
  // v0.4.2
    'showToast', 'jumpWhenBackground', 'jumpWhenForeground',
    // v0.4.68：子代理错误 / 长度上限 / Toast 精准跳转
    'notifyOnSubagentError', 'notifyOnMaxTokens', 'toastJumpSession',
    // ⚠️ multiJumpRule 是**字符串**（clicked/earliest/latest/none），
    // 不能放进 BOOL_KEYS —— 那会让 sanitize 按 boolean 校验并丢弃它。
    // 它的校验在 RULES 里单独给出。
  // v0.4.11：devReload。GUI 早就有这个开关，但白名单里没有 →
  // 保存时被 sanitize 当未知键丢弃，返回 nothing-to-write（实测踩到）。
  'devReload',
  // v0.4.16：自定义音频是否标准化（默认关：尊重用户原文件的响度）。
  'normalizeCustomAudio'];

/** 合法音源 id（与 lib/audio-source.js 的 AUDIO_SOURCES 保持一致）。 */
const AUDIO_SOURCES = ['tts', 'bundled', 'system', 'custom', 'none'];

/**
 * 校验自定义音频路径：必须是**绝对路径** + 合法扩展名。
 *
 * 拒绝相对路径的原因：播放进程的 cwd 不确定，相对路径会随启动方式漂移，
 * 属于"看起来能用、实际随机失败"的坑（与 lib/audio-source.js 同口径）。
 *
 * @param {any} v
 * @returns {string|undefined} 合法则返回原值，否则 undefined（表示丢弃）
 */
function absAudioPath(v) {
  if (typeof v !== 'string') return undefined;
  const p = v.trim();
  if (!p || p.length > 512) return undefined;
  const isAbs = /^[a-zA-Z]:[\\/]/.test(p) || /^\\\\/.test(p);
  if (!isAbs) return undefined;
  // 拒绝设备命名空间前缀（\\?\ / \\.\），它们能绕开路径规范化
  if (/^\\\\[?.]\\/.test(p)) return undefined;
  if (!/\.(wav|mp3|m4a|flac|ogg)$/i.test(p)) return undefined;
  return p;
}

const RULES = {
    // v0.4.71：multiJumpRule 是字符串枚举，必须在 RULES 里单独校验。
    // 原先它被错放进 BOOL_KEYS（那是给 boolean 用的），保存时会被当未知类型丢弃。
    multiJumpRule: (v) => (['clicked', 'earliest', 'latest', 'none'].includes(v) ? v : undefined),
  voiceMode: (v) => (v === 'fixed' || v === 'random' ? v : undefined),
  // v0.5.3：语音包语言。只认 ja / zh，其余丢弃（回落默认 ja）。
  // 与 voiceMode 同口径：字符串枚举必须在 RULES 里显式校验，否则被当未知键丢弃。
  voiceLang: (v) => (v === 'ja' || v === 'zh' ? v : undefined),
  voiceName: (v) => (typeof v === 'string' && /^\w[\w-]*$/.test(v) ? v : undefined),
  volume: (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? Math.round(n) : undefined;
  },
  // v0.4.2：音源与 TTS
  audioSource: (v) => (typeof v === 'string' && AUDIO_SOURCES.includes(v) ? v : undefined),
  // v0.4.34 日志级别：只有 info / debug 两个值，其余拒绝（回落到默认）。
  // 这里必须显式校验：logLevel 会决定「要不要把用户台词写进日志」，
  // 拼错一个字母就静默退回 info 是安全的，但反过来（错值被当 debug）不安全。
  logLevel: (v) => (v === 'info' || v === 'debug' ? v : undefined),
  // 发音人名可能含空格（如 "Microsoft Huihui Desktop"），只做长度与类型校验
  ttsVoice: (v) => (typeof v === 'string' && v.length <= 120 ? v : undefined),
  ttsRate: (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= -10 && n <= 10 ? Math.round(n) : undefined;
  },
  // v0.4.16：语音包数字增益（1.0 = 原样，2.0 = 放大一倍）。
  // 素材峰值中位仅 40.4%，而 MCI 音量上限只有 1.0 倍，必须靠数字增益补。
  voiceGain: (v) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return undefined;
    if (n < 1.0 || n > 4.0) return undefined;
    return Math.round(n * 10) / 10;
  },
  // v0.4.4：自定义音频（按事件一个绝对路径）
  //
  // 为什么按事件分开：用户可能想让"完成"放自己的音乐、"失败"放另一段。
  // 存储形态是扁平的两个键（customFileDone / customFileFail …），
  // 因为 config-store 的白名单只认扁平的标量键；audio-source 那边再拼成
  // `customFiles: { done: ... }` 供读取逻辑用。
  customFileDone: (v) => absAudioPath(v),
  customFileFail: (v) => absAudioPath(v),
  customFileQuestion: (v) => absAudioPath(v),
  customFileApproval: (v) => absAudioPath(v),
  customFileBlocked: (v) => absAudioPath(v),

  // v0.4.5：按事件覆盖音源（高级功能）
  //
  // 用户可能想让「完成」听日语语音包、而「失败」听系统警告音。
  // 存成扁平键（kindSourceFail = 'system'），因为白名单只认标量；
  // 空串表示"跟随全局默认"。
  kindSourceDone: (v) => kindSourceOf(v),
  kindSourceFail: (v) => kindSourceOf(v),
  kindSourceQuestion: (v) => kindSourceOf(v),
  kindSourceApproval: (v) => kindSourceOf(v),
  kindSourceBlocked: (v) => kindSourceOf(v),

  // v0.4.7：冷却（用户明确要求可调）
  //
  // 原注释说"刻意不收 debounce —— 改错了只会让人困惑"。但用户 2026-10-17
  // 明确要求："同一会话的冷却我们可以给它关了，甚至可以把不同会话的冷却加上"。
  // 需求优先：两类人诉求相反，必须让用户自己调。
  // 范围限制在 0..3600 秒（1 小时封顶），0 表示关闭。
  debounceSeconds: (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 3600 ? Math.round(n) : undefined;
  },
  globalCooldownSeconds: (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 3600 ? Math.round(n) : undefined;
  },

  // v0.5.11：空闲门静默期（毫秒）。0 = 关闭（退回 v0.5.10 的即时放行）。
  //
  // 必须进白名单：白名单外的键在保存时会被 sanitize 当"未知键"丢弃，
  // 用户改了却静默不生效 —— devReload 当年正是这么踩的（见 BOOL_KEYS 的注释）。
  // 上限 60 秒：静默期再长就不是"等一下看它动不动"，而是"忘了播"。
  idleGateQuietMs: (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 60000 ? Math.round(n) : undefined;
  },

  // v0.4.8：TTS 自定义台词（每种事件一段，空串 = 用内置台词库）
  //
  // 长度上限 60 字：SAPI 念 60 字约 5 秒，符合"一句话提醒"的定位。
  // 再长会让用户"点了完成、十秒后才出声"，也容易被命令行长度上限截断。
  ttsTextDone: (v) => cleanTtsText(v),
  ttsTextFail: (v) => cleanTtsText(v),
  ttsTextQuestion: (v) => cleanTtsText(v),
  ttsTextApproval: (v) => cleanTtsText(v),
  ttsTextBlocked: (v) => cleanTtsText(v),
};

// ── v0.4.9：每种音源的参数都按事件可调 ────────────────────────────────────
//
// 用户 2026-10-17 指出：高级区每行只选了音源类型，但选完之后
// **念什么话、什么声音、什么音效** 都得回上面用全局的，不合逻辑。
// 而且不只 TTS —— 语音包、系统音效各有自己的参数，都要能按事件设。
//
// 参数矩阵：
//   tts     → 发音人 ttsVoiceK + 语速 ttsRateK + 台词 ttsTextK（已有）
//   bundled → 音色模式 kindVoiceModeK + 音色名 kindVoiceNameK
//   system  → 系统音效 kindSystemSoundK
//   custom  → 文件 customFileK（已有）
//
// 命名规则：`kind<Param><Kind>`（如 kindSystemSoundFail），
// 这样一眼能看出"是按事件的覆盖"，也不会与全局键（ttsVoice/voiceName）混淆。
// 空串一律表示"跟随全局"。
const KINDS = ['Done', 'Fail', 'Question', 'Approval', 'Blocked'];

/** 合法系统音效名（与 lib/audio-source.js 的 SYSTEM_SOUNDS 一致）。 */
const SYSTEM_SOUNDS = ['Asterisk', 'Beep', 'Exclamation', 'Hand', 'Question'];

for (const k of KINDS) {
  // 发音人：与全局 ttsVoice 同口径（允许空格，如 "Microsoft Huihui Desktop"）
  RULES['kindTtsVoice' + k] = (v) => (typeof v === 'string' && v.length <= 120 ? v : undefined);
  // 语速：-10..10，空串表示跟随全局
  RULES['kindTtsRate' + k] = (v) => {
    if (v === '' || v === null) return '';
    const n = Number(v);
    return Number.isFinite(n) && n >= -10 && n <= 10 ? Math.round(n) : undefined;
  };
  // 音色模式：fixed | random | 空（跟随全局）
  RULES['kindVoiceMode' + k] = (v) => {
    if (v === '') return '';
    return (v === 'fixed' || v === 'random') ? v : undefined;
  };
  // 音色名：与全局 voiceName 同口径
  RULES['kindVoiceName' + k] = (v) => {
    if (v === '') return '';
    return (typeof v === 'string' && /^\w[\w-]*$/.test(v)) ? v : undefined;
  };
  // 系统音效名：合法值或空
  RULES['kindSystemSound' + k] = (v) => {
    if (v === '') return '';
    return (typeof v === 'string' && SYSTEM_SOUNDS.includes(v)) ? v : undefined;
  };
}

/**
 * 规整用户自定义 TTS 台词：去掉换行/控制字符、压空白、限长。
 *
 * 与 lib/tts-lines.js 的 sanitizeTtsText 同口径（那里也有一份，
 * 因为它在浏览器端也要能独立工作；两处都由测试覆盖）。
 *
 * @param {any} v
 * @returns {string|undefined} 空串表示"清除自定义"；非字符串返回 undefined（丢弃）
 */
function cleanTtsText(v) {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > 60 ? s.slice(0, 60).trim() : s;
}

/**
 * 校验"某事件的音源覆盖"：合法音源 id 或空串（表示跟随默认）。
 * @param {any} v
 * @returns {string|undefined}
 */
function kindSourceOf(v) {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (!s) return '';                                  // 空 = 清除覆盖
  return AUDIO_SOURCES.includes(s) ? s : undefined;
}

for (const k of BOOL_KEYS) RULES[k] = (v) => (typeof v === 'boolean' ? v : undefined);

/** 所有可持久键（供 CLI/GUI 列出）。 */
export const CONFIG_KEYS = Object.keys(RULES);

/**
 * 解析 DSH home（**唯一事实源在 lib/dsh-home.js**，此处仅保持旧名可调用）。
 *
 * 历史教训（v0.4.88 修复）：这里曾只读 `process.env.DSH_HOME`，没值即返回空串。
 * 但该变量是**可选覆盖项**，不是安装产物 —— 用户机器上普遍没有设置，
 * 于是 `configPath()` 为空、保存一律返回 `{ok:false, reason:'no-home'}`，
 * 表现为「设置页任何改动都保存失败」。现改为委托官方同款解析：
 * `$DSH_HOME`（空白视为未设置）→ `~/.dsh`。
 *
 * @param {object} [env] 环境包，默认 `process.env`
 * @param {object} [opts] 透传给 `resolveDshHome`（可用 `anchors` 尝试官方模块）
 * @returns {string} 归一化后的绝对路径；都取不到时返回空串
 */
export function safeHome(env, opts) {
  return resolveDshHome(env, opts);
}

/**
 * 计算持久文件的绝对路径。
 * @param {object} [env]
 * @param {object} [opts] 透传给 `safeHome`
 * @returns {string} 绝对路径；home 完全取不到时返回空串
 */
export function configPath(env, opts) {
  const home = safeHome(env, opts);
  if (!home) return '';
  return join(home, CONFIG_RELATIVE_PATH);
}

/**
 * 诊断用：说明 home 与配置路径**是怎么定下来的**。
 *
 * 与 `configPath()` 的区别只在于多返回「来源」和「是否存在」：
 * 排查 `no-home` 时，光看一个路径分不清它是 `$DSH_HOME` 给的
 * 还是回落到 `~/.dsh` 的，也分不清「配置存不进去」是路径为空
 * 还是目录不可写。这里一次把三件事都说清楚。
 *
 * ⚠️ 返回值会进诊断文件，**必须经 `sanitizeDiagnostics()` 处理**
 * 才能落盘（路径含用户名）。
 *
 * @param {object} [env] 环境包，默认 `process.env`
 * @param {object} [opts] 透传给 `resolveDshHomeWithSource`
 * @returns {{ home: string, source: string, configPath: string, exists: boolean }}
 */
export function describeHome(env, opts) {
  const got = resolveDshHomeWithSource(env, opts);
  const home = (got && got.home) || '';
  const path = home ? join(home, CONFIG_RELATIVE_PATH) : '';
  let exists = false;
  if (path) {
    try { exists = existsSync(path); } catch { exists = false; }
  }
  return {
    home,
    source: (got && got.source) || 'none',
    configPath: path,
    exists,
  };
}

/**
 * 把任意输入收敛成合法配置片段。
 *
 * 未知键与非法值一律**丢弃**（不是报错），这样 GUI 传错一个字段不会让整次保存失败，
 * 也不会让脏数据落盘。
 *
 * @param {object} raw
 * @returns {{ ok: boolean, value?: object, dropped?: string[] }}
 */
export function sanitize(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, value: {}, dropped: [] };
  }
  const out = {};
  const dropped = [];
  for (const [k, v] of Object.entries(raw)) {
    const rule = RULES[k];
    if (!rule) { dropped.push(k); continue; }
    const got = rule(v);
    if (got === undefined) { dropped.push(k); continue; }
    out[k] = got;
  }
  return { ok: true, value: out, dropped };
}

/**
 * 读取持久配置。文件不存在视为「没有运行时偏好」（不是错误）。
 *
 * @param {object} [env]
 * @returns {{ ok: boolean, value: object, reason?: string }}
 *   - `ok:true, value:{}`            文件不存在或为空 → 调用方用 patch 默认值
 *   - `ok:true, value:{...}`         读到并校验通过
 *   - `ok:false, reason:'corrupt'`   文件在但解析失败/形状不对 → **不回写**
 *   - `ok:false, reason:'read:...'`  读失败
 */
export function readConfig(env) {
  const p = configPath(env);
  if (!p) return { ok: false, value: {}, reason: 'no-home' };
  let text;
  try {
    if (!existsSync(p)) return { ok: true, value: {} };
    text = readFileSync(p, 'utf8');
  } catch (ex) {
    return { ok: false, value: {}, reason: 'read:' + String(ex && ex.message ? ex.message : ex) };
  }
  if (!text.trim()) return { ok: true, value: {} };
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, value: {}, reason: 'corrupt' };
  }
  if (doc == null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, value: {}, reason: 'corrupt' };
  }
  if (doc.version !== CONFIG_VERSION) {
    // 版本不认识：当作 corrupt，不覆盖（可能是别的版本写的，人工处理）
    return { ok: false, value: {}, reason: 'corrupt' };
  }
  const values = doc.values;
  if (values == null || typeof values !== 'object' || Array.isArray(values)) {
    return { ok: false, value: {}, reason: 'corrupt' };
  }
  const s = sanitize(values);
  return { ok: true, value: s.value };
}

/**
 * 原子写入持久配置：先写 `.tmp` 再 rename，避免半截文件。
 *
 * @param {object} patch 要合并进去的键值（只写白名单内的）
 * @param {object} [env]
 * @returns {{ ok: boolean, value?: object, written?: string[], reason?: string }}
 */
export function writeConfig(patch, env) {
  const p = configPath(env);
  if (!p) return { ok: false, reason: 'no-home' };
  const s = sanitize(patch);
  if (!s.ok) return { ok: false, reason: 'bad-input' };
  if (Object.keys(s.value).length === 0) {
    return { ok: false, reason: 'nothing-to-write', dropped: s.dropped };
  }

  // 读现有值再合并（读失败时不静默覆盖用户的坏文件）
  const cur = readConfig(env);
  if (cur.ok === false && cur.reason === 'corrupt') {
    return { ok: false, reason: 'corrupt' };
  }
  const merged = { ...(cur.ok ? cur.value : {}), ...s.value };
  const doc = { version: CONFIG_VERSION, values: merged };

  const tmp = p + '.tmp';
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    renameSync(tmp, p);
  } catch (ex) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* best effort */ }
    return { ok: false, reason: 'write:' + String(ex && ex.message ? ex.message : ex) };
  }
  return { ok: true, value: merged, written: Object.keys(s.value), path: p };
}

/**
 * 把「patch 层配置」与「运行时偏好」合并成最终生效配置。
 *
 * 优先级：`fileValues` 覆盖 `patchConfig`。两者都不含的键由调用方的 DEFAULTS 兜底。
 *
 * @param {object} patchConfig `cordis.patch.yml` 传来的 config（可能含 camelCase 键）
 * @param {object} fileValues  `readConfig().value`
 * @returns {object} 合并后的原始配置（交给 normalizeConfig）
 */
export function mergeConfig(patchConfig, fileValues) {
  const base = patchConfig != null && typeof patchConfig === 'object' ? patchConfig : {};
  const over = fileValues != null && typeof fileValues === 'object' ? fileValues : {};
  return { ...base, ...over };
}

/**
 * 把 patch 用的 `*Seconds` 键转成归一化后的毫秒值说明（仅供 CLI/GUI 展示）。
 * 本模块不参与这两项的持久化，故只做只读呈现。
 *
 * @param {object} cfg normalizeConfig 的输出
 * @returns {object} 便于人读的摘要
 */
export function describe(cfg) {
  return {
    voice: cfg.voice,
    voiceMode: cfg.voiceMode,
    // v0.5.3：语言也要进摘要 —— 它影响"随机抽哪个池"，
    // 漏了这里会导致改了语言但"配置变更签名"不变，日志看不出变化。
    voiceLang: cfg.voiceLang,
    voiceName: cfg.voiceName,
    volume: cfg.volume,
    notifyOnComplete: cfg.notifyOnComplete,
    notifyOnError: cfg.notifyOnError,
    notifyOnBlocked: cfg.notifyOnBlocked,
    notifyOnAborted: cfg.notifyOnAborted,
    notifyOnApproval: cfg.notifyOnApproval,
    notifyOnQuestion: cfg.notifyOnQuestion,
    subagents: cfg.subagents,
    idleGate: cfg.idleGate,
    // v0.4.2+：这些也要进摘要，否则改了它们"配置变更签名"不变，
    // 日志就不会打印新配置，排查时看不出变化。
    audioSource: cfg.audioSource,
    showToast: cfg.showToast,
    ttsVoice: cfg.ttsVoice,
    ttsRate: cfg.ttsRate,
    jumpWhenBackground: cfg.jumpWhenBackground,
    jumpWhenForeground: cfg.jumpWhenForeground,
  multiJumpRule: cfg.multiJumpRule,
    devReload: cfg.devReload,
    logLevel: cfg.logLevel,
    audioSourceByKind: cfg.audioSourceByKind,
    ttsTexts: cfg.ttsTexts,
    kindSystemSound: cfg.kindSystemSound,
    kindVoiceName: cfg.kindVoiceName,
    customFiles: cfg.customFiles,
    debounceSeconds: Math.round((Number(cfg.debounceMs) || 0) / 1000),
    globalCooldownSeconds: Math.round((Number(cfg.globalCooldownMs) || 0) / 1000),
    idleGateTimeoutSeconds: Math.round((Number(cfg.idleGateTimeoutMs) || 0) / 1000),
    // v0.5.11：静默期（毫秒）原样回传，前端按毫秒展示
    idleGateQuietMs: Math.round(Number(cfg.idleGateQuietMs) || 0),
  };
}
