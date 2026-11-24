/**
 * dsh-notify-say 失败语音（fail 池）测试 —— v0.3.1。
 *
 * 覆盖两处：
 *  A. lib/index.js：error 分支必须走 psKind='fail'；blocked 必须仍是 'chime'
 *     （语义不同：error=跑了但失败，blocked=被拦下没跑起来）。
 *  B. dsh-notify.ps1：fail 池**不得**回落到 done 池 / master-voice / 梗音效池
 *     ——否则失败时会播「主人、任務完了です！」，语义完全相反。
 *
 * B 用 PowerShell 子进程真跑 ps1（-Preview 只出声不弹 Toast），断言其 pick= 字段。
 *
 * ⚠️ **本文件故意不 import ../lib/index.js，也不改 SystemRoot**（三条实测踩坑，别踩）：
 * ① 别的测试文件用 `process.env.SystemRoot = '<不存在>'` 来让 spawn 失效；
 *    若本文件也这么干，**PowerShell 子进程会启动失败**（报 `8009001d`
 *    "Loading managed Windows PowerShell failed"——CLR 找不到 .NET），
 *    表现为 stdout 全空、5 条断言全红，**极易误判成"代码坏了"**。
 *    本文件只读源码文本、只跑 ps1，不需要那个隔离。
 * ② 不能用 `node --test ... -- <args>` 传参：`node --test` 会把 `--` 之后的参数当
 *    **测试文件**加载，`.ps1` 触发 `ERR_UNKNOWN_FILE_EXTENSION`，且 argv 取不到值。
 * ③ 不能用 `execFileSync` 抓 stdout（本机 `node --test` 下拿不到）；用 `spawnSync`。
 *
 * ⚠️ worktree 长路径限制（实测）：MCI 在 >130 字符的 wav 路径上 open 返回 304，
 * 故本文件**只断言"选到了哪个文件"**（pick= 字段，纯字符串判定），
 * **不断言"是否真的出声"**——后者在 worktree 里必假失败，是环境限制非代码缺陷。
 * 真机播放已在短路径（模拟部署）下人工验证通过。
 *
 * 运行：node --test tools/plugins/dsh-notify-say/test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { RUNTIME_PS } from './ps-interp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const PS1 = join(PLUGIN, 'dsh-notify.ps1');
const FAIL_POOL = join(PLUGIN, 'sounds', 'voice-lines', 'fail');
/** done 池 = voice-lines 根目录（那批是说「任務完了です」的，失败时不该播）。 */
const DONE_POOL = join(PLUGIN, 'sounds', 'voice-lines');
const LIB = join(PLUGIN, 'lib', 'index.js');

/** 跑 ps1 -Preview，返回 stdout / stderr / exit code。用 spawnSync（见文件头踩坑③）。 */
function runPs1(args) {
  const r = spawnSync(RUNTIME_PS,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, ...args],
    { encoding: 'utf8', timeout: 60_000 });
  return {
    out: String(r.stdout || ''),
    err: String(r.stderr || ''),
    code: typeof r.status === 'number' ? r.status : 1,
  };
}

/** 从输出里提取 pick=<name>。 */
function pickOf(out) {
  const m = /pick=([^\s+]+)/.exec(out);
  return m ? m[1] : '';
}

// ── A. lib 源码分支路由（读源码文本断言，不起进程）─────────────────────────
test('A1: lib 源码中 error 分支走 fail 池，blocked 仍走 chime（exact）', () => {
  const src = readFileSync(LIB, 'utf8');
  assert.match(src, /gate = cfg\.notifyOnError; psKind = 'fail';/,
    "error 分支必须设为 psKind='fail'（否则失败不播 fail 池）");
  assert.match(src, /gate = cfg\.notifyOnBlocked; psKind = 'chime';/,
    "blocked 必须保持 psKind='chime'（它是'被拦下没跑起来'，不是'跑了但失败'）");
  // 负例：error 不得再是 chime —— 那正是本次要改掉的旧行为
  assert.doesNotMatch(src, /gate = cfg\.notifyOnError; psKind = 'chime';/,
    "error 不应再走 chime");
});

// ── B. ps1 池选择与语义护栏（真跑 ps1）──────────────────────────────────────
test('B0: fail 池资产存在且为 48 条（3 句 × 16 音色）', () => {
  assert.equal(existsSync(FAIL_POOL), true, 'fail 池目录必须存在');
  const files = readdirSync(FAIL_POOL).filter((f) => f.endsWith('.wav'));

  // ⚠️ 不能硬编码"48 条 / 16 音色"。
  //
  // 自用版有 16 个音色的 fail 语音，但**发布版只带 1 个音色**。
  // 硬编码会在发布包里必然失败 —— 而那个失败是"测试假设了开发环境"，
  // 不是资产真的有问题。外部用户跑 `npm test` 看到红灯，会以为包坏了。
  //
  // 判据改为：**按 fail 池自己出现的音色集合**推算应有条数。
  // 每个音色在 fail 池应有 3 个变体（~1/~2/~3）。
  const byVoice = new Map();
  for (const f of files) {
    const m = /^(.+)~(\d)\.wav$/.exec(f);
    if (!m) continue;
    const [, base, n] = m;
    if (!byVoice.has(base)) byVoice.set(base, new Map());
    byVoice.get(base).set(n, (byVoice.get(base).get(n) || 0) + 1);
  }
  assert.ok(byVoice.size > 0, 'fail 池至少要有一个音色');

  // 每个音色的三个变体都应恰好各 1 条（不是"某些音色有 3 条、某些只有 1 条"）
  for (const [base, variants] of byVoice) {
    assert.deepEqual(
      [...variants.keys()].sort(),
      ['1', '2', '3'],
      `音色 ${base} 应恰好有 ~1/~2/~3 三个变体，实际 ${[...variants.keys()].join(',')}`,
    );
    for (const [n, count] of variants) {
      assert.equal(count, 1, `音色 ${base} 的 ~${n} 变体不应重复（实际 ${count} 条）`);
    }
  }

  // 总数 = 音色数 × 3
  assert.equal(
    files.length,
    byVoice.size * 3,
    `fail 池应为 ${byVoice.size} 音色 × 3 变体 = ${byVoice.size * 3} 条，实际 ${files.length}`,
  );
});

test('B1: -Kind fail + 固定音色 → 选到 fail 池的 ~N 变体（不是 done 池同名文件）', () => {
  const { out, err, code } = runPs1(['-Kind', 'fail', '-Preview', '-Voice', 'zundamon-normal', '-Volume', '0']);
  assert.equal(code, 0, `ps1 应正常退出；stderr=${err.slice(0, 200)}`);
  const pick = pickOf(out);
  assert.match(pick, /^zundamon-normal~\d\.wav$/, `应选 fail 池 ~N 变体，实际 pick=${pick}`);
  // 负例：不得选到 done 池根目录的同名（无 ~）文件
  assert.doesNotMatch(pick, /^zundamon-normal\.wav$/, '不得选到 done 池根目录的同名文件');
});

test('B2: -Kind fail + random → 仍限定在 fail 池（不回落到庆祝音）', () => {
  const { out, code } = runPs1(['-Kind', 'fail', '-Preview', '-Mode', 'random', '-Volume', '0']);
  assert.equal(code, 0, 'ps1 应正常退出');
  const pick = pickOf(out);
  assert.match(pick, /~\d\.wav$/, `random 应选 fail 池 ~N 变体，实际 pick=${pick}`);
  assert.doesNotMatch(pick, /master-voice/, '不得回落 master-voice（那是"任務完了"）');
  assert.doesNotMatch(pick, /\.mp3$/, '不得回落梗音效池（庆祝音）');
});

test('B3: fail 池缺该音色 → 在 fail 池内换音色，**绝不回落到 done 池**（关键护栏）', () => {
  // 独立复核 I-1 提出后（2026-10-17）行为已加强：池内换音色 > 没台词。
  // 用 done 池里真实存在、但 fail 池不覆盖的 key（如 -kansai-1 变体）来测这条路径。
  const { out, code } = runPs1(['-Kind', 'fail', '-Preview', '-Voice', 'ameharu-hau-kansai-1', '-Volume', '0']);
  assert.equal(code, 0, 'ps1 应正常退出');
  const pick = pickOf(out);

  // ① 必须仍从 fail 池取到台词（不能因为缺该音色就哑掉）
  assert.match(pick, /~\d\.wav$/, `应在 fail 池内换音色，实际 pick=${pick}`);

  // ② 本测试最重要的一条：绝不回落到 done 池（那会播「主人、任務完了です！」语义相反）。
  // ⚠️ 不能写 `assert.doesNotMatch(out, /pick=\S*voice-lines\\/)`——`pick=` 只含**叶文件名**、
  // 从不含目录，该断言**永远为真 = 空断言**（自查时发现并改掉）。
  // 有效做法：拿 done 池根目录的真实文件名清单，断言 pick 不等于其中任何一个。
  const doneNames = new Set(readdirSync(DONE_POOL).filter((f) => f.endsWith('.wav')));
  assert.ok(!doneNames.has(pick), `pick=${pick} 落在 done 池里（说明回落到"完成"语音）`);

  // ③ 也不许回落到 master-voice / 梗音效（庆祝音）
  assert.doesNotMatch(out, /master-voice/, '不得回落 master-voice');
  assert.doesNotMatch(pick, /\.mp3$/, '不得回落梗音效池');
});

test('B3b: 完全不存在该音色 → 仍在 fail 池内取台词（不哑）', () => {
  const { out, code } = runPs1(['-Kind', 'fail', '-Preview', '-Voice', 'no-such-voice-xyz', '-Volume', '0']);
  assert.equal(code, 0, 'ps1 应正常退出');
  const pick = pickOf(out);
  assert.match(pick, /~\d\.wav$/, `应在 fail 池内换音色，实际 pick=${pick}`);
  const doneNames = new Set(readdirSync(DONE_POOL).filter((f) => f.endsWith('.wav')));
  assert.ok(!doneNames.has(pick), `pick=${pick} 落在 done 池里`);
});

test('B3c: fail 池整目录缺失 → 落到蜂鸣（不变哑巴，也不越池到 done）', () => {
  // 用 chime 模拟"子池取不到"这层保护：chime 恒不取语句，其兜底必须是蜂鸣而非 done 池。
  const { out, code } = runPs1(['-Kind', 'chime', '-Preview', '-Volume', '0']);
  assert.equal(code, 0, 'ps1 应正常退出');
  assert.equal(pickOf(out), 'chime', 'chime 应标为 chime（走蜂鸣）');
  assert.doesNotMatch(out, /pick=\S+\.wav/, 'chime 不得取到任何语句文件');
});

test('B4: -Kind chime → 不选语句（pick 标为 chime，只蜂鸣）', () => {
  const { out, code } = runPs1(['-Kind', 'chime', '-Preview', '-Volume', '0']);
  assert.equal(code, 0, 'ps1 应正常退出');
  // 既有行为：chime 的展示标签就是 'chime'（ps1 的 pickedName 分支），不是 'none'。
  // 关键断言是「没有选到任何 wav 语句」——chime 必须既不是 fail 池也不是 done 池。
  assert.equal(pickOf(out), 'chime', `chime 的 pick 标签应为 chime，实际=${pickOf(out)}`);
  assert.doesNotMatch(out, /pick=\S+\.wav/, 'chime 不得选到任何语音文件');
});

test('B5: -Kind done 未回归（仍从 done 池选）', () => {
  const { out, code } = runPs1(['-Kind', 'done', '-Preview', '-Voice', 'zundamon-normal', '-Volume', '0']);
  assert.equal(code, 0, 'ps1 应正常退出');
  const pick = pickOf(out);
  assert.match(pick, /^(zundamon-normal|master-voice)\.wav$/, `done 应走 done 池/master，实际 pick=${pick}`);
});

test('B6: 未知 Kind 被 ValidateSet 拒绝（fail-closed，不会静默走错池）', () => {
  // -Volume 0 是必需的不是可选的：ValidateSet 在参数绑定阶段就拒绝，
  // 现在确实走不到播放，但依赖「错误刚好发生在绑定期」是脆弱假设。
  // 下面 S1 会强制要求这里带上它。
  const { code } = runPs1(['-Kind', 'bogus-kind', '-Preview', '-Volume', '0']);
  assert.notEqual(code, 0, 'ValidateSet 应拒绝未知 Kind');
});

// ══════════════════════════════════════════════════════════════════════════
// S. 测试静默护栏 —— 跑测试不该在用户耳边出声
//
// ## 为什么这几条在这里
//
// 2026-10-24 用户在我跑测试期间听到「一直在滴滴滴」，问「不知道为什么」。
// 排查出两个**不同**的原因，都值得钉死：
//
// ### 原因一（真实发生）：跑 ps1 的测试忘传 -Volume 0
// `dsh-notify.ps1` 的静音开关是 `if ($script:notifyVol -eq 0) { return }`
// （Play-VoiceLine:499 / Play-Chime:415）。不传 `-Volume 0` 它就**真的播音频**。
// 当天我用 `-Preview` 手动验证中文音色时没传，连续放了 6 段中文语音；
// 同一形状的隐患存在于任何新增的 runPs1(...) 调用点 —— 全靠人工记得加。
// 放在本文件是因为「这里就是跑 ps1 的地方」，护栏和被守护的代码挨着。
//
// ### 原因二（潜在，尚未发生）：JS 层蜂鸣不经过 ps1
// fallbackBeep() 直接 spawn [console]::beep，-Volume 0 管不到它。
// 它现在没吵到人纯属巧合（测试把 SystemRoot 指到不存在路径，蜂鸣的
// powershell 也起不来）。已在 index.js 里按既有 __STUB_CHILD_PROCESS__
// 约定显式挡掉，S2 补一条断言防回退。
//
// ## 判据设计
// 不用「跑一遍听有没有声音」（不可自动化），而是静态扫描调用点：
// 任何把 ps1 的 -Preview / -Kind 真跑起来的地方，同一条 argv 里
// 必须有 `-Volume', '0'`。这条判据能稳定复现、误报低。
// ══════════════════════════════════════════════════════════════════════════

/**
 * 找出所有会**真跑** dsh-notify.ps1 的 argv 构造点，检查是否带 `-Volume 0`。
 *
 * 只认同一个 `['...', ...]` 数组字面量里的内容 —— 跨行也算，
 * 因为 spawn 的 argv 常常拆成多行写。
 *
 * ⚠️ 必须跳过**注释行**：文档里写「这里原本是 runPs1(['-Kind', ...])」
 * 是很正常的说明方式，若把注释也当违规，判据会逼着人不敢写注释。
 * （第一版没跳，结果把本文件里的说明文字报成了违规。）
 *
 * @returns {string[]} 问题描述，空数组 = 全部合规
 */
function silentArgvProblems() {
  const problems = [];
  for (const name of readdirSync(HERE)) {
    if (!name.endsWith('.test.mjs')) continue;
    const src = readFileSync(join(HERE, name), 'utf8');
    const lines = src.split(/\r?\n/);
    let inBlockComment = false;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      // 维护块注释状态（`/** ... */` 与 `/* ... */`）
      const trimmed = line.trim();
      if (inBlockComment) {
        if (trimmed.includes('*/')) inBlockComment = false;
        continue;
      }
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) inBlockComment = true;
        continue;
      }
      if (trimmed.startsWith('//')) continue;

      // 定位一次 argv 数组的字面量起点（`['-Kind'` 或 `['-Preview'`）
      if (!/\[\s*'-(Kind|Preview|Mode|Voice)'/.test(line)) continue;
      // 向后收集到本数组闭合（简单括号计数，够用：这些数组里没有嵌套括号）
      let depth = 0;
      let buf = '';
      let j = i;
      for (; j < lines.length; j += 1) {
        const ln = lines[j];
        for (const ch of ln) {
          if (ch === '[') depth += 1;
          else if (ch === ']') depth -= 1;
        }
        buf += ln + '\n';
        if (depth <= 0 && j >= i) break;
      }
      // 只关心真的跑 ps1 的（带 -Preview 或 -Kind），而不是在断言源码文本
      if (!/'-Preview'/.test(buf) && !/'-Kind'/.test(buf)) continue;
      // 已经是字符串/正则字面量（在断言别处源码）→ 跳过
      if (/assert\.|match\(|regex|RE\b/.test(lines[Math.max(0, i - 1)])) continue;
      const silent = /'-Volume'\s*,\s*'0'/.test(buf) || /"-Volume"\s*,\s*"0"/.test(buf);
      if (!silent) {
        problems.push(`${name}:${i + 1} 真跑 ps1 却没传 -Volume 0 → 会在用户耳边出声：\n`
          + buf.split('\n').slice(0, 3).map((s) => '      ' + s.trim()).join('\n'));
      }
      i = j;   // 跳过已消费的行，避免同一数组被重复报告
    }
  }
  return problems;
}

test('S1: 任何真跑 dsh-notify.ps1 的测试都必须传 -Volume 0（否则真的会响）', () => {
  const problems = silentArgvProblems();
  assert.deepEqual(problems, [],
    '这些测试跑 ps1 时会真的播放音频。跑测试不该吵到正在用电脑的人：\n  '
    + problems.join('\n  ')
    + '\n\n修法：在该 argv 里加 \'-Volume\', \'0\'。'
    + '\n（-Volume 0 在 Play-VoiceLine 与 Play-Chime 里都是「在打开文件之前就 return」的真静音）');
});

test('S2: fallbackBeep 必须有测试环境守卫（JS 层蜂鸣绕过 -Volume 0）', () => {
  // 定位函数体
  const m = readFileSync(LIB, 'utf8').match(/function fallbackBeep\(which\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(m, '应能定位 fallbackBeep 函数体');
  const body = m[1];

  assert.match(body, /__STUB_CHILD_PROCESS__\s*===\s*true/,
    'fallbackBeep 必须在测试环境（__STUB_CHILD_PROCESS__ === true）下不真蜂鸣。\n'
    + '它 spawn 的是 [console]::beep，完全绕过 ps1 的 -Volume 0 静音；\n'
    + '现在不出声只是因为测试把 SystemRoot 指到了不存在的路径 —— 那是巧合，不是约定。');

  // 守卫必须是**条件**而不是注释：去掉注释后仍要能找到
  const noComment = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.match(noComment, /__STUB_CHILD_PROCESS__/,
    '这个守卫必须在**生效代码**里，不能只是注释里提了一句');

  // 必须真的提前 return（否则守卫写了等于没写）
  assert.match(noComment, /if\s*\(\s*stubbed\s*\)\s*return/,
    '守卫后面必须 `if (stubbed) return`，否则 spawn 照样发生');
});

test('S3: 静音判据本身要能失败（反向证明，防恒真空过滤）', () => {
  // 拿一段"故意漏传 -Volume 0"的假源码喂给同一个判据逻辑，必须报出问题。
  // 不这么做的话，S1 可能在判据写错时一直绿 —— #469 踩过这个坑
  // （「筛出问题后必须为空」的断言，若筛子本身永远筛不出东西，它就恒真）。
  //
  // ⚠️ 假源码**不能写成完整的 argv 字面量**：S1 会扫到它，
  // 把本文件自己报成违规（第一版就这么红了）。用字符串拼接，让静态扫描
  // 看不到完整的字面量，而判据逻辑本身照样能被喂到。
  const fake = "const r = runPs1(['" + "-Kind', 'done', '-Preview']);\n";
  const hasSilent = /'-Volume'\s*,\s*'0'/.test(fake);
  assert.equal(hasSilent, false, '这段假源码确实没传 -Volume 0，判据应能识别');
  // 再验证正例：加了之后判据应认为合规
  const fakeOk = "const r = runPs1(['" + "-Kind', 'done', '-Preview', '-Volume', '0']);\n";
  assert.equal(/'-Volume'\s*,\s*'0'/.test(fakeOk), true, '加了 -Volume 0 后判据应认为合规');
});
