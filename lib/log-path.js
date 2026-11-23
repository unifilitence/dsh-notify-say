/**
 * 通知日志目录/文件的**唯一**事实源（Node 侧）。
 *
 * ## 为什么单独抽一个模块（v0.5.4）
 *
 * 2026-11-09 在真机上排查 DSH 0.2.2-rc.1 兼容性时踩到：
 * 用户 `%TEMP%\dsh-notify-say\notify.log` 里出现了 12 条
 * `spawn Z:\__no_such_root__\...\powershell.exe ENOENT` 的 play-fail 记录，
 * 全部集中在同一秒 —— **那是 `npm test` 灌进去的，不是用户机器的故障**。
 *
 * 根因：测试只隔离了 `DSH_HOME`（`mkdtempSync` 建临时 home），
 * 而日志路径只认 `process.env.TEMP`，于是测试进程直接写进用户真实日志。
 * 后果不是"脏"，而是**误导排查**：任何人看到那几行都会以为插件在真机上起不来。
 *
 * 修法同 `voice-pack-store.js` 的 `DSH_NOTIFY_SAY_DATA_DIR`：
 * 给一个显式覆盖变量 `DSH_NOTIFY_SAY_LOG_DIR`，测试与便携模式都指向临时目录。
 *
 * ## 为什么 ps1 也要认同一个变量
 *
 * `[toast]` / `[preview]` 是 PowerShell 侧写的，`[plan]` / `[skip]` 是 Node 侧写的，
 * 两者必须落在**同一个文件**里 —— 否则"这一刻到底播了还是没播"就没法按时间顺序对照。
 * 所以 `dsh-notify.ps1` 与 `tts-speak.ps1` 读同一个环境变量（宿主 spawn 时继承）。
 */

import { join } from 'node:path';

/** 覆盖日志目录的环境变量名（测试 / 便携模式用）。 */
export const LOG_DIR_ENV = 'DSH_NOTIFY_SAY_LOG_DIR';

/**
 * 解析日志目录。
 *
 * 优先级：
 *   ① `DSH_NOTIFY_SAY_LOG_DIR`（非空白才算数，与 `safeHome` 同口径）
 *   ② `%TEMP%` → `%TMP%`（Windows 常规；跨平台回落）
 *   ③ 都没有 → 空串（调用方必须自己判空，不能拼出相对路径乱写 cwd）
 *
 * @param {{ env?: Record<string, string | undefined> }} [opts] 便于测试注入
 * @returns {string} 绝对目录路径；无法确定时返回空串
 */
export function notifyLogDir(opts) {
  const env = (opts && opts.env) || process.env;

  const override = env[LOG_DIR_ENV];
  if (override && String(override).trim()) return String(override).trim();

  const tmp = env.TEMP || env.TMP || '';
  return tmp ? join(tmp, 'dsh-notify-say') : '';
}

/**
 * 解析日志文件路径。
 *
 * @param {{ env?: Record<string, string | undefined> }} [opts]
 * @returns {string} 绝对路径；无法确定时返回空串
 */
export function notifyLogPath(opts) {
  const dir = notifyLogDir(opts);
  return dir ? join(dir, 'notify.log') : '';
}
