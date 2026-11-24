/**
 * R 系列：运行时 PowerShell 脚本的解释器契约（fitness function）
 *
 * ## 为什么需要这个文件（2026-11-24，踩坑 #494）
 *
 * ADR-0015 把全仓 .ps1 统一到 PowerShell 7，用 `tools/ps7-add-requires.ps1`
 * 批量给 137 个脚本顶部插 `#Requires -Version 7.0`。但**这个插件有一类脚本不能插**：
 *
 *   宿主 `lib/index.js` 的 `POWERSHELL_EXE` 是**写死绝对路径**的 Windows PowerShell 5.1：
 *
 *     const POWERSHELL_EXE =
 *       `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
 *
 *   它是**故意**写死的（Toast 走 WinRT 投影，只有 5.1 可用），不会因为装了 pwsh 7 就换。
 *   所以被它启动的那几个脚本一旦带上 `#Requires -Version 7.0`，在 5.1 下直接
 *   `exit 1`（ScriptRequiresUnmatchedPSVersion），表现是：
 *
 *     - `tts-speak.ps1`   → TTS 静默失效，退化成蜂鸣（audioSource 默认就是 'tts'）
 *     - `lib/wav-gain.ps1` → 增益被 try/catch 吞掉，音量设置静默失效
 *     - `jump-handler.ps1` → 有 .vbs 兜底，暂不炸但埋雷
 *
 *   这三处失败**都不报错给用户**，只能靠日志里的半行提示发现。
 *
 * ## 这条测试守什么
 *
 * 它断言的是**分类**而不是单点：`RUNTIME_SCRIPTS` 里的文件不得带 `#Requires`，
 * `TOOLING_SCRIPTS` 里必须带。这样将来再加脚本时，作者必须显式想清楚它属于哪类
 * —— 而不是"批量插一遍，跑挂了再说"。
 *
 * 为什么不能只靠 `ps7-add-requires.ps1` 的 `$SkipNames`：那是个**可选**清单，
 * 忘了加与"当时没想到这类脚本存在"是同一种失败。这里用正向断言把契约钉在插件自己身上，
 * 不依赖外部工具的配置是否记得更新。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_PS } from './ps-interp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 宿主用 5.1 启动的运行时脚本（相对插件根）。
 * 新增条目时必须同时确认：调用它的地方走的是 `POWERSHELL_EXE`，而不是 `pwsh`。
 */
const RUNTIME_SCRIPTS = [
  'dsh-notify.ps1',
  'tts-speak.ps1',
  'jump-handler.ps1',
  join('lib', 'wav-gain.ps1'),
];

/**
 * **用户手动运行**、且随 npm 包发出去的脚本（相对插件根）。
 *
 * 与 RUNTIME_SCRIPTS 的区别：它们不是宿主 spawn 的，而是 README 教用户
 * `cd <插件>\tools` 后直接敲的。用户机器上只有 Windows 出厂自带的 5.1 是
 * 常态，所以它们同样**不得**要求 PowerShell 7。
 *
 * 2026-11-24（踩坑 #495）：`tools/notify-config.ps1` 被 `ps7-add-requires.ps1`
 * 批量插了 `#Requires -Version 7.0`，0.5.8 若照此发出，README 里那 8 条命令
 * 在 5.1 上会全部 `exit 1`。R1 当时只覆盖「宿主 spawn 的脚本」，没覆盖这一类，
 * 所以没拦住 —— 这个数组就是补上的那道闸。
 */
const USER_SCRIPTS = [
  join('tools', 'notify-config.ps1'),
];

/** 维护者工具（不会被插件运行时调用），由 ADR-0015 统一要求 PowerShell 7。 */
const TOOLING_SCRIPTS = [
  join('tools', 'release-build.ps1'),
  join('tools', 'release.ps1'),
];

// 注意：JS 正则没有 `(?m)` 内联标志（那是 .NET/Python 语法），
// 多行匹配要用 `/m` 修饰符。写错会在**模块链接阶段**直接抛 SyntaxError，
// 整个文件一行都跑不了 —— 表现是"只有 1 个失败：文件本身"。
const REQUIRE_7 = /^\s*#Requires\s+-Version\s+7\.0\s*$/m;
const REQUIRE_ANY = /^\s*#Requires\s+-Version\s+(\d+)\.(\d+)/gm;

/**
 * 「必须在 5.1 上跑得起来」的全部脚本 —— 运行时 spawn 的 + 用户手敲的。
 * R1/R2 都遍历这个合集：两类脚本对解释器的约束**完全相同**（都只能 ≤5.1），
 * 区别只在"谁启动它"，而"谁启动它"在版本判定上不重要。
 */
const MUST_RUN_ON_51 = [...RUNTIME_SCRIPTS, ...USER_SCRIPTS];

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

// ── R1: 必须在 5.1 上跑的脚本一律不得带 #Requires 7.0 ────────────────────
test('R1: 宿主用 5.1 启动的运行时脚本，一律不得带 #Requires -Version 7.0', () => {
  const offenders = [];
  for (const rel of MUST_RUN_ON_51) {
    if (!existsSync(join(ROOT, rel))) continue;
    if (REQUIRE_7.test(read(rel))) offenders.push(rel);
  }
  assert.deepEqual(offenders, [],
    '这些脚本由 lib/index.js 的 POWERSHELL_EXE（写死的 5.1）启动，\n'
    + '带 #Requires -Version 7.0 会让它们在 5.1 下 exit 1，而且失败是静默的：\n  '
    + offenders.join('\n  '));
});

// ── R2: 必须在 5.1 上跑的脚本里任意 #Requires 都必须 ≤5.1 ───────────────
test('R2: 运行时脚本若声明 #Requires，版本必须 ≤5.1', () => {
  const bad = [];
  for (const rel of MUST_RUN_ON_51) {
    if (!existsSync(join(ROOT, rel))) continue;
    for (const m of read(rel).matchAll(REQUIRE_ANY)) {
      if (Number(m[1]) > 5) bad.push(`${rel}: #Requires -Version ${m[1]}.${m[2]}`);
    }
  }
  assert.deepEqual(bad, [],
    '运行时脚本的解释器由宿主写死为 5.1，任何 >5 的版本要求都会让它在真机上跑不起来：\n  '
    + bad.join('\n  '));
});

// ── R3: 维护者工具必须带 #Requires 7.0（ADR-0015 的正向面）──────────────
test('R3: 维护者工具脚本必须带 #Requires -Version 7.0', () => {
  const missing = [];
  for (const rel of TOOLING_SCRIPTS) {
    if (!existsSync(join(ROOT, rel))) continue;
    if (!REQUIRE_7.test(read(rel))) missing.push(rel);
  }
  assert.deepEqual(missing, [],
    'ADR-0015 要求维护者工具跑在 PowerShell 7（5.1 会误读无 BOM 的 UTF-8 中文源码）：\n  '
    + missing.join('\n  '));
});

// ── R4: 宿主确实在用 5.1（契约的另一半，防"改了宿主却没人知道"）─────────
test('R4: lib/index.js 的 POWERSHELL_EXE 仍指向 Windows PowerShell 5.1', () => {
  // ⚠️ 用 `includes` 而不是正则：源码里写的是**转义后的**双反斜杠
  //    （模板字符串拼路径），正则要匹配它们得写四层 `\\\\`，极易数错一层。
  //    这里直接比字面量，`'...\\\\v1.0...'` 在 JS 里就等于源码中的 `\\v1.0`。
  const src = read(join('lib', 'index.js'));
  assert.ok(src.includes('WindowsPowerShell\\\\v1.0\\\\powershell.exe'),
    'POWERSHELL_EXE 若改成 pwsh 7，R1 的前提就不成立了 —— '
    + '那时应同步给 RUNTIME_SCRIPTS 加 #Requires 7.0，并重跑真机验证');
});

// ── R5: 测试辅助器必须把两类脚本分开 ────────────────────────────────────
test('R5: test/ps-interp.mjs 导出了 RUNTIME_PS 与 TOOLING_PS 两个解释器', () => {
  const src = read(join('test', 'ps-interp.mjs'));
  assert.match(src, /export const RUNTIME_PS/, '必须有运行时解释器常量');
  assert.match(src, /export const TOOLING_PS/, '必须有工具解释器常量');
  assert.ok(src.includes('WindowsPowerShell\\\\v1.0\\\\powershell.exe'),
    'RUNTIME_PS 必须复刻宿主的 5.1 路径，不能"哪个好用用哪个"');
});

// ── R6: 用户 CLI 必须在 5.1 下**真的跑起来**（静态断言之外的真跑）───────
/**
 * R1/R2 只看源码文本。但 `#Requires` 的失败模式是**运行时**才发生的
 * （5.1 读到 `#Requires -Version 7.0` 直接 exit 1，脚本一行都不执行），
 * 所以这里用宿主同款解释器真跑一遍 `-Show`（只读，不写 config）。
 *
 * 这条测试的价值：`-Show` 能读出配置就证明「用户敲 README 第 170 行那条命令不会报错」。
 * 当初 0.5.8 差点把带 `#Requires 7.0` 的 CLI 发出去，静态检查漏了，只有真跑才发现。
 */
test('R6: tools/notify-config.ps1 在 5.1 下真跑 -Show 必须成功', () => {
  const rel = join('tools', 'notify-config.ps1');
  if (!existsSync(join(ROOT, rel))) return;
  const r = spawnSync(RUNTIME_PS,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(ROOT, rel), '-Show'],
    { encoding: 'utf8', timeout: 60_000 });
  const out = String(r.stdout || '') + String(r.stderr || '');
  assert.equal(r.status, 0,
    '用户 CLI 在 Windows 自带的 5.1 下必须能跑（README:170-181 教用户直接运行它）。\n'
    + '若报 ScriptRequiresUnmatchedPSVersion，说明有人又给它加了 #Requires 7.0。\n'
    + `实际输出：\n${out.slice(0, 800)}`);
  assert.match(out, /dsh-notify-say 配置/,
    `-Show 应当打印配置标题，实际输出：\n${out.slice(0, 800)}`);
});

// ── R7: 维护者工具自己 spawn 的解释器必须也是 pwsh ──────────────────────
/**
 * R3 只保证 `TOOLING_SCRIPTS`（release.ps1 / release-build.ps1）**自己**带
 * `#Requires 7.0`。但"父进程在 7 下跑"不等于"它 spawn 出去的子进程也在 7 下"：
 *
 *   · `'powershell'` / `'powershell.exe'` 在任何 PowerShell 里都解析到
 *     `System32\WindowsPowerShell\v1.0\powershell.exe`（= 5.1），与 PATH 顺序无关；
 *   · 于是 release.ps1（带 Requires 7.0）用裸 `'powershell'` 去启动
 *     release-build.ps1（也带 Requires 7.0）时，子进程是 5.1，读到 Requires 直接 exit 1。
 *
 * 2026-11-24 真实代价：0.5.8 发版第 3 步「重建发布包」必挂，报
 * `ScriptRequiresUnmatchedPSVersion`。C7 静态闸拦不住 —— 它只匹配 AST 里的裸命令
 * `& powershell`，不匹配"作为字符串传给 Invoke-Checked 的 `'powershell'`"。
 *
 * 这里用**字符串字面量**判定（不依赖 AST），因此那类间接调用也能抓到。
 */
test('R7: 维护者工具不得以字符串形式 spawn powershell（5.1），必须用 pwsh', () => {
  // 只认「作为独立字符串字面量出现」的 powershell / powershell.exe。
  // 不匹配 System32 绝对路径（那是 ADR-0015 允许的 5.1 例外），也不匹配注释里的普通提及。
  const BARE_PS = /(['"])(?:powershell|powershell\.exe)\1/i;
  const bad = [];
  for (const rel of TOOLING_SCRIPTS) {
    const abs = join(ROOT, rel);
    if (!existsSync(abs)) continue;
    const lines = read(rel).split(/\r?\n/);
    lines.forEach((line, i) => {
      const code = line.replace(/#.*$/, ''); // 去掉行尾注释，避免误报
      if (!BARE_PS.test(code)) return;
      // System32\WindowsPowerShell\v1.0\powershell.exe 这类绝对路径是允许的例外
      if (/System32.*WindowsPowerShell/i.test(code)) return;
      bad.push(`${rel}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(bad, [],
    '维护者工具用裸 powershell 字符串启动子进程时，子进程是 5.1，\n'
    + '而被启动的脚本要求 7.0 → ScriptRequiresUnmatchedPSVersion，发版必挂。\n'
    + '改法：把字符串换成 \'pwsh\'。命中行：\n  ' + bad.join('\n  '));
});
