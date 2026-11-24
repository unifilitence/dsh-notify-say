/**
 * PowerShell 解释器选择器（测试专用）
 *
 * ## 为什么需要这个文件（2026-11-24，踩坑 #494）
 *
 * 本项目里有**两类** PowerShell 脚本，它们必须用**不同的解释器**跑：
 *
 * 1. **运行时脚本**（`dsh-notify.ps1` / `tts-speak.ps1` / `jump-handler.ps1` / `lib/wav-gain.ps1`）
 *    —— 这些由宿主 `lib/index.js` 的 `POWERSHELL_EXE` 常量以**绝对路径的 Windows PowerShell 5.1**
 *    启动（`WindowsPowerShell\v1.0\powershell.exe`）。原因见 lib/index.js 的注释：Toast 走的
 *    WinRT 投影只在 5.1 可用。**测试必须复刻这个解释器**，用 pwsh 7 跑等于测了另一条代码路径。
 *    这几个脚本**不允许**带 `#Requires -Version 7.0`（带了就在 5.1 下 exit 1，且失败是静默的）。
 *
 * 2. **维护者工具**（`tools/release-build.ps1` / `tools/release.ps1` / …）
 *    —— 这些带 `#Requires -Version 7.0`（ADR-0015 L3：5.1 会误读无 BOM 的 UTF-8 中文源码）。
 *    **测试必须用 pwsh 7 调用它们**，用 5.1 会撞 `ScriptRequiresUnmatchedPSVersion`。
 *
 * ADR-0015 阶段 4 的批量插 `#Requires` 把第 1 类也扫进去了，而当时所有测试都用
 * `'powershell.exe'` 硬编码 → TTS 与增益静默失效 + 13 条测试红，直到下一次发版才暴露。
 * 这个文件把「哪类脚本配哪个解释器」变成**一处显式声明**，避免再次各写各的。
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 运行时脚本用的解释器：Windows PowerShell 5.1，与宿主 `POWERSHELL_EXE` 同一条路径。
 *
 * 刻意**不**做成"哪个好用用哪个"——宿主是写死 5.1 的，测试必须复刻真实路径，
 * 否则"在 pwsh 7 下能跑"会伪装成"插件能跑"。
 */
export const RUNTIME_PS
  = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

/**
 * 维护者工具用的解释器：PowerShell 7（`#Requires -Version 7.0` 要求 ≥7.0）。
 *
 * 本机没装 pwsh 7 时返回 `null`，调用方应 `skip` 而不是用 5.1 硬跑
 * —— 用 5.1 跑只会得到 `ScriptRequiresUnmatchedPSVersion`，那是**环境缺失**，
 * 不是被测代码的缺陷，不该记成失败。
 */
export const TOOLING_PS = (() => {
  const candidates = [
    join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'PowerShell', '7', 'pwsh.exe'),
    join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'pwsh.exe'),
  ];
  for (const p of candidates) {
    if (p && existsSync(p)) return p;
  }
  return null;
})();

/** pwsh 7 是否可用（决定工具类测试是跑还是 skip）。 */
export const HAS_TOOLING_PS = TOOLING_PS !== null;
