/**
 * 发通知用的 AUMID 必须是「本机真的注册过的那一个」（v0.5.4 提议）。
 *
 * ## 为什么这个文件必须存在
 *
 * 2026-10-25 用户实测截图：Toast 标题行印的是 **`com.deepseek.dsh`** 这串原始
 * AUMID，名字旁边没有小图标。而 `Show()` **不抛异常** —— 旧实现的 try/catch
 * 完全兜不住这类"静默降级"，界面难看但日志全绿。
 *
 * 根因：官方壳的 AUMID 并非处处一致。官方安装包注册 `com.deepseek.dsh`，
 * 而 Electron 默认身份（开始菜单快捷方式里带的正是它）是
 * `electron.app.<ProductName>`。写死的那个没注册时，Windows 只好把 AUMID
 * 原文当应用名，并从快捷方式拿不到图标。
 *
 * ## 关键契约
 *
 * | 项 | 要求 |
 * |---|---|
 * | 探测来源 | `Get-StartApps` 里名字/AppID 命中 DeepSeek Harness 的项 |
 * | 缓存 | 落盘到 `%LOCALAPPDATA%\dsh-notify-say\toast-aumid.txt`，避免每条通知都付 ~540ms |
 * | 纯兜底不写缓存 | 探测失败时不能把兜底值固化，否则一次网络/时序抖动永久生效 |
 * | 兜底 | 仍是 `com.deepseek.dsh` → `Microsoft.Windows.Shell.RunDialog`，行为可回退 |
 * | `$shown` | 只在**成功 Show** 之后置 true（旧实现无条件置 true，兜底链形同虚设） |
 * | BOM | 文件必须以 UTF-8 BOM 开头，否则 PowerShell 5.1 按 ANSI 解析中文注释 → 语法错 |
 *
 * 只读源码文本，不启动 PowerShell：CI 上没有 DSH 安装，Get-StartApps 探测必然为空，
 * 跑真进程只会得到"环境缺失"的假失败。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PS1 = readFileSync(join(ROOT, 'dsh-notify.ps1'), 'utf8');

test('A1 定义了 Get-ToastAppId，并且用 Get-StartApps 探测', () => {
  assert.match(PS1, /function\s+Get-ToastAppId/, '必须存在 Get-ToastAppId');
  assert.match(PS1, /Get-StartApps/, '必须用 Get-StartApps 找"真的注册过"的 AUMID');
  assert.ok(PS1.includes('DeepSeek\\s*Harness'), '要按显示名匹配 DeepSeek Harness');
});

test('A2 探测结果落盘缓存，且路径在 LOCALAPPDATA 下', () => {
  assert.match(PS1, /toast-aumid\.txt/, '缓存文件名应为 toast-aumid.txt');
  assert.match(PS1, /LOCALAPPDATA/, '缓存必须放在用户可写目录，不能放安装目录');
});

test('A3 纯兜底不写缓存（一次失败不能被永久固化）', () => {
  // 形如：if ($list.Count -gt 2) { ... Set-Content ... }
  assert.match(
    PS1,
    /if\s*\(\s*\$list\.Count\s*-gt\s*2\s*\)/,
    '只有探测成功（列表里有第 3 个候选）才写缓存',
  );
});

test('A4 兜底链保持不变：com.deepseek.dsh → RunDialog', () => {
  const a = PS1.indexOf("'com.deepseek.dsh'");
  const b = PS1.indexOf("'Microsoft.Windows.Shell.RunDialog'");
  assert.ok(a > 0, '兜底里必须保留 com.deepseek.dsh');
  assert.ok(b > a, 'RunDialog 应排在 com.deepseek.dsh 之后（更晚兜底）');
});

test('A5 Show 走候选循环，而不是写死一个 AUMID', () => {
  assert.match(PS1, /foreach\s*\(\s*\$toastAumid\s+in\s+\$toastAumids\s*\)/, '按候选逐个 Show');
  assert.match(
    PS1,
    /CreateToastNotifier\(\$toastAumid\)/,
    'Show 的入参必须是循环变量，不能是字面量',
  );
  assert.ok(
    !/CreateToastNotifier\('com\.deepseek\.dsh'\)\s*\.Show/.test(PS1),
    '不允许再出现写死 com.deepseek.dsh 的直接 Show（那正是回归点）',
  );
});

test('A6 $shown 只在成功 Show 之后置 true', () => {
  // 旧实现：try/catch 之后无条件 $shown = $true，兜底链等于没生效
  const loop = PS1.slice(PS1.indexOf('foreach ($toastAumid in $toastAumids)'));
  const shownIdx = loop.indexOf('$shown = $true');
  const breakIdx = loop.indexOf('break');
  assert.ok(shownIdx > 0, '循环里必须设置 $shown');
  assert.ok(shownIdx < breakIdx, '$shown 必须在 break 之前（即 Show 成功之后）');
  assert.ok(
    !/\}\s*\r?\n\s*\$shown = \$true\s*\r?\n/.test(PS1),
    '不允许在 try/catch 之外无条件置 $shown = $true',
  );
});

test('A7 文件以 UTF-8 BOM 开头（PowerShell 5.1 解析中文注释的前提）', () => {
  const head = readFileSync(join(ROOT, 'dsh-notify.ps1')).subarray(0, 3);
  assert.deepEqual(
    [...head],
    [0xef, 0xbb, 0xbf],
    'BOM 被编辑器吃掉后，PS 5.1 会按 ANSI 读中文注释，直接语法错（实测过一次）',
  );
});
