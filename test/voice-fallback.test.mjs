/**
 * 音色回退的语言一致性（issue #1 回归）。
 *
 * ## 这条测试守的是什么
 *
 * issue #1（dustinmoon78，2026-10-25）：用户在设置页选了**中文**音色
 * `zh-clear-female`，而发布包只自带两个音色（日语 `zundamon-normal` +
 * 中文 `zh-soft-female`）。原选曲链找不到指定音色时一路落到
 * `sounds/master-voice.wav` —— 那文件与 `zundamon-normal.wav` 是同一个文件
 * （sha256 相同），说的是「主人、任務完了です！」。
 *
 * 于是：用户明确点了中文，听到的是日语；而且**全程没有一行日志**，
 * 用户只能凭耳朵发现"怎么变日语了"，提 issue 时也拿不出证据。
 *
 * ## 修复后的契约（三段，逐条断言）
 *
 * ① **同语系优先**：点选的音色取不到时，先在同一个池里换一个**同语言**的音色，
 *    再考虑任何跨语言的兜底。中文请求绝不该先嫁接到日语上。
 * ② **不越池**：`fail` 仍然是 `fail` 池（不得跑到 done 池去播庆祝台词）——
 *    这是 2026-10-17 那条更早的护栏，新逻辑不能把它弄破。
 * ③ **留痕**：真的换了音色时，日志里必须有一行 `[voice-miss]`，
 *    且 `-Preview` 的输出里带 `[voice-miss]` 标记。
 *
 * ## 为什么这里只用"发布包那套音色"来测
 *
 * 自用目录里 17 个音色全在，`zh-clear-female` 是**装了**的，那条代码路径根本
 * 走不到（实测：自用目录下 `-Voice zh-clear-female` 直接选中它，不会回退）。
 * 用户踩坑的是**发布包**。所以本文件用 `-VoiceRoot` 指向一个只含
 * `zundamon-normal` + `zh-soft-female` 的临时根，复刻发布包形态。
 *
 * ⚠️ 不能用 `-Voice` 指向真实不存在的 key 来测语言回退：那种情况下
 * `Get-VoiceLangOf` 只能按 `zh-` 前缀猜，虽然也能过，但**测不到**
 * "用户点的是真实存在、只是没装的音色"这个真实场景。
 *
 * ⚠️ worktree 长路径：MCI 在 >130 字符的路径上 open 返回 304，
 * 所以本文件**只断言 pick= 字符串**，不断言真的出声（同 fail-voice.test.mjs 的说明）。
 *
 * 运行：node --import ./test/test-env-setup.mjs --test test/voice-fallback.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const PS1 = join(PLUGIN, 'dsh-notify.ps1');
const REAL_SOUNDS = join(PLUGIN, 'sounds');

/** 发布包里真实存在的两个音色（见 release-build.ps1 的默认自带清单）。 */
const SHIPPED_JA = 'zundamon-normal';
const SHIPPED_ZH = 'zh-soft-female';
/** 自用目录有、发布包**没有**的中文音色 —— issue #1 里用户点的就是这个。 */
const NOT_SHIPPED_ZH = 'zh-clear-female';

/**
 * 造一个"发布包形态"的语音根：只有 zundamon-normal 与 zh-soft-female 两族。
 *
 * 直接从真实 sounds 目录**按音色前缀复制**，不重新合成 —— 音频内容无关紧要，
 * 本测试只断言"选中了哪个文件名"。
 */
function makeShippedVoiceRoot() {
  const root = mkdtempSync(join(tmpdir(), 'ns-shipped-'));
  const dest = join(root, 'voice-lines');
  mkdirSync(dest, { recursive: true });
  for (const pool of ['', 'fail', 'question', 'approval']) {
    const srcDir = pool ? join(REAL_SOUNDS, 'voice-lines', pool) : join(REAL_SOUNDS, 'voice-lines');
    if (!existsSync(srcDir)) continue;
    const outDir = pool ? join(dest, pool) : dest;
    mkdirSync(outDir, { recursive: true });
    for (const key of [SHIPPED_JA, SHIPPED_ZH]) {
      // 该池里此音色的所有变体（<key>.wav 与 <key>~N.wav）
      for (const f of readdirSync(srcDir)) {
        if (!f.endsWith('.wav')) continue;
        const base = f.replace(/~.*$/, '').replace(/\.wav$/, '');
        if (base !== key) continue;
        cpSync(join(srcDir, f), join(outDir, f));
      }
    }
  }
  return root;
}

/** 跑 ps1 -Preview，返回 stdout / stderr / exit code。用 spawnSync（见 fail-voice.test.mjs 踩坑③）。 */
function runPs1(args, logDir) {
  const env = { ...process.env };
  if (logDir) env.DSH_NOTIFY_SAY_LOG_DIR = logDir;
  const r = spawnSync('powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, ...args],
    { encoding: 'utf8', timeout: 60_000, env });
  return {
    out: String(r.stdout || ''),
    err: String(r.stderr || ''),
    code: typeof r.status === 'number' ? r.status : 1,
  };
}

/** 从输出里提取 pick=<name>。 */
function pickOf(out) {
  const m = /pick=([^\s+]+)/.exec(out.replace('（静音）', ''));
  return m ? m[1] : '';
}

/** 文件名 → 音色 key（去掉 ~N 变体后缀与 .wav）。 */
function keyOf(file) {
  return file.replace(/~.*$/, '').replace(/\.wav$/, '');
}

/** 某音色 key 是否属于中文（与 ps1 / client.js 同一命名契约：zh- 前缀）。 */
function isZh(key) {
  return key.startsWith('zh-');
}

// ── 1. 同语系回退：中文请求不该先落到日语 ──────────────────────────────────
test('F1: 发布包形态下点未安装的中文音色 → 退到**中文**已装音色，不是 master-voice', () => {
  const root = makeShippedVoiceRoot();
  try {
    const { out, err, code } = runPs1(
      ['-Kind', 'done', '-Preview', '-NoSound', '-Voice', NOT_SHIPPED_ZH, '-VoiceRoot', join(root, 'voice-lines'), '-Volume', '0'],
    );
    assert.equal(code, 0, `ps1 应正常退出；stderr=${err.slice(0, 300)}`);
    const pick = pickOf(out);
    assert.notEqual(pick, '', `应选到一个文件，实际输出=${out}`);
    assert.equal(isZh(keyOf(pick)), true,
      `点中文音色时应播中文，实际 pick=${pick}（master-voice 是日语「任務完了です」，正是 issue #1）`);
    assert.notEqual(pick, 'master-voice.wav', '不得落到 master-voice.wav');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 2. 四个 kind 都要覆盖（issue #1 只写了 done，实际四类都有）────────────────
for (const kind of ['done', 'question', 'approval', 'fail']) {
  test(`F2-${kind}: -Kind ${kind} + 未安装中文音色 → 仍是中文（四类都不得跨语言）`, () => {
    const root = makeShippedVoiceRoot();
    try {
      const { out, code } = runPs1(
        ['-Kind', kind, '-Preview', '-NoSound', '-Voice', NOT_SHIPPED_ZH, '-VoiceRoot', join(root, 'voice-lines'), '-Volume', '0'],
      );
      assert.equal(code, 0, 'ps1 应正常退出');
      const pick = pickOf(out);
      assert.equal(isZh(keyOf(pick)), true,
        `kind=${kind} 点中文却播了 ${pick}；四类都必须同语系回退`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

// ── 3. 不越池：fail 不得跑到 done 池去播庆祝台词 ────────────────────────────
test('F3: fail 池缺该中文音色时，仍在 fail 池内换中文音色（不越到 done 池）', () => {
  const root = makeShippedVoiceRoot();
  try {
    const { out, code } = runPs1(
      ['-Kind', 'fail', '-Preview', '-NoSound', '-Voice', NOT_SHIPPED_ZH, '-VoiceRoot', join(root, 'voice-lines'), '-Volume', '0'],
    );
    assert.equal(code, 0, 'ps1 应正常退出');
    const pick = pickOf(out);
    // done 池根目录的 <key>.wav（无 ~N）是"任务完成"台词；fail 必须选带 ~N 的子池变体
    assert.match(pick, /~\d+\.wav$/, `fail 必须留在 fail 池（~N 变体），实际 pick=${pick}`);
    assert.doesNotMatch(pick, /master-voice/, 'fail 不得回落到 master-voice（语义相反）');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 4. 留痕：换音色必须写 [voice-miss] ──────────────────────────────────────
test('F4: 真的换了音色时，日志写 [voice-miss] 且 Preview 输出带标记', () => {
  const root = makeShippedVoiceRoot();
  const logDir = mkdtempSync(join(tmpdir(), 'ns-miss-'));
  try {
    const { out, code } = runPs1(
      ['-Kind', 'done', '-Preview', '-NoSound', '-Voice', NOT_SHIPPED_ZH, '-VoiceRoot', join(root, 'voice-lines'), '-Volume', '0'],
      logDir,
    );
    assert.equal(code, 0, 'ps1 应正常退出');
    assert.match(out, /\[voice-miss\]/, 'Preview 输出必须带 [voice-miss]（用户当场就能看出换过音色）');
    const logFile = join(logDir, 'notify.log');
    assert.equal(existsSync(logFile), true, `日志文件必须存在：${logFile}`);
    const log = readFileSync(logFile, 'utf8');
    assert.match(log, /\[voice-miss\]/, '日志必须有一行 [voice-miss]');
    assert.match(log, new RegExp(`requested=${NOT_SHIPPED_ZH}`),
      '日志必须写明用户请求的是哪个音色');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
});

// ── 5. 没换音色时不得误报（否则日志会被噪声淹没，等于没留痕）────────────────
test('F5: 点的是已装音色 → 不写 [voice-miss]（避免误报把留痕淹掉）', () => {
  const root = makeShippedVoiceRoot();
  const logDir = mkdtempSync(join(tmpdir(), 'ns-nomiss-'));
  try {
    const { out, code } = runPs1(
      ['-Kind', 'done', '-Preview', '-NoSound', '-Voice', SHIPPED_ZH, '-VoiceRoot', join(root, 'voice-lines'), '-Volume', '0'],
      logDir,
    );
    assert.equal(code, 0, 'ps1 应正常退出');
    assert.equal(keyOf(pickOf(out)), SHIPPED_ZH, `应精确选中 ${SHIPPED_ZH}，实际 ${pickOf(out)}`);
    assert.doesNotMatch(out, /\[voice-miss\]/, '选中了请求的音色时不该报 miss');
    const log = readFileSync(join(logDir, 'notify.log'), 'utf8');
    assert.doesNotMatch(log, /\[voice-miss\]/, '选中了请求的音色时不该写 miss 日志');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
});

// ── 6. 反向：日语请求不该被送到中文去 ──────────────────────────────────────
test('F6: 点未安装的日语音色 → 退到日语已装音色，不是中文', () => {
  const root = makeShippedVoiceRoot();
  try {
    const { out, code } = runPs1(
      ['-Kind', 'done', '-Preview', '-NoSound', '-Voice', 'ameharu-hau', '-VoiceRoot', join(root, 'voice-lines'), '-Volume', '0'],
    );
    assert.equal(code, 0, 'ps1 应正常退出');
    const pick = pickOf(out);
    assert.equal(isZh(keyOf(pick)), false,
      `点日语却播了中文 ${pick}；同语系回退是双向的`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 7. 契约漂移守卫：ps1 与 client.js 必须用同一套语言判据 ──────────────────
test('F7: 语言判据在 ps1 与 client.js 之间不漂移（都按 zh- 前缀）', () => {
  const ps1 = readFileSync(PS1, 'utf8');
  // ps1 侧：Get-VoiceLangOf 必须按 zh- 前缀判，而不是维护第二份清单
  assert.match(ps1, /function Get-VoiceLangOf/, 'ps1 必须有 Get-VoiceLangOf');
  assert.match(ps1, /if \(\$Key -like 'zh-\*'\) \{ return 'zh' \}/,
    'Get-VoiceLangOf 必须按 zh- 前缀判中文（清单会漂移，前缀不会）');
  // 同语系回退必须用**不退回未过滤**的那个取法
  assert.match(ps1, /function Pick-RandomWavInLang/, 'ps1 必须有 Pick-RandomWavInLang');
});
