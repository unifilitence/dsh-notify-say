/**
 * 语音包增益与限幅测试（v0.4.16）。
 *
 * ## 为什么需要增益
 *
 * 实测本包 247 个语音包峰值：最小 24.7%、中位 40.4%、最大 84.4%。
 * 素材本身录得偏轻。而 Windows MCI 的 `setaudio volume to 1000`
 * 上限**只等于原始幅度 1.0 倍**，无法超过 —— 所以 GUI 音量拉满
 * 也只能听到原始电平的 35%~40%，听感必然偏轻。
 *
 * 唯一出路是**数字增益**：把样本乘一个系数。
 *
 * ## 为什么必须限幅
 *
 * 最响的文件已 84.4%，硬乘 2 倍会超过满刻度 → 削波（破音）。
 * 所以实际系数 = min(期望倍数, 95% / 实测峰值)。
 *
 * 这些用例直接调用 ps1 里的函数（真跑 PowerShell，不是 mock），
 * 因为增益涉及字节级操作，mock 测不出真问题。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, unlinkSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_PS } from './ps-interp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GAIN_LIB = join(ROOT, 'lib', 'wav-gain.ps1');
const VOICE_DIR = join(ROOT, 'sounds', 'voice-lines');

/** 跑一段 PowerShell，返回 stdout。 */
function ps(code) {
  const dir = mkdtempSync(join(tmpdir(), 'gain-test-'));
  const file = join(dir, 'run.ps1');
  // 必须带 BOM：Windows PowerShell 5.1 读无 BOM 的 UTF-8 会按 ANSI 解释，
  // 中文全变乱码并报语法错（本项目踩过）。
  writeFileSync(file, '\uFEFF' + code, 'utf8');
  try {
    return execFileSync(RUNTIME_PS, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file,
    ], { encoding: 'utf8', timeout: 120_000 });
  } finally {
    try { unlinkSync(file); } catch { /* ignore */ }
  }
}

// ── G1: 增益函数存在且能测峰值 ───────────────────────────────────────────
test('G1: Get-WavPeakPercent 能读出峰值百分比', () => {
  const f = join(VOICE_DIR, 'zundamon-normal.wav');
  if (!existsSync(f)) return;   // 语音包未随仓库分发时跳过
  const out = ps(`. '${GAIN_LIB}'; Get-WavPeakPercent -Path '${f}'`);
  const v = Number(out.trim());
  assert.ok(Number.isFinite(v), `应返回数值，实际: ${out}`);
  assert.ok(v > 0 && v <= 100, `峰值应在 0~100，实际 ${v}`);
});

// ── G2: 增益确实放大，且不超过 95% 安全线 ────────────────────────────────
test('G2: 增益生效且峰值不超过 95%（不削波）', () => {
  const f = join(VOICE_DIR, 'zundamon-normal.wav');
  if (!existsSync(f)) return;
  const tmpOut = join(tmpdir(), `g2-${Date.now()}.wav`);
  try {
    const out = ps(`
      . '${GAIN_LIB}'
      $r = Invoke-WavGain -Path '${f}' -OutPath '${tmpOut}' -Gain 2.0
      Write-Output ("{0}|{1}|{2}" -f $r.Ok, $r.PeakBefore, $r.PeakAfter)
    `);
    const [ok, before, after] = out.trim().split('|');
    assert.equal(ok, 'True', '增益应成功');
    assert.ok(Number(after) > Number(before), `放大后峰值(${after})应高于原值(${before})`);
    assert.ok(Number(after) <= 95.5, `绝不能超过安全线，实际 ${after}%`);
  } finally {
    try { unlinkSync(tmpOut); } catch { /* ignore */ }
  }
});

// ── G3: 很响的文件自动降倍（关键护栏）──────────────────────────────────
test('G3: 本来就响的文件自动降到安全倍数，不削波', () => {
  const f = join(VOICE_DIR, 'my-voice-ja-2.wav');
  if (!existsSync(f)) return;
  const tmpOut = join(tmpdir(), `g3-${Date.now()}.wav`);
  try {
    const out = ps(`
      . '${GAIN_LIB}'
      $r = Invoke-WavGain -Path '${f}' -OutPath '${tmpOut}' -Gain 2.0
      Write-Output ("{0}|{1}|{2}" -f $r.AppliedGain, $r.PeakBefore, $r.PeakAfter)
    `);
    const [applied, before, after] = out.trim().split('|');
    // 这个文件原峰值 84.4%，2 倍必然削波 -> 必须自动降倍
    assert.ok(Number(applied) < 2.0,
      `应为避免削波而降倍，实际倍数 ${applied}`);
    assert.ok(Number(after) <= 95.5, `峰值 ${after}% 超过安全线`);
    assert.ok(Number(before) > 80, `选定文件应确实很响，实际 ${before}%`);
  } finally {
    try { unlinkSync(tmpOut); } catch { /* ignore */ }
  }
});

// ── G4: 非 16-bit PCM / 非 wav 不做增益，退回原样 ───────────────────────
test('G4: 不支持的文件返回 Ok=false（调用方据此用原文件）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gain-bad-'));
  const fake = join(dir, 'not-a-wav.mp3');
  writeFileSync(fake, Buffer.from('ID3 fake mp3 content'));
  const tmpOut = join(dir, 'out.wav');
  try {
    const out = ps(`
      . '${GAIN_LIB}'
      $r = Invoke-WavGain -Path '${fake}' -OutPath '${tmpOut}' -Gain 2.0
      Write-Output ("{0}|{1}" -f $r.Ok, $r.Reason)
    `);
    const [ok, reason] = out.trim().split('|');
    assert.equal(ok, 'False', '不是 16-bit PCM wav 时不该声称成功');
    assert.ok(reason.length > 0, '应给出原因');
  } finally {
    try { unlinkSync(fake); unlinkSync(tmpOut); } catch { /* ignore */ }
  }
});

// ── G5: Gain <= 1.0 时什么都不做 ─────────────────────────────────────────
test('G5: Gain<=1.0 时跳过（不加倍也不写文件）', () => {
  const f = join(VOICE_DIR, 'zundamon-normal.wav');
  if (!existsSync(f)) return;
  const tmpOut = join(tmpdir(), `g5-${Date.now()}.wav`);
  try {
    const out = ps(`
      . '${GAIN_LIB}'
      $r = Invoke-WavGain -Path '${f}' -OutPath '${tmpOut}' -Gain 1.0
      Write-Output ("{0}|{1}" -f $r.Ok, $r.Reason)
    `);
    const [ok, reason] = out.trim().split('|');
    assert.equal(ok, 'False');
    assert.equal(reason, 'gain<=1');
  } finally {
    try { unlinkSync(tmpOut); } catch { /* ignore */ }
  }
});
