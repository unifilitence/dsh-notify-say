/**
 * 音色友好显示名的一致性测试（v0.4.55）。
 *
 * ## 为什么要这些测试
 *
 * 用户反馈：下拉里显示 `zundamon-normal` 是开发者内部标识，应显示「角色名 · 风格名」。
 *
 * 这个改动本身很小，但它引入了**第二份音色名字**：
 *   ① `tools/build-voice-packs.ps1` 的 `$Approved[].Name`（打包用，权威）
 *   ② `lib/client.js` 的 `VOICE_LABELS`（显示用）
 *
 * 两份名字一旦漂移，用户会在「语音包列表」看到一个名字、
 * 在「音色下拉」看到另一个名字 —— 同一件事两种叫法。
 * 所以必须用测试把它们钉在一起。
 *
 * ## 关键的"不能改"约束
 *
 * 只改显示。**保存提交的仍是原 key** —— 如果哪天有人把 option 的 value
 * 改成友好名，用户的配置就会写入一个后端不认识的字符串。
 * Q3 专门盯这一条。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_PS } from './ps-interp.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLIENT = readFileSync(join(ROOT, 'lib', 'client.js'), 'utf8');
const BUILD_PS1 = join(ROOT, 'tools', 'build-voice-packs.ps1');
const hasBuild = existsSync(BUILD_PS1);

// ⚠️ 必须在 import lib/index.js **之前**把 DSH_HOME 指到空目录（L9f 需要）。
//
// 为什么：插件启动时会把 `$DSH_HOME/storages/dsh-notify-say/config.json`
// 当作**最高优先级**的运行时覆盖层（合并顺序 patch → schema → fileValues）。
// 不隔离就会读到**用户本人的真实配置**：实测在开发者机器上该文件里
// 已经有 `voiceLang: "ja"`（GUI 保存时写进去的），于是 L9f 的老用户用例
// 恒得到 `["ja"]`，看起来像代码坏了，其实是测试读到了别人的配置。
// 与 test/fail-route.test.mjs:34-42 记录的是同一个坑。
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'notify-voicelabel-home-'));
process.env.DSH_HOME = ISOLATED_HOME;

// ⚠️ L9f 会真跑 apply()，而 apply() 会同步协议注册（写/删 HKCU 下的
// `dshnotify-say` 键）。开发机上那是**用户真实的协议注册**，跑一次测试
// 就可能把它删掉 —— protocol-ownership.test.mjs 的 I7 专门盯这件事，
// 第一次跑就抓到了我（报错原文：这些测试调 apply() 却没关注册表访问）。
process.env.DSH_NOTIFY_NO_REGISTRY = '1';

process.on('exit', () => {
  try { rmSync(ISOLATED_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
});

/** 往隔离 home 写 config.json（L9f 用；不写就是"全新用户"）。 */
function writeIsolatedConfig(values) {
  const dir = join(ISOLATED_HOME, 'storages', 'dsh-notify-say');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'),
    JSON.stringify({ version: 1, values }), 'utf8');
}

/** 清空隔离 home 的 config.json，回到"没有配置"状态。 */
function clearIsolatedConfig() {
  const p = join(ISOLATED_HOME, 'storages', 'dsh-notify-say', 'config.json');
  try { rmSync(p, { force: true }); } catch { /* best effort */ }
}

// ── 真跑 ps1 的工具（L2b 用；与 fail-voice.test.mjs 同一套写法）─────────────
//
// ⚠️ 一律带 `-Volume 0`：S1 会静态扫描本文件里所有跑 ps1 的 argv，
// 缺了它测试就会出声（用户反馈过「跑测试一直滴滴响」）。
const PS1 = join(ROOT, 'dsh-notify.ps1');

// ⚠️ `node:child_process` 必须**惰性**导入，不能写成顶层 import。
//
// 为什么：本文件也要能在 route 段跑（`--import ./test/route-loader-register.mjs`），
// 而那个 loader 把 `node:child_process` 整个换成了记录型假实现
// （`test/stub-child-process.mjs`，只导出 spawn / execFileSync）。
// 顶层 `import { spawnSync }` 会在模块链接阶段直接抛
//   SyntaxError: The requested module 'node:child_process' does not provide an export named 'spawnSync'
// —— 整个文件一行都跑不了，L9f 就永远没机会执行（实测踩过）。
// 惰性导入后，只有真正调 runPs1 时才解析，而 route 段里 L2b 是 skip 的。
async function runPs1(args) {
  const { spawnSync } = await import('node:child_process');
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

/** 解析 client.js 里的 VOICE_KEYS。 */
function voiceKeys() {
  const m = CLIENT.match(/var VOICE_KEYS = \[([\s\S]*?)\n    \]/);
  assert.ok(m, '应能定位 VOICE_KEYS');
  return [...m[1].matchAll(/'([a-z0-9-]+)'/g)].map((x) => x[1]);
}

/** 解析 client.js 里的 VOICE_LABELS。 */
function voiceLabels() {
  const m = CLIENT.match(/var VOICE_LABELS = \{([\s\S]*?)\n    \}/);
  assert.ok(m, '应能定位 VOICE_LABELS');
  const out = {};
  for (const mm of m[1].matchAll(/'([a-z0-9-]+)':\s*'([^']+)'/g)) out[mm[1]] = mm[2];
  return out;
}

/** 解析打包脚本的 $Approved（key → 官方 Name）。 */
function approvedNames() {
  const src = readFileSync(BUILD_PS1, 'utf8');
  const out = {};
  for (const m of src.matchAll(/'([a-z0-9-]+)'\s*=\s*@\{\s*Name\s*=\s*'([^']+)'/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

/** `ずんだもん（ノーマル）` → `ずんだもん`；`四国めたん` → `四国めたん`。 */
function characterOf(official) {
  const m = /^(.+?)（(.+?)）$/.exec(official);
  return m ? m[1] : official;
}

// ── Q1: VOICE_KEYS 每一项都有友好名 ─────────────────────────────────────
test('Q1: 每个可选音色都有友好显示名', () => {
  const keys = voiceKeys();
  const labels = voiceLabels();
  assert.ok(keys.length >= 8, `音色数量偏少（${keys.length}）`);

  const missing = keys.filter((k) => !labels[k]);
  assert.deepEqual(missing, [],
    '这些音色还显示着英文 key（用户看不懂），应补进 VOICE_LABELS：\n' + missing.join('\n'));
});

// ── Q2: 友好名与打包脚本的官方名同源 ────────────────────────────────────
test('Q2: 友好名的角色部分与 build-voice-packs.ps1 一致', () => {
  if (!hasBuild) {
    // 发布包里没有维护者工具，跳过（与 D6/D7 同款处理）
    return;
  }
  const labels = voiceLabels();
  const approved = approvedNames();
  assert.ok(Object.keys(approved).length >= 8, '应能解析出打包脚本的音色表');

  const problems = [];
  for (const [key, official] of Object.entries(approved)) {
    const label = labels[key];
    if (!label) continue;                       // Q1 管缺失
    const wantChar = characterOf(official);
    const gotChar = label.split(' · ')[0];
    if (gotChar !== wantChar) {
      problems.push(`${key}: 显示「${label}」，但打包脚本的角色名是「${wantChar}」`);
    }
  }
  assert.deepEqual(problems, [],
    '两份音色名字漂移了 —— 用户会在不同位置看到不同叫法：\n' + problems.join('\n'));
});

// ── Q3: 保存的仍是原 key，不是友好名 ───────────────────────────────────
test('Q3: 音色下拉的 value 仍是原 key（只改显示）', () => {
  // 如果 value 被改成友好名，用户的配置会写入后端不认识的字符串。
  assert.match(CLIENT, /h\('option', \{ key: k, value: k, title: k \}, voiceLabel\(k\)\)/,
    '固定音色的 option 必须 value=原key、显示=友好名');
  assert.match(CLIENT, /h\('option', \{ key: x, value: x, title: x \}, voiceLabel\(x\)\)/,
    '按事件覆盖的音色 option 同理');
  // 原 key 要能在悬停提示里看到（用户排查问题时需要）
  assert.match(CLIENT, /title: k/, '原 key 应放在 title 里（悬停可见）');
});

// ── Q4: option 显示文本不再直接是 key ──────────────────────────────────
test('Q4: 音色 option 的显示文本走 voiceLabel，不是裸 key', () => {
  // 反面断言：不能再出现 `h('option', { key: k, value: k }, k)` 这种裸 key 显示
  assert.doesNotMatch(CLIENT, /h\('option', \{ key: k, value: k \}, k\)/,
    '固定音色不应再直接显示英文 key');
  assert.doesNotMatch(CLIENT, /h\('option', \{ key: x, value: x \}, x\)/,
    '按事件覆盖的音色不应再直接显示英文 key');

  // 语音包列表也要用统一风格（括号 → 点）
  assert.match(CLIENT, /prettyPackName\(p\.name\)/,
    '语音包列表的官方名应统一成「角色 · 风格」风格');
  assert.match(CLIENT, /function prettyPackName/, '应有 prettyPackName 工具函数');
});

// ══════════════════════════════════════════════════════════════════════════
// L. 语音语言（voiceLang，v0.5.3）—— 中日音色不能混播
//
// ## 为什么需要这个字段
//
// 用户 2026-10-24 指出：随机模式会中日混播 ——
// 「有些放日语，有些放中文，感觉可能对有些人来说不太好」。
// 根因是随机模式从**整个** sounds/voice-lines 目录抓一个 wav，
// 而中文日语混在同一个核心里。
//
// ## 约束（这一段盯住的东西）
//
// 1. **key 前缀是唯一事实源**：中文音色一律 zh- 开头，日语不带。
//    不能维护第二份"语言清单"—— 那必然漂移。
// 2. **过滤在跨根聚合之后做**：用户目录可能有中文、插件目录只有日语，
//    若每个根各自过滤再合并，前一个根找不到中文就直接判失败。
// 3. **过滤后为空时必须退回未过滤**：宁可放一句别的语言，
//    也不能整段静音 —— 提醒不响比语言跳更糟。
// 4. **GUI 只列当前语言的音色**：中日混排的下拉里用户分不清，
//    选错还会直接落空（中文池里找日语 key）。
// ══════════════════════════════════════════════════════════════════════════

const PS1_SRC = readFileSync(join(ROOT, 'dsh-notify.ps1'), 'utf8');
const SCHEMA_SRC = readFileSync(join(ROOT, 'lib', 'config-schema.js'), 'utf8');
const INDEX_SRC = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');

/** 中文音色的命名约定：`zh-` 前缀。 */
const ZH_PREFIX = 'zh-';

test('L1: 中文音色全部以 zh- 开头，日语全部不带（前缀是唯一事实源）', () => {
  const keys = voiceKeys();
  assert.ok(keys.length >= 15, `音色数量偏少（${keys.length}），中日应各有若干`);

  const zh = keys.filter((k) => k.startsWith(ZH_PREFIX));
  const ja = keys.filter((k) => !k.startsWith(ZH_PREFIX));

  assert.ok(zh.length > 0, '应有中文音色（zh- 前缀）');
  assert.ok(ja.length > 0, '应有日语音色（无 zh- 前缀）');
  assert.equal(zh.length + ja.length, keys.length, '每个音色必须能明确归到一种语言（不能两边都不算）');
});

test('L2: Select-WavByLang 按前缀过滤，且过滤后为空要退回未过滤', () => {
  const m = PS1_SRC.match(/function Select-WavByLang\([\s\S]*?\n\}/);
  assert.ok(m, '应能定位 Select-WavByLang');
  const body = m[0];

  assert.match(body, /-like\s+'zh-\*'/, 'zh 分支应按 zh-* 过滤');
  assert.match(body, /-notlike\s+'zh-\*'/, 'ja 分支应按「不是 zh-*」过滤');

  // ⚠️ 下面这两条源码断言**单独存在时是无效判据**（2026-10-25 复核实测证实）：
  //
  //   把 `$all = $filtered` 改成 `$null = $filtered`（保留 Count 判断、丢掉结果）
  //   → 这两条源码断言**全绿**，而真跑 -Lang zh 八次只出 1 次中文、7 次日语。
  //
  // 也就是说：它们只能验「形状」，验不了「语义」。
  // 真正的判据必须是**真跑 ps1 看选出来的文件**，见下面的 L2b。
  const callSite = PS1_SRC.match(/Select-WavByLang \$all \$Lang[\s\S]{0,200}/);
  assert.ok(callSite, '应能定位 Select-WavByLang 的调用点');
  assert.match(callSite[0], /if\s*\(\s*\$filtered\.Count\s*-gt\s*0\s*\)/,
    '过滤后为空时必须退回未过滤（否则用户切了语言但该语言没素材 → 整段静音）');
});

// ── L2b: 真跑 ps1，用 pick= 判语言（唯一能抓住"保留锚点改语义"的判据）──────
test('L2b: 真跑 ps1 —— -Lang zh 必须 100% 选出中文音色，-Lang ja 必须 100% 日语', {
  // 本文件会被跑两遍：`node --test`（默认套件）与 `npm run test:all` 的 route 段。
  // 24 次真启动 PowerShell 要 13 秒，跑两遍纯属浪费 —— 只在默认套件里跑。
  // route 段用 L9f（loader stub，不起进程）覆盖另一条链路。
  skip: process.env.DSH_ROUTE_LOADER === '1' && 'route 段不重复真跑 ps1（L9f 覆盖该链路）',
}, async () => {
  // 为什么必须有这条：L2 的三条源码断言在 `$null = $filtered` 变异下全绿，
  // 而真实行为是「八次里七次日语」= 本次要修的混播症状原样复现。
  // 只有真跑一遍、看 pick 出来的文件名，才是判据本身而不是它的影子。
  //
  // -Volume 0：绝不能出声（S1 强制要求）。
  // 每种语言跑 N 次：单次可能偶然命中同语言样本，跑多次把「偶尔对」压掉。
  const N = 12;
  const bad = [];
  for (const lang of ['zh', 'ja']) {
    let zhCount = 0;
    let emptyCount = 0;
    const samples = [];
    for (let i = 0; i < N; i += 1) {
      const { out, err, code } = await runPs1(['-Kind', 'done', '-Preview', '-Mode', 'random', '-Lang', lang, '-Volume', '0']);
      if (code !== 0) { bad.push(`-Lang ${lang} 第 ${i + 1} 次退出码 ${code}：${err.slice(0, 120)}`); continue; }
      const pick = pickOf(out);
      if (!pick) { emptyCount += 1; continue; }
      const name = pick.split(/[\\/]/).pop();
      if (/^zh-/i.test(name)) zhCount += 1;
      if (samples.length < 3) samples.push(name);
    }
    if (emptyCount > 0) bad.push(`-Lang ${lang} 有 ${emptyCount} 次没选到文件`);
    if (lang === 'zh' && zhCount !== N) {
      bad.push(`-Lang zh 跑了 ${N} 次，只有 ${zhCount} 次选到中文（样本: ${samples.join(', ')}）`
        + ' —— 说明语言过滤没真正生效，随机池里混进了日语。'
        + '这正是本次要修的症状：保留锚点、改语义的变异会让 L2 的源码断言全绿而这里必红。');
    }
    if (lang === 'ja' && zhCount !== 0) {
      bad.push(`-Lang ja 跑了 ${N} 次，有 ${zhCount} 次选到中文（样本: ${samples.join(', ')}）`);
    }
  }
  assert.deepEqual(bad, [], bad.join('\n'));
});

test('L3: 过滤在跨根聚合之后做（不是每个根各自过滤）', () => {
  const m = PS1_SRC.match(/function Pick-RandomWavFromRoots\([\s\S]*?\n\}/);
  assert.ok(m, '应能定位 Pick-RandomWavFromRoots');
  const body = m[0];

  const collectIdx = body.indexOf('foreach ($root in $script:voiceRoots)');
  const filterIdx = body.indexOf('Select-WavByLang');
  assert.ok(collectIdx >= 0, '应先遍历所有根收集');
  assert.ok(filterIdx >= 0, '应调用 Select-WavByLang');
  assert.ok(collectIdx < filterIdx,
    '语言过滤必须在**跨根聚合之后**；若在每个根内部各自过滤，'
    + '「用户目录有中文、插件目录只有日语」时选 zh 会直接判失败');
});

test('L4: index.js 的两条播放路径都要把 -Lang 传给 ps1', () => {
  // 真实播报 + 试听 两条路径。少任何一条都会出现「试听听到的」与
  // 「真实播报听到的」不是同一语言 —— 试听就失去意义。
  // 数组变量名两边不同（args / a），所以用 \w+ 而不是写死 args。
  const re = /(\w+)\.push\('-Lang',\s*cfg\.voiceLang\s*===\s*'zh'\s*\?\s*'zh'\s*:\s*'ja'\)/g;
  const hits = [...INDEX_SRC.matchAll(re)];
  assert.ok(hits.length >= 2,
    `应有至少 2 处传 -Lang（真实播报 + 试听），实际找到 ${hits.length} 处。\n`
    + '漏传的后果：随机模式会退回「整个目录随便抓」= 中日混播，正是本次要修的问题。');

  // ── 反向证明：这两处必须真的是「在为 ps1 构造参数」──────────────────
  // 不能只数出现次数 —— 把 -Lang 塞进任何无关数组也能凑够 2 处。
  // 判据：同一个数组在这行附近还要 push 至少一个**其它 ps1 开关**。
  //
  // 为什么不用"附近有没有 -Volume"：两条路径写法不同 ——
  //   真实播报 notifyArgs：args.push('-Volume', …) 就在下面几行；
  //   试听：`const a = baseNotifyArgs(...)` 起头，-Volume 已经在 base 里了，
  //        行内只会看到 -Mode / -Voice / -Gain。
  // 用"任意其它开关"才不会对某一条路径过严。
  const lines = INDEX_SRC.split(/\r?\n/);
  const problems = [];
  for (const h of hits) {
    const varName = h[1];
    const lineNo = INDEX_SRC.slice(0, h.index).split(/\r?\n/).length;   // 1-based
    const window = lines.slice(lineNo - 1, lineNo + 12).join('\n');
    const hasOther = new RegExp(`\\b${varName}\\.push\\('-(?!Lang)[A-Za-z]`).test(window);
    if (!hasOther) {
      problems.push(`L${lineNo}: 数组 '${varName}' 附近没有 push 其它 ps1 开关 —— `
        + '说明它可能不是 ps1 的参数数组（-Lang 被塞进了无关数组）');
    }
  }
  assert.deepEqual(problems, [],
    '每处 -Lang 都应落在**为 ps1 构造参数**的数组里：\n' + problems.join('\n'));

  // 两条路径的变量名必须不同（同一个数组被 push 两次 = 其实只有一条路径）
  const vars = new Set(hits.map((h) => h[1]));
  assert.equal(vars.size, 2,
    `两处 -Lang 应属于两个不同的参数数组（真实播报 / 试听），实际变量名：${[...vars].join(', ')}`);
});

test('L5: voiceLang 的 schema 只接受 ja / zh，默认 ja', () => {
  assert.match(SCHEMA_SRC, /voiceLang:\s*z\s*\.union\(\[z\.const\('ja'\),\s*z\.const\('zh'\)\]\)/,
    'voiceLang 应限定为 ja / zh 两个值');
  assert.match(SCHEMA_SRC, /voiceLang:\s*'ja'/, '默认值应为 ja（保持既有用户行为不变）');
});

test('L6: GUI 的音色下拉只列当前语言的音色（中日不混排）', () => {
  // 全局那处与事件级覆盖那处，都要按 voiceLang 过滤
  const filters = [...CLIENT.matchAll(/VOICE_KEYS\.filter\(function\s*\((\w+)\)\s*\{[\s\S]{0,200}?indexOf\('zh-'\)\s*===\s*0[\s\S]{0,200}?\}\)/g)];
  assert.ok(filters.length >= 2,
    `应有至少 2 处按语言过滤音色下拉（全局设置 + 事件覆盖），实际 ${filters.length} 处。\n`
    + '不过滤的后果：下拉里中日混排用户分不清，且选错会直接落空（中文池里找日语 key）。');
});

test('L7: 切语言时自动换到该语言的默认音色（避免自相矛盾的组合）', () => {
  // 「语言=中文，固定音色=ずんだもん」这种组合会让中文池里去找日语 key，直接落空
  const m = CLIENT.match(/onChange:\s*function\s*\(e\)\s*\{[\s\S]{0,700}?voiceLang:\s*nextLang/g);
  assert.ok(m, '切语言的处理函数里应同时更新 voiceName');
  assert.match(m[0], /nextLang\s*===\s*'zh'\s*\?\s*'zh-soft-female'\s*:\s*'zundamon-normal'/,
    '应回落到该语言的默认音色（中文 zh-soft-female / 日语 zundamon-normal）');
});

test('L8: 行为验证 —— 前缀判定与 ps1 的 -like 语义一致（zh- 不匹配日语 key）', () => {
  // 用纯逻辑复刻 ps1 的 -like 'zh-*' / -notlike 'zh-*'，验证中日集合严格互斥且完备。
  // 这么测是因为 PowerShell 的 -like 大小写不敏感，而 JS 的 startsWith 区分大小写 ——
  // 若将来有人加了大写开头的 key，两边判定会不一致。
  const sample = ['zundamon-normal', 'zh-low-male', 'zh-soft-female', 'namiine-ritsu', 'ZH-bad-case'];
  const isZhLike = (n) => /^zh-/i.test(n);     // 复刻 -like 'zh-*'（不区分大小写）
  const isNotZhLike = (n) => !/^zh-/i.test(n); // 复刻 -notlike 'zh-*'

  for (const k of sample) {
    const a = isZhLike(k);
    const b = isNotZhLike(k);
    assert.notEqual(a, b, `${k}: zh / ja 两个分支必须互斥且完备（不能两个都真或都假）`);
  }
  // 明确钉住：大写 ZH- 也会被 PS 当成中文（因为 -like 不区分大小写）。
  // 所以 key 必须一律小写，否则 client.js 的 startsWith 与 ps1 的 -like 会分歧。
  assert.equal(isZhLike('ZH-bad-case'), true,
    'PowerShell 的 -like 不区分大小写，大写 ZH- 也算中文 —— 因此 key 必须全小写，'
    + '且 client.js 的 indexOf("zh-") === 0 与 ps1 的 -like 才能一致');
});

// ── L9: 老用户向迁移（v0.5.3.1）─────────────────────────────────────────
//
// ## 这个 bug 是什么
// voiceLang 是 v0.5.3 新增字段，默认 'ja'。老用户配置里只有 voiceName，
// 没有 voiceLang。升级后如果直接按默认 'ja' 走，随机池会从「中日混播」
// 变成「只有日语」—— 对「选了中文音色」的用户来说是**比修复前更糟**的回退。
//
// ## 为什么必须调真实链路而不是写源码正则
// 第一版判据是对 lib/index.js 写 `/v0.5.3.1：老用户向迁移/` 这类文本断言。
// 那种判据在两个方向都会骗人：注释被改字就假红；代码被短路（比如把 if
// 条件改成 false）却因为文本还在而**恒绿**。踩坑 #469 就是这个形态。
// 所以把逻辑抽成可导出的纯函数，直接驱动行为。
//
// ⚠️ 第一版 L9 还犯了一个更隐蔽的错误：它直接调 `normalizeConfig({...})`，
// 而真实链路里 normalizeConfig 收到的是**已被 schema 层填过默认值**的对象。
// 于是「迁移写在 normalizeConfig 里」这个错误位置，在测试里完全看不出来 ——
// 测试绿、真实宿主一次都不执行。所以下面统一走 replayRefresh()（复刻真实链路）。

/**
 * 复刻真实链路的配置解析（lib/index.js 的插件入口 → refreshConfig）。
 *
 * ⚠️ 关键：最后一步调的是**生产代码自己导出的** `resolveEffectiveConfig`，
 * 不是在这里复刻迁移逻辑。第一版就是复刻的 —— 结果删掉生产代码里的调用，
 * 测试照样全绿（判据测的是副本，不是本体）。这类假绿比恒真断言更难发现。
 *
 * 仍然必须自己做的两步：
 *   · `entryFromSchema`：真实链路里它会**给所有缺失键填 FIELD_DEFAULTS**
 *   · `mergeConfig`：三层合并
 * 这两步不做，就跳过了「迁移到底有没有机会执行」这个关键问题。
 *
 * @param {object} patch cordis patch 传来的原始配置（用户写的，可能是 ref）
 * @param {object} fileValues $DSH_HOME/storages/.../config.json 里的值（用户写的）
 * @returns {Promise<object>} 最终生效的 cfg
 */
async function replayRefresh(patch, fileValues) {
  const { FIELD_DEFAULTS, readConfig: readSchemaConfig } = await import('../lib/config-schema.js');
  const { mergeConfig } = await import('../lib/config-store.js');
  const { resolveEffectiveConfig } = await import('../lib/index.js');

  // entryFromSchema：只有当输入里存在 schemastery ref 时才走 schema 层
  const looksLikeRefs = Object.keys(FIELD_DEFAULTS).some((k) => {
    const slot = patch && patch[k];
    return slot != null && typeof slot === 'object' && typeof slot.get === 'function';
  });
  const fromSchema = looksLikeRefs ? readSchemaConfig(patch) : null;

  const merged = mergeConfig(mergeConfig(patch, fromSchema || {}), fileValues || {});
  // ↓ 这里调生产代码，不复制逻辑
  return resolveEffectiveConfig(merged, patch, fileValues || {});
}

test('L9: 老用户没有 voiceLang 但用中文音色时，推断为 zh（不是退回 ja）', async () => {
  const cases = [
    // [说明, patch 层, config.json 层, 期望 voiceLang]
    ['老用户：中文音色 + 随机（无 voiceLang）', { voiceName: 'zh-soft-female', voiceMode: 'random' }, {}, 'zh'],
    ['老用户：另一种中文音色', { voiceName: 'zh-mid-male' }, {}, 'zh'],
    ['老用户：第三种中文音色', { voiceName: 'zh-low-male' }, {}, 'zh'],
    ['老用户：第四种中文音色', { voiceName: 'zh-clear-female' }, {}, 'zh'],
    // 显式选择必须被尊重 —— 迁移只在「config.json 里没有这个键」时生效。
    //
    // ⚠️ 全部放在**第二个参数（config.json 层）**：
    // 真机上 patch 的每个字段都是 ref、get() 恒返回 schema 默认值，
    // 无法表达「用户显式设置」。设置页写的也是 config.json，所以这才是真实写入位置。
    // 「patch 显式 ja」在真机不可达，已从用例里移除（见 L9c 的前提断言）。
    ['config.json 显式 ja + 中文音色（不能改）', { voiceName: 'zh-soft-female' }, { voiceName: 'zh-soft-female', voiceLang: 'ja' }, 'ja'],
    ['config.json 显式 zh + 日语音色（不能改）', { voiceName: 'zundamon-normal' }, { voiceName: 'zundamon-normal', voiceLang: 'zh' }, 'zh'],
    ['config.json 显式 zh + 中文音色（不必推断，保持）', { voiceName: 'zh-soft-female' }, { voiceName: 'zh-soft-female', voiceLang: 'zh' }, 'zh'],
    // 全新用户不能受影响
    ['全新用户（空配置）', {}, {}, 'ja'],
    ['日语音色 + 无 voiceLang', { voiceName: 'zundamon-normal' }, {}, 'ja'],
    // 音色来自 config.json 而不是 patch
    ['音色只在 config.json 里', {}, { voiceName: 'zh-low-male' }, 'zh'],
    // ── 下面两条钉住「语言标识只看前缀 + 大小写不敏感」 ──────────────────
    //
    // 为什么必须有：复核 P2 实测，把 startsWith 改成 includes、或去掉
    // toLowerCase，上面所有用例**仍然全绿**（漏掉 3 个变异体中的 2 个）。
    // 它们不红，是因为原有用例里 zh- 恰好都在开头且全是小写 —— 判据没有区分力。
    //
    // ① zh- 出现在中间但不是前缀 → 不是中文音色（挡 includes）
    ['前缀不是 zh-（中间含 zh-）→ 不算中文', { voiceName: 'namiine-zh-normal' }, {}, 'ja'],
    // ② 大写 ZH- 前缀 → 必须与 ps1 的 `-like 'zh-*'`（不区分大小写）同口径（挡去掉 toLowerCase）
    ['大写 ZH- 前缀 → 仍算中文（对齐 ps1 -like）', { voiceName: 'ZH-soft-female' }, {}, 'zh'],
  ];

  const bad = [];
  for (const [desc, patch, file, want] of cases) {
    const cfg = await replayRefresh(patch, file);
    if (cfg.voiceLang !== want) bad.push(`${desc}: 得到 ${cfg.voiceLang}，期望 ${want}`);
  }
  assert.deepEqual(bad, [],
    '老用户迁移失败：升级后随机池会从「中日混播」变成「只有日语」，'
    + '而这位用户明明选的是中文音色 —— 比修复前更糟。\n' + bad.join('\n'));
});

// ── L9b: 反向证明 L9 不是恒真空跑 ─────────────────────────────────────────
//
// L9 断言的是「一批输入都得到期望值」。如果迁移根本没执行，那么「显式 ja」
// 「空配置」「日语音色」这几条照样过 —— L9 仍会绿。必须有一条断言专门证明
// **迁移分支确实被执行过**，否则 L9 只是半个空过滤（踩坑 #469 的形态）。
test('L9b: 迁移分支确实生效 —— 同一个音色，有没有 voiceLang 结果不同', async () => {
  const { normalizeConfig } = await import('../lib/index.js');

  // 最关键的对照：两边**只差 config.json 里的一个 voiceLang 键**。
  // 若迁移不存在，两者都应是 'ja'，这条就会红。
  //
  // ⚠️ 显式值必须放在 config.json 层（第二个参数），不能放在 patch 层：
  // 真机上 patch 的每个字段都是 ref，其 get() 恒返回 schema 默认值，
  // 无法表达「用户显式设置」。见 L9c 的前提断言。
  const withoutKey = await replayRefresh({ voiceName: 'zh-soft-female' }, { voiceName: 'zh-soft-female' });
  const withExplicitJa = await replayRefresh(
    { voiceName: 'zh-soft-female' },
    { voiceName: 'zh-soft-female', voiceLang: 'ja' },
  );

  assert.equal(withoutKey.voiceLang, 'zh',
    'config.json 里没有 voiceLang 时，应从中文音色推断出 zh');
  assert.equal(withExplicitJa.voiceLang, 'ja',
    '显式写 ja 时必须保持 ja（迁移不能覆盖用户选择）');
  assert.notEqual(withoutKey.voiceLang, withExplicitJa.voiceLang,
    '两者结果必须不同 —— 若相同，说明迁移分支根本没执行（或判断条件写反），'
    + 'L9 里的「显式 ja」用例是靠默认值碰巧过的，不是靠逻辑过的');

  // ⚠️ 附加：证明「只调 normalizeConfig 是不够的」。
  // 这条钉住迁移**不在** normalizeConfig 里 —— 否则有人把它挪回去，
  // 真实宿主又会静默失效（schema 层已把 voiceLang 填成 'ja'）。
  const onlyNormalize = normalizeConfig({ voiceName: 'zh-soft-female' });
  assert.equal(onlyNormalize.voiceLang, 'ja',
    'normalizeConfig 单独调用时必须仍是 ja —— 这是设计约束：'
    + '它拿到的输入已被 schema 层填过默认值，迁移只能在其后（refreshConfig 层）做。'
    + '若这条变红，说明有人把迁移挪回了 normalizeConfig，真实宿主会失效。');
});

// ── L9c: 真机形态 —— 宿主把**全部字段**包成 ref，值来自 schema 默认填充 ─────
//
// ## 这条为什么重写过（2026-10-24，复核 P1/P2）
//
// 上一版用的是 `ref = (v) => ({ get: () => v })`，**只放一个键**。
// 真机不是这样：schema 存在时宿主把 **59 个字段全部**包成 ref，
// 且 `voiceLang.get()` 返**恒返回 schema 默认值 `'ja'`**，
// 与我们有没有显式设置无关（实测「显式 ja」与「没设」两份 ref 逐字段完全相同）。
//
// 于是上一版 L9c 是一个**假 ref 掩盖了真 bug**：它测的形态在真机不存在。
// 现在的 L9c 复刻真机形态，并明确钉住「无法区分」这个事实。
test('L9c: 真机形态（全字段 ref + 默认填充）下，迁移仍按 config.json 判断', async () => {
  // 复刻宿主：所有字段都在，值=「用户显式设置 或 schema 默认值」。
  // 真机无法从 ref 本身分辨这两种来源 —— 这正是 P1 的根因。
  const DEFAULTS = {
    voice: 'bundled', voiceMode: 'random', voiceName: 'zundamon-normal',
    volume: 80, voiceLang: 'ja',
  };
  const hostSnapshot = (explicit = {}) => {
    const snap = {};
    for (const k of Object.keys(DEFAULTS)) {
      const v = Object.prototype.hasOwnProperty.call(explicit, k) ? explicit[k] : DEFAULTS[k];
      snap[k] = { get: () => v };
    }
    return snap;
  };

  // ① 最关键的证明：显式 ja 与没设，两种 ref 完全等价 —— 所以判据不能看 patch。
  const explicitJaRef = hostSnapshot({ voiceLang: 'ja' }).voiceLang;
  const notSetRef = hostSnapshot({}).voiceLang;
  assert.deepEqual(
    { props: Object.getOwnPropertyNames(explicitJaRef), val: explicitJaRef.get() },
    { props: Object.getOwnPropertyNames(notSetRef), val: notSetRef.get() },
    '前提变了：如果真机能区分「显式 ja」与「没设」，那 inferLegacyVoiceLang 就'
    + '可以改回同时看 patch 层。这条先钉住当前事实 —— 两者不可区分。',
  );

  // ② 老用户：中文音色 + config.json 无 voiceLang → 必须迁移成 zh。
  //    注意 patch 是「全字段 ref」形态，voiceLang ref 的 get() 返回默认 ja。
  const legacy = await replayRefresh(
    hostSnapshot({ voiceName: 'zh-soft-female' }),
    { voiceName: 'zh-soft-female' },
  );
  assert.equal(legacy.voiceLang, 'zh',
    '真机形态下迁移必须生效 —— 判据只能看 config.json，'
    + '因为 patch 里的 voiceLang ref 恒返回 schema 默认值 ja。');

  // ③ 用户在 config.json 里显式设了 ja → 尊重，不迁移
  const explicitJaFile = await replayRefresh(
    hostSnapshot({ voiceName: 'zh-soft-female' }),
    { voiceName: 'zh-soft-female', voiceLang: 'ja' },
  );
  assert.equal(explicitJaFile.voiceLang, 'ja',
    'config.json 里显式写了 ja 必须被尊重 —— 那是用户真正写下的值，没有 schema 填充。');

  // ④ 用户在 config.json 里显式设了 zh → 保持
  const explicitZhFile = await replayRefresh(
    hostSnapshot({ voiceName: 'zundamon-normal' }),
    { voiceLang: 'zh' },
  );
  assert.equal(explicitZhFile.voiceLang, 'zh',
    'config.json 里显式写 zh 时必须保持，不能被音色反推覆盖。');

  // ⑤ 全新用户（config.json 空）→ ja，不受影响
  const fresh = await replayRefresh(hostSnapshot({}), {});
  assert.equal(fresh.voiceLang, 'ja', '全新用户必须仍是默认 ja。');
});

// ── L9d: 真跑 computeEffectiveConfig —— 合并顺序与迁移接线一起验 ─────────
//
// ## 这条为什么重写过（2026-10-25 第三份独立复核）
//
// 上一版只对源码做 `body.includes('resolveEffectiveConfig(')` —— **形状断言**。
// 复核实测下面五种坏写法都能让它全绿，而真实行为已经坏掉（-Lang 恒为 ["ja"]）：
//   · 调用后丢弃结果
//   · 塞进 `if (false) … else cfg = normalizeConfig(merged)`
//   · 整行注释掉
//   · 传错参数（把 fromSchema 当 fileValues）
//   · mergeConfig 顺序对调
// 只有「整行删除」能红。也就是说它当时是**半个空过滤**。
//
// 现在合并与迁移都收进导出的 computeEffectiveConfig，测试直接驱动生产代码：
// 任何一条坏写法都会改变返回值，因而必然报红。
test('L9d: computeEffectiveConfig 必须真的把三层合并结果与迁移都用上', async () => {
  const { computeEffectiveConfig } = await import('../lib/index.js');
  const { FIELD_DEFAULTS } = await import('../lib/config-schema.js');

  // 复刻真机形态：全字段 ref，voiceLang 的 get() 恒返回 schema 默认 ja
  const hostPatch = (overrides = {}) => {
    const out = {};
    for (const k of Object.keys(FIELD_DEFAULTS)) {
      const v = Object.prototype.hasOwnProperty.call(overrides, k) ? overrides[k] : FIELD_DEFAULTS[k];
      out[k] = { get: () => v };
    }
    return out;
  };
  const fromSchemaOf = (patch) => {
    const out = {};
    for (const k of Object.keys(FIELD_DEFAULTS)) out[k] = patch[k].get();
    return out;
  };

  const problems = [];

  // ① 迁移必须生效：老用户（config.json 无 voiceLang、中文音色）→ zh
  {
    const patch = hostPatch({ voiceName: 'zh-soft-female' });
    const got = computeEffectiveConfig(patch, fromSchemaOf(patch), { voiceName: 'zh-soft-female' });
    if (got.voiceLang !== 'zh') {
      problems.push(`老用户应为 zh，实际 ${got.voiceLang} —— `
        + '若为 ja，说明迁移结果被丢弃，或 computeEffectiveConfig 没走到 resolveEffectiveConfig');
    }
    // 同时确认合并结果真的进来了（不是返回一个全新对象把输入全忽略）
    if (got.voiceName !== 'zh-soft-female') {
      problems.push(`合并结果丢失：voiceName 应为 zh-soft-female，实际 ${got.voiceName}`);
    }
  }

  // ② 合并顺序必须对：fileValues 覆盖 fromSchema，fromSchema 覆盖 patch
  {
    const patch = hostPatch({ voiceName: 'zundamon-normal', volume: 80 });
    const fromSchema = fromSchemaOf(patch);
    fromSchema.volume = 55;               // schema 层改成 55
    const got = computeEffectiveConfig(patch, fromSchema, { volume: 33 });
    if (got.volume !== 33) {
      problems.push(`合并顺序错：fileValues(33) 应覆盖 schema(55)，实际 ${got.volume}`
        + ' —— 若为 55 说明 fileValues 没放最后，若为 80 说明 schema 层被丢掉了');
    }
  }

  // ③ 用户显式选择必须被尊重（不能被迁移覆盖）
  {
    const patch = hostPatch({ voiceName: 'zh-soft-female' });
    const got = computeEffectiveConfig(patch, fromSchemaOf(patch),
      { voiceName: 'zh-soft-female', voiceLang: 'ja' });
    if (got.voiceLang !== 'ja') {
      problems.push(`config.json 显式 ja 应保持 ja，实际 ${got.voiceLang}`
        + ' —— 说明迁移覆盖了用户选择');
    }
  }

  // ④ 全新用户不受影响
  {
    const patch = hostPatch({});
    const got = computeEffectiveConfig(patch, fromSchemaOf(patch), {});
    if (got.voiceLang !== 'ja') {
      problems.push(`全新用户应为默认 ja，实际 ${got.voiceLang}`);
    }
  }

  assert.deepEqual(problems, [], problems.join('\n'));
});

// L9e：refreshConfig() 抛异常时的首帧配置。
//
// 真实缺口（自查发现）：插件入口函数里先 `let cfg = <初始值>`，再 `refreshConfig()`。
// refreshConfig 的 catch 分支是「保持上一次的值」—— 首次调用时「上一次的值」
// 就是那行初始值。若初始值直接写 `normalizeConfig(config)`，老用户在
// entryFromSchema()/readConfig() 抛异常时会**整个进程生命周期**停在未迁移状态，
// 随机池只剩日语 —— 恰好是本次要修的那个回退。
//
// 这类「异常路径」不会被任何正常链路测试覆盖，只能直接钉源码写出法。
test('L9e: 首帧配置也必须走迁移（refreshConfig 抛异常时不会退回未迁移状态）', () => {
  const src = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');

  // 1) 找到插件入口里那行初始化，确认它把 config 传给了 resolveEffectiveConfig
  const initRe = /let cfg = ([^;]+);/g;
  const inits = [...src.matchAll(initRe)].map((m) => m[1].trim());
  assert.ok(inits.length > 0, '应能找到 `let cfg = ...` 初始化');

  const bad = inits.filter((expr) => expr.includes('normalizeConfig(')
    && !expr.includes('resolveEffectiveConfig('));
  assert.deepEqual(bad, [],
    '首帧配置不能只调 normalizeConfig —— refreshConfig 抛异常时 cfg 会停在这里，'
    + '老用户（中文音色、无 voiceLang）整个进程都拿不到迁移结果。\n'
    + '正确写法：resolveEffectiveConfig(normalizeConfig(config), config, {})');

  // 2) 反向证明：至少有一处初始化确实带了迁移（否则上面那条断言是空过滤）
  const good = inits.filter((expr) => expr.includes('resolveEffectiveConfig('));
  assert.ok(good.length >= 1,
    '应至少有一处 `let cfg = resolveEffectiveConfig(...)` —— '
    + '若这句也没有，说明上面那条"不许只调 normalizeConfig"是恒真空过滤');
});

// ── L9f: 端到端 —— 真跑 apply()，看它到底给 ps1 传了哪个 -Lang ────────────
//
// ## 这条为什么必须存在（2026-10-25 第三份独立复核的最强一击）
//
// L9d 改完后我写了 attack-l9d.mjs 复现复核报的 5 种坏写法，结果
// **只抓住 1 种（mergeConfig 顺序对调）**，另外 3 种全逃逸：
//   A1 调用后丢弃结果            → fail=0 没抓住
//   A2 塞进 if(false) 的 else    → fail=0 没抓住
//   A3 传错参数（fromSchema 当 fileValues）→ fail=0 没抓住
//
// 原因很直白：这三个变异改的是 **refreshConfig 里的调用点**，
// 而 L9d 直接调 computeEffectiveConfig，根本不经过那里。
// 也就是说「把缺口从 A4 挪到了 A1/A2/A3」，并没有真补上。
//
// 唯一能同时抓住它们的判据，是**真跑 apply()**、看它把什么交给 ps1。
// 仓库里已有现成装置：`test/stub-child-process.mjs` 这个 ESM loader
// 把 `node:child_process` 换成记录型假实现（spawn 只往
// `globalThis.__SPAWN_CALLS` 推记录，不起进程、不出声、不弹 Toast）。
//
// 它只能通过 `--import ./test/route-loader-register.mjs` 装，
// 所以本条在默认套件里 skip，由 `npm run test:all` 的 route 段执行。
test('L9f: 真跑 apply() —— 老用户（中文音色无 voiceLang）必须给 ps1 传 -Lang zh', {
  skip: process.env.DSH_ROUTE_LOADER === '1'
    ? false
    : '需 npm run test:all（route 段带 --import loader）；默认 node --test 跳过',
}, async () => {
  if (globalThis.__STUB_CHILD_PROCESS__ !== true) {
    assert.fail('loader stub 未生效 —— 本条的断言会变成看空气，必须先跑 npm run test:all');
  }

  const { apply } = await import('../lib/index.js');

  /** 造最小 ctx 替身（与 test/fail-route.test.mjs 同一套，漏一个 apply 就会抛）。 */
  const mkCtx = () => {
    const handlers = new Map();
    return {
      on(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); },
      get() { return undefined; },
      effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
      emit(name, ...args) { for (const fn of handlers.get(name) || []) fn(...args); },
    };
  };

  const agentOf = (id) => ({ id, status: 'idle', session: { id, header: { id } } });

  /** 跑一次「turn/end(done) + agent running→idle」，返回本次 spawn 收到的 -Lang。 */
  const langsOf = (config) => {
    const agent = agentOf('sess-l9f');
    const ctx = mkCtx();
    globalThis.__SPAWN_CALLS = [];
    apply(ctx, config);
    ctx.emit('session/event', agent.session,
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
    ctx.emit('agent/status', { agent, status: 'running' });
    ctx.emit('agent/status', { agent, status: 'idle' });

    const out = [];
    for (const c of globalThis.__SPAWN_CALLS || []) {
      const args = Array.isArray(c.args) ? c.args : [];
      const i = args.indexOf('-Lang');
      if (i >= 0 && i + 1 < args.length) out.push(String(args[i + 1]));
    }
    return out;
  };

  const problems = [];

  // ① 老用户：中文音色 + config.json 里没有 voiceLang → 必须传 zh
  //
  // 真机形态：宿主先把 patch 过一遍 schema，voiceLang 变成 ref 且 get() 恒为 'ja'；
  // 迁移只能看 config.json。fileValues 来自隔离 home（见文件头的 DSH_HOME 隔离），
  // 这里写进去的就是"用户配置"。
  {
    clearIsolatedConfig();
    writeIsolatedConfig({ voiceName: 'zh-soft-female', voiceMode: 'random' });
    const langs = langsOf({ idleGate: false, subagents: false, voice: true, volume: 0,
      voiceMode: 'random', voiceName: 'zh-soft-female' });
    if (langs.length === 0) {
      problems.push('①没记录到任何 -Lang —— 播报链路没跑起来，本判据无意义');
    } else if (!langs.includes('zh')) {
      problems.push(`①老用户（中文音色无 voiceLang）应传 -Lang zh，实际 ${JSON.stringify(langs)}`
        + ' —— 说明 refreshConfig 里的调用被丢弃/短路/传错参数，或迁移没走到');
    }
  }

  // ② 显式 ja 必须尊重（迁移不能盖掉用户选择）
  {
    clearIsolatedConfig();
    writeIsolatedConfig({ voiceName: 'zh-soft-female', voiceMode: 'random', voiceLang: 'ja' });
    const langs = langsOf({ idleGate: false, subagents: false, voice: true, volume: 0,
      voiceMode: 'random', voiceName: 'zh-soft-female', voiceLang: 'ja' });
    if (langs.length === 0) {
      problems.push('②没记录到任何 -Lang');
    } else if (langs.includes('zh')) {
      problems.push(`②显式 voiceLang=ja 时应传 ja，实际 ${JSON.stringify(langs)}`
        + ' —— 说明迁移覆盖了用户显式选择');
    }
  }

  // ③ 全新用户不受影响
  {
    clearIsolatedConfig();
    const langs = langsOf({ idleGate: false, subagents: false, voice: true, volume: 0 });
    if (langs.length === 0) {
      problems.push('③没记录到任何 -Lang');
    } else if (langs.includes('zh')) {
      problems.push(`③全新用户应为默认 ja，实际 ${JSON.stringify(langs)}`);
    }
  }

  clearIsolatedConfig();
  assert.deepEqual(problems, [], problems.join('\n'));
});
