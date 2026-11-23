/**
 * 音色下拉候选 = 内置清单 ∪ 已下载 ∪ 当前值（v0.5.6，issue #3）。
 *
 * ## 这个 bug 是什么（用户 2026-10-25 报的）
 *
 * 设置页的「固定音色」下拉候选取自 `lib/client.js` 里一份**写死的**
 * `VOICE_KEYS`（发行版内置清单）。用户后来在「语音包」区下载的音色
 * 不在那份清单里 —— 于是下载成功了、列表里写着「已安装」，
 * 音色下拉里却根本选不到它，等于白下。
 *
 * 连带发现第二个坑：`VOICE_KEYS` 漏登记了 `tohoku-zunko` / `tohoku-kiritan`
 * 两个音色。它们早就通过了许可审核（`tools/build-voice-packs.ps1` 的
 * `$Approved` 与 `docs/audio-audit/README.md` 的"当前可发布清单"里都有），
 * 只是这份前端清单忘了写。
 *
 * ## 为什么必须渲染真实组件
 *
 * 第一版想写「源码里有 appendInstalled 调用」的文本断言。那种判据在两个
 * 方向都会骗人：注释被改字就假红；调用被挪到不会执行的分支里却恒绿。
 * 所以这里真跑一遍 `SettingsCard()`（假 React，与 ui-final.test.mjs 同款），
 * 从渲染出来的 `<option>` 列表判断。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');

/** 够用的假 React（与 ui-final.test.mjs 同款：effect 只跑一次）。 */
function fakeReact() {
  const createElement = (type, props, ...children) => ({
    $$typeof: Symbol.for('react.element'),
    type,
    props: { ...(props || {}), children },
  });
  const hooks = { slots: [], index: 0, eff: 0, ranEff: new Set(), rerender: null };
  const useState = (init) => {
    const i = hooks.index++;
    if (hooks.slots[i] === undefined) {
      hooks.slots[i] = { value: typeof init === 'function' ? init() : init };
    }
    const slot = hooks.slots[i];
    const set = (updater) => {
      slot.value = typeof updater === 'function' ? updater(slot.value) : updater;
      if (typeof hooks.rerender === 'function') hooks.rerender();
    };
    return [slot.value, set];
  };
  const useEffect = (fn) => {
    const i = hooks.eff++;
    if (hooks.ranEff.has(i)) return;
    hooks.ranEff.add(i);
    try { fn(); } catch { /* ignore */ }
  };
  const resetIndex = () => { hooks.index = 0; hooks.eff = 0; };
  return { createElement, useState, useEffect, __hooks: hooks, __resetIndex: resetIndex };
}

const FULL = {
  voice: true, voiceMode: 'fixed', voiceName: 'zundamon-normal', volume: 80,
  voiceLang: 'ja', audioSource: 'bundled',
  notifyOnComplete: true, notifyOnError: true, notifyOnBlocked: true,
  notifyOnAborted: false, notifyOnApproval: true, notifyOnQuestion: true,
  subagents: false, idleGate: true,
  showToast: true, ttsVoice: '', ttsRate: 0, devReload: false,
  logLevel: 'info', voiceGain: 2.0, normalizeCustomAudio: false,
  jumpWhenBackground: true, jumpWhenForeground: false,
  debounceSeconds: 60, globalCooldownSeconds: 0,
  audioSourceByKind: {}, ttsTexts: {}, kindSystemSound: {}, kindVoiceName: {},
  customFiles: {},
};

function elements(node, out) {
  const acc = out || [];
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) { node.forEach((n) => elements(n, acc)); return acc; }
  if (node.type) acc.push(node);
  elements(node.props && node.props.children, acc);
  return acc;
}

/** 主 state 槽（按形状找，不写死索引）。 */
function findMainSlot(card) {
  const s = card.r.__hooks.slots.find(
    (x) => x && x.value && typeof x.value === 'object'
      && 'values' in x.value && 'loaded' in x.value,
  );
  if (!s) throw new Error('找不到主 state 槽');
  return s;
}

/**
 * 渲染设置卡。
 *
 * @param {{values?: object, installed?: string[]}} cfg host 的 /config 响应
 */
async function renderCard(cfg) {
  let captured = null;
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', CLIENT)(
    { __ModuleLoader__: { load(def) { captured = def; } }, addEventListener() {}, removeEventListener() {} },
    undefined,
  );
  if (!captured) throw new Error('client.js 没有注册');

  const r = fakeReact();
  const mod = captured.factory((id) => {
    if (id === 'react') return r;
    throw new Error('client 不应 require: ' + id);
  });

  let component = null;
  mod.apply({
    get(id) {
      if (id === 'slots') return { inject(_n, fn) { fn(); }, register(_m, c) { component = c; } };
      return undefined;
    },
  });
  if (!component) throw new Error('没有注册设置卡');

  globalThis.fetch = (url) => {
    const u = String(url);
    const body = u.includes('version')
      ? {
        ok: true, running: '0.5.6', installed: '0.5.6', latest: '0.5.6',
        hasUpdate: false, needsRestart: false, npmLatest: '0.5.6',
        githubLatest: '0.5.6', installMode: 'managed', changelogUrl: 'x',
      }
      // /config：这是 issue #3 的关键 —— installed 跟着生效值一起来
      : { ok: true, values: { ...FULL, ...((cfg && cfg.values) || {}) }, installed: (cfg && cfg.installed) || [] };
    return Promise.resolve({
      ok: true, status: 200, json: () => Promise.resolve(body),
    });
  };

  const render = () => { r.__resetIndex(); return component({}); };
  render();
  r.__hooks.rerender = render;
  for (let i = 0; i < 8; i++) await Promise.resolve();
  return { r, render, installed: (cfg && cfg.installed) || [] };
}

/**
 * 内置清单（从源码解析）+ 本次注入的已下载 key = "什么算音色候选"。
 *
 * 为什么不能靠"候选值全是小写字母"来识别音色下拉：
 * `audioSource` 那个下拉的候选是 `bundled` / `tts` / `custom`，
 * 完全符合那个形状 —— 会被误认成音色下拉。
 */
function knownVoiceKeys(installed) {
  const m = CLIENT.match(/var VOICE_KEYS = \[([\s\S]*?)\n    \]/);
  const base = m ? [...m[1].matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]) : [];
  return new Set(base.concat(installed || []));
}

/** 取出所有音色下拉的候选 value 列表（不含「跟随全局」那个空 option）。 */
function voiceOptions(tree, installed) {
  const known = knownVoiceKeys(installed);
  const out = [];
  for (const e of elements(tree)) {
    if (e.type !== 'select') continue;
    const opts = elements(e).filter((x) => x.type === 'option');
    const vals = opts.map((o) => o.props && o.props.value).filter((v) => v);
    // 只算"音色"下拉：候选里至少有一个是已知音色 key
    const looksLikeVoice = vals.some((v) => known.has(v));
    if (looksLikeVoice) out.push(vals);
  }
  return out;
}

// ── V1: 已下载但不在内置清单里的音色，必须出现在下拉里 ────────────────────
test('V1: 下载过的音色出现在音色下拉里（不再"装了也选不到"）', async () => {
  // `namiine-ritsu` 在静态清单里；这里用一个**不在**清单里的 key 模拟"后来下载的"。
  // 用真实存在的 packs 里的名字不合适（那些都在清单里了），
  // 所以造一个只可能来自"已下载"的 key。
  const installed = ['zh-extra-voice', 'ja-extra-voice'];
  const card = await renderCard({ values: { voiceLang: 'ja' }, installed });
  const lists = voiceOptions(card.render(), card.installed);
  assert.ok(lists.length > 0, '应能找到一个音色下拉');

  const ja = lists[0];
  assert.ok(ja.includes('ja-extra-voice'),
    '已下载的日语���色必须出现在日语下拉里，实际候选：' + ja.join(', '));
  assert.ok(ja.includes('zundamon-normal'), '内置音色不能因此消失');

  // 中文那一组只在切到 zh 后才有；这里直接验证 ja 组不含中文 key
  assert.ok(!ja.some((k) => k.indexOf('zh-') === 0),
    '日语下拉不得混入中文音色（voiceLang=ja）');
});

// ── V2: 中文下拉同理 ────────────────────────────────────────────────────
test('V2: 已下载的中文音色出现在中文下拉里，且不混日语', async () => {
  const installed = ['zh-extra-voice'];
  // voiceName 也要给中文的：`keyOpts.unshift(v.voiceName)` 会把"当前生效但
  // 不属于该语言"的音色补进列表（这是有意的，见 client.js 那段注释）。
  // 不给的话默认 voiceName 是 zundamon-normal，日语键会合理地被 unshift 进来。
  const card = await renderCard({ values: { voiceLang: 'zh', voiceName: 'zh-soft-female' }, installed });
  const lists = voiceOptions(card.render(), card.installed);
  assert.ok(lists.length > 0, '应能找到一个音色下拉');
  const zh = lists[0];
  assert.ok(zh.includes('zh-extra-voice'), '已下载的中文音色必须可选，实际：' + zh.join(', '));
  assert.ok(!zh.some((k) => k.indexOf('zh-') !== 0),
    '中文下拉不得混入日语（voiceLang=zh 且当前音色也是中文），实际：' + zh.join(', '));
});

// ── V3: 没注入 installed 时行为与修复前逐字一致 ──────────────────────────
test('V3: host 不返回 installed 时，下拉退回纯内置清单（向后兼容）', async () => {
  const card = await renderCard({ values: { voiceLang: 'ja' }, installed: [] });
  const lists = voiceOptions(card.render(), card.installed);
  assert.ok(lists.length > 0, '应能找到一个音色下拉');
  const ja = lists[0];
  assert.ok(ja.includes('zundamon-normal'), '内置音色必须仍在');
  assert.ok(ja.indexOf('zh-extra-voice') < 0, '没装的音色不该出现');
});

// ── V4: 漏登记的两个音色补回来了 ────────────────────────────────────────
test('V4: tohoku-zunko / tohoku-kiritan 已补进内置清单（并与打包脚本同名）', () => {
  const m = CLIENT.match(/var VOICE_KEYS = \[([\s\S]*?)\n    \]/);
  assert.ok(m, '应能定位 VOICE_KEYS');
  const keys = [...m[1].matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]);

  for (const k of ['tohoku-zunko', 'tohoku-kiritan']) {
    assert.ok(keys.includes(k),
      k + ' 必须在内置清单里 —— 它通过了许可审核、release 上也有人下载，'
      + '漏在前面等于"下了也在下拉里看不到"');
    // 显示名必须同源
    assert.match(CLIENT, new RegExp("'" + k + "': '"), k + ' 必须有友好显示名');
  }
  assert.ok(keys.length >= 17, '内置清单应至少 17 个音色，实际 ' + keys.length);
});

// ── V5: 下拉候选不得出现许可被禁的音色（即便磁盘上有）──────────────────────
test('V5: 即便已下载目录里有禁用音色，也不得出现在下拉里', async () => {
  // 这道防线的意义：VOICE_KEYS 的注释里明确说 kasukabe-tsumugi / mochiko
  // 因官方规约禁止再分发。若哪天用户目录里残留了它们的文件（老版本装的），
  // 我们不能因为「已安装」就把它列出来。
  const installed = ['mochiko', 'kasukabe-tsumugi', 'zh-extra-voice'];
  const card = await renderCard({ values: { voiceLang: 'zh' }, installed });
  const lists = voiceOptions(card.render(), card.installed);
  const all = lists.flat();
  for (const banned of ['mochiko', 'kasukabe-tsumugi']) {
    assert.ok(all.indexOf(banned) < 0,
      banned + ' 不得出现在下拉里（官方规约禁止再分发，见 docs/audio-audit/README.md）');
  }
});

// ── V6: 深色模式下下拉可读（issue #3b）─────────────────────────────────
test('V6: select 声明 colorScheme:inherit，让展开列表跟随宿主深色主题', () => {
  // 原样式只有 background:transparent + color:inherit。原生 <select> 的
  // **展开列表**由浏览器单独绘制，按元素上的 color-scheme 决定配色 ——
  // 不设就默认浅色白底，配上继承来的浅灰文字 = 白字白底看不见。
  assert.match(CLIENT, /colorScheme:\s*'inherit'/,
    'select 样式必须声明 colorScheme:inherit（否则深色模式下展开列表白字白底）');
  // 不得写死颜色（写死会在另一种主题下翻车）
  const seg = CLIENT.slice(CLIENT.indexOf('select: {'), CLIENT.indexOf('select: {') + 500);
  assert.doesNotMatch(seg, /color:\s*'(black|white|#[0-9a-fA-F]{3,6})'/,
    '不得写死文字颜色 —— 主题切换时会翻车');
});
