/**
 * 测试环境隔离（`--import` 预加载，在**任何**测试文件之前执行）。
 *
 * ## 为什么必须有这个文件（v0.5.4，2026-11-09 真机踩到）
 *
 * `lib/log-path.js` 决定 `notify.log` 写哪里。测试原本只隔离了 `DSH_HOME`
 * （`test/wiring.test.mjs` / `test/real-cordis.test.mjs` 用 `mkdtempSync`），
 * **没有隔离日志目录** —— 而 `wiring.test.mjs` 会把 `SystemRoot` 换成
 * `Z:\__no_such_root__` 并调用 `apply()`，那些失败的 spawn 会被
 * `appendNotifyLog` 原样写进用户 `%TEMP%\dsh-notify-say\notify.log`。
 *
 * 实测后果：真机日志里出现 12 条
 * `[play-fail] ... spawn Z:\__no_such_root__\...\powershell.exe ENOENT`，
 * 全部集中在跑 `npm test` 的那一秒。后来排查 DSH 0.2.2-rc.1 兼容性时，
 * 这几行足以让人误判「插件在真机上起不来 PowerShell」。
 *
 * ## 用法
 *
 * 只能走 `--import`（不是 `--loader`，后者在新版 Node 已废弃）：
 * `node --import ./test/test-env-setup.mjs --test`
 * `package.json` 里所有 `node --test` 脚本都已带上；`test/log-path.test.mjs`
 * 的 L7 会断言这件事，防止有人以后新加脚本时又漏。
 *
 * ⚠️ 本文件**不是**测试文件（不以 `.test.` 命名），默认 `node --test` 不会执行它。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const LOG_DIR = mkdtempSync(join(tmpdir(), 'notify-test-logs-'));

// 宿主 spawn ps1 时会继承 process.env，所以 ps1 侧的 [toast]/[preview]/[tts]
// 也会落到这个临时目录 —— 正是我们要的：Node 侧与 ps1 侧仍然同口径。
process.env.DSH_NOTIFY_SAY_LOG_DIR = LOG_DIR;

// 进程退出时清掉；测试进程被强杀时残留一个几十字节的目录，无害。
process.on('exit', () => {
  try { rmSync(LOG_DIR, { recursive: true, force: true }); } catch { /* best effort */ }
});
