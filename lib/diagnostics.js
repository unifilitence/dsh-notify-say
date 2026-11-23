/**
 * 诊断导出（v0.4.35）。
 *
 * ## 为什么要单独一个出口
 *
 * `log-privacy.js` 里的 `sanitizeDiagnostics()` 早就写好了，但**没有调用方** ——
 * 等于脱敏能力存在却用不上。用户提 Issue 时还是得自己去 `%TEMP%` 找日志、
 * 手动删用户名，多数人不会做。
 *
 * 所以这里把它接成一个真正的功能：读日志 → 脱敏 → 写一份可直接上传的文件。
 *
 * ## 为什么写到同一目录而不是让浏览器下载
 *
 * 渲染进程（设置卡片）跑在沙箱里，没有 `fs`，也没有可用的保存对话框 API。
 * 宿主侧写文件 + 返回路径让用户自己去打开，是唯一可靠的做法。
 *
 * ## 输出位置
 *
 * ```
 * %TEMP%\dsh-notify-say\diagnostics-<时间戳>.txt
 * ```
 *
 * 与日志同目录 —— 用户已经知道去哪儿找日志，就一定能找到它。
 *
 * ## ⚠️ 脱敏不是万能的
 *
 * 只处理：用户名、绝对路径、长 token。
 * **不处理**：用户自己写在台词里的项目名、人名（那些看起来就是普通文本）。
 *
 * 所以导出文件的头部明确写「仍请自行检查一遍」。
 * 默认档日志本来就不含台词，这条主要是给开了 debug 的用户兜底。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { sanitizeDiagnostics, diagnosticsHeader, normalizeLevel } from './log-privacy.js';
import { notifyLogDir } from './log-path.js';

/** 导出的诊断文件保留几份（太多了目录会乱）。 */
const KEEP_MAX = 5;

/**
 * 日志目录。
 *
 * 与 `lib/index.js`（宿主侧 `[skip]`）和两个 ps1（`[toast]` / `[preview]`）
 * 共用 `log-path.js` 的同一份口径 —— 否则导出诊断时会漏掉 ps1 写的行，
 * 或者把 `DSH_NOTIFY_SAY_LOG_DIR` 覆盖忽略掉（测试会写进用户真实日志）。
 *
 * @returns {string}
 */
export function logDirPath() {
  return notifyLogDir();
}

/**
 * 读日志正文（含轮转出来的 .1）。
 *
 * 为什么要带 .1：用户遇到问题时日志可能刚轮转过，
 * 上一份里才有事发时的记录。
 *
 * @returns {{ ok: boolean, text?: string, error?: string }}
 */
export function readLogText() {
  const dir = logDirPath();
  if (!dir) return { ok: false, error: 'no-temp-dir' };

  const main = join(dir, 'notify.log');
  const rotated = join(dir, 'notify.log.1');

  const parts = [];
  try {
    // 轮转的先读（它更旧）
    if (existsSync(rotated)) {
      parts.push('--- notify.log.1（较早，已轮转）---');
      parts.push(readFileSync(rotated, 'utf8'));
    }
    if (existsSync(main)) {
      parts.push('--- notify.log（当前）---');
      parts.push(readFileSync(main, 'utf8'));
    }
  } catch (e) {
    return { ok: false, error: `read: ${(e && e.message) || e}` };
  }

  if (parts.length === 0) return { ok: false, error: 'no-log-file' };
  return { ok: true, text: parts.join('\n') };
}

/** 清理旧的诊断文件，只留最近 KEEP_MAX 份。 */
function pruneOldDiagnostics(dir) {
  try {
    const files = readdirSync(dir)
      .filter((f) => /^diagnostics-.*\.txt$/.test(f))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(KEEP_MAX)) {
      try { unlinkSync(join(dir, f)); } catch { /* ignore */ }
    }
  } catch { /* 清理失败不影响导出 */ }
}

/** 时间戳里去掉 Windows 文件名不允许的字符。 */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/**
 * 导出一份可直接上传的诊断文件。
 *
 * @param {object} info 环境信息（version / nodeVersion / platform / logLevel / home）
 * @returns {{ ok: boolean, path?: string, bytes?: number, lines?: number, error?: string }}
 */
export function exportDiagnostics(info) {
  const dir = logDirPath();
  if (!dir) return { ok: false, error: 'no-temp-dir' };

  const read = readLogText();
  if (!read.ok) return { ok: false, error: read.error };

  const header = diagnosticsHeader({
    version: info && info.version,
    nodeVersion: process.version,
    platform: process.platform,
    logLevel: normalizeLevel(info && info.logLevel),
    now: new Date().toISOString(),
    // v0.4.89：home 的来历（哪条分支 + 实际路径 + 配置是否已存在）。
    // 不传时头部写 (not collected)，不会静默省略成"看起来正常"。
    home: info && info.home,
  });

  // ⚠️ v0.4.89：**头部也要脱敏**了。
  // 此前注释写的是"头部本身不含用户内容"，但 home 段引入绝对路径后
  // 这个前提不再成立 —— 漏掉这一步就会把用户名原样带出去。
  const body = sanitizeDiagnostics(read.text);
  const head = sanitizeDiagnostics(header);
  const content = head + body;

  try {
    mkdirSync(dir, { recursive: true });
    pruneOldDiagnostics(dir);
    const out = join(dir, `diagnostics-${stamp()}.txt`);
    writeFileSync(out, content, 'utf8');
    return {
      ok: true,
      path: out,
      bytes: Buffer.byteLength(content, 'utf8'),
      lines: content.split('\n').length,
    };
  } catch (e) {
    return { ok: false, error: `write: ${(e && e.message) || e}` };
  }
}
