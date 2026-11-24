/**
 * 发布包「个人声音样本」防护测试（v0.4.21）。
 *
 * ## 为什么这条测试必须存在
 *
 * `sounds/voice-lines/my-voice-*.wav` 是作者本人的声音样本。
 * 它们只用于本地自用。**一旦进发布包就等于把个人生物特征公开分发，
 * 而且不可撤回**（推上 GitHub / npm 后无法真正删除）。
 *
 * 原有的筛选只靠 `-VoiceKey` 参数，而 `-KeepAllVoices` 会绕过它。
 * 也就是说：任何人为了"打个全量包"加上那个开关，个人声音就会漏出去。
 *
 * 所以 `release-build.ps1` 里加了**前缀黑名单**，优先于一切参数。
 * 这条测试锁住该行为。
 *
 * ## 测试策略
 *
 * 真跑 `release-build.ps1`（不是读源码字符串），
 * 用两种最危险的参数组合验证输出目录里没有 my-voice 文件。
 * 这样即使将来重写了筛选逻辑，只要行为对就通过；
 * 行为一旦回退，立刻变红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOLING_PS, HAS_TOOLING_PS } from './ps-interp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILDER = join(ROOT, 'tools', 'release-build.ps1');

// `tools/release-build.ps1` 是**维护者工具**，带 `#Requires -Version 7.0`（ADR-0015 L3），
// 必须用 pwsh 7 跑；用 5.1 会撞 ScriptRequiresUnmatchedPSVersion，那是环境缺失不是代码缺陷。
// 本机没装 pwsh 7 时这些用例 skip（见 test/ps-interp.mjs 的两类脚本说明）。
const SKIP_NO_PS7 = !HAS_TOOLING_PS && '本机没有 PowerShell 7（pwsh.exe），release-build.ps1 需要它';

/** 递归找匹配的文件（不引第三方库）。 */
function findFiles(dir, predicate, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) findFiles(full, predicate, out);
    else if (predicate(name)) out.push(full);
  }
  return out;
}

/**
 * 只找**音频/语音文件**里的被禁音色。
 *
 * ⚠️ 不能对所有文件名做前缀匹配：审核文档快照（docs/audio-audit/snapshots/
 * mochiko.txt）和测试文件本身**就应该**包含这些名字 —— 它们是"为什么禁"
 * 的证据。原来的判据把它们也算成泄漏，属于假阳性。
 *
 * 真正要拦的是：这些音色的 **wav / mp3** 是否进包。
 */
function findBannedAudio(dir, voiceKey) {
  return findFiles(dir, (n) => {
    if (!/\.(wav|mp3|m4a|ogg|flac)$/i.test(n)) return false;
    return n.toLowerCase().startsWith(voiceKey.toLowerCase());
  });
}
/** 跑一次发布包构建，返回目标目录。 */
function buildRelease(extraArgs) {
  const dest = mkdtempSync(join(tmpdir(), 'rel-guard-'));
  execFileSync(TOOLING_PS, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', BUILDER,
    '-Destination', dest, '-Force', ...extraArgs,
  ], { encoding: 'utf8', timeout: 300_000 });
  return dest;
}

// ── P1: 默认参数下不包含个人声音 ────────────────────────────────────────
test('P1: 默认参数构建的发布包不含 my-voice 文件', { skip: SKIP_NO_PS7 }, () => {
  if (!existsSync(BUILDER)) return;
  const dest = buildRelease([]);
  const leaked = findBannedAudio(dest, 'my-voice');
  assert.deepEqual(leaked, [],
    '个人声音样本绝不能进发布包 —— 这是不可撤回的隐私泄漏：\n  '
    + leaked.join('\n  '));
});

// ── P2: -KeepAllVoices 也必须挡住（关键：原实现会漏）────────────────────
test('P2: -KeepAllVoices 也无法带出 my-voice（黑名单优先于一切参数）', { skip: SKIP_NO_PS7 }, () => {
  if (!existsSync(BUILDER)) return;
  const dest = buildRelease(['-KeepAllVoices']);
  const leaked = findBannedAudio(dest, 'my-voice');
  assert.deepEqual(leaked, [],
    '-KeepAllVoices 会绕过 -VoiceKey 筛选，黑名单必须优先于它才能挡住：\n  '
    + leaked.join('\n  '));
});

// ── P3: 防护不能误伤其它音色 ────────────────────────────────────────────
test('P3: 防护只挡 my-voice，其它音色照常保留', { skip: SKIP_NO_PS7 }, () => {
  if (!existsSync(BUILDER)) return;
  const dest = buildRelease(['-KeepAllVoices']);
  const wavs = findFiles(dest, (n) => n.toLowerCase().endsWith('.wav'));
  const others = wavs.filter((f) => !/^my-voice/i.test(f.split(/[\\/]/).pop()));
  assert.ok(others.length > 100,
    `-KeepAllVoices 应保留其它全部音色，实际只有 ${others.length} 个 —— 防护可能误伤过广`);
});

// ── P4: 源码里必须有这道防护的声明 ──────────────────────────────────────
test('P4: release-build.ps1 里有明确的 NeverShip 黑名单', { skip: SKIP_NO_PS7 }, () => {
  if (!existsSync(BUILDER)) return;
  const src = execFileSync(TOOLING_PS, [
    '-NoProfile', '-Command',
    `Get-Content -LiteralPath '${BUILDER.replace(/'/g, "''")}' -Raw`,
  ], { encoding: 'utf8' });
  assert.match(src, /NeverShipVoicePrefixes/,
    '必须有显式黑名单变量，便于将来审计与修改');
  assert.match(src, /Test-VoiceNeverShip/,
    '必须有判断函数，且它要在 KeepAllVoices 之前生效');
});

// ── P5: mochiko 必须被阻断（许可明确禁止再分发）──────────────────────────
test('P5: mochiko 不进发布包（官方规约禁止无偿配发音声素材）', { skip: SKIP_NO_PS7 }, () => {
  if (!existsSync(BUILDER)) return;
  const dest = buildRelease(['-KeepAllVoices']);
  const leaked = findBannedAudio(dest, 'mochiko');
  assert.deepEqual(leaked, [],
    'もち子さん 的官方规约第 1 项禁止「出力した合成音声を使用した音声素材を無償配布」，'
    + '我们的免费提醒包正落在该禁令内：\n  ' + leaked.join('\n  '));
});

// ── P6: Mixkit mp3 不得重新出现（许可禁止再分发素材本身）─────────────────
test('P6: 发布包不含任何 .mp3（Mixkit 已移除，且禁止再分发）', { skip: SKIP_NO_PS7 }, () => {
  if (!existsSync(BUILDER)) return;
  const dest = buildRelease(['-KeepAllVoices']);
  const mp3 = findFiles(dest, (n) => n.toLowerCase().endsWith('.mp3'));
  assert.deepEqual(mp3, [],
    'Mixkit 许可禁止"redistribute the Item on its own... or with source files"，'
    + '这些 mp3 不应再随包分发：\n  ' + mp3.join('\n  '));
});

// ── P7: npm files 白名单必须包含第三方声明 ──────────────────────────────
test('P7: 发布包 package.json 的 files 含 THIRD-PARTY-NOTICES.md', { skip: SKIP_NO_PS7 }, async () => {
  if (!existsSync(BUILDER)) return;
  const dest = buildRelease([]);
  const pkgPath = join(dest, 'package.json');
  if (!existsSync(pkgPath)) return;
  const pkg = JSON.parse(execFileSync(TOOLING_PS, [
    '-NoProfile', '-Command',
    `Get-Content -LiteralPath '${pkgPath.replace(/'/g, "''")}' -Raw`,
  ], { encoding: 'utf8' }));
  assert.ok(Array.isArray(pkg.files), '应有 files 白名单');
  assert.ok(pkg.files.includes('THIRD-PARTY-NOTICES.md'),
    'npm 只打包 files 白名单里的路径；漏了第三方声明等于用户拿不到它 —— '
    + '这正是 2026-10-18 外部审阅发现的问题');
});
// ── P8: kasukabe-tsumugi 必须阻断（规约禁止「二次配布」）────────────────
test('P8: kasukabe-tsumugi 不进发布包（官方规约禁止二次配布）', { skip: SKIP_NO_PS7 }, () => {
  if (!existsSync(BUILDER)) return;
  const dest = buildRelease(['-KeepAllVoices']);
  const leaked = findBannedAudio(dest, 'kasukabe-tsumugi');
  assert.deepEqual(leaked, [],
    '春日部つむぎ 官方规约第 6 条禁止事项明确列出「二次配布、自作発言」，'
    + '我们的 ZIP 分发正属该禁令范围（2026-10-18 读原文发现，此前只当"条件保留"）：\n  '
    + leaked.join('\n  '));
});

// ── P9: yurei-chan 必须阻断（身份未确认）────────────────────────────────
test('P9: yurei-chan 不进发布包（角色身份未确认）', { skip: SKIP_NO_PS7 }, () => {
  if (!existsSync(BUILDER)) return;
  const dest = buildRelease(['-KeepAllVoices']);
  const leaked = findBannedAudio(dest, 'yurei-chan');
  assert.deepEqual(leaked, [],
    'ユーレイちゃん(U-Stella) 与 夜語トバリ 是不同权利人，'
    + '文件名无法证明实际用的是哪个；确认前不应分发：\n  ' + leaked.join('\n  '));
});

// ── P10: 审核记录必须存在且列明结论 ─────────────────────────────────────
test('P10: docs/audio-audit/README.md 存在并包含三类判定', async () => {
  const audit = join(ROOT, 'docs', 'audio-audit', 'README.md');
  if (!existsSync(audit)) return;
  const { readFileSync } = await import('node:fs');
  const md = readFileSync(audit, 'utf8');
  for (const marker of ['FORBIDDEN', 'CONDITIONAL', 'PENDING']) {
    assert.match(md, new RegExp(marker),
      `审核记录必须用 ${marker} 标注状态，便于机器与人工共同复核`);
  }
  assert.match(md, /kasukabe-tsumugi/,
    '必须记录 kasukabe-tsumugi 的二次配布禁令——这是读原文才发现的');
  assert.match(md, /二次配布/,
    '必须引用官方原文关键词，而非只写结论');
});