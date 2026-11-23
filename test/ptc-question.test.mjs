/**
 * dsh-notify-say「PTC / code-mode 下的提问提醒」测试 —— v0.5.7（issue #5）。
 *
 * ## 这个文件在防什么
 *
 * PTC（code-mode）模式下，模型手里只有 `run_code` 一个工具，提问工具是**子调用**：
 * 顶层的 `tool/call` 事件里 `name` 恒为 `run_code`，`QUESTION_TOOLS` 判定永远不命中
 * → 通知一声不响，用户只能干等。issue #5 原话是"在 code-mode 下永远不会触发"。
 *
 * 真名与真参数只在 `tool/ptc-dispatch-start` 里（宿主
 * `@deepseek-ai/dsh-tools/lib/types/types.d.ts` 的 `PtcDispatchStartEventData`）。
 * 这个行为**不能靠读源码文本断言**：订阅写错事件名、把 `subCallId` 当 `callId`、
 * 或者忘了结算时清理幂等键，源码正则都照样全绿。
 *
 * ## 观测手段
 *
 * 与 `fail-route.test.mjs` 同款：用 `--import` loader 把 `node:child_process` 换成
 * 记录型假实现 → `spawn()` 只把参数记进 `globalThis.__SPAWN_CALLS`，
 * 不弹 Toast、不出声、不依赖真实 SystemRoot。断言的是**插件实际传给 ps1 的 -Kind**，
 * 这是"用户到底会不会听见提问提醒"的最短证据链。
 *
 * ⚠️ 运行方式：本文件需要 loader，**不能用默认 `node --test`**（否则用例全 skip）。
 * 用 `npm run test:ptc`，或：
 *   node --import ./test/test-env-setup.mjs --import ./test/route-loader-register.mjs --test test/ptc-question.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ⚠️ 必须在 import lib/index.js **之前**把 DSH_HOME 指到空目录：
// 插件会读 `$DSH_HOME/storages/dsh-notify-say/config.json` 作为运行时覆盖层，
// 优先级高于 apply() 传入的 config —— 用真实 DSH_HOME 的话，
// 用户只要在 GUI 里关过 notifyOnQuestion，本文件的断言就会红。
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'notify-ptc-home-'));
process.env.DSH_HOME = ISOLATED_HOME;
process.on('exit', () => {
  try { rmSync(ISOLATED_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

// ⚠️ 显式关闭注册表访问（`test/protocol-ownership.test.mjs` 的 I7 会检查这一行）。
// 本文件的 spawn 已被 loader 换掉，理论上碰不到注册表；但 I7 的规矩是"调 apply()
// 就必须显式声明"，不靠副作用 —— 那个桩哪天被改动，跑测试就会真删用户的协议键。
process.env.DSH_NOTIFY_NO_REGISTRY = '1';

const SKIP = !process.env.DSH_ROUTE_LOADER && '需 npm run test:ptc（带 --import loader）；默认 node --test 跳过';

/** 造最小 ctx 替身（与 wiring / fail-route 同款）。 */
function mkCtx() {
  const handlers = new Map();
  return {
    handlers,
    on(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); },
    get() { return undefined; },
    effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
    emit(name, ...args) { for (const fn of handlers.get(name) || []) fn(...args); },
  };
}

function mkSession(id, extra = {}) {
  return { id, header: { id, ...extra } };
}

/** 从记录的 spawn 调用里取出所有传给 ps1 的 -Kind 值。 */
function kindsOf(calls) {
  const out = [];
  for (const c of calls || []) {
    const args = Array.isArray(c.args) ? c.args : [];
    const i = args.indexOf('-Kind');
    if (i >= 0 && i + 1 < args.length) out.push(String(args[i + 1]));
  }
  return out;
}

/**
 * 起一次插件实例，跑 `body`，返回它期间产生的 -Kind 列表。
 * 每个用例独立 apply()（插件本就支持多次 apply，模块缓存共享但处理器是新的一份）。
 */
async function withPlugin(cfg, body) {
  const { apply } = await import('../lib/index.js');
  const ctx = mkCtx();
  globalThis.__SPAWN_CALLS = [];
  apply(ctx, { voice: true, volume: 0, showToast: true, ...cfg });
  await body(ctx);
  return kindsOf(globalThis.__SPAWN_CALLS);
}

/** 一条 PTC 子调用开始事件（name/arguments 就是真实派发的工具与参数）。 */
function ptcStart(subCallId, name, args) {
  return {
    type: 'tool/ptc-dispatch-start',
    data: {
      rootCallId: 'root-1',
      parentCallId: 'root-1',
      subCallId,
      name,
      arguments: args,
    },
  };
}

const ASK = { questions: [{ question: '要继续吗', header: '确认', options: [{ label: '是' }, { label: '否' }] }] };

test('P0: loader stub 生效（否则本文件的断言无意义）', { skip: SKIP }, () => {
  assert.equal(globalThis.__STUB_CHILD_PROCESS__, true, 'stub 未生效：必须用 npm run test:ptc 跑');
});

test('P1: PTC 子调用提问 → ps1 收到 -Kind question（issue #5 的主症状）', { skip: SKIP }, async () => {
  const sess = mkSession('ptc-sess-1');
  const kinds = await withPlugin({}, (ctx) => {
    ctx.emit('session/event', sess, ptcStart('root-1:ptc:1', 'ask_user_question', ASK));
  });
  assert.deepEqual(kinds, ['question'], `PTC 提问必须播 question，实际 ${JSON.stringify(kinds)}`);
  // 负例：绝不能因为顶层 name 是 run_code 就什么都不播
  assert.notDeepEqual(kinds, [], 'PTC 下提问不得静默');
});

test('P2: PTC 子调用 exit_plan_mode 也走 question（不是 done）', { skip: SKIP }, async () => {
  const sess = mkSession('ptc-sess-2');
  const kinds = await withPlugin({}, (ctx) => {
    ctx.emit('session/event', sess, ptcStart('root-2:ptc:1', 'exit_plan_mode', { plan: '# 计划\n先改 A' }));
  });
  assert.deepEqual(kinds, ['question'], `exit_plan_mode 必须播 question，实际 ${JSON.stringify(kinds)}`);
});

test('P3: PTC 里的普通工具（非提问工具）不得播报 —— 负例', { skip: SKIP }, async () => {
  const sess = mkSession('ptc-sess-3');
  const kinds = await withPlugin({}, (ctx) => {
    ctx.emit('session/event', sess, ptcStart('root-3:ptc:1', 'bash', { command: 'ls' }));
    ctx.emit('session/event', sess, ptcStart('root-3:ptc:2', 'read_file', { path: 'a.txt' }));
  });
  assert.deepEqual(kinds, [], `非提问工具不应播报，实际 ${JSON.stringify(kinds)}`);
});

test('P4: 同一 subCallId 重复派发只播一次（幂等键 = subCallId）', { skip: SKIP }, async () => {
  const sess = mkSession('ptc-sess-4');
  const kinds = await withPlugin({}, (ctx) => {
    const ev = ptcStart('root-4:ptc:1', 'ask_user_question', ASK);
    ctx.emit('session/event', sess, ev);
    ctx.emit('session/event', sess, ev);
  });
  assert.deepEqual(kinds, ['question'], `同 subCallId 只应播一次，实际 ${JSON.stringify(kinds)}`);
});

test('P5: 子调用结算后同类提问可再次提醒（幂等标记必须清）', { skip: SKIP }, async () => {
  const sess = mkSession('ptc-sess-5');
  const id = 'root-5:ptc:1';
  const kinds = await withPlugin({}, (ctx) => {
    ctx.emit('session/event', sess, ptcStart(id, 'ask_user_question', ASK));
    // 子调用结算（内容回到 run_code 程序里）
    ctx.emit('session/event', sess, {
      type: 'tool/ptc-dispatch',
      data: { rootCallId: 'root-5', parentCallId: 'root-5', subCallId: id, name: 'ask_user_question', arguments: ASK, isError: false, content: [] },
    });
    // 同一个 subCallId 再来一次 —— 只有标记被清掉才会再播
    ctx.emit('session/event', sess, ptcStart(id, 'ask_user_question', ASK));
  });
  assert.deepEqual(kinds, ['question', 'question'], `结算后应能再播一次，实际 ${JSON.stringify(kinds)}`);
});

test('P6: notifyOnQuestion=false 时 PTC 提问也不播（开关仍然生效）', { skip: SKIP }, async () => {
  const sess = mkSession('ptc-sess-6');
  const kinds = await withPlugin({ notifyOnQuestion: false }, (ctx) => {
    ctx.emit('session/event', sess, ptcStart('root-6:ptc:1', 'ask_user_question', ASK));
  });
  assert.deepEqual(kinds, [], `关掉提问提醒后不得播报，实际 ${JSON.stringify(kinds)}`);
});

test('P7: 子代理会话里 PTC 提问默认不播（subagents=false 门仍生效）', { skip: SKIP }, async () => {
  const sess = mkSession('ptc-child-1', { origin: 'subagent', parentSession: 'ptc-main-1' });
  const kinds = await withPlugin({}, (ctx) => {
    ctx.emit('session/event', sess, ptcStart('root-7:ptc:1', 'ask_user_question', ASK));
  });
  assert.deepEqual(kinds, [], `子代理的提问默认不播，实际 ${JSON.stringify(kinds)}`);
});

test('P8: 顶层 tool/call 路径没被改坏（回归）', { skip: SKIP }, async () => {
  const sess = mkSession('top-sess-1');
  const kinds = await withPlugin({}, (ctx) => {
    ctx.emit('session/event', sess, {
      type: 'tool/call',
      data: { callId: 'call-1', name: 'ask_user_question', arguments: ASK },
    });
  });
  assert.deepEqual(kinds, ['question'], `顶层提问仍须播报，实际 ${JSON.stringify(kinds)}`);
});
