/**
 * 日志路径隔离测试（v0.5.4）。
 *
 * ## 为什么要有这个文件
 *
 * 2026-11-09 在真机排查 DSH 0.2.2-rc.1 兼容性时，`notify.log` 里出现 12 条
 * `[play-fail] ... spawn Z:\__no_such_root__\...\powershell.exe ENOENT`，
 * 全部集中在跑 `npm test` 的那一秒 —— **是测试写进来的，不是真机故障**。
 *
 * 根因：测试隔离了 `DSH_HOME`，却没隔离日志目录；`wiring.test.mjs` 会把
 * `SystemRoot` 换成 `Z:\__no_such_root__` 再调 `apply()`，失败的 spawn
 * 被 `appendNotifyLog` 原样写进用户真实日志。任何看到那几行的人都会
 * 误判「插件在真机上起不来 PowerShell」—— 这比日志变脏严重得多。
 *
 * ## 检查什么
 *
 * 1. `DSH_NOTIFY_SAY_LOG_DIR` 覆盖生效，且空白视为未设置（与 `safeHome` 同口径）
 * 2. 没有 TEMP/TMP 时返回空串，**不能**拼出相对路径写进 cwd
 * 3. `diagnostics.js` 的 `logDirPath()` 与宿主侧走同一份实现（否则导出会漏行）
 * 4. 两个 ps1 读同一个环境变量（Node 侧与 PowerShell 侧必须落在同一文件）
 * 5. `package.json` 里所有 `node --test` 脚本都预加载 `test-env-setup.mjs`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { notifyLogDir, notifyLogPath, LOG_DIR_ENV } from '../lib/log-path.js';
import { logDirPath } from '../lib/diagnostics.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// ── L1: 覆盖变量生效（这是修复的核心）──────────────────────────────────
test('L1: DSH_NOTIFY_SAY_LOG_DIR 覆盖 TEMP', () => {
  const dir = notifyLogDir({ env: { DSH_NOTIFY_SAY_LOG_DIR: 'E:\\tmp\\logs', TEMP: 'E:\\real\\temp' } });
  assert.equal(dir, 'E:\\tmp\\logs', '显式覆盖必须优先于 TEMP');
});

// ── L2: 空白覆盖视为未设置 ──────────────────────────────────────────────
//
// 判据必须与 `config-store.js` 的 `safeHome` 一致：**空白不算设置**。
// 否则 `DSH_NOTIFY_SAY_LOG_DIR=""` 会解析出 cwd 相对路径。
test('L2: 空白 / 全空格的覆盖值视为未设置', () => {
  for (const blank of ['', '   ', '\t']) {
    const dir = notifyLogDir({ env: { DSH_NOTIFY_SAY_LOG_DIR: blank, TEMP: 'E:\\real\\temp' } });
    assert.equal(dir, join('E:\\real\\temp', 'dsh-notify-say'),
      `覆盖值为 ${JSON.stringify(blank)} 时应回落到 TEMP`);
  }
});

// ── L3: 没有 TEMP/TMP 时给空串（绝不写相对路径）────────────────────────
test('L3: 无 TEMP/TMP 且无覆盖时返回空串', () => {
  assert.equal(notifyLogDir({ env: {} }), '', '不能拼出相对路径 —— 那会把日志写进宿主 cwd');
  assert.equal(notifyLogPath({ env: {} }), '', '同理');
});

// ── L4: 文件名与 TEMP 回落 ──────────────────────────────────────────────
test('L4: 默认落到 TEMP\\dsh-notify-say\\notify.log', () => {
  const env = { TEMP: 'E:\\real\\temp' };
  assert.equal(notifyLogDir({ env }), join('E:\\real\\temp', 'dsh-notify-say'));
  assert.equal(notifyLogPath({ env }), join('E:\\real\\temp', 'dsh-notify-say', 'notify.log'));
});

// ── L5: TMP 作为 TEMP 的备选 ────────────────────────────────────────────
test('L5: TEMP 缺失时用 TMP', () => {
  assert.equal(notifyLogDir({ env: { TMP: 'E:\\only\\tmp' } }), join('E:\\only\\tmp', 'dsh-notify-say'));
});

// ── L6: diagnostics 必须同源（否则导出会漏掉 ps1 写的行）────────────────
test('L6: diagnostics.logDirPath 与宿主侧同源', () => {
  const old = process.env[LOG_DIR_ENV];
  const probe = join(tmpdir(), 'logpath-same-source-probe');
  try {
    process.env[LOG_DIR_ENV] = probe;
    assert.equal(logDirPath(), probe,
      'diagnostics 必须认同一份覆盖变量 —— 否则测试/便携模式下导出会读错目录');
    assert.equal(logDirPath(), notifyLogDir(), '两处必须返回完全相同的目录');
  } finally {
    if (old === undefined) delete process.env[LOG_DIR_ENV];
    else process.env[LOG_DIR_ENV] = old;
  }
});

// ── L7: 两个 ps1 必须读同一个环境变量 ──────────────────────────────────
//
// `[plan]`/`[skip]` 是 Node 写的，`[toast]`/`[preview]`/`[tts]` 是 ps1 写的。
// 一边认覆盖、一边不认，排查时就会看到"半个故事"。
test('L7: dsh-notify.ps1 与 tts-speak.ps1 都认 DSH_NOTIFY_SAY_LOG_DIR', () => {
  for (const rel of ['dsh-notify.ps1', 'tts-speak.ps1']) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    assert.match(src, /DSH_NOTIFY_SAY_LOG_DIR/,
      `${rel} 必须读 ${LOG_DIR_ENV}（与 lib/log-path.js 同口径）`);
    assert.match(src, /IsNullOrWhiteSpace/,
      `${rel} 必须用 IsNullOrWhiteSpace 判空 —— 空白不能当成有效目录`);
  }
});

// ── L8: 所有 node --test 脚本都必须预加载隔离 ──────────────────────────
//
// 这条是防"以后新加一个脚本又漏了"。实测代价见文件头。
test('L8: package.json 里每个 node --test 脚本都预加载 test-env-setup.mjs', () => {
  const offenders = [];
  for (const [name, cmd] of Object.entries(PKG.scripts || {})) {
    if (!String(cmd).includes('node ') || !String(cmd).includes('--test')) continue;
    if (!String(cmd).includes('--import ./test/test-env-setup.mjs')) offenders.push(`${name}: ${cmd}`);
  }
  assert.deepEqual(offenders, [],
    '这些脚本会在跑测试时写用户真实 notify.log —— 必须加 --import ./test/test-env-setup.mjs');
});

// ── L9: 隔离真的生效了（当前进程确实被重定向）──────────────────────────
//
// 直接 `node --test test/log-path.test.mjs` 时不会预加载，这里 skip；
// L8 保证正式入口一定预加载，所以不存在"两边都松"的空档。
test('L9: 跑测试时日志目录已被重定向到临时目录',
  { skip: !process.env[LOG_DIR_ENV] && '未预加载 test-env-setup.mjs（L8 保证正式入口会预加载）' },
  () => {
    const dir = notifyLogDir();
    assert.ok(dir, '预加载后必须能解析出目录');
    assert.ok(dir.startsWith(tmpdir()),
      `测试日志目录必须在系统临时区，实际是 ${dir}`);
    assert.notEqual(dir, join(process.env.TEMP || '', 'dsh-notify-say'),
      '绝不能落回用户真实的 %TEMP%\\dsh-notify-say');
  });
