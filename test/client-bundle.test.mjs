/**
 * client bundle 形态测试（v0.4.1）。
 *
 * ## 为什么需要它
 *
 * v0.4.0 曾把 `lib/client.js` 写成**裸 ESM**（`export function apply`）却声明
 * `dsh.client.platform=web`。宿主把 client 产物当**经典脚本**执行，要求它自行注册
 * `window.__ModuleLoader__.load({id, factory})`（实测：dsh-sidebar-footer-stack 的
 * 3KB 手写 client.js 也是这个包裹；dsh-cost-meter 的构建产物同款）。
 * 结果是浏览器端 SyntaxError → `client-modules: could not load`。
 *
 * 独立审查在提交前拦下了这个错误。本测试用来**防止它再犯**：
 * 断言 client.js 的第一条有效语句就是 `window.__ModuleLoader__.load({...})`，
 * 且 factory 里正确导出 `apply` / `inject` / `name`。
 *
 * 这些断言不依赖宿主：直接把文件当文本读 + 用一个假的 `window.__ModuleLoader__`
 * 在 Node 里**真实执行**一次，确认它调用了 load 且 factory 能跑出 apply。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CLIENT = new URL('../lib/client.js', import.meta.url);
const PKG = new URL('../package.json', import.meta.url);

function readClient() {
  return readFileSync(CLIENT, 'utf8');
}

// ── C1: 必须是 __ModuleLoader__ 包裹，不能是裸 ESM ──────────────────────────
test('C1: client.js 使用 window.__ModuleLoader__.load 包裹（不是裸 ESM）', () => {
  const src = readClient();
  assert.match(src, /window\.__ModuleLoader__\.load\s*\(\s*\{/,
    'client 产物必须自行注册 window.__ModuleLoader__.load({id, factory})');
  // 反面断言：不能出现顶层 export（会被当经典脚本执行而报 SyntaxError）
  assert.doesNotMatch(src, /^\s*export\s+(function|const|default|\{)/m,
    'client.js 不得含顶层 export —— 它不是 ESM 模块，是经典脚本');
  // 也不能有顶层 import
  assert.doesNotMatch(src, /^\s*import\s+/m,
    'client.js 不得含顶层 import');
});

// ── C2: id 必须与包名一致 ───────────────────────────────────────────────────
test('C2: 注册的 id 与 package.json 的 name 一致', () => {
  const src = readClient();
  const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
  const m = src.match(/__ModuleLoader__\.load\s*\(\s*\{[\s\S]*?id:\s*['"]([^'"]+)['"]/);
  assert.ok(m, '应能解析出 id');
  assert.equal(m[1], pkg.name, '注册 id 必须等于包名，否则 loaded without registering');
});

/** 极简假 React：只要 createElement 能把 type/props/children 记下来即可。 */
/**
 * 够用的假 React：支持 createElement + useState/useEffect。
 *
 * useState 用「外部可变槽」实现——测试里只渲染一次，不需要真正的重渲染，
 * 但组件初始化时会读 state，所以必须给初值。
 * useEffect 立刻执行一次（组件里用它来 loadConfig）。
 */
function fakeReact() {
  const created = [];
  const createElement = (type, props, ...children) => {
    // 注意：属性名必须是 $$typeof（两个美元符号）。曾因 PowerShell 里 $$ 被转义
    // 吃成一个 $，变成 typeof，导致所有元素被判定为「非 React 元素」而误报。
    const node = { $$typeof: Symbol.for('react.element'), type, props: { ...(props || {}), children } };
    created.push(node);
    return node;
  };
  // 支持重渲染的假 useState：状态槽**跨多次渲染持久**（模拟真实 React 的 hook 记忆）。
  // 每个 fakeReact() 实例对应一次「组件生命周期」，所以槽放在实例闭包里。
  const hooks = { slots: [], index: 0, rerender: null };
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
  const useEffect = (fn) => { try { const d = fn(); if (typeof d === 'function') d(); } catch { /* ignore */ } };
  const resetIndex = () => { hooks.index = 0; };
  return { createElement, useState, useEffect, __created: created, __hooks: hooks, __resetIndex: resetIndex };
}

/** 带 react 的 require 桩（factory 只允许 require('react')）。 */
function requireWithReact(r) {
  return (id) => {
    if (id === 'react') return r;
    throw new Error('client 不应 require: ' + id);
  };
}

// ── C3: 真实执行一次 —— 假 window，确认 load 被调用且 factory 可跑 ──────────
test('C3: 在假 window 环境下真实执行，load 被调用且导出 apply/inject/name', () => {
  const src = readClient();

  let captured = null;
  const fakeWindow = {
    __ModuleLoader__: {
      load(def) { captured = def; },
    },
    addEventListener() {},
    removeEventListener() {},
  };
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'document', src);
  run(fakeWindow, undefined);

  assert.ok(captured, '__ModuleLoader__.load 必须被调用');
  assert.equal(typeof captured.id, 'string');
  assert.equal(typeof captured.factory, 'function');

  // factory 要能执行并返回带 apply 的 exports
  const out = captured.factory(requireWithReact(fakeReact()));
  assert.equal(typeof out.apply, 'function', 'factory 必须导出 apply');
  assert.ok(Array.isArray(out.inject), 'factory 必须导出 inject（数组）');
  assert.equal(out.name, captured.id, 'name 应与 id 一致');
});

// ── C4: apply 在「什么都没有」的 ctx 下不崩（降级）──────────────────────────
test('C4: apply 在无 slots / 无 uiWorkspace 的 ctx 下安全执行', () => {
  const src = readClient();
  let captured = null;
  const fakeWindow = {
    __ModuleLoader__: { load(def) { captured = def; } },
    addEventListener() {},
    removeEventListener() {},
  };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', src)(fakeWindow, undefined);
  const mod = captured.factory(requireWithReact(fakeReact()));

  const ctx = { get() { return undefined; } };  // 什么都拿不到
  let dispose;
  assert.doesNotThrow(() => { dispose = mod.apply(ctx); });
  assert.equal(typeof dispose, 'function', 'apply 应返回清理函数');
  assert.doesNotThrow(() => dispose());
});

// ── C5: package.json 的 client 声明与文件存在性一致 ─────────────────────────
test('C5: package.json 声明 dsh.client 且 exports["./client"] 指向真实文件', () => {
  const pkg = JSON.parse(readFileSync(PKG, 'utf8'));
  assert.ok(pkg.dsh.client, '必须声明 dsh.client');
  assert.equal(pkg.dsh.client.platform, 'web');
  // package.json 的 dsh.client.inject 声明「需要宿主预注入什么」。
  // 我们不需要宿主注入任何东西（API_PREFIX 是常量、没有外部模块），所以这里为空；
  // 而 **代码里** 的 `exports.inject = ['slots']` 是 Cordis 的服务依赖，
  // 由 C13 单独断言。两者语义不同，不要混。
  assert.deepEqual(pkg.dsh.client.inject, [],
    'dsh.client.inject 应为空：本 client 不需要宿主预注入模块');
  assert.ok(pkg.exports['./client'], 'exports 必须暴露 ./client');
  // 指向的文件必须存在且有内容
  const target = pkg.exports['./client'].replace(/^\.\//, '');
  const src = readFileSync(new URL('../' + target, import.meta.url), 'utf8');
  assert.ok(src.length > 500, 'client.js 不应为空');
});

// ── C6: route 前缀在 host 与 client 两侧一致（防拼错导致 404）───────────────
test('C6: host 与 client 的 route 前缀一致', async () => {
  const bridge = await import('../lib/session-bridge.js');
  const src = readClient();
  assert.ok(bridge.ROUTE_PREFIX.startsWith('/api/'), 'host 前缀应以 /api/ 开头');
  const seg = bridge.ROUTE_PREFIX.replace('/api/', '');
  assert.ok(src.includes("API_PREFIX = '" + seg + "'"),
    `client 的 API_PREFIX 必须等于 host 的路径段 "${seg}"`);
});

// ── C7: 设置分区必须返回 React 元素，不能返回原生 DOM ──────────────────────
// v0.4.1 首版用 document.createElement 造节点 → 设置页点进去**一片空白**
// （React 不认原生 DOM 节点，不会挂载）。本测试锁住这个回归。
test('C7: 设置分区返回 React 元素（不是原生 DOM 节点）', () => {
  const src = readClient();
  const r = fakeReact();
  let captured = null;
  const fakeWindow = {
    __ModuleLoader__: { load(def) { captured = def; } },
    addEventListener() {}, removeEventListener() {},
  };
  new Function('window', 'document', src)(fakeWindow, undefined);
  const mod = captured.factory(requireWithReact(r));

  // 造一个能捕获 slots.register 注册项的 ctx
  let registered = null;
  const ctx = {
    get(id) {
      if (id === 'slots') {
        return {
          inject(_name, fn) { fn(); },
          register(meta, component) { registered = { meta, component }; },
        };
      }
      return undefined;
    },
  };
  mod.apply(ctx);

  assert.ok(registered, '应在 settings.section 上注册一项');
  assert.equal(registered.meta.name, 'settings.section');
  assert.equal(typeof registered.component, 'function', '注册的应是组件函数');

  // 渲染它 —— 必须产出 React 元素
  const tree = registered.component({});
  assert.ok(tree, '组件应返回内容（不能返回 null 当有了 React）');
  assert.equal(tree.$$typeof, Symbol.for('react.element'),
    '必须返回 React 元素；返回原生 DOM 会导致设置页空白');
  assert.equal(tree.type, 'div', '根节点应是 div');
});

// ── C8: React 拿不到时返回 null 而不是抛（宁可无卡，不可崩页）──────────────
test('C8: 没有 React 时组件返回 null，且不抛异常', () => {
  const src = readClient();
  let captured = null;
  const fakeWindow = {
    __ModuleLoader__: { load(def) { captured = def; } },
    addEventListener() {}, removeEventListener() {},
  };
  new Function('window', 'document', src)(fakeWindow, undefined);
  // require 抛错 → 模块内 React 应为 null
  const mod = captured.factory(() => { throw new Error('no react'); });
  assert.ok(mod, 'factory 仍应返回 exports（不能因缺 React 就失败）');
  assert.equal(typeof mod.apply, 'function');

  let registered = null;
  const ctx = {
    get(id) {
      if (id === 'slots') {
        return {
          inject(_n, fn) { fn(); },
          register(_m, c) { registered = c; },
        };
      }
      return undefined;
    },
  };
  assert.doesNotThrow(() => mod.apply(ctx));
  assert.equal(typeof registered, 'function');
  let out;
  assert.doesNotThrow(() => { out = registered({}); });
  assert.equal(out, null, '没有 React 时应返回 null（不渲染），而不是抛');
});

// ── C9: 设置分区不得再用 document.createElement 造节点 ─────────────────────
// 注意：必须**剥掉注释**再检查，否则文件头解释"为什么不能用 createElement"
// 的那段说明文字会误伤本测试（自测时踩到过）。
test('C9: 不用 document.createElement 造 UI（但允许非 UI 的辅助元素）', () => {
  const src = readClient();
  const code = src
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))   // 去掉纯注释行
    .join('\n');

  // 唯一允许的用法：创建一个**不可见**的 <input type=file> 来触发系统文件对话框。
  // 它不会被 React 渲染、也不进入组件树，与"用原生 DOM 冒充 UI"是两回事
  // （后者才会导致设置页空白，见 v0.4.1 事故）。
  const allowed = /document\.createElement\(\s*'input'\s*\)/g;
  const stripped = code.replace(allowed, '/* allowed: file picker */');

  assert.doesNotMatch(stripped, /document\.createElement/,
    '不得用原生 DOM 造设置页 UI —— React 不会挂载它（v0.4.1 实测空白）。'
    + '唯一例外是不可见的 file input（触发系统文件对话框）。');
});

// ── C10: 设置卡必须有真控件（不能只有说明文字）────────────────────────────
// 用户实测反馈：「只有说明卡，没有可编辑或者可以操作的地方」。
// 这条锁住它：渲染出来的树里必须能找到 checkbox / range / select。
test('C10: 设置卡内含真控件（checkbox + range + select）', async () => {
  const src = readClient();
  const r = fakeReact();
  let captured = null;
  const fakeWindow = {
    __ModuleLoader__: { load(def) { captured = def; } },
    addEventListener() {}, removeEventListener() {},
  };
  new Function('window', 'document', src)(fakeWindow, undefined);
  const mod = captured.factory(requireWithReact(r));

  let component = null;
  const ctx = {
    get(id) {
      if (id === 'slots') {
        return { inject(_n, fn) { fn(); }, register(_m, c) { component = c; } };
      }
      return undefined;
    },
  };
  mod.apply(ctx);
  assert.ok(component, '应注册设置卡');

  // fetch 桩：返回一份已有配置，让组件走到"有控件"分支
  globalThis.fetch = () => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ ok: true, values: { volume: 55, voice: true, voiceMode: 'fixed', voiceName: 'zundamon-normal' } }),
  });

  // 首次渲染是「读取配置中…」（loadConfig 是异步的）。
  // 让假 React 挂上 rerender，等微任务跑完 loadConfig 后再渲染一次。
  let tree = component({});
  r.__hooks.rerender = () => { r.__resetIndex(); tree = component({}); };
  // 等两轮微任务，确保 fetch 的 Promise 链走完
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  // 再主动渲染一次（此时 state 已 loaded）
  r.__resetIndex();
  tree = component({});
  assert.ok(tree, '卡应有内容');

  // 深度遍历树，收集所有元素的 type
  const types = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type) types.push(node.type);
    const kids = node.props && node.props.children;
    if (kids) walk(kids);
  };
  walk(tree);

  assert.ok(types.includes('input'), '必须有 input 控件（开关/音量）');
  assert.ok(types.includes('select'), '必须有 select 控件（音色/模式）');

  // 更具体：应同时出现 checkbox 与 range 两种 input
  const inputKinds = [];
  const walkInputs = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walkInputs);
    if (node.type === 'input' && node.props && node.props.type) inputKinds.push(node.props.type);
    const kids = node.props && node.props.children;
    if (kids) walkInputs(kids);
  };
  walkInputs(tree);
  assert.ok(inputKinds.includes('checkbox'), '应有 checkbox（语音开关 / 事件开关）');
  assert.ok(inputKinds.includes('range'), '应有 range（音量滑杆）');
  // 收紧：个数也要够。语音开关 1 个 + 事件开关 8 个 = 至少 9 个 checkbox；
  // 少一个都说明某个控件被删掉了（早期断言只看"存在"，去掉一个仍然绿，是空断言）。
  const checkboxCount = inputKinds.filter((k) => k === 'checkbox').length;
  // 语音开关 1 + 弹窗开关 1 + 事件开关 8 = 至少 10 个（v0.4.4 加了弹窗开关）
  assert.ok(checkboxCount >= 10, `checkbox 至少 10 个（语音 + 弹窗 + 8 个事件），实际 ${checkboxCount}`);
  // range / select 的数量**随音源而变**（tts 时多一个语速滑杆；bundled 才显示音色下拉），
  // 所以断言下限而不是精确值 —— 精确值会把"以后再加一个控件"变成假失败。
  assert.ok(inputKinds.filter((k) => k === 'range').length >= 1, '至少有音量滑杆');
  assert.ok(types.filter((x) => x === 'select').length >= 1, '至少有音源选择器');
});

// ── C11: 每个事件开关都必须有面向用户的说明文字 ────────────────────────────
// 用户反馈：「空闲门不是所有人都知道什么意思」。内部术语必须在界面上解释。
// 这条锁住：TOGGLES 里每一项的第 3 个元素（说明）都必须是非空字符串，
// 且不能只是复述键名。
test('C11: 每个事件开关都带人话说明（尤其 idleGate）', () => {
  const src = readClient();

  // 解析 TOGGLES 数组里的每一项
  const m = src.match(/var TOGGLES = \[([\s\S]*?)\n    \]/);
  assert.ok(m, '应能定位 TOGGLES 定义');
  const body = m[1];

  // 每个 [ 'key', '名称', '说明' ] 元组
  const tuples = [...body.matchAll(/\[\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*([\s\S]*?)\]/g)];
  assert.ok(tuples.length >= 8, `应有至少 8 个开关，实际 ${tuples.length}`);

  const problems = [];
  for (const t of tuples) {
    const key = t[1];
    const label = t[2];
    const descRaw = t[3].trim();
    if (!descRaw) { problems.push(`${key} 缺少说明`); continue; }
    // 去掉字符串拼接与引号，得到实际文案
    const text = descRaw.replace(/'/g, '').replace(/\+/g, '').replace(/\s+/g, '');
    if (text.length < 8) problems.push(`${key} 的说明过短（${text}）`);
    if (text === label.replace(/\s+/g, '')) problems.push(`${key} 的说明只是复述名称`);
  }
  assert.deepEqual(problems, [], '所有开关都应有足够清楚的人话说明');

  // idleGate 必须有解释"它在防什么"的实质内容
  const idle = tuples.find((t) => t[1] === 'idleGate');
  assert.ok(idle, '应有 idleGate 项');
  const idleText = idle[3].replace(/'/g, '').replace(/\+/g, '');
  assert.match(idleText, /子任务|子代理/, 'idleGate 说明应提到它和子任务/子代理有关');
  assert.match(idleText, /等|先不响|结束/, 'idleGate 说明应讲清"等结束再响"这个行为');
  // 不应把内部术语直接当标题
  assert.doesNotMatch(idle[2], /空闲门/, '标题不应直接用"空闲门"这种内部术语');
});

// ── C12: client 内联的跳转判定必须与 lib/session-jump.js 行为一致 ──────────
// client 是经典脚本（不能 import ESM），所以把 decideJump 内联了一份。
// 两份逻辑漂移的话，测试全绿但线上行为错误 —— 这条锁住一致性。
test('C12: client 内联 shouldJump 与 lib decideJump 行为等价', async () => {
  const src = readClient();

  // 提取 client 里的 shouldJump 函数体
  const m = src.match(/function shouldJump\(inp\)\s*\{([\s\S]*?)\n    \}/);
  assert.ok(m, '应能定位 client 内联的 shouldJump');
  // eslint-disable-next-line no-new-func
  const inlineShouldJump = new Function('inp', m[1]);

  const { decideJump } = await import('../lib/session-jump.js');

  // 穷举开关 × 前后台 × 边界，逐一比对
  const cases = [];
  for (const bg of [true, false, undefined]) {
    for (const fg of [true, false, undefined]) {
      for (const phase of ['background', 'foreground']) {
        cases.push({
          jumpWhenBackground: bg,
          jumpWhenForeground: fg,
          consumed: false,
          sessionId: 'sess-1',
          notifiedAt: phase === 'background' ? 1000 : 500,
          leftAt: phase === 'background' ? 500 : 1000,
        });
      }
    }
  }
  // 再加几条边界
  cases.push({ sessionId: '', notifiedAt: 1000, leftAt: 500 });
  cases.push({ sessionId: 's', notifiedAt: 1000, leftAt: 0 });
  cases.push({ sessionId: 's', notifiedAt: 0, leftAt: 500 });
  cases.push({ sessionId: 's', consumed: true, notifiedAt: 1000, leftAt: 500 });

  // returnedAt 的三种情形（第一版缺这个参数，导致"离开过一次后前台判定永久失效"）：
  //   undefined → 还没回来（应算后台）
  //   > notifiedAt → 通知在回来之前到达（应算后台）
  //   <= notifiedAt → 通知在回来之后到达（应算前台）
  for (const bg of [true, false]) {
    for (const fg of [true, false]) {
      cases.push({ jumpWhenBackground: bg, jumpWhenForeground: fg, sessionId: 's', notifiedAt: 5000, leftAt: 1000, returnedAt: undefined });
      cases.push({ jumpWhenBackground: bg, jumpWhenForeground: fg, sessionId: 's', notifiedAt: 5000, leftAt: 1000, returnedAt: 9000 });
      cases.push({ jumpWhenBackground: bg, jumpWhenForeground: fg, sessionId: 's', notifiedAt: 9000, leftAt: 1000, returnedAt: 5000 });
      cases.push({ jumpWhenBackground: bg, jumpWhenForeground: fg, sessionId: 's', notifiedAt: 5000, leftAt: 1000, returnedAt: NaN });
    }
  }

  const diffs = [];
  for (const c of cases) {
    const a = inlineShouldJump(c);
    const b = decideJump(c).jump;
    if (a !== b) {
      diffs.push({ input: c, client: a, lib: b });
    }
  }
  assert.deepEqual(diffs, [],
    'client 内联实现与 lib/session-jump.js 必须行为一致，否则线上会误跳/漏跳');
});

// ── C13: exports.inject 必须声明 slots（否则设置分区可能永久不出现）────────
// 独立审查 2026-10-17 指出：slots 由 dsh-client-ui-renderer 提供，
// 若本插件激活早于该服务生效，`ctx.get('slots', false)` 会拿到 undefined；
// 原实现没有重试 → 设置页分区永久缺失且不留日志。
// 声明为 inject 后宿主会等依赖就绪再激活，从根上避免竞态。
test('C13: exports.inject 声明了 slots 依赖', () => {
  const src = readClient();
  let captured = null;
  const fakeWindow = {
    __ModuleLoader__: { load(def) { captured = def; } },
    addEventListener() {}, removeEventListener() {},
  };
  new Function('window', 'document', src)(fakeWindow, undefined);
  const mod = captured.factory(requireWithReact(fakeReact()));
  assert.ok(Array.isArray(mod.inject), 'inject 应是数组');
  assert.ok(mod.inject.includes('slots'),
    "inject 必须包含 'slots'，否则设置页分区可能因激活顺序而永久不出现");
});

// ── C14: 音源选择器必须存在且五选项齐全 ────────────────────────────────────
// 用户 2026-10-17 的核心需求："怎么自由怎么来"—— 有人要语音包、有人要系统音、
// 有人只想听自己的文件、有人干脆不要声音。四种人都要能选。
test('C14: 设置卡有音源选择器，含全部五种音源', () => {
  const src = readClient();
  // 选择性读取 SOURCES 定义
  const m = src.match(/var SOURCES = \[([\s\S]*?)\n      \]/);
  assert.ok(m, '应能定位 SOURCES 定义');
  for (const id of ['tts', 'bundled', 'system', 'custom', 'none']) {
    assert.ok(m[1].includes("'" + id + "'"), `音源选择器应包含 ${id}`);
  }
  // 必须有下拉选择控件
  assert.match(src, /apply\(\{ audioSource: e\.target\.value \}/, '选择后应保存 audioSource');
});

// ── C15: Toast 开关必须存在 ───────────────────────────────────────────────
test('C15: 设置卡有「显示通知弹窗」开关', () => {
  const src = readClient();
  assert.match(src, /apply\(\{ showToast: !!e\.target\.checked \}/, '应有 showToast 保存逻辑');
  assert.match(src, /显示通知弹窗/, '应有对应文案');
});

// ── C16: 音源专属设置按当前音源条件显示 ────────────────────────────────────
// 避免界面上堆一堆无关选项：选 tts 时不该看到音色包下拉，反之亦然。
test('C16: 音源专属设置按当前音源条件渲染', () => {
  const src = readClient();
  assert.match(src, /if \(curSource === 'bundled'\)/, '语音包设置应受条件控制');
  assert.match(src, /if \(curSource === 'tts'\)/, 'TTS 设置应受条件控制');
  assert.match(src, /if \(curSource === 'custom'\)/, '自定义音频设置应受条件控制');
});

// ── C17: 自定义音频按事件分别选择 ──────────────────────────────────────────
test('C17: 自定义音频支持按事件分别选文件', () => {
  const src = readClient();
  const m = src.match(/var CUSTOM_KINDS = \[([\s\S]*?)\n        \]/);
  assert.ok(m, '应能定位 CUSTOM_KINDS');
  for (const k of ['Done', 'Fail', 'Question', 'Approval']) {
    assert.ok(m[1].includes("'" + k + "'"), `应支持为 ${k} 单独选文件`);
  }
  // 保存键名必须与 config-store 白名单一致（customFileDone 等）
  assert.match(src, /var key = 'customFile' \+ suffix/, '保存键应为 customFile<Kind>');
});

// ── C18: 拿不到真实路径时必须提示，不能静默 ────────────────────────────────
test('C18: 文件选择失败时给出明确提示而非静默', () => {
  const src = readClient();
  assert.match(src, /没有取到文件路径/, '应提示用户');
  // 必须尝试官方 __DSH_HOST_PATHS__ 拿真实路径
  assert.match(src, /__DSH_HOST_PATHS__/, '应使用宿主暴露的 pathFor 拿真实路径');
  assert.match(src, /pathFor/, '应调用 pathFor');
});

// ── C19: 高级区必须有「按事件覆盖音源」 ────────────────────────────────────
// 用户 2026-10-17 明确要求："完成想听日语、失败想听系统警告音"。
// 这必须是可配置的，且放在折叠区（多数人不需要，铺开只会劝退）。
test('C19: 高级折叠区含五种事件的音源覆盖', () => {
  const src = readClient();
  // 折叠加展开按钮。
  // 文案在 v0.4.53 第一阶段 UI 里从「高级：给每种提醒单独设置」改成
  // 分区标题「高级设置」（+ 分区说明），所以这里断言新文案。
  // ⚠️ 改的是**文案**，不是行为：下面「五个事件都要有覆盖下拉」的断言原样保留。
  assert.match(src, /高级设置/, '应有高级折叠区标题');
  assert.match(src, /advOpen/, '应有展开/收起状态');
  assert.match(src, /function toggleAdv\(\)/, '应有展开/收起的切换动作');

  // 五个事件都要有覆盖下拉
  const m = src.match(/var KIND_ROWS = \[([\s\S]*?)\]\s*\n/);
  assert.ok(m, '应能定位 KIND_ROWS');
  for (const k of ['Done', 'Fail', 'Question', 'Approval', 'Blocked']) {
    assert.ok(m[1].includes("'" + k + "'"), `应支持 ${k} 的事件级覆盖`);
  }

  // 写入键名必须与 config-store 白名单一致（kindSourceFail 等）。
  //
  // v0.4.10 起**读写字段名不同**，这是必须的：
  //   写 → 扁平键 kindSourceFail='system'（白名单只认标量）
  //   读 → 字典 v.audioSourceByKind.fail（backend 会把扁平键聚合成字典，
  //        生效值里没有扁平键）
  // 第一版读写都用扁平键，导致界面永远显示"跟随默认"（其实已存进文件）。
  assert.match(src, /var writeKey = 'kindSource' \+ suffix/, '写入键应为 kindSource<Kind>');
  assert.match(src, /v\.audioSourceByKind/, '读取应查 audioSourceByKind 字典');

  // 必须有「跟随默认」选项，否则用户无法把某项改回继承
  assert.match(src, /__follow__/, '应有「跟随默认」选项');
  assert.match(src, /跟随默认（/, '「跟随默认」应显示当前全局音源名');
});

// ── C20: 热重载开关必须在 GUI，且默认关 ───────────────────────────────────
// 用户 2026-10-17 要求："UI 里面没有放上热重载吗？让他选支不支持"
test('C20: GUI 有热重载开关，且说明其风险', () => {
  const src = readClient();
  // ⚠️ v0.4.57：从「自动热重载开关」改成「点一次重载一次」的按钮。
  //
  // 原因（2026-10-18 实测宿主崩溃）：watcher 在我改 UI 期间触发了 40 多次
  // 失败重载，每次 dispose 都释放宿主仍在用的会话引用，最后渲染进程崩溃。
  // 现在没有开关、没有自动触发，只有显式按钮。
  assert.doesNotMatch(src, /apply\(\{ devReload: !!e\.target\.checked \}/,
    '不应再有 devReload 的自动重载开关 —— 自动触发已被移除');
  assert.match(src, /重载现在生效/, '应有一键重载按钮');
  assert.match(src, /function doReload\(\)/, '按钮应触发一次显式重载请求');
  assert.match(src, /cfgUrl\('reload'\)/, '重载应走 POST /reload');
  // 必须说明风险：依赖宿主内部结构、失效不影响播报
  assert.match(src, /依赖宿主内部结构/, '应说明它依赖内部结构');
  assert.match(src, /失效时只报错/, '应说明失效时的行为');
});

// ── C21: 状态重建必须保留 advOpen（防"点一下就自己收起"）──────────────────
test('C21: 所有状态重建都保留 advOpen，折叠区不会自己收起', () => {
  const src = readClient();
  // 找所有 return { ... loaded: ... } 形式的状态重建
  const rebuilds = [...src.matchAll(/return \{\s*\n?\s*loaded:/g)];
  assert.ok(rebuilds.length >= 4, `应找到多处状态重建，实际 ${rebuilds.length}`);

  // 逐个检查每个重建块（从 return { 到下一个 }）是否含 advOpen。
  // 不能用全局计数：注释和"切换折叠"那处也会出现 advOpen，会把漏掉的真问题掩盖。
  const missing = [];
  const re = /return \{\n([\s\S]*?)\n\s{0,20}\}/g;
  let mm;
  while ((mm = re.exec(src)) !== null) {
    const body = mm[1];
    if (!/loaded:/.test(body)) continue;        // 不是状态重建
    if (!/advOpen:/.test(body)) {
      missing.push(body.split('\n')[0].trim().slice(0, 60));
    }
  }
  assert.deepEqual(missing, [],
    '以下状态重建漏了 advOpen，会导致保存后折叠区自己收起：' + JSON.stringify(missing));
});

// ── C22: 跳转开关必须在 GUI，且不在折叠区里 ────────────────────────────────
// 用户 2026-10-17 指出："是否跳回会话好像也还没做，应该也做到 GUI 里面。"
// 此前只有跳转**逻辑**在读这两个配置键，界面上根本没有开关。
//
// 而且要放在**常规区**，不是高级折叠区 —— 它属于大多数人都该看到的设置。
test('C22: 跳转开关有真控件，且位于高级折叠区之外', () => {
  const src = readClient();

  // 1) 必须有保存逻辑（真控件，而不是仅读配置）
  assert.match(src, /apply\(\{ jumpWhenBackground: !!e\.target\.checked \}/,
    '后台跳转应有保存逻辑');
  assert.match(src, /apply\(\{ jumpWhenForeground: !!e\.target\.checked \}/,
    '前台跳转应有保存逻辑');

  // 2) 必须有两个独立开关的文案
  assert.match(src, /在后台完成时跳转/, '应有后台跳转开关文案');
  assert.match(src, /窗口就在眼前时也跳转/, '应有前台跳转开关文案');

  // 3) 位置：必须在 `if (advOpen)` 之前（常规区），不能被折叠遮住
  const jumpIdx = src.indexOf("key: 'jumpTitle'");
  const advIdx = src.indexOf('if (advOpen) {');
  assert.ok(jumpIdx > 0, '应能找到跳转块');
  assert.ok(advIdx > 0, '应能找到高级区');
  assert.ok(jumpIdx < advIdx,
    '跳转开关必须在高级折叠区**之前**（它属于常规设置，不该被折叠藏起来）');

  // 4) 说明实测限制，免得用户以为是 bug
  assert.match(src, /Toast 的点击只能唤起窗口/, '应说明"点通知才跳"做不到的原因');
});

// ── C23: 两个开关都关时给出明确提示 ────────────────────────────────────────
test('C23: 两个跳转开关都关时提示"不会自动跳转"', () => {
  const src = readClient();
  assert.match(src, /两个都关，不会自动跳转/, '应明确告知当前不跳转');
});

// ── C24: TTS 台词输入框 ────────────────────────────────────────────────────
// 用户 2026-10-17 要求："既然是这个 TTS 台词，是不是可以用户去输一段话呀？"
test('C24: TTS 设置区有自定义台词输入框（五种事件）', () => {
  const src = readClient();
  // 五行的定义
  const m = src.match(/var TTS_TEXT_ROWS = \[([\s\S]*?)\n        \]/);
  assert.ok(m, '应能定位 TTS_TEXT_ROWS');
  for (const k of ['Done', 'Fail', 'Question', 'Approval', 'Blocked']) {
    assert.ok(m[1].includes("'" + k + "'"), `应支持为 ${k} 自定义台词`);
  }
  // 保存键名必须与 config-store 白名单一致
  assert.match(src, /var key = 'ttsText' \+ suffix/, '保存键应为 ttsText<Kind>');
  // 必须是文本输入而不是别的控件
  assert.match(src, /type: 'text'/, '应为文本输入框');
  // 必须限长（防止用户写几千字拖垮合成）
  assert.match(src, /maxLength: 60/, '输入框应限长 60');
  // 必须说明留空的含义，否则用户不知道该不该填
  assert.match(src, /留空则每次从内置的几句里随机/, '应说明留空 = 内置随机');
});

// ── C25: 高级区每行能展开「该音源的子设置」 ────────────────────────────────
// 用户 2026-10-17 指出：只选了音源类型，但"念什么话、什么声音、什么音效"
// 还得回上面用全局的，不合逻辑。而且不只 TTS —— 语音包、系统音效各有参数。
test('C25: 高级区覆盖音源后展开对应子设置', () => {
  const src = readClient();

  // 1) 子设置只在"覆盖了音源"时展开（跟随时不展开，避免界面爆炸）
  assert.match(src, /if \(cur === FOLLOW\) return/, '「跟随默认」不应展开子设置');
  assert.match(src, /var effSrc = \(cur === FOLLOW\) \? curSource : cur/, '应能算出实际生效的音源');

  // 2) 四种音源各有自己的子参数
  assert.match(src, /kindTtsVoice/, 'tts 子设置应有发音人');
  assert.match(src, /kindTtsRate/, 'tts 子设置应有语速');
  assert.match(src, /kindVoiceMode/, 'bundled 子设置应有音色模式');
  assert.match(src, /kindVoiceName/, 'bundled 子设置应有音色名');
  assert.match(src, /kindSystemSound/, 'system 子设置应有音效选择');

  // 3) 子设置容器存在（有缩进的视觉从属关系）
  assert.match(src, /S\.subBox/, '应有子设置容器样式');
  assert.match(src, /borderLeft/, '子设置应有左边框以表明从属');
});

// ── C26: 子设置保存的键名与 config-store 白名单一致 ────────────────────────
test('C26: 子设置用 kind<Param><Kind> 命名，与白名单一致', () => {
  const src = readClient();
  // 键名通过 suffix 拼接，检查拼接基准
  for (const base of ['kindTtsVoice', 'kindTtsRate', 'kindVoiceMode', 'kindVoiceName', 'kindSystemSound']) {
    assert.ok(src.includes("'" + base + "'"), `应使用 ${base} 作为键名前缀`);
  }
  // 必须用 suffix 拼，而不是写死某个事件
  assert.match(src, /var kKey = function \(base\) \{ return base \+ suffix \}/, '键名应由前缀 + 事件后缀拼成');
});

// ── C27: 设置页必须暴露精准跳转开关 ───────────────────────────────────────
//
// ## 为什么要有这条
//
// 2026-10-20 发布前审查发现：`toastJumpSession`（点哪条 Toast 跳哪条会话）
// 从 v0.4.70 就实现了，但**设置页里没有开关** —— 普通用户只能改配置文件
// 才能启用。而 README 写着「设置页 → 通知 → 打开它」，文档与实现不一致。
//
// 一个功能"做了但用户开不了"，等于没做。
test('C27: 设置页必须提供「点击通知跳到对应会话」开关', () => {
  const src = readClient();

  // 开关本体：能读也能写这个配置键
  assert.match(src, /checked:\s*v\.toastJumpSession === true/,
    '设置页必须有读取 toastJumpSession 的 checkbox');
  assert.match(src, /apply\(\{ toastJumpSession: !!/,
    '勾选后必须能保存 toastJumpSession');

  // 文案：用户要能看懂"这是点了才跳，和自动跳不是一回事"
  assert.match(src, /点击通知跳到对应会话/, '开关要有中文标签');
  assert.match(src, /点了才跳|你点了才跳/, '文案必须说明这是"点了才跳"');

  // 必须告知会注册 Windows 协议（有人会介意）
  assert.match(src, /dshnotify-say:\/\//, '文案必须提到会注册 dshnotify-say:// 协议');
  assert.match(src, /关掉时自动清理|关掉.*清理/, '文案必须说明关掉会清理');

  // 开启后必须提示"自动跳暂时不生效"，否则用户调下面的开关没反应会以为坏了
  assert.match(src, /下面两个自动跳开关暂时不生效/,
    '开启精准跳转时必须提示自动跳已被接管');

  // 反向断言：不能残留"点通知才跳做不到"这类过时结论作陈述
  const stale = src.split('\n').filter(
    (l) => l.includes('点通知才跳') && l.includes('做不到')
      && !l.includes('更正') && !l.includes('过时'),
  );
  assert.equal(stale.length, 0,
    '设置页注释里还留着"点通知才跳做不到"的旧结论（未标注更正）');
});

// ══════════════════════════════════════════════════════════════════════════
// v0.6.1 启动守卫（C28–C32）
//
// 背景：DSH 把多个插件的 client 打进同一个 classic script batch。同批里任一
// 包解析失败或抛错，排在后面的 `__ModuleLoader__.load()` 全都不会执行，随后
// web-boot 把「没有 fiber」的每个 entry 都记成 import failed 并弹致命框
// （2026-11-27 18:45 实测：dsh-light-guard 有一行 TS 残留，弹窗却点名我们）。
//
// 这些用例钉住三件事：①我们的产物自己必须能当 classic script 解析；
// ②顶层注册必须容错且**不能**用全局布尔锁（否则热重载失效）；
// ③真错误仍要被抛出（异步），不能被静默吞掉。
// ══════════════════════════════════════════════════════════════════════════

// ── C28: 产物必须能被 classic script 解析 ──────────────────────────────────
test('C28: client.js 能被 new Function 解析（classic script 门）', () => {
  const src = readClient();
  // 这一条就是 18:45 那次事故的镜像：同批的别的插件在这里炸了，
  // 我们被连坐。我们自己的产物必须永远过这道门。
  assert.doesNotThrow(() => { /* eslint-disable-next-line no-new-func */
    new Function(src);
  }, 'client.js 必须能被当作 classic script 解析（出现 TS 语法/顶层 await 就会整批作废）');
});

// ── C29: 顶层注册必须包在 try/catch 里，且不用全局布尔锁 ────────────────────
test('C29: 顶层 load() 被 try/catch 包住，duplicate 匹配宽松，且无全局布尔锁', () => {
  const src = readClient();

  // ① load 调用必须在 try 块里
  assert.match(src, /try\s*\{[\s\S]{0,400}?window\.__ModuleLoader__\.load\s*\(\s*\{/,
    'window.__ModuleLoader__.load(...) 必须被 try 包住 —— 否则重复注册会整批拖垮');

  // ② catch 里必须按文案识别「重复注册」，且文案匹配要宽松
  //    （宿主改措辞也不该让守卫失效；对应 DSH ClientModuleSystem.register 的报错）
  assert.match(src, /\}\s*catch\s*\(\s*err\s*\)\s*\{/,
    '顶层必须有 catch (err) 分支');
  assert.match(src, /\/duplicate\|already\/i/,
    'duplicate 判定必须用宽松正则 /duplicate|already/i，不要精确匹配宿主文案');

  // ③ 反面断言：不许用全局布尔锁把二次执行直接挡掉 —— 那会让真正的热重载失效
  assert.doesNotMatch(src, /if\s*\(\s*(?:window\.)?__?[A-Za-z]*[Bb]ooted\s*\)\s*return/,
    '不得用全局 booted 布尔锁短路（会让热重载后 bundle 拒绝重新注册）');
  assert.doesNotMatch(src, /^\s*(?:var|let|const)\s+booted\s*=/m,
    '不得引入模块级 booted 标志');

  // ④ 真错误不能被吞：必须异步重抛（microtask 优先，setTimeout 兜底）
  assert.match(src, /queueMicrotask\s*\(\s*function\s*\(\s*\)\s*\{\s*throw\s+err/,
    '非 duplicate 错误必须用 queueMicrotask 重新抛出，让 console 看得见');
  assert.match(src, /setTimeout\s*\(\s*function\s*\(\s*\)\s*\{\s*throw\s+err\s*\}/,
    'queueMicrotask 不可用时要有 setTimeout 兜底');
});

// ── C30: 重复执行时 duplicate 被吞掉（真实执行，不只是文本断言）─────────────
test('C30: 同 realm 内重复执行两次不抛错（duplicate 被吞）', () => {
  const src = readClient();
  let calls = 0;
  const fakeWindow = {
    __ModuleLoader__: {
      load() {
        calls += 1;
        if (calls > 1) {
          throw new Error('client-modules: duplicate factory registration for "dsh-notify-say" '
            + '(bundle executed twice without invalidate?)');
        }
      },
    },
    addEventListener() {},
    removeEventListener() {},
  };
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'document', src);
  assert.doesNotThrow(() => run(fakeWindow, undefined), '第一次执行应成功');
  assert.doesNotThrow(() => run(fakeWindow, undefined),
    '第二次执行撞 duplicate 时必须静默 —— 否则会打断同批其他插件的注册');
  assert.equal(calls, 2, '两次都应真的调用到 load（守卫是 catch，不是提前 return）');
});

// ── C31: 非 duplicate 错误改为异步抛出（不阻断同批邻居）────────────────────
test('C31: 非 duplicate 的启动错误异步重抛，不同步抛出', () => {
  const src = readClient();
  const fakeWindow = {
    __ModuleLoader__: {
      load() { throw new Error('boom: 这是真错误，不能被吞'); },
    },
    addEventListener() {},
    removeEventListener() {},
  };
  const queued = [];
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'document', 'queueMicrotask', src);

  assert.doesNotThrow(() => run(fakeWindow, undefined, (fn) => { queued.push(fn); }),
    '真错误也不能同步抛 —— 同步抛会打断 batch 里后面插件的注册');
  assert.equal(queued.length, 1, '真错误必须被排队重抛（不能静默吞掉）');
  assert.throws(() => queued[0](), /boom: 这是真错误/,
    '排队的那次执行必须真的抛出原错误，让 console 留痕');
});

// ── C32: apply 出口兜底（任何未预料异常都不该让 fiber failed）───────────────
test('C32: apply 有出口兜底，主体在 applyInner 里', () => {
  const src = readClient();

  assert.match(src, /function applyInner\s*\(\s*ctx\s*\)\s*\{/,
    'apply 主体应拆到 applyInner，外层只负责兜底');
  assert.match(src, /function apply\s*\(\s*ctx\s*\)\s*\{[\s\S]{0,600}?return applyInner\s*\(\s*ctx\s*\)/,
    '外层 apply 必须把调用转发给 applyInner');
  assert.match(src, /catch\s*\(\s*e\s*\)\s*\{[\s\S]{0,300}?\[apply\] failed/,
    '兜底必须记一条 [apply] failed 日志（不掩盖问题）');
  assert.match(src, /return function\s*\(\s*\)\s*\{\s*(?:\/\*[\s\S]{0,80}?\*\/)?\s*\}/,
    '兜底路径必须返回空 disposer，cordis 才不会认为 fiber 失败');

  // 运行时：apply 仍可正常调用（兜底不该影响正常路径）
  let captured = null;
  const fakeWindow = {
    __ModuleLoader__: { load(def) { captured = def; } },
    addEventListener() {},
    removeEventListener() {},
  };
  // eslint-disable-next-line no-new-func
  new Function('window', 'document', src)(fakeWindow, undefined);
  const mod = captured.factory(requireWithReact(fakeReact()));
  const dispose = mod.apply({ get() { return undefined; } });
  assert.equal(typeof dispose, 'function', '正常路径仍应返回可调用的 disposer');
  assert.doesNotThrow(() => dispose());
});
