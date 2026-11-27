/**
 * 前端启动自检（v0.6.1）的源码契约测试。
 *
 * 背景：DSH web-boot 失败时，前端可能一条日志都发不出来，notify.log 里会是
 * 「什么都没有」——事后无法区分「前端没起来」与「起来了但没干活」。
 *
 * 这条自检把「什么都没有」变成一条可检索的证据：宿主启动 45s 内收不到任何
 * `[ui] CLIENT-BOOT` 就记 `[boot] client never booted …`。
 *
 * 为什么用源码断言而不是跑真宿主：自检逻辑嵌在 `apply(ctx, config)` 内部，
 * 直接跑需要伪造 cordis + webServer + 45s 时钟，成本远高于收益；
 * 这里钉住「判定条件、进程级标记、清理」三个易漂移点。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');

test('B1: 启动自检存在，判据是 45s 内没收到 CLIENT-BOOT', () => {
  assert.match(INDEX, /BOOT_SELFCHECK_MS\s*=\s*45000/, '自检窗口应为 45s');
  assert.match(INDEX, /\[boot\] client never booted within 45s/,
    '超时日志必须可检索（诊断导出时靠它判断前端是否起来）');
  // 必须在超时回调里再判一次，避免定时器与 CLIENT-BOOT 的竞态
  assert.match(INDEX, /bootCheckTimer\s*=\s*setTimeout\(\(\)\s*=>\s*\{\s*\n\s*if \(clientBootSeen\) return;/,
    '超时回调必须先复查 clientBootSeen');
  // 定时器不应拖住进程退出
  assert.match(INDEX, /bootCheckTimer\.unref\(\)/, '定时器必须 unref');
});

test('B2: 用进程级标记，热重载不会误报', () => {
  // 热重载会重新 import 本模块（模块级变量清零），但页面不会重新加载、
  // CLIENT-BOOT 也不会再来一次 → 若只用模块级变量，每次热重载都会误报。
  assert.match(INDEX, /__dshNotifySayClientBootSeen/,
    '必须用 globalThis 上的进程级标记，热重载前后共享');
  assert.match(INDEX, /globalThis\[BOOT_SEEN_KEY\]\s*=\s*true/,
    '收到 CLIENT-BOOT 时必须写进程级标记');
  assert.match(INDEX, /globalThis\[BOOT_SEEN_KEY\]\s*===\s*true/,
    'apply 时必须读进程级标记，已启动过就不再起窗');
});

test('B3: 收到 CLIENT-BOOT 时置位并清掉定时器；dispose 也要清', () => {
  assert.match(INDEX, /msg\.indexOf\('CLIENT-BOOT'\)\s*>=\s*0/,
    '必须按日志内容识别前端启动');
  assert.match(INDEX, /if \(bootCheckTimer\) \{ clearTimeout\(bootCheckTimer\); bootCheckTimer = null; \}/,
    '置位后要立刻清定时器，别让 45s 到点再打一遍日志');
  assert.match(INDEX, /clearTimeout\(bootCheckTimer\)/, 'dispose 必须清定时器');
});
