/**
 * 文档一致性测试（v0.4.29）。
 *
 * ## 为什么需要
 *
 * 2026-10-18 外部审阅指出两处文档漂移：
 *   · `docs/待做清单.md` 还停在 v0.4.24，里面列着已经修完的事项
 *   · 审核记录里有个 `ankokon`，实际音色 key 是 `ankomon`
 *
 * 这类错误不影响功能，但会误导读者 —— 而且**只要没人看就永远发现不了**。
 * 审阅者建议「用测试或校验脚本预防」，这个文件就是那个脚本。
 *
 * ## 检查什么
 *
 * 1. 文档里提到的音色 key 必须真实存在（拼写漂移）
 * 2. 待做清单的"最后更新"版本不能落后太多（进度漂移）
 * 3. 内部文档不得含本机绝对路径（发布物卫生）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/**
 * 惰性取 fs.globSync —— 它是 Node 22.0 才有的导出。
 *
 * ⚠️ 不能写成静态 import：Node 20 上整个模块会在求值前加载失败
 * （`SyntaxError: The requested module 'node:fs' does not provide an export
 * named 'globSync'`），外层 try/catch 一条断言都拦不住 —— 这正是 0.5.2 起
 * GitHub Actions「单元测试（Node 20）」连红四次的原因（0.5.2 / 0.5.3 /
 * 0.5.7 / 0.5.8 全中；本机 Node 24 看不到，所以一直没被发现）。
 *
 * 与 test/reload-verification.test.mjs 对 registerHooks 的处理同一套做法：
 * 运行时按需取，取不到就落保守分支。
 */
let _globSync;
function getGlobSync() {
  if (_globSync !== undefined) return _globSync;
  try {
    const fsMod = createRequire(import.meta.url)('node:fs');
    _globSync = typeof fsMod.globSync === 'function' ? fsMod.globSync : null;
  } catch {
    _globSync = null;
  }
  return _globSync;
}

/** 磁盘上真实存在的音色 key（从 sounds/voice-lines 推）。 */
function realVoiceKeys() {
  const base = join(ROOT, 'sounds', 'voice-lines');
  const keys = new Set();
  if (!existsSync(base)) return keys;

  const scan = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) { scan(join(dir, e.name)); continue; }
      if (!e.name.toLowerCase().endsWith('.wav')) continue;
      const k = e.name
        .replace(/\.wav$/i, '')
        .replace(/~\d+$/, '')
        .replace(/-(?:extra|kansai)-\d+$/, '');
      if (k) keys.add(k);
    }
  };
  scan(base);
  return keys;
}

// ── D1: 审核记录里的音色 key 必须真实存在 ───────────────────────────────
test('D1: docs/audio-audit/README.md 提到的音色 key 都真实存在', () => {
  const f = join(ROOT, 'docs', 'audio-audit', 'README.md');
  if (!existsSync(f)) return;

  const real = realVoiceKeys();
  if (real.size === 0) return;   // 发布包里只有 1 个音色也可能，跳过

  const md = readFileSync(f, 'utf8');

  // 抓「反引号包裹的、形如音色 key 的标识」
  // 音色 key 的特征：小写字母开头，含 - 或纯字母，长度 >= 4
  const candidates = new Set();
  for (const m of md.matchAll(/`([a-z][a-z0-9-]{3,})`/g)) {
    const k = m[1];
    // 排除明显不是音色 key 的（文件名、命令、配置键）
    if (/\.(md|js|mjs|ps1|json|wav|txt|yml)$/.test(k)) continue;
    if (k.startsWith('my-')) continue;          // 个人声音不参与公开清单
    if (['node-test', 'test-all', 'test-route'].includes(k)) continue;
    candidates.add(k);
  }

  // 只校验"看起来像音色 key"的：全部小写 + 含连字符
  const suspect = [...candidates].filter((k) => {
    if (real.has(k)) return false;
    return /^[a-z]+(?:-[a-z0-9]+)+$/.test(k);
  });

  // 允许一些通用词
  const allowed = new Set(['third-party', 'audio-audit', 'not-recorded']);
  const bad = suspect.filter((k) => !allowed.has(k));

  // ⚠️ 发布包只带 1 个音色（10 个 wav），而审核文档列了 13 个。
  // 直接断言"文档里每个 key 都必须在磁盘上"会在发布包里必然失败 ——
  // 那是"测试假设了开发环境"，不是文档真的拼错了。
  //
  // 正确判据：**只校验发布包实际拥有音色的那个子集**。
  // 没有的音色无法在此环境验证，跳过（不算通过，只是不阻塞）。
  //
  // 但拼写漂移仍能被抓到：如果某个 key 在文档里写错，
  // 而正确拼写在磁盘上存在，那个错的就不在任何子集里 —— 无法区分。
  // 所以这里加一条补充：磁盘上有的音色，文档里若出现"近似拼写"
  // （只差一个后缀段）就报出来。
  const installed = real.size;
  if (installed >= 10) {
    // 开发环境：全部校验
    assert.deepEqual(bad, [],
      '这些 key 在文档里出现但磁盘上没有对应音色（可能是拼写漂移）：\n  '
      + bad.join('\n  '));
    return;
  }

  // 发布环境（音色很少）：只检查"磁盘上有、但文档里写成近似但不同"的
  const nearMiss = [];
  for (const key of real) {
    for (const s of bad) {
      // 一个是另一个的前缀（如 manbetsu-hanamaru vs -genki）
      if (key.startsWith(s) || s.startsWith(key)) {
        if (key !== s) nearMiss.push(`${s} vs ${key}`);
      }
    }
  }
  assert.deepEqual(nearMiss, [],
    '文档里的写法与磁盘上的音色 key 近似但不一致（疑似漏写后缀）：\n  '
    + nearMiss.join('\n  '));
});

// ── D2: 待做清单的更新版本不能落后于 package.json ───────────────────────
test('D2: docs/待做清单.md 的版本不落后于 package.json', () => {
  const f = join(ROOT, 'docs', '待做清单.md');
  if (!existsSync(f)) return;

  const md = readFileSync(f, 'utf8');
  const m = /最后更新[：:]\s*\d{4}-\d{2}-\d{2}[（(]v?([\d.]+)[）)]/.exec(md);
  if (!m) {
    // 没写版本号也算不漂移（只是格式不同）
    return;
  }
  const docVer = m[1];
  const pkgVer = PKG.version;

  const cmp = (a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    }
    return 0;
  };

  // 允许文档比包版本落后 1 个补丁号（写文档有滞后是合理的）；
  // 落后 2 个以上说明"改完没回头更新"，那才是漂移。
  const behind = cmp(pkgVer, docVer);
  assert.ok(behind <= 1,
    `待做清单停在 v${docVer}，而包已经是 v${pkgVer} —— `
    + '落后超过 1 个补丁号说明改完没回头更新（外部审阅已指出过一次）');
});

// ── D3: 公开文档不得含本机绝对路径 ──────────────────────────────────────
test('D3: docs/ 下的文档不含本机绝对路径', () => {
  const docsDir = join(ROOT, 'docs');
  if (!existsSync(docsDir)) return;

  const offenders = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!/\.(md|ps1|mjs|js|json|txt)$/i.test(e.name)) continue;
      const text = readFileSync(full, 'utf8');
      // 本机路径特征：盘符 + 已知开发目录
      if (/[A-Z]:\\+(?:0Deepseek|Codex|Users\\+audio)/i.test(text)) {
        offenders.push(full.replace(ROOT, '.'));
      }
    }
  };
  walk(docsDir);

  assert.deepEqual(offenders, [],
    '文档里出现本机绝对路径 —— 发布物是公开的，别人拿去跑不通：\n  '
    + offenders.join('\n  '));
});

// ── D4: THIRD-PARTY-NOTICES 必须给出可点的官方链接 ──────────────────────
test('D4: 第三方声明含官方条款链接（不能只有口头说明）', () => {
  const f = join(ROOT, 'THIRD-PARTY-NOTICES.md');
  if (!existsSync(f)) return;
  const md = readFileSync(f, 'utf8');

  assert.match(md, /https:\/\/voicevox\.hiroshiba\.jp\/term/,
    '必须给出 VOICEVOX 官方条款链接 —— 用户需要能自己核对');
  assert.match(md, /https:\/\/zunko\.jp\//,
    '必须给出ずんずんプロジェクト条款链接');
  // 绝不能把第三方音频说成 MIT/CC0
  assert.doesNotMatch(md, /语音.{0,8}(?:MIT|CC0).{0,8}(?:发布|许可)/,
    '不得声称语音文件以 MIT/CC0 发布 —— 我们无权变更第三方素材的许可');
});

// ── D5: 重载漏报诊断必须存在（排查"没听到播报"的第一手信号）────────────
test('D5: index.js 有重载漏报诊断', () => {
  const INDEX = readFileSync(join(ROOT, 'lib', 'index.js'), 'utf8');

  assert.match(INDEX, /EVENT_COUNTER_KEY/,
    '应有跨实例的事件计数器（重载后新模块读不到旧变量，必须用 globalThis）');
  assert.match(INDEX, /function bumpEventCount/,
    '应有计数入口');
  assert.match(INDEX, /bumpEventCount\(\)/,
    'session/event 处理器里应真的调用它');
  assert.match(INDEX, /重载窗口内/,
    '重载后应打印漏报提示，否则排查时无法区分"事件没进来"和"进来了没播"');

  // 计数器必须挂在 globalThis：模块级变量在重载后会重置，就失去意义
  assert.match(INDEX, /Symbol\.for\('dsh-notify-say\.eventCount'\)/,
    'key 应带插件名（避免与其它插件冲突）');
});
// ══ 打包与变更记录（v0.4.45）════════════════════════════════════════════
//
// ⚠️ 一个重要区别：`tools/release-build.ps1` 是**维护者工具**，
// 不随发布包分发（发布包的 tools\ 里只有 notify-config.ps1）。
// 所以检查它的那些断言在发布包里必须 skip，否则 CI 必然红。
//（v0.4.45 首跑 CI 就是这么红的：D6/D7/D8 去读一个不存在的文件。）
const RELEASE_BUILD = join(ROOT, 'tools', 'release-build.ps1');
const hasReleaseBuild = existsSync(RELEASE_BUILD);
const SKIP_DEVONLY = hasReleaseBuild ? false : 'release-build.ps1 是维护者工具，不在发布包内';

// ── release-build.ps1 白名单的锚点（D19 / D19b / D19c 共用）────────────────
//
// 必须是**行首锚定**（`^[ \t]*…` + `m` 标志）：
//   · 不用 `\bfiles` —— `$` 与 `f` 之间也是词边界，脚本里写一句
//     `$files = @(...)` 就命中诱饵了（2026-10-23 审查实测）；
//   · 不用含对齐空格的字符串字面量 —— 别人重排格式就失配、假红；
//   · `[ \t]*` 允许 `files       = @(` 这种为对齐打过空格的历史写法。
const ANCHOR_INCLUDE_FILES = /^[ \t]*\$includeFiles[ \t]*=[ \t]*@\(/m;
const ANCHOR_INCLUDE_DIRS = /^[ \t]*\$includeDirs[ \t]*=[ \t]*@\(/m;
const ANCHOR_INCLUDE_TOOLS = /^[ \t]*\$includeTools[ \t]*=[ \t]*@\(/m;
const ANCHOR_NPM_FILES = /^[ \t]*files[ \t]*=[ \t]*@\(/m;
// files 数组的**结束边界**：用来把「files 数组那一段」精确切出来做变异，
// 避免在整份文件里 replaceFirst 打到 $includeDirs 里同名的 'lib',（实测踩过）。
const ANCHOR_NPM_KEYWORDS = /^[ \t]*keywords[ \t]*=[ \t]*@\(/m;

/**
 * 有意**只进 GitHub、不进 npm** 的目录 → 理由。
 *
 * 加进这张表的代价是：npm 用户拿不到该目录。所以每一条都必须写清为什么 ——
 * 理由长度有下限（REASON_MIN），防的是"随手写个 x 糊过去"，那等于没有判据。
 * D19c 的自检会要求：表里的键仍在 $includeDirs（防陈旧）、不在 files（防矛盾）。
 */
const NPM_DIR_EXCLUSIONS = new Map([
  ['docs',
    'docs/audio-audit/snapshots 存的是各权利人官网条款全文，不适合随 npm 分发；'
    + '安装包里只放 THIRD-PARTY-NOTICES.md（署名 + 官方链接）'],
  ['.github',
    'CI 工作流只在 GitHub 侧需要，装插件的用户用不到'],
]);

/**
 * 由**专门复制逻辑**带走、因此不写在 $includeDirs 里、但要出现在 files 里的目录。
 *
 * 不加这张表，D19c 的反向判据会把它们当成"来源不明的目录"。表里同样要写理由。
 */
const DEDICATED_COPY_DIRS = new Map([
  ['sounds',
    'release-build.ps1 单独复制 sounds\\（音色包体积大，走独立复制与裁剪，'
    + '只带默认音色 + 中文音色）'],
  ['tools',
    '$includeTools 只挑 tools\\notify-config.ps1；release-build.ps1 自己是维护者工具，不发布'],
]);

/**
 * files 白名单里**源目录中本就不存在**的条目 —— 由构建过程生成。
 *
 * 为什么要单独一张表，而不是简单地"不存在就跳过"：
 * 最初 D19c 的 B 组用 `existsSync(abs) && isDirectory()` 过滤，结果**拼错的目录名
 * 也一起被跳过了**（实测：files 里写 `'libb'` → problems=[] 全绿）。那正是
 * "npm pack 静默丢弃缺失条目、无 warning、exit 0" 的入口。
 *
 * 所以改成三类显式归类：存在的目录 → 查 A/DEDICATED 表；存在的文件 → 放行；
 * **不存在** → 必须在这张表里，否则报"拼错或漏提交"。往这张表里加东西时，
 * 也得写清它由谁生成。
 */
const BUILD_GENERATED_ENTRIES = new Map([
  ['CHANGELOG.md',
    'release-build.ps1 从 git log 生成（见脚本里「生成 CHANGELOG」那段），'
    + '源目录刻意不存这个文件，避免两个来源'],
]);

/** 排除/专门复制理由的最短长度，防敷衍。 */
const REASON_MIN = 15;

/**
 * `release-build.ps1` 两份白名单的**当前项数**（单一事实源）。
 *
 * 为什么单独抽出来：第五轮复核查出 D19b 用 `>= 9 / >= 15`（下限）而 D19f 用
 * `=== 9 / === 15`（精确），两处各写一份数字、口径还不一致 ——
 * 加一条条目时 D19f 红、D19b 不红，于是"只改一处"就能让报错消失，
 * 数字到底该是多少从此没人对得上。改数字必须动这里一处。
 *
 * 两份白名单各自管什么：
 *   `$includeFiles` — 会被**逐个复制**进发布目录的单文件；
 *   `package.json` 的 `files` — npm 打包时**真正会带上**的东西。
 * 两者必须一致（D19b 正向 + D19c 反向），项数也是两边一起变。
 */
const WHITELIST_COUNTS = Object.freeze({
  includeFiles: 9,
  npmFiles: 15,
});

/**
 * 从 PowerShell 源码里取出某个数组块中的**字符串字面量条目**。
 *
 * 用途：校验 release-build.ps1 的**特定一份**白名单，而不是"文件里某处出现过
 * 这个字符串"。2026-10-23 的 D19 就是因为后者而假绿 —— 它在 $includeFiles 里
 * 命中了，于是 npm 的 files 白名单漏了同一条也照样通过。
 *
 * ⚠️ 2026-10-23 二次修：上一版是"先按行剥 `#`，再按字符数括号"。它被四类真实
 * 写法骗过（只读审查端到端复现，其中一类是「npm 包里真的没有 .gitattributes
 * 而全量测试 563/537/0 fail 全绿」—— 也就是本函数要防的事故仍然发生）：
 *   · 多行块注释 `<# … '.gitattributes' … #>`：剥行内注释只认 `#`，块注释
 *     开着的时候里面的引号仍被抽成条目 → 假绿；
 *   · 双引号条目 `"x.ps1"`：只 matchAll 单引号 → 静默丢弃 → 假绿；
 *   · 行内注释里有不配对的 `)`（`# 见 CARD) 内部资料`）：括号配平提前收尾
 *     → 其后条目全部消失 → 假红，且报错说"你漏了 .gitattributes"（方向指错）；
 *   · 块注释里提到一个不存在的文件：被当成真条目 → 假红。
 *
 * 所以改成**单次状态机扫描**：区分「单引号串（`''` 转义）/ 双引号串 / 行注释 /
 * 块注释」，括号只在字符串外、注释外计数，条目只从数组**顶层**的字符串字面量取。
 * 锚点一律用行首锚定正则，避免 `$files = @(...)`、注释里的 `# files = @(...)`
 * 这类诱饵命中。
 *
 * 仍不覆盖（如实写明，别假装全盖）：`$arr += @(...)` 这类追加写法；数组里放
 * 变量或表达式；here-string。当前 release-build.ps1 都没有这些写法。
 *
 * @param {string} src  release-build.ps1 全文
 * @param {RegExp} anchor  数组赋值的匹配模式，**必须是带 `m` 标志的行首锚定
 *   正则**。用含空格的字符串字面量（如 `'files       ='`）会在别人重排格式时
 *   失配而假红，报错还指错方向。
 * @returns {string[]|null} 条目（去引号、去空白）；**解析失败返回 null**
 *   （与"解析成功但数组为空"区分开，调用方必须先判 null 再判内容）
 */
/**
 * 把 PowerShell 源码里的**注释内容抹成空格**，保持长度与换行不变。
 *
 * 为什么必须有这一步（2026-10-23 第二轮只读审查实测抓出来的 P1）：
 * 锚点是 `/^[ \t]*files[ \t]*=[ \t]*@\(/m` 这样的行首正则，它只认「这一行以
 * `files = @(` 开头」。于是**行注释**里的诱饵挡住了（`# files = @(` 行首是 `#`），
 * 但**块注释**里的诱饵完全挡不住 —— `<#` 那一行的行首是 `<#`，而块注释**内部**
 * 的那些行，行首就是 `files = @(` 本身。审查的复现方式是：在文件头 `<# … #>`
 * 里插一段一模一样的 files 数组（含 `.gitattributes`），再把真实数组里那条删掉 →
 * D19 / D19b / D19c / D19f **全部假绿**，只有 D19d 因为变异打在第一处才红。
 * 也就是说 v0.5.1 的事故形态在新判据下**仍然可以复发**。
 *
 * 所以：先在「去注释视图」上找锚点，再回到原文用状态机取值。两者下标一一对应
 * （抹成空格而不是删除），因此不会错位。
 *
 * 已知边界：here-string（`@" … "@`）里若出现 `files = @(` 仍会被当成锚点 ——
 * 当前 release-build.ps1 没有 here-string，如实写明而不假装覆盖。
 */
function maskComments(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    // 字符串整体跳过（串里的 `#` 不是注释、`'` 也不是结束）
    if (ch === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "'") {
          if (src[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j += 1;
      }
      i = j + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '`') { j += 2; continue; }
        if (src[j] === '"') {
          if (src[j + 1] === '"') { j += 2; continue; }
          break;
        }
        j += 1;
      }
      i = j + 1;
      continue;
    }

    // 块注释（必须先于行注释：`<#` 里也含 `#`）
    if (ch === '<' && src[i + 1] === '#') {
      const close = src.indexOf('#>', i + 2);
      const end = close < 0 ? src.length : close + 2;
      blank(i, end);
      i = end;
      continue;
    }
    // 行注释：到行尾（不含换行本身）
    if (ch === '#') {
      const nl = src.indexOf('\n', i);
      const end = nl < 0 ? src.length : nl;
      blank(i, end);
      i = end;
      continue;
    }

    i += 1;
  }

  return out.join('');
}

function arrayBlockEntries(src, anchor) {
  // 锚点必须在「注释已抹掉」的视图上找 —— 否则块注释里的诱饵会让整条判据假绿
  const masked = maskComments(src);

  // ⚠️ 重复定义要失败关闭：PowerShell 对同名变量**最后一次赋值生效**，
  // 而这里若只取第一处，就会去验一份根本没生效的陈旧数组（fail-open）。
  // 审查实测：在真实定义之前再插一份旧数组，可整体骗过 D19/D19b/D19c/D19f。
  const re = new RegExp(anchor.source, anchor.flags.includes('g') ? anchor.flags : anchor.flags + 'g');
  const hits = [...masked.matchAll(re)];
  if (hits.length === 0) return null;
  if (hits.length > 1) return null;   // 多份定义 → 视为解析失败，交给调用方报红

  const m = hits[0];
  const open = masked.indexOf('@(', m.index);
  if (open < 0) return null;

  const items = [];
  let depth = 0;    // 圆括号深度：1 = 正处在数组顶层
  let braces = 0;   // 花括号深度：>0 = 在 @{ … } 哈希表 / 脚本块里
  let i = open + 1;

  // 只在「数组顶层」收集字符串：depth === 1 且不在任何花括号里。
  // 花括号这一条是补的 —— 第一版只数圆括号，于是 files 里写
  // `@{ k = 'v' }` 时 `'v'` 会在 depth===1 被当成数组条目（实测复现：
  // 期望 ["a","b"] 实际 ["a","v","b"]）。当前 release-build.ps1 的 files
  // 数组里没有哈希表，所以无实际影响；但那是"暂时没有"，不是"不会发生"。
  const atTopLevel = () => depth === 1 && braces === 0;

  while (i < src.length) {
    const ch = src[i];

    // 单引号字符串（PowerShell 里 '' 表示一个 '）
    if (ch === "'") {
      let j = i + 1;
      let buf = '';
      while (j < src.length) {
        if (src[j] === "'") {
          if (src[j + 1] === "'") { buf += "'"; j += 2; continue; }
          break;
        }
        buf += src[j];
        j += 1;
      }
      // 这里**不 trim**：npm 的 files 条目不做任何 trim，`'lib '` 会整条丢弃。
      // 一旦在这里 trim 掉，那条"格式被悄悄修好"的变异就在判据里看不见了（实测：
      // 判据全绿而 npm pack 丢弃整个 lib/）。判据要看到原样的条目。
      if (atTopLevel()) items.push(buf);
      i = j + 1;
      continue;
    }

    // 双引号字符串（只处理 `` 变量转义与 "" 双写，够用于本文件）
    if (ch === '"') {
      let j = i + 1;
      let buf = '';
      while (j < src.length) {
        if (src[j] === '`') { buf += src[j + 1] ?? ''; j += 2; continue; }
        if (src[j] === '"') {
          if (src[j + 1] === '"') { buf += '"'; j += 2; continue; }
          break;
        }
        buf += src[j];
        j += 1;
      }
      // 这里**不 trim**：npm 的 files 条目不做任何 trim，`'lib '` 会整条丢弃。
      // 一旦在这里 trim 掉，那条"格式被悄悄修好"的变异就在判据里看不见了（实测：
      // 判据全绿而 npm pack 丢弃整个 lib/）。判据要看到原样的条目。
      if (atTopLevel()) items.push(buf);
      i = j + 1;
      continue;
    }

    // 块注释 <# … #>（必须先于行注释判断：`<#` 里也有 `#`）
    if (ch === '<' && src[i + 1] === '#') {
      const close = src.indexOf('#>', i + 2);
      i = close < 0 ? src.length : close + 2;
      continue;
    }

    // 行注释：到行尾
    if (ch === '#') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      continue;
    }

    if (ch === '(') { depth += 1; i += 1; continue; }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return items;
      i += 1;
      continue;
    }

    // 花括号只影响「是否在顶层」，不参与数组边界判定
    if (ch === '{') { braces += 1; i += 1; continue; }
    if (ch === '}') { if (braces > 0) braces -= 1; i += 1; continue; }

    i += 1;
  }

  return null;   // 括号没闭合 —— 交给调用方报"解析失败"
}

// ── D6: 打包不得带临时/备份文件（fail-closed）──────────────────────────
test('D6: release-build 有垃圾文件闸（.bak/.tmp 不得进发布包）', { skip: SKIP_DEVONLY }, () => {
  // ⚠️ 2026-10-18 真实事故：我把 mutation 测试用的
  // `lib/dev-reload.js.bak` 忘在源码目录里，release-build 把它一起
  // 复制进发布包 —— **而且已经推到 GitHub 与 npm**。
  //
  // 内容无害，但发布物里出现 .bak 是明显疏漏：用户疑惑、包体积白涨、
  // 而且说明打包流程没检查「目录里有没有残留」。
  const rb = readFileSync(RELEASE_BUILD, 'utf8');

  assert.match(rb, /junkPattern/, '应有垃圾文件模式定义');
  assert.match(rb, /\.\(bak\|tmp\|orig\|rej\|swp\)/,
    '应覆盖常见编辑器/工具残留（.bak/.tmp/.orig/.rej/.swp）');
  assert.match(rb, /exit 1/, '发现垃圾文件必须中止构建（fail-closed），不能只警告');

  const guardAt = rb.indexOf('$junkPattern');
  const clAt = rb.indexOf('生成 CHANGELOG');
  assert.ok(guardAt > 0 && clAt > 0 && guardAt < clAt,
    '垃圾闸应在复制完成后、写 CHANGELOG 之前');
});

// ── D7: CHANGELOG 过滤器必须挡住内部内容 ──────────────────────────────
test('D7: CHANGELOG 生成器过滤内部标记与 hash', { skip: SKIP_DEVONLY }, () => {
  // 公开仓库只有 release: vX.Y.Z 快照，外部看不到每次改了什么。
  // 但**也不能原样输出开发提交标题** —— 实测早期标题是内部笔记风格：
  //   · CARD：#7849 跟进评论回写
  //   · RECOVERY.md 救援说明（三级回滚…）
  //   · deploy-snapshots/desktop-profile-pre-...
  //   · a306b8d / b9d83e1（私有仓库 hash）
  const rb = readFileSync(RELEASE_BUILD, 'utf8');

  assert.match(rb, /publicTypes/, '应只保留面向使用者的提交类型');
  for (const t of ['feat', 'fix', 'perf', 'refactor']) {
    assert.match(rb, new RegExp(`'${t}'`), `publicTypes 应含 ${t}`);
  }
  assert.doesNotMatch(rb, /publicTypes = @\([^)]*'(docs|test|chore|ci)'/,
    'docs/test/chore/ci 不应算面向使用者的类型');

  assert.match(rb, /internalMarkers/, '应有内部标记黑名单');
  for (const m of ['CARD', 'RECOVERY', '交接备忘', 'deploy-snapshots']) {
    assert.ok(rb.includes(m),
      `internalMarkers 应含 ${m} —— 实测这些标记会带出内部资料引用`);
  }

  assert.match(rb, /0-9a-f\]\{7,40\}/,
    '应剥掉 7~40 位十六进制串（私有仓库 hash 在公开仓库里指不到东西）');
});

// ── D8: 已发布的 CHANGELOG 本身要干净（这条在两种环境都跑）────────────
test('D8: 随包发布的 CHANGELOG 不含内部标记 / hash / 本机路径', () => {
  // 这条查的是**产物**而不是生成器，所以在发布包里也能跑 ——
  // 而且它比"检查生成器源码"更接近真实：用户拿到的就是这份文件。
  const cl = join(ROOT, 'CHANGELOG.md');
  if (!existsSync(cl)) return;   // 开发目录没有（它是构建产物），跳过

  const c = readFileSync(cl, 'utf8');

  // 内部资料标记：提到这些说明过滤失效了
  for (const m of ['CARD', 'RECOVERY', '交接备忘', 'deploy-snapshots', 'app.asar', '待做清单']) {
    assert.ok(!c.includes(m),
      `CHANGELOG 里出现了内部标记「${m}」—— 过滤失效，会带出内部资料引用`);
  }

  // 私有仓库的提交 hash 在公开仓库里指不到任何东西，反而误导
  const hex = c.match(/\b[0-9a-f]{7,40}\b/g) || [];
  assert.deepEqual(hex, [],
    `CHANGELOG 里出现了疑似提交 hash：${hex.slice(0, 5).join(', ')}`);

  // 本机绝对路径
  assert.doesNotMatch(c, /[A-Za-z]:\\\\/, '不得含本机绝对路径');

  // 得有实际内容（防"生成器坏了、产出一个空文件"）
  assert.match(c, /^## v\d+\.\d+\.\d+/m, 'CHANGELOG 应含至少一个版本节');
});

// ── D8b: 生成器配置（仅开发目录）───────────────────────────────────────
test('D8b: CHANGELOG 由构建脚本生成，且内部资料不进发布包', { skip: SKIP_DEVONLY }, () => {
  // 注意：**源 package.json 与发布包 package.json 是两份不同的东西**。
  // 源的 files 服务于本地 link 安装（甚至列了 CARD.md / RECOVERY.md）；
  // 发布包那份由 release-build.ps1 重写 —— 那才是 npm 用户拿到的。
  const rb = readFileSync(RELEASE_BUILD, 'utf8');

  assert.match(rb, /'CHANGELOG\.md',/,
    'CHANGELOG.md 必须出现在 release-build 写出的 files 数组里 —— '
    + '同类事故：THIRD-PARTY-NOTICES.md 曾漏了 files，导致 npm 包没有任何第三方声明');

  // ⚠️ 2026-10-23 修：这里原来是
  //     rb.slice(rb.indexOf('files'), rb.indexOf('keywords'))
  // —— 两个下标**写反了**：`indexOf('files')` 命中的是文件头注释里的
  // "files 数组"字样（更靠后），而 `indexOf('keywords')` 命中的是 $outPj 里
  // 更靠前的位置。slice(后, 前) 返回**空串**，于是下面那个 for 循环检查的是
  // 一个空字符串 —— 断言恒真，向 files 里插入 'CARD.md' 也不会红。
  // 第二轮只读审查实测抓出来的。改成用解析器取真正生效的那份 files 数组。
  const filesBlock = (arrayBlockEntries(rb, ANCHOR_NPM_FILES) || []).join('\n');
  assert.ok(filesBlock.length > 0,
    '未能解析出发布包的 files 白名单（解析器或锚点失效，不是"内部资料没进去"）');
  for (const internal of ['CARD.md', 'RECOVERY.md']) {
    assert.ok(!filesBlock.includes(internal),
      `${internal} 是内部资料，不得出现在发布包的 files 里`);
  }

  assert.match(rb, /WriteAllText\(\(Join-Path \$Destination 'CHANGELOG\.md'\)/,
    'CHANGELOG.md 应由构建脚本生成到目标目录（不是从源码目录复制）');
});

// ── D9: 发版流程必须在**发布包里**跑一次测试 ────────────────────────────
test('D9: release.ps1 在构建后、推送前，于发布包内跑测试', { skip: SKIP_DEVONLY }, () => {
  // ⚠️ 2026-10-18 真实代价：D6/D7/D8 去读 `tools/release-build.ps1`，
  // 而那是**维护者工具、不在发布包里** ——
  // 于是开发目录全绿、推上去 CI 三平台全红。
  //
  // 根因不是那三条测试写错，而是**发版流程只在开发目录跑测试**，
  // 而 CI 跑的是发布包（公开仓库本身就是发布包）。两者文件集不同。
  //
  // 修法：步骤 3 重建发布包之后、步骤 4 推送之前，再跑一次测试。
  // 这样"本地绿、线上红"在推之前就会暴露。
  const rp = readFileSync(join(ROOT, 'tools', 'release.ps1'), 'utf8');

  const step35 = rp.indexOf('3.5 在发布包里跑测试');
  const step3 = rp.indexOf("Write-Step '3. 重建发布包'");
  const step4 = rp.indexOf("Write-Step '4. 提交并推送 GitHub'");

  assert.ok(step3 > 0 && step35 > 0 && step4 > 0,
    'release.ps1 应有步骤 3 / 3.5 / 4');
  assert.ok(step35 > step3 && step35 < step4,
    '3.5 必须在「重建发布包」之后、「推送 GitHub」之前 —— '
    + '顺序错了就起不到拦截作用');

  // 必须在发布包目录里跑，且失败要中止
  assert.match(rp, /Push-Location \$ReleaseDir/,
    '应在发布包目录里执行');
  assert.match(rp, /throw 'release-package tests failed'/,
    '发布包内测试失败必须中止发版（fail-closed）');
});
// ══ README 与实现一致性（v0.4.47）════════════════════════════════════════
//
// 2026-10-18 外部审阅指出 README 落后于功能：
//   · 说语音包下载"尚未实现"（其实 13 个 zip 早发布了，GUI 也能下）
//   · 说"全离线"（下载语音包要访问 GitHub）
//   · 说"点 Toast 可跳回会话"（Toast 点击带不了会话 id，跳转是另一套机制）
//   · 说"设置页 12 项"（实际 schema 字段多得多）
//
// README 是用户判断"这插件能干什么"的第一入口。写错不是文字瑕疵 ——
// 别人可能因此根本不知道有下载功能。

const README = readFileSync(join(ROOT, 'README.md'), 'utf8');

// ── D10: README 不得再声称语音包下载"未实现" ────────────────────────────
test('D10: README 不得说语音包下载尚未实现', () => {
  assert.doesNotMatch(README, /下载提供（尚未实现）/,
    '语音包下载已实现并发布 13 个 zip，README 不得再说"尚未实现"');
  assert.doesNotMatch(README, /尚未实现/,
    'README 里不应残留"尚未实现"这类过时表态');

  // 反而应该真的介绍怎么下载
  assert.match(README, /语音包/,
    'README 应有语音包章节');
  assert.match(README, /下载/,
    'README 应说明可以下载');
});

// ── D11: README 不得无条件下声称"全离线" ────────────────────────────────
test('D11: README 的联网表述必须区分"播放离线"与"下载要联网"', () => {
  // 只写"全离线"会让用户以为下载语音包也不需要网络，
  // 一旦断网失败就以为插件坏了。
  const hasOfflineClaim = /全离线/.test(README);
  if (hasOfflineClaim) {
    assert.match(README, /下载.*联网|联网.*下载/,
      '若说"全离线"，必须同时说明下载语音包需要联网');
  }
  // 明确写清楚是更好的做法
  assert.match(README, /不调用云端 TTS|不联网/,
    '应说明播放/通知是离线的');
});

// ── D12: README 对「点 Toast 跳会话」的描述必须与实现一致 ───────────────
//
// ⚠️ 这条测试原先断言的是**旧结论**：「Toast 点击带不了会话 id」。
// 2026-10-20 我们通过注册自有协议 dshnotify-say:// 做出了可靠实现，
// 旧结论被推翻 —— 继续断言旧说法就会逼着文档写错的东西。
//
// 现在断言语义反过来：README 必须承认这个功能**存在**，
// 且必须说清它是**可选开关**（不能让用户以为装了就默认具备）。
test('D12: README 必须正确描述「点 Toast 跳会话」（可选开关，非默认）', () => {
  // 不得再出现"做不到"的旧结论
  assert.doesNotMatch(README, /做不到：点哪条 Toast/,
    '旧结论已推翻 —— README 不能再说点 Toast 跳会话做不到');

  // 必须承认这个功能存在，并给出协议名（让用户能自己核实注册表）
  assert.match(README, /dshnotify-say:\/\//,
    '应写明用的自有协议 dshnotify-say://，否则用户无法排查协议注册问题');

  // 必须是**显式开关**，不能说成默认行为
  assert.match(README, /点击通知跳转到对应会话/,
    '应给出开关的实际名称，用户要能在设置页找到它');
  assert.match(README, /不开启时|显式开关/,
    '必须说明不开启时的行为 —— 否则用户会以为装了就自动具备');

  // 保留真实限制：DSH 官方协议确实带不了参数（这条事实没变）
  assert.match(README, /dsh:\/\/open/,
    '应保留 DSH 官方协议限制的说明，这是选择自有协议的原因');
});

// ── D13: README 里的数字必须与实现一致 ──────────────────────────────────
test('D13: README 的测试条数与实际一致', () => {
  const pkgScripts = PKG.scripts || {};
  assert.ok(pkgScripts['test:all'], '应有 test:all 脚本');

  // README 写了几条就直接比对；写错了会误导贡献者
  const m = README.match(/\*\*(\d+) 条测试通过/);
  if (!m) {
    assert.match(README, /条测试/, 'README 应说明测试规模');
    return;
  }
  const claimed = Number(m[1]);
  // 只做「量级」校验，不比对精确值 —— 精确比对会让每次加测试都要改 README，
  // 而真正该防的是「写着 3000 条但其实早就不止/远不到」这种失真。
  // 区间随套件增长上调过：v0.5.0 时 test:all = 568（主套件 542 + route 26）。
  assert.ok(claimed > 300 && claimed < 900,
    `README 声称 ${claimed} 条测试，超出合理范围 —— 数字可能过时`);
});

// ── D20: 静态 import 里不许出现 engines.node 不支持的 API ─────────────────
//
// 为什么必须有这条：0.5.2 → 0.5.3 → 0.5.7 → 0.5.8 四次发布，GitHub Actions
// 的「单元测试（Node 20）」**每次都红**，公开仓库的 CI 徽章一直是 failing。
// 根因只有一个：`docs-consistency.test.mjs` 静态 import 了 `globSync`
// —— 它是 Node 22.0 才有的导出。Node 20 上**整个模块在求值前就加载失败**，
// 外层 try/catch 一条断言都拦不住，所以格外难在本地发现（本机 Node 24 全绿）。
//
// 这类问题的共同形状是「能跑通的机器上看不出来」：静态 import 在模块求值
// **之前**解析，所以任何"运行时降级"都救不了它。判据只能落在**源码文本**上。
//
// 同源的先例：`reload-verification.test.mjs` 为 `registerHooks`（22.15+）
// 写过一次同样的坑（0.4.26~0.4.28 修了三轮），但那次只修了用法，没建判据，
// 于是同一个坑换了个 API 又踩一遍 —— 这条判据就是那次缺的机制。
test('D20: 静态 import 不得引用 engines.node 范围内的 Node 没有的导出', () => {
  // 只登记**本仓库真用到过 / 极易误用**的条目，不做全量 API 考古。
  // version 用来说明"为什么它不够老"，编译报错时人能看懂。
  const TOO_NEW = [
    { mod: 'fs', name: 'globSync', version: '22.0.0' },
    { mod: 'fs/promises', name: 'glob', version: '22.0.0' },
    { mod: 'module', name: 'registerHooks', version: '22.15.0' },
    { mod: 'module', name: 'stripTypeScriptTypes', version: '22.13.0' },
    { mod: 'util', name: 'parseEnv', version: '20.12.0' },
  ];
  // engines 说支持的最低版本（写死在这里是刻意的：下限变了就得有人来改判据）
  const MIN_NODE = [20, 0, 0];

  const isTooNew = (v) => {
    const got = v.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((got[i] || 0) > MIN_NODE[i]) return true;
      if ((got[i] || 0) < MIN_NODE[i]) return false;
    }
    return false;
  };
  const banned = TOO_NEW.filter((e) => isTooNew(e.version));

  const files = [];
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const rel = dir + '/' + e.name;
      if (e.isDirectory()) walk(rel);
      else if (/\.(mjs|js)$/.test(e.name)) files.push(rel);
    }
  };
  for (const d of ['test', 'lib']) {
    if (existsSync(join(ROOT, d))) walk(d);
  }
  assert.ok(files.length > 20, `扫描到的源码文件太少（${files.length}），walk 可能坏了`);

  // 只认**静态** import：`import { x } from 'node:fs'`。
  // 动态 `createRequire(...)('node:fs')` 与 `await import()` 是有意为之的降级，
  // 不在判据范围内（它们的可用性由用到的地方自己的 skip 分支兜住）。
  const STATIC_IMPORT = /^\s*import\s*\{([^}]*)\}\s*from\s*['"]node:([^'"]+)['"]/gm;
  const offenders = [];
  for (const rel of files) {
    const src = readFileSync(join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(STATIC_IMPORT)) {
      const names = m[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      for (const b of banned) {
        if (m[2] !== b.mod) continue;
        if (names.includes(b.name)) {
          offenders.push(`${rel}: 静态 import {${b.name}} from 'node:${b.mod}'`
            + `（Node ${b.version}+ 才有，但 engines 说 ${MIN_NODE.join('.')} 起就支持）`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [],
    '这些静态 import 会让 Node 20/22.0 上的模块直接加载失败（不是断言失败，是整文件不跑）：\n  '
    + offenders.join('\n  ')
    + '\n改法：用 createRequire(import.meta.url)(...) 或 await import() 运行时按需取，'
    + '取不到就走跳过/保守分支。');
});

// ── D14: README 必须提到音色下载的许可告知 ──────────────────────────────
test('D14: README 说明下载前会展示署名与条款', () => {
  // 这是合规要求：用户得知道"用这些语音做的内容要署名"。
  // README 是下载前的最后一道说明。
  assert.match(README, /署名/,
    'README 应说明音色的署名要求');
  assert.match(README, /条款/,
    'README 应说明条款');
  assert.match(README, /TERMS\.md/,
    '应说明包内带 TERMS.md');
});
// ── D15: MANIFEST 不得留 (unknown)，要留可回溯的线索 ────────────────────
test('D15: MANIFEST 的版本回溯栏可用（不是 unknown）', { skip: SKIP_DEVONLY }, () => {
  // 2026-10-18 外部审阅指出：公开仓库的 MANIFEST 长期显示
  // `Git 提交: (unknown)` —— 这一栏从来没提供过信息。
  //
  // 原因是它在**构建时**生成，而发布包首次 commit 在构建**之后**。
  // 现在改为如实说明 + 给出真正能查的线索。
  const rb = readFileSync(RELEASE_BUILD, 'utf8');

  assert.doesNotMatch(rb, /'\(unknown\)'/,
    '不得再写 (unknown) —— 那等于这一栏没信息');

  assert.match(rb, /源码日期/,
    '应记录源提交日期（判断构建用的是哪天源码）');
  assert.match(rb, /版本回溯/,
    '应指向可查的公开提交 / CHANGELOG');
});
// ── D16: .ps1 必须是 LF ─────────────────────────────────────────────────
test('D16: PowerShell 脚本用 LF（与 .gitattributes 一致）', () => {
  // ⚠️ 2026-10-18 核实时发现真实分歧：
  //
  //   本地工作树  CRLF
  //   发布包      CRLF   ← release-build 从工作树复制
  //   GitHub      纯LF   ← .gitattributes 的 `*.ps1 text eol=lf` 归一化
  //
  // 于是"同版本"的两个产物字节不同：npm 用户拿到 CRLF，GitHub 用户拿到 LF。
  // 两者都能跑（实测通过），但**测的东西和用户拿的东西不是一个**，
  // 任何按字节校验/哈希对比都会对不上。
  //
  // 修法：工作树也归一成 LF（对 git 是 no-op，因为索引本来就是 LF）。
  // 这条测试防止以后有人用会写 CRLF 的工具改 ps1。
  const bad = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.tmp')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.toLowerCase().endsWith('.ps1')) continue;
      try {
        const buf = readFileSync(p);
        if (buf.includes(13)) bad.push(p.slice(ROOT.length + 1));
      } catch { /* 读不到就跳过 */ }
    }
  };
  walk(ROOT);

  assert.deepEqual(bad, [],
    '.ps1 里出现了 CR (CRLF 行尾) —— 与 .gitattributes 的 eol=lf 不一致，'
    + '会导致发布包与 GitHub 版本字节不同：\n' + bad.join('\n'));
});

// ── D16b: 所有文本扩展名都必须是 LF（不只是 .ps1）─────────────────────
test('D16b: 所有声明了 eol=lf 的文本文件都不许出现 CR', () => {
  // ⚠️ 2026-10-25 实测漏网：
  //
  // `.gitattributes` 声明的是 *.ps1 / *.js / *.mjs / *.md / *.json / *.yml
  // / *.yaml / *.txt 全部 `text eol=lf`。但 D16 只检查 .ps1。
  //
  // 后果（我当场踩到）：用会写 CRLF 的编辑器/工具改 `test/voice-label.test.mjs`
  // 之后，该文件变成 547 个 CRLF，而**整套 589 条测试照样全绿** ——
  // 只有 `git commit` 时会冒出一句 warning，然后 git 在索引里悄悄归一化。
  // 于是"工作树字节"与"提交/发布出去的字节"又一次不同，
  // 而这正是上方 .gitattributes 注释里写明要杜绝的事。
  //
  // 判据来源必须与 .gitattributes 一致：直接从文件里解析出扩展名清单，
  // 而不是在测试里另抄一份（抄一份就会漂移）。
  //
  // ⚠️ 2026-10-25 合并到主仓时立刻红了一次，暴露出一个真实缺陷：
  // `.gitattributes` 的 `eol=lf` **只对 git 跟踪的文件生效** ——
  // 被 .gitignore 排除的目录（本项目的 `.snapshots/` 存着历史快照，
  // 是当年用 CRLF 工具生成的）不影响任何人 checkout 到的字节。
  // 但这条判据只排除 node_modules / .tmp，于是把 `.snapshots/` 也扫了，
  // 报「30 个文件违规」—— 全是历史快照，与本次改动无关。
  //
  // worktree 里没有 `.snapshots/`，所以这个假红**只在主仓才出现**。
  // 修法不是加一个 `.snapshots` 白名单（那会随新目录名再次复发），
  // 而是用 git 本身来问「这个文件被跟踪吗 / 被忽略吗」：
  //   未跟踪 或 被忽略 ⇒ 跳过（eol=lf 对它没有约束力）
  const GA = readFileSync(join(ROOT, '.gitattributes'), 'utf8');
  const exts = [];
  for (const line of GA.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = t.match(/^(\*\.[\w.]+)\s+.*\beol=lf\b/);
    if (m) exts.push(m[1].slice(1).toLowerCase()); // '*.mjs' → '.mjs'
  }
  assert.ok(exts.length >= 5,
    `.gitattributes 里应解析出至少 5 个 eol=lf 扩展名，实际 ${exts.length} 个：${exts.join(',')}`
    + ' —— 若解析失败说明 .gitattributes 格式变了，下面这条判据会变成空过滤');

  // 「哪些文件被 .gitignore 排除」—— 用 git 自己回答，不靠测试里另抄一份忽略规则。
  //
  // ## 这段被改过四次，每次都是同一个坑的另一面（留档，别再来第五次）
  //
  // 目标只有一个：**被 .gitignore 排除的文件不该被检查**，因为
  // `.gitattributes` 的 `eol=lf` 对它们没有约束力（它们不参与 checkout，
  // 不影响任何用户拿到的字节）。
  //
  // ① 首次：只排除 node_modules / .tmp → 主仓 `.snapshots/`（被忽略的
  //    历史快照，30 个文件全是 CRLF）被当成违规，纯假红。
  // ② 第二次：用 `--show-toplevel == ROOT` 判断"ROOT 是仓库根"。
  //    **判据错**：插件目录本来就在大仓子目录里（toplevel=E:/0Deepseek），
  //    主仓里恒为 false → 又退回全扫 → 假红复发。
  //    被自己写的 prove-snapshots.mjs 抓出来。
  // ③ 第三次：改成"ROOT 在 toplevel 之内"，然后**跳过所有未跟踪文件**。
  //    **判据还是错**：`release.ps1` 第 3.5 步把发布包建在仓库内
  //    （`…\.tmp\…`），里面 107 个文件全是「未跟踪但没被忽略」，
  //    于是被全部跳过 → 扫到 0 个 → 反向证明报红。
  //    被三形态矩阵（shape-matrix.mjs）抓出来。
  // ④ 现在：**只跳过被忽略的，不跳过"未跟踪"的**。
  //    两者语义完全不同：
  //      · 被忽略（`.snapshots/`、`.tmp/`）→ eol=lf 管不到 → 跳过 ✓
  //      · 未跟踪但没被忽略（刚新建的文件、发布包副本）→ 将来会入库
  //        → 必须照常检查 ✓（这个严格性正是想要的）
  //    这样三种形态都自然正确，不需要判断"是不是仓库根"：
  //      · 源码目录：忽略清单含 .snapshots → 跳过它，其余照查
  //      · 发布包（仓库内）：忽略清单为空（发布包里没有 .gitignore 规则生效）
  //        → 全都照查，与修复前一致
  //      · 发布包（仓库外）：没有 git → 全都照查
  //
  // ⑤ 第四次收尾时又发现一个边界（三形态矩阵的形态③抓的）：
  //    **ROOT 自身落在被忽略的目录里时不能信忽略清单。**
  //    典型场景：把发布包建在仓库的 `.tmp/` 底下（我自己就干过），
  //    此时 `git ls-files --others --ignored` 会把该目录下**每一个**文件
  //    都报成"被忽略"（因为父目录 `.tmp/` 被忽略），于是全部跳过 → 扫到 0。
  //    判据：先问 `git check-ignore` 判定 ROOT 本身是否被忽略；
  //    被忽略 ⇒ ignoredSet 保持 null（全都查）。
  let ignoredSet = null;
  try {
    // 先判 ROOT 本身是否落在忽略范围内。退出码 0 = 被忽略。
    let rootIgnored = false;
    try {
      execFileSync('git', ['check-ignore', '-q', '.'], { cwd: ROOT, stdio: 'pipe', timeout: 15_000 });
      rootIgnored = true;   // 退出码 0 时 execFileSync 不抛
    } catch (e) {
      rootIgnored = e && e.status === 0;
    }
    if (!rootIgnored) {
      // -z：NUL 分隔，避免中文/空格文件名被转义成带引号的形式。
      const out = execFileSync(
        'git', ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
        { cwd: ROOT, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024, stdio: 'pipe' },
      );
      // 只取**目录级别**的忽略前缀，逐文件比对太脆（新文件随时增删）。
      // 一个被忽略的目录，其下所有文件的相对路径都以 `<dir>/` 开头。
      const entries = out.split('\0').filter(Boolean);
      ignoredSet = new Set();
      for (const e of entries) {
        ignoredSet.add(e.replace(/\/$/, ''));
        const seg = e.split('/')[0];
        if (seg && seg !== e) ignoredSet.add(seg);
      }
    }
  } catch { /* 不是 git 仓库 / 无 git：保持 null，全都查 */ }

  // 判断某个相对路径是否落在被忽略的范围里
  const isIgnored = (rel) => {
    if (ignoredSet === null || ignoredSet.size === 0) return false;
    if (ignoredSet.has(rel)) return true;
    // 任一前缀段命中（例如 `.snapshots` 命中 `.snapshots/20261020-122245/x.js`）
    let acc = '';
    for (const seg of rel.split('/')) {
      acc = acc ? `${acc}/${seg}` : seg;
      if (ignoredSet.has(acc)) return true;
    }
    return false;
  };

  const bad = [];
  let scanned = 0;
  let skippedIgnored = 0;
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.tmp')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const low = e.name.toLowerCase();
      if (!exts.some((x) => low.endsWith(x))) continue;
      // 只有**被 .gitignore 排除**的才跳过（见上方四轮说明）。
      // "未跟踪但没被忽略"的文件必须照查 —— 它将来会入库。
      if (isIgnored(p.slice(ROOT.length + 1).replace(/\\/g, '/'))) {
        skippedIgnored += 1;
        continue;
      }
      scanned += 1;
      try {
        const buf = readFileSync(p);
        if (buf.includes(13)) bad.push(p.slice(ROOT.length + 1));
      } catch { /* 读不到就跳过 */ }
    }
  };
  walk(ROOT);

  // 反向证明：确认真的扫到了文件，否则这条是恒真空过滤
  assert.ok(scanned >= 30,
    `只扫到 ${scanned} 个未被忽略的文本文件（跳过被忽略的 ${skippedIgnored} 个），`
    + '明显偏少 —— 判据可能失效（空过滤）');

  assert.deepEqual(bad, [],
    `以下文本文件出现 CR（CRLF 行尾），与 .gitattributes 的 eol=lf 不一致。`
    + `这会让工作树字节与提交/发布出去的字节不同，任何按字节校验都会对不上。`
    + `\n检查范围（从 .gitattributes 解析）: ${exts.join(' ')}`
    + `\n共扫描 ${scanned} 个文件，违规 ${bad.length} 个:\n` + bad.join('\n'));
});
// ── D17: README 的联网说明必须涵盖"检查更新" ────────────────────────────
test('D17: README 如实说明检查更新也会联网', () => {
  // ⚠️ 2026-10-18 第四轮审阅指出：v0.4.48 加了"挂载时自动查版本"，
  // 但 README 仍写着"不下载语音包的话，这个插件不会联网" —— 文档与行为冲突。
  //
  // 用户对"全离线"是有期待的。加了自动联网就必须说清楚。
  assert.doesNotMatch(README, /不下载语音包的话，这个插件不会联网/,
    '这句已不成立：设置页挂载时会查版本（缓存过期时访问 npm/GitHub）');

  // 必须明确列出"检查更新"也会联网
  assert.match(README, /检查更新/,
    'README 应提到检查更新');
  assert.match(README, /npm registry|npm 与 GitHub|npm\/GitHub/,
    '应说明检查更新访问的是哪些地址');
  assert.match(README, /24 小时/,
    '应说明检查频率（用户有权知道多久联一次网）');

  // 也要说明失败不影响功能
  assert.match(README, /不影响通知|照常工作/,
    '应说明联网失败不影响通知与语音');
});
// ── D18: 所有 .ps1 必须带 UTF-8 BOM ─────────────────────────────────────
test('D18: PowerShell 脚本必须有 UTF-8 BOM（含维护者工具）', () => {
  // ⚠️ 2026-10-18 我自己踩的坑：
  //
  // 用 Node 或 .NET 编辑 .ps1 时，`writeFileSync(..., 'utf8')` /
  // `WriteAllText(..., UTF8Encoding($false))` 会**丢掉 BOM**。
  // 而 PowerShell 5.1 在没有 BOM 时按系统 ANSI（中文系统是 GBK）解码，
  // 于是文件里的中文变成乱码 → 语法错误 → 构建直接崩：
  //
  //   Missing closing ')' in expression.
  //   master-voice.wav锛坉one 鍏滃簳锛?
  //
  // CI 里有 BOM 检查，但它只看**发布包里的** ps1 ——
  // `tools/release-build.ps1` 与 `tools/release.ps1` 是维护者工具、不进发布包，
  // 所以它们的 BOM 一直没人查，这次才崩在本地。
  const bad = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.tmp')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.toLowerCase().endsWith('.ps1')) continue;
      try {
        const buf = readFileSync(p);
        const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
        if (!hasBom) bad.push(p.slice(ROOT.length + 1));
      } catch { /* 读不到就跳过 */ }
    }
  };
  walk(ROOT);

  assert.deepEqual(bad, [],
    '这些 .ps1 没有 UTF-8 BOM —— PowerShell 5.1 会把中文读成乱码然后语法报错：\n'
    + bad.join('\n'));
});

// ── D19: .gitattributes 必须随包分发 ────────────────────────────────────
test('D19: 发布包带 .gitattributes（否则 Windows 上 checkout 会改成 CRLF）', () => {
  // 2026-10-18 实测：CI 跑在 windows-latest，公开仓库当时没有 .gitattributes，
  // `actions/checkout` 按 autocrlf=true 把 .ps1 转成 CRLF，
  // 而开发机是 LF → D16 在 CI 全红（同样的提交，字节不同）。
  assert.ok(existsSync(join(ROOT, '.gitattributes')),
    '插件目录应有自己的 .gitattributes，并随包分发');

  const ga = readFileSync(join(ROOT, '.gitattributes'), 'utf8');
  assert.match(ga, /\*\.ps1\s+text eol=lf/,
    '.gitattributes 应把 .ps1 定为 LF');
  assert.match(ga, /\*\.wav\s+binary/,
    '音频必须标 binary，否则换行转换会损坏文件');

  // ⚠️ 2026-10-23 修：原来这里只 `assert.match(rb, /'\.gitattributes'/)` ——
  // 只要 release-build.ps1 里**出现过**这个字符串就算过。而 $includeFiles 里
  // 就有它，于是这条断言永远绿，**验不到 npm 的 files 白名单那一半**。
  //
  // 真实代价：v0.5.0 / v0.5.1 从 npm 装的用户，包里没有 .gitattributes，
  // 而开发目录和发布目录磁盘上都有 —— 只有把 npm tarball 解出来才看得见。
  //
  // 现在两处白名单**分别**校验，且各自有能分辨的失败信息。
  if (hasReleaseBuild) {
    const rb = readFileSync(RELEASE_BUILD, 'utf8');
    const inc = arrayBlockEntries(rb, ANCHOR_INCLUDE_FILES);
    const npm = arrayBlockEntries(rb, ANCHOR_NPM_FILES);

    // 先证伪"解析器自己坏了"这一层，再谈条目内容。
    // 否则锚点失配时 inc/npm 会解析失败，报错会变成"你漏了 .gitattributes"，
    // 而真实原因是解析失败 —— 方向指错比不报更费时间（2026-10-23 变异实测）。
    // 注意判 null 而不是 length：[] 是"解析成功但数组真空"，null 才是"没解析出来"。
    assert.ok(Array.isArray(inc), '未能解析出 $includeFiles 白名单（解析器或锚点失效，不是文件漏了）');
    assert.ok(Array.isArray(npm), '未能解析出 package.json 的 files 白名单（解析器或锚点失效，不是文件漏了）');
    assert.ok(inc.length > 0, '$includeFiles 解析出空数组（白名单真的空了，或锚点打在了空数组上）');
    assert.ok(npm.length > 0, 'files 白名单解析出空数组（白名单真的空了）');

    assert.ok(inc.includes('.gitattributes'),
      'release-build 的 $includeFiles 必须含 .gitattributes，否则不会复制进发布目录');
    assert.ok(npm.includes('.gitattributes'),
      'release-build 生成的 package.json files 白名单必须含 .gitattributes，'
      + '否则 npm 用户拿到的包里没有它（开发目录与发布目录都看不出来）');
  }
});

// ── D19b: 进发布目录的每个文件都必须进 npm 包 ───────────────────────────
test('D19b: $includeFiles 的每一项都必须在 npm files 白名单里', { skip: SKIP_DEVONLY }, () => {
  // 这条是 D19 的**一般化**：漏带文件这个坑我们踩过两次，症状完全一样，
  // 都是「开发机/发布目录正常，npm 用户手里缺文件」：
  //   · v0.4.80 — jump-handler.vbs 漏了 → 点 Toast 静默无反应、不报错
  //   · v0.5.1 — .gitattributes 漏了 → 从 npm 装的用户包里没有它
  //
  // 两次的根因是同一个：release-build.ps1 有**两个**白名单，改一处忘了另一处。
  // 注释里写过「两处都要改」，但注释拦不住人 —— 所以改成断言。
  //
  // 不变量：**凡是被复制进发布目录的单个文件，都必须出现在 npm files 白名单里**。
  //
  // 本条**只管单个文件**（$includeFiles）。目录级由 D19c 单独管 —— 之所以分开，
  // 是因为两者期望不同：单文件必须两边都有；目录允许"只进 GitHub 不进 npm"，
  // 但那种排除必须**显式写在 D19c 的排除表里并给出理由**，不能靠注释。
  const rb = readFileSync(RELEASE_BUILD, 'utf8');
  const incRaw = arrayBlockEntries(rb, ANCHOR_INCLUDE_FILES);
  const npmRaw = arrayBlockEntries(rb, ANCHOR_NPM_FILES);

  assert.ok(Array.isArray(incRaw), '未能解析出 $includeFiles 白名单（解析器或锚点失效，不是文件漏了）');
  assert.ok(Array.isArray(npmRaw), '未能解析出 files 白名单（解析器或锚点失效，不是文件漏了）');

  // 通配条目交给各文件自己的测试
  const inc = incRaw.filter((e) => !/[*?]/.test(e));
  const npm = npmRaw;

  // 数量必须与 WHITELIST_COUNTS 一致（数字只在那一处维护）。
  // ⚠️ 计的是**原始解析结果** incRaw，不是过滤掉通配符后的 inc：
  // WHITELIST_COUNTS 描述的是 release-build.ps1 里数组的项数，将来若真加了
  // 通配条目，用过滤后的长度会凭空少一项、报出一条看不懂的红。
  assert.equal(incRaw.length, WHITELIST_COUNTS.includeFiles,
    `$includeFiles 应解析出 ${WHITELIST_COUNTS.includeFiles} 项，实际 ${incRaw.length} 项`
    + '（加/删文件是正常维护，改 WHITELIST_COUNTS 那一处即可；这里要的是"你确实想过"）');
  assert.equal(npm.length, WHITELIST_COUNTS.npmFiles,
    `files 白名单应解析出 ${WHITELIST_COUNTS.npmFiles} 项，实际 ${npm.length} 项`
    + '（同上：改 WHITELIST_COUNTS 一处）');

  const missing = inc.filter((e) => !npm.includes(e));
  assert.deepEqual(missing, [],
    `这些文件会进发布目录但**不会进 npm 包**（npm 只打包 files 白名单）：${missing.join(', ')}`);
});

// ── 目录级白名单判定（D19c 用它，D19d 用它做变异验证）────────────────────
//
// 抽成函数而不是写在 test 里，是为了让 D19d 能对**同一份实现**跑变异体。
// 如果复制一份到 D19d 里，两份必然漂移 —— 第一次写这条时就是这么错的：
// 复制版漏了 C 组，于是「删掉 docs」的变异体在复制版里不报红，测试自己先红。
//
// 返回 problems 数组（空 = 合格），每项是 `{ code, detail }` 而不是纯句子。
//
// 为什么带 code：D19d 要断言「报红的原因正是这条变异想测的那个类别」。
// 如果 problems 只有中文句子，测试就只能 `notDeepEqual(problems, [])` ——
// 那是"随便红一下就算过"，语义漂移会被绿灯掩护（本仓踩过：git-work-sync 的
// T6 用了「多个可接受结果之一」的宽松断言，preflight/grant 语义漂移在 73 条
// 断言全绿下溜过）。所以把 reason code 变成返回值的一等公民。
//
// 解析失败抛错（调用方各自转成断言失败）。
const REASON = {
  A_NOT_PACKED: 'A-漏打包',        // $includeDirs 有、npm 没有、也没排除理由
  B_MISSING: 'B-不存在',           // files 里的条目在源目录不存在
  B_UNSOURCED: 'B-来源不明',       // files 里的目录不在 $includeDirs / DEDICATED_COPY_DIRS
  C_STALE: 'C-陈旧',               // 排除表里的键已不在 $includeDirs
  C_CONTRADICT: 'C-矛盾',          // 同一个键既排除又打包
  C_REASON_SHORT: 'C-理由过短',    // 排除/登记表的理由敷衍
  D_TOOLS: 'D-工具',               // $includeTools 或 tools 打包缺失
  B_NOT_COPIED: 'B-未复制',        // files 里的文件没有任何一层白名单会复制它（反向缺口）
  B_FORMAT: 'B-格式',              // 条目写成 npm 不接受的形态（反斜杠/首尾空格/绝对路径）
};

/**
 * 跑一遍目录级判据，返回 `{ code, detail }[]`（空数组 = 没问题）。
 *
 * @param {string} rb  release-build.ps1 全文
 * @param {object} [tables] 可选覆盖三张表 —— 只给测试用，生产调用不传。
 *   为什么要这个参数：`C-理由过短` 那条判据原本**零覆盖**（第二轮只读审查实测：
 *   把三处 `if (!reason || reason.trim().length < REASON_MIN)` 全改成 `if (false)`
 *   之后仍然 26/26 全绿）。原因是三张表是模块级常量，测试没法在不改源码的前提下
 *   造出一条"理由过短"的登记。抽成参数后，D19d 能直接喂一张敷衍理由的表来钉住它。
 */
function dirWhitelistProblems(rb, tables = {}) {
  const dirs = arrayBlockEntries(rb, ANCHOR_INCLUDE_DIRS);
  const npm = arrayBlockEntries(rb, ANCHOR_NPM_FILES);
  const tools = arrayBlockEntries(rb, ANCHOR_INCLUDE_TOOLS);
  const incFiles = arrayBlockEntries(rb, ANCHOR_INCLUDE_FILES);
  if (!Array.isArray(dirs)) throw new Error('未能解析出 $includeDirs（解析器或锚点失效）');
  if (!Array.isArray(npm)) throw new Error('未能解析出 files 白名单（解析器或锚点失效）');
  if (!Array.isArray(tools)) throw new Error('未能解析出 $includeTools（解析器或锚点失效）');
  if (!Array.isArray(incFiles)) throw new Error('未能解析出 $includeFiles（解析器或锚点失效）');

  const exclusions = tables.exclusions || NPM_DIR_EXCLUSIONS;
  const dedicated = tables.dedicated || DEDICATED_COPY_DIRS;
  const generated = tables.generated || BUILD_GENERATED_ENTRIES;

  // norm：归一化用于**集合比对**，必须让 `'./lib'` 与 `'lib'` 等价 ——
  // npm 实测接受 `./` 前缀（正常打包），我们原来把它算成"来源不明 + 漏打包"，
  // 是假红（第三轮 P2-3c）。第四轮又实测出**前导斜杠**同样正常打包：
  //   '/lib' → 包里就是 lib/a.js（npm 把它当包内相对路径）
  // 而 norm 原来只去 `./`、不去前导 `/`，于是 '/lib' 归一化后仍不等于 'lib'
  // → 同时报 A-漏打包 + B-来源不明（假红，D19i 实测抓出来的）。
  // 归一化只用于**比对**：`'lib\'`/`'lib '` 这类 npm 会丢弃的形态仍由 badFormat 抓。
  const norm = (s) => s.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '');
  const dirSet = new Set(dirs.map(norm));
  const npmSet = new Set(npm.map(norm));
  const incFileSet = new Set(incFiles.map(norm));
  const problems = [];
  const add = (code, detail) => problems.push({ code, detail });

  // ── 格式判据（第三轮只读审查 P2-3 + 第四轮 P2-1）────────────────────────
  //
  // npm 的 files 条目规则**不是**"必须是规范相对路径"，我第一版凭直觉写的那套
  // 有一条假红、一条假绿。第四轮复核要求"按实测重写四条件"，于是逐个跑
  // `npm pack --dry-run --json` 实测（探针见下），结论：
  //
  //   'lib/'   → 正常打包 lib/a.js        ← 原来判红，**假红**
  //   'lib//'  → 正常打包 lib/a.js        ← 原来没管
  //   '/lib'   → 正常打包 lib/a.js        ← 原来判红，**假红**
  //   'lib\'(反斜杠) → 整条丢弃（包里没有 lib/）  ← 真错，判红正确
  //   'lib/.'  → 整条丢弃                 ← 原来不认，**假绿**
  //   'lib '   → 整条丢弃                 ← 真错，判红正确
  //   'lib\.'  → 整条丢弃                 ← 真错
  //   '*.md' / '**/*.js' → 正常打包       ← 通配是合法写法，原来报 B-不存在（假红）
  //
  // 另外 `**/*.js` 实测只能匹配**当前目录**的 js，不递归（`lib/a.js` 没被打进去；
  // 要递归得写 `lib/**/*.js`）—— 这点和直觉不同，所以通配一律不判"是否存在"。
  //
  // ── 第五轮复核：上一版仍有两个方向的洞（我按 npm 实测逐形态复验后重写）──────
  //
  // 夹具 = 真实插件目录副本，条目逐个 `npm pack --dry-run --json`：
  //
  //   ① 假绿（npm 整条丢弃，判据沉默）—— 上一版只认 `endsWith('/.')`：
  //        'lib/./' 'lib/.//' 'lib/././' 'lib/./x.js' './lib/.'
  //        → 全部只打出 LICENSE+README（lib 一个文件都没进包）
  //        '././lib' './/lib' '/./lib' '//lib' → 同样整条丢弃
  //
  //   ② 假绿（更严重：npm 把**包外/内部资料**打进包）—— 上一版完全没管：
  //        'lib/..'        → 124 个文件（.gitattributes / .gitignore /
  //                          .github/workflows/** / CARD.md / cordis.patch.yml /
  //                          docs/** / test/** / tools/release-build.ps1 …）
  //        'lib/../CARD.md'→ CARD.md 进包
  //        'lib/../docs'   → docs/** 24 个进包
  //        这条比"丢包"更危险：丢包用户会发现缺功能，泄漏是**悄悄把内部资料发出去**。
  //
  //   ③ 假红（npm 正常打包，判据却报错）：
  //        'LIB' / 'Lib' → Windows 大小写不敏感，能打包；**但 CI/Linux 会丢**
  //        → 这个不是"npm 会丢弃"，所以不归 badFormat，见下面案例 ⑤ 单独处理。
  //
  // 规则按"剥一层前缀再看路径段"写，而不是逐字符 endsWith：
  const badFormat = (raw) => {
    if (raw !== raw.trim()) return '首尾有空白（npm 不 trim，会整条丢弃）';
    if (raw.includes('\\')) return '用的是反斜杠（npm 只认正斜杠，会整条丢弃）';
    // 作用户目录绝对路径 'C:/x' 会被当成包内相对路径，等于写了个不存在的条目。
    if (/^[A-Za-z]:[\\/]/.test(raw)) return '写成了盘符绝对路径（npm 会当成包内相对路径）';
    // npm 允许**一层**前缀：'./lib' 与 '/lib' 都正常打包；但 '././lib'、'.//lib'、
    // '//lib'（两层及以上，或 ./ 后又跟斜杠）实测整条丢弃。
    let rest = raw;
    if (rest.startsWith('./')) rest = rest.slice(2);
    else if (rest.startsWith('/')) rest = rest.slice(1);
    if (rest.startsWith('/')) {
      // ⚠️ 这里必须分两种，实测行为**相反**（变异验证抓出来的：原来只写了一种，
      // 而 D19j 只断言"报 B-格式"不区分理由，于是拆掉整条也很难被发现）：
      //   '//lib'  './/lib'  '/./lib'  '././lib'  './/'  '//.'   → 2 个文件，整条丢弃
      //   '//'  '///'  '////'                                     → **125 个文件**
      // 纯斜杠写法被 npm 当成"根目录"，会把 .github/ docs/ CARD.md 等内部资料
      // 一起打进发布包 —— 这是泄漏，比丢弃危险得多，理由不能说反。
      if (/^\/+$/.test(rest)) {
        return '整条只有斜杠（npm 把它当成根目录，会把整个仓库打进发布包，'
          + '包括 docs/ .github/ CARD.md 等内部资料）';
      }
      return '前导斜杠叠了两层及以上（npm 会整条丢弃）';
    }
    // 通配先摘掉：'lib/*.js'、'**/*.js' 里的 `*` 段不是路径段，不该被下面的段级规则误伤。
    if (/[*?]/.test(rest)) return null;
    const segs = rest.split('/');
    for (const seg of segs) {
      // `..` 一律禁止：同族的 'lib/..' 实测会把上层目录整个打进包（124 个文件），
      // 'lib/../lib' 虽然恰好解析回包内，但两者只差一个段、不值的（也不该）让人肉区分。
      if (seg === '..') return '路径段里有 `..`（npm 会逃出包目录，把上游目录打进发布包）';
      // `.` 段（含结尾 'lib/.'、'lib/./'、中间 'lib/./x.js'）实测整条丢弃。
      if (seg === '.') return '路径段里有 `.`（npm 会整条丢弃）';
      // npm 永不打包这两个名字（无论出现在哪一层）。
      if (seg === '.git') return '路径段里有 `.git`（npm 永不打包，这一条等于没声明）';
      if (seg === 'node_modules') return '路径段里有 `node_modules`（npm 永不打包，这一条等于没声明）';
    }
    // 空段出现在**中间**（'lib//x.js'、'.//lib'）实测整条丢弃；只在**结尾**的
    // （'lib/'、'lib//'、'lib///'）正常打包 —— 所以先把结尾空段全剥掉再看中间。
    let tail = segs.length;
    while (tail > 0 && segs[tail - 1] === '') tail -= 1;
    for (let i = 0; i < tail; i += 1) {
      if (segs[i] === '') return '路径中间有空段（npm 会整条丢弃）';
    }
    return null;
  };

  // ⑤ 大小写不一致：**只有 Windows 打得出来，Linux/CI 会丢**。
  //
  // 第五轮复核实测：files 写 'LIB' → 本机（NTFS 大小写不敏感）npm 正常打包 lib/，
  // 上一版判据报 B-来源不明 —— 形态上是假红。但直接放行同样不行：
  // 维护者 CI 跑在 Linux 上时这一条会被 npm 静默丢弃（用户装了包没有 lib/）。
  //
  // 这条必须**查磁盘**，所以不能并进 badFormat（那是纯字符串判断）。抽成独立函数，
  // 让 B 组报错、A 组在判断"这条是不是同一个目录"时也能认出来（见 hasBadFormatOf）。
  //
  // ⚠️ 必须**无条件**核对，不能写在 `if (!exists)` 里：NTFS 大小写不敏感，
  // `existsSync('LIB')` 在本机返回 true，那段代码根本进不去（我第一版就写错了，
  // 靠 verify-r5.mjs 的 npm 对照才抓出来）。
  const caseMismatchOf = (relPath) => {
    const segsForCase = relPath.split('/');
    let cur = ROOT;
    for (let i = 0; i < segsForCase.length; i += 1) {
      let names;
      try { names = readdirSync(cur); } catch { return null; }
      if (names.includes(segsForCase[i])) { cur = join(cur, segsForCase[i]); continue; }
      const ci = names.find((x) => x.toLowerCase() === segsForCase[i].toLowerCase());
      if (ci === undefined) return null;        // 这一段真不存在 → 交给存在性判据
      return segsForCase.slice(0, i).concat(ci).join('/');
    }
    return null;
  };

  for (const raw of npm) {
    const why = badFormat(raw);
    if (why) add(REASON.B_FORMAT, `files 白名单条目 ${JSON.stringify(raw)} ${why}`);
    // 格式本身没错时才查大小写 —— 已经报过格式错的条目，再说大小写只会加噪音。
    if (!why) {
      const diskName = caseMismatchOf(norm(raw));
      if (diskName) {
        add(REASON.B_FORMAT, `files 条目 ${JSON.stringify(raw)} 与磁盘上的名字**只有大小写不同**`
          + `（磁盘上是 ${JSON.stringify(diskName)}）`
          + ' → Windows 上能打包，CI/Linux 上会被 npm 静默丢弃');
      }
    }
  }
  for (const raw of incFiles) {
    if (raw.includes('\\')) {
      add(REASON.B_FORMAT, `$includeFiles 条目 ${JSON.stringify(raw)} 用的是反斜杠`
        + '（它在 Windows 上碰巧能复制成功，但含义与 npm 条目不同，易误读）');
    }
  }

  // ── A. 正向：$includeDirs 每项要么进 files，要么显式排除并写明理由 ──
  //
  // 若 files 里针对**同一个目录**已有格式错误的条目，这条 A 组就不再报：那条
  // "格式错误的 lib" 归一化后虽然对不上 `'lib'`，但根因是**同一个**（写法错），
  // 再报一条「A-漏打包」只会在报错里制造两个互不相同的原因。
  //
  // ⚠️ 这里原来写的是 `const npmHasFormatError = npm.some(e => badFormat(e))`
  // 然后 `if (npmHasFormatError) continue` —— **只要 files 里有任何一条格式错，
  // 所有目录的 A 组检查全部跳过**。实测：files 的 lib 带尾空格 + $includeDirs
  // 多加一个 newdir（项数守恒的误改）→ 只报 ["B-格式"]，newdir 漏打包这个
  // 真问题被整体藏起来了。所以跳过条件必须精确到"同一个目录"。
  const lenient = (raw) => raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  // 比较必须**忽略大小写**：files 写 'LIB' 时这一条确实覆盖了 lib 目录（Windows 上
  // npm 真会打包 lib/），若不忽略大小写，A 组会额外再报一条「lib 漏打包」——
  // 那是在说"lib 不在白名单里"，而它明明在，只是写法大小写不对
  // （第五轮复核 P1-1，D19j 实测抓出来的）。
  const hasBadFormatOf = (dirName) => npm.some(
    (e) => (badFormat(e) || caseMismatchOf(norm(e)))
      && lenient(e).toLowerCase() === dirName.toLowerCase(),
  );
  for (const d of dirs) {
    const n = norm(d);
    if (npmSet.has(n)) continue;
    if (exclusions.has(n)) continue;
    if (hasBadFormatOf(n)) continue;
    add(REASON.A_NOT_PACKED, `目录 ${n} 会复制进发布目录，但既不在 npm files 白名单、`
      + '也不在 NPM_DIR_EXCLUSIONS 里 → npm 用户拿不到它');
  }

  // ── B. 反向：files 里每一项的**来源**必须解释得清 ──
  //
  // 四类显式归类，而不是"不存在就跳过"：
  //   ① 源目录里**确实存在的目录** → 必须在 $includeDirs（会由通用复制带走）
  //      或在 DEDICATED_COPY_DIRS（由专门逻辑带走）；
  //   ② 源目录里**确实存在的文件** → 必须在 $includeFiles 里（第三轮只读审查 P2-1：
  //      原来这里直接 continue，而 D19b 只断言 inc ⊆ npm，**反方向无人管**——
  //      把 $includeFiles 的 tts-speak.ps1 换成 README.md（项数守恒）时判据全绿，
  //      实测发布目录不再有 tts-speak.ps1、npm 静默丢弃、用户包里 TTS 脚本消失）；
  //   ③ 源目录里**不存在** → 必须列在 BUILD_GENERATED_ENTRIES 里（由构建生成）。
  //
  // 为什么要 ③：最初这里写的是 `existsSync && isDirectory()` 过滤，实测
  // files 里写 `'libb'`（拼错）→ problems=[] **全绿**。而 npm pack 对缺失条目
  // 的处理正是「静默丢弃、无 warning、exit 0」—— 于是"拼错一个名字"和
  // "目录没被复制"都会变成装机后才发现的事故。③ 把这种静默改成显式登记。
  for (const e of npm) {
    const n = norm(e);
    // 格式已经报过的条目，不再往下归类 —— 否则会连带报出 B-不存在 / B-来源不明，
    // 把"写成 npm 不接受的样子"这个真原因淹没在噪音里（实测 `'lib '` 会同时
    // 报 B-格式 + B-不存在 + A-漏打包）。
    if (badFormat(e)) continue;
    // `files` 里写目录下的**子路径**（`lib/a.js`）是合法用法：整个 lib/ 由
    // $includeDirs 复制进发布目录，npm 只是再声明一次。
    //
    // ⚠️ 这里原来没这一跳，实测 `test/docs-consistency.test.mjs` 会被报成
    // 「B-未复制」—— 因为 incFileSet 里只有 $includeFiles 的**顶级**文件名，
    // 不认识子路径，于是"文件其实会被复制"这件事被误判成"没人复制它"（假红）。
    //
    // ⚠️⚠️ 但第一版豁免写成了**无条件放行**：
    //   `const slash = n.indexOf('/'); if (slash > 0 && (dirSet.has(p) || dedicated.has(p))) continue;`
    // —— 只看父目录在不在名单，既不查文件是否存在、也不查它是否真会被复制。
    // 第四轮只读复核实测这条豁免可被五类条目整体骗过（problems 全 []）：
    //   `lib/indx.js`（拼错，文件不存在）
    //   `tools/notify-confg.ps1`（拼错）
    //   `tools/release-build.ps1`（**真实存在但故意不发布**的维护者工具；
    //      实测把它写进 files 后 npm pack 真会打进包，而这条豁免让它全绿）
    //   `docs/audio-audit/README.md`（父目录在 NPM_DIR_EXCLUSIONS，npm 拿不到）
    //   `sounds/does-not-exist.wav`
    // 而顶层对照 `zzz-not-exist.ps1` 却正确报 B-不存在 —— 判据只对无斜杠条目
    // 查存在性，这是两条不一致的路径。更要命的是：当时挡住这些假绿的
    // **只有 D19f 里"项数恰好 15"那条硬编码**，判据本身是沉默的。
    //
    // 现在豁免必须同时满足三件事，缺一不可：
    //   ① 父目录由 `$includeDirs` **整目录**复制 → 子路径才真的会被带走。
    //      注意这里**不认** `dedicated`：DEDICATED_COPY_DIRS 是"选择性复制"，
    //      只带走它自己挑的文件（如 tools/ 只复制 notify-config.ps1、
    //      sounds/ 只复制语音包），拿它当子路径来源等于假设整目录都被复制。
    //   ② 父目录不在 NPM_DIR_EXCLUSIONS 里 → 否则 npm 根本拿不到这个目录。
    //   ③ 该子路径在源目录里**真实存在**，或已登记为构建生成物。
    const slash = n.indexOf('/');
    if (slash > 0) {
      const parent = n.slice(0, slash);
      const parentIsWholeDir = dirSet.has(parent) && !exclusions.has(parent);
      if (parentIsWholeDir) {
        const subAbs = join(ROOT, n);
        let subExists = false;
        try { subExists = existsSync(subAbs); } catch { subExists = false; }
        if (subExists || BUILD_GENERATED_ENTRIES.has(n)) continue;
        add(REASON.B_MISSING, `files 白名单里的子路径 ${n} 在源目录**不存在**`
          + `（父目录 ${parent} 会被整目录复制，所以这不是"来源不明"，是名字写错了）`);
        continue;
      }
      // 父目录不给整目录复制 → 落到下面的存在性/来源归类里，由它说清楚为什么不行。
    }
    // ⚠️ 这里原来有一句 `if (n.startsWith('.')) continue;` —— 理由是"点文件不是
    // 目录"。但它把**存在性检查**也一起跳过了：files 里写一个不存在的
    // `'.typodir'` 时，唯一能兜住的是 D19f 里"项数恰好 15"这条硬编码，
    // 判据本身沉默（第二轮只读审查实测）。点文件、点目录一律走同一套归类。
    const abs = join(ROOT, n);
    let exists = false;
    let isDir = false;
    try {
      exists = existsSync(abs);
      isDir = exists && statSync(abs).isDirectory();
    } catch { exists = false; isDir = false; }

    // ⑤ 大小写不一致已在上面格式判据里报过（那里要查磁盘，故与 badFormat 分开）。
    //    这里不再重复归类 —— 否则会连带报 B-来源不明，把「CI/Linux 会丢」这个
    //    真原因淹没成「这个目录没人管」。
    if (!badFormat(e) && caseMismatchOf(n)) continue;

    if (!exists) {
      if (BUILD_GENERATED_ENTRIES.has(n)) continue;   // ③ 显式登记为构建生成
      // ④ 通配写法（`*.md` / `**/*.js` / `lib/*.js`）：npm 实测**正常打包**，
      //    不能按"文件不存在"报红。第四轮复核实测 `*.md`、`**/*.js` 被判
      //    B-不存在（假红）—— `$includeFiles` 侧早就过滤了通配，files 侧漏了。
      //    用 fs.globSync 判它到底能匹配到东西；匹配不到才算真错。
      if (/[*?[\]]/.test(n)) {
        let matched = [];
        const gs = getGlobSync();
        if (gs) {
          try { matched = gs(n, { cwd: ROOT }); } catch { matched = []; }
        } else {
          // Node 20 没有 globSync，无法真的判它能不能匹配到东西。
          // 宁可放过（不报警）也不能凭空报 B-不存在 —— 那会把一个跨版本兼容
          // 问题伪装成"files 白名单写错了"。
          matched = [n];
        }
        if (matched.length > 0) continue;
        add(REASON.B_MISSING, `files 白名单里的通配 ${n} 在源目录匹配不到任何文件`
          + ' → npm pack 不会因此报错，但这一条等于什么也没声明');
        continue;
      }
      add(REASON.B_MISSING, `files 白名单里的 ${n} 在源目录**不存在**，也不是已知的构建生成物`
        + ' → 要么名字拼错，要么文件漏提交；npm pack 会静默跳过它（不报错）');
      continue;
    }
    if (!isDir) {
      // ② 普通文件：必须由 $includeFiles 真复制进发布目录，否则 npm 拿不到。
      if (incFileSet.has(n) || BUILD_GENERATED_ENTRIES.has(n)) continue;
      add(REASON.B_NOT_COPIED, `files 白名单里的文件 ${n} 既不在 $includeFiles 里、`
        + '也不是构建生成物 → 发布目录不会有它，npm pack 会静默丢弃这一条'
        + '（用户装了包却没有这个文件）');
      continue;
    }
    if (dirSet.has(n) || dedicated.has(n)) continue;  // ① 来源清楚
    add(REASON.B_UNSOURCED, `files 白名单里的目录 ${n} 既不在 $includeDirs、也不在 DEDICATED_COPY_DIRS 里`
      + ' → 发布目录可能根本没有它');
  }

  // ── C. 排除表自检：不许陈旧、不许自相矛盾、理由不许敷衍 ──
  for (const [k, reason] of exclusions) {
    if (!dirSet.has(k)) add(REASON.C_STALE, `NPM_DIR_EXCLUSIONS 里的 ${k} 已不在 $includeDirs 中（陈旧条目，应删除）`);
    if (npmSet.has(k)) add(REASON.C_CONTRADICT, `NPM_DIR_EXCLUSIONS 里的 ${k} 同时出现在 files 白名单（自相矛盾）`);
    if (!reason || reason.trim().length < REASON_MIN) {
      add(REASON.C_REASON_SHORT, `NPM_DIR_EXCLUSIONS 里 ${k} 的理由过短（至少 ${REASON_MIN} 字，写清为什么它不该随包分发）`);
    }
  }
  for (const [k, reason] of dedicated) {
    if (dirSet.has(k)) add(REASON.C_CONTRADICT, `DEDICATED_COPY_DIRS 里的 ${k} 已在 $includeDirs 中（两处都复制会重复）`);
    if (!npmSet.has(k)) add(REASON.B_UNSOURCED, `DEDICATED_COPY_DIRS 里的 ${k} 不在 files 白名单（那张表就没有意义了）`);
    if (!reason || reason.trim().length < REASON_MIN) {
      add(REASON.C_REASON_SHORT, `DEDICATED_COPY_DIRS 里 ${k} 的理由过短`);
    }
  }
  for (const [k, reason] of generated) {
    if (!npmSet.has(k)) add(REASON.B_UNSOURCED, `BUILD_GENERATED_ENTRIES 里的 ${k} 不在 files 白名单（登记了却不打包，等于没登记）`);
    if (!reason || reason.trim().length < REASON_MIN) {
      add(REASON.C_REASON_SHORT, `BUILD_GENERATED_ENTRIES 里 ${k} 的理由过短`);
    }
  }

  // $includeTools 是"专门复制目录"的一种；它带走的 tools/ 必须在 files 里，
  // 否则用户装了包却没有命令行工具。
  //
  // 第三轮只读审查 P2-2：原来只看 `tools.length === 0` 和 `npmSet.has('tools')`，
  // **从不看条目本身存不存在**。实测 `$includeTools` 拼错成 `notify-confg.ps1`
  // 时 26/26 全绿；真删源文件同样全绿。而 release-build.ps1 对缺失项只打印黄色
  // `! 缺少 {0}` 并继续，`tools/` 目录因此根本不会被建出来 → npm 连 `'tools'`
  // 一起静默丢弃 → 用户包里没有 notify-config.ps1，而 README 引用它。
  if (tools.length === 0) add(REASON.D_TOOLS, '$includeTools 解析出空数组（tools 目录将不会随包分发）');
  if (!npmSet.has('tools')) add(REASON.D_TOOLS, 'files 白名单必须含 tools（$includeTools 从那里挑文件）');
  for (const t of tools) {
    const n = norm(t);
    if (!existsSync(join(ROOT, n))) {
      add(REASON.D_TOOLS, `$includeTools 里的 ${n} 在源目录不存在 → 这一条会被静默跳过；`
        + '若整目录都缺失，tools/ 根本不会建出来，用户包里就没有命令行工具');
    }
  }

  return problems;
}

// 把 problems 渲染成人类可读的多行文本（D19c 报错用）
function formatProblems(problems) {
  return problems.map((p) => `[${p.code}] ${p.detail}`).join('\n  - ');
}

// ── D19c: 目录级两个方向都要有交代 ──────────────────────────────────────
test('D19c: $includeDirs 与 npm files 白名单的目录必须双向对得上', { skip: SKIP_DEVONLY }, () => {
  // 为什么单文件有 D19/D19b 了还要这条：D19b 只管 $includeFiles，**完全没管
  // $includeDirs**。而目录级两个方向都会出事，且都是"看起来通过"：
  //
  //   方向①（正向漏打包）：新目录只加进 $includeDirs、忘了加进 files
  //     → 发布目录有它、npm 包没有。与 v0.5.1 缺 .gitattributes **同型**，
  //       只是粒度从文件换成目录。
  //
  //   方向②（反向漏复制）：从 $includeDirs 删掉目录、files 里仍留着它
  //     → 发布目录根本没生成这个目录，但生成的 package.json 仍声明它。
  //       `npm pack` 会**静默丢弃**缺失条目（无 warning、exit 0），于是包内的
  //       `npm test` 变成 **0 tests / exit 0** —— 不是报错，是"看起来通过"。
  //       这一条尤其阴：README 承诺"克隆后 npm test 即可跑"，实际空跑。
  //
  // 判据分三组（实现在 dirWhitelistProblems 里，D19d 用它做变异验证）：
  //   A. $includeDirs 每一项 → 要么进 files，要么在 NPM_DIR_EXCLUSIONS 里带理由
  //   B. files 里的每一项 → 存在的目录要来源清楚；**不存在**的必须是登记的构建生成物
  //   C. 三张表自检 —— 陈旧、自相矛盾、理由敷衍
  //
  // 残余边界（如实写明）：`$includeDirs += @(...)` 追加写法不覆盖；目录**内部**
  // 新增文件不覆盖（那是目录级决策，由排除表理由承担）。当前都没有这些写法。
  const rb = readFileSync(RELEASE_BUILD, 'utf8');
  const problems = dirWhitelistProblems(rb);
  assert.deepEqual(problems.map((p) => p.code), [],
    '目录级白名单与 npm 打包范围对不上：\n  ' + formatProblems(problems));
});

// ── D19d: 证明 D19c 真的会红（把「判据自身失效」也钉住）────────────────────
test('D19d: D19c 对四类真实失误必须报红（否则它只是装饰）', { skip: SKIP_DEVONLY }, () => {
  // 为什么需要这条：D19c 刚写完时，B 组用的是 `existsSync && isDirectory()` 过滤，
  // 实测把 files 里的目录名拼错成 'libb' → problems=[] **全绿**。
  // 一个只会绿的判据等于没有判据。这条用**同一份实现**（dirWhitelistProblems）
  // 跑四个变异体，断言它必须红，防止将来"优化"时又把静默改回来。
  //
  // 共用实现是刻意的：我第一版把判定逻辑复制进这里，复制版漏了 C 组，
  // 于是「删掉 docs」的变异体在复制版里不报红 —— 测试自己先红，正好证明了
  // "复制实现必然漂移"这句话。
  const rb = readFileSync(RELEASE_BUILD, 'utf8');

  // A0 基线：未变异的真实源码必须不报红
  assert.deepEqual(dirWhitelistProblems(rb).map((p) => p.code), [],
    'D19d 的基线就报红了 —— D19c 在真实源码上已经不通过');

  const NPM_HEAD = '  files       = @(\n';
  assert.ok(rb.includes(NPM_HEAD), '未能定位 files 白名单开头（锚点变了，请同步本测试）');

  // 断言方式的纪律（判定协议断言纪律）：不能只断言「problems 非空」——
  // 那是"随便红一下就算过"，语义漂移会被绿灯掩护。必须断言 **exact reason code**：
  // 报红的原因得正是这条变异想测的那个类别，且不夹带无关类别。
  // 这也是把 problems 从"中文句子数组"改成 `{ code, detail }` 的原因。
  const codes = (list) => list.map((p) => p.code).sort();

  // A1 目录名拼错（v0.5.1 事故的最近亲：名字对不上 = 打进包的东西少一样）
  {
    const mut = rb.replace(NPM_HEAD, NPM_HEAD + "    'libb',\n");
    assert.deepEqual(codes(dirWhitelistProblems(mut)), [REASON.B_MISSING],
      'files 里的目录名拼错成 libb 应当且仅当报「B-不存在」');
  }
  // A2 文件名拼错
  {
    const mut = rb.replace(NPM_HEAD, NPM_HEAD + "    'zzz-not-exist.ps1',\n");
    assert.deepEqual(codes(dirWhitelistProblems(mut)), [REASON.B_MISSING],
      'files 里的文件名拼错应当且仅当报「B-不存在」');
  }
  // A3 两处白名单都写了、但目录根本没建（"改脚本忘了建目录"）
  {
    const mut = rb
      .replace(NPM_HEAD, NPM_HEAD + "    'newdir',\n")
      .replace('$includeDirs = @(\n', "$includeDirs = @(\n  'newdir',\n");
    assert.deepEqual(codes(dirWhitelistProblems(mut)), [REASON.B_MISSING],
      '白名单两处都写了 newdir 但目录不存在，应当报「B-不存在」'
      + '（若同时报出别的类别，说明这条变异牵动了无关判据）');
  }
  // A4 从 $includeDirs 删掉一个真实目录（它同时也在 NPM_DIR_EXCLUSIONS 里）
  //
  // 期望**只有** C-陈旧，没有 B-来源不明 —— 我第一版就写错了这条预期，实测纠正：
  // docs 不在 npm 的 files 白名单里（正因如此才进排除表），所以 B 组遍历 files 时
  // 根本不会碰到它。这条变异只让「排除表里的键已不在 $includeDirs」这一条成立。
  // 保留这个"看似该报两条、实际只该报一条"的用例本身有价值：它钉住了
  // 「排除表与 files 是两个集合、判据各管一处」这个语义。
  {
    const mut = rb.replace("  'docs',\n", '');
    assert.deepEqual(codes(dirWhitelistProblems(mut)), [REASON.C_STALE],
      '从 $includeDirs 删掉 docs（它不在 files 里）应当只报「C-陈旧」一条');
  }
  // A4b 从 $includeDirs 删掉一个**同时**在 files 里的目录 → 应报「B-来源不明」。
  // 与 A4 配对，证明 B 组那一路真的会响，而不是被 A4 的单一结果掩盖。
  {
    const mut = rb.replace("  'lib',\n", '');
    assert.deepEqual(codes(dirWhitelistProblems(mut)), [REASON.B_UNSOURCED],
      '从 $includeDirs 删掉 lib（它在 files 里）应当报「B-来源不明」');
  }
  // A5 反面对照：把已存在的 lib 也写进 files（它在 $includeDirs 里）→ 必须保持不报红。
  // 没有这条，上面四条可以用"永远报红"糊弄过去。
  {
    const mut = rb.replace(NPM_HEAD, NPM_HEAD + "    'lib',\n");
    assert.deepEqual(dirWhitelistProblems(mut).map((p) => p.code), [], '合法的重复声明（lib 已在两处）不该报红');
  }

  // A6 方向①：新目录**只**加进 $includeDirs、忘了加进 files → 必须报「A-漏打包」。
  //
  // 这条是补漏的，而且是我自己实测抓出来的：在此之前 A 组（A_NOT_PACKED）
  // **没有任何永久变异覆盖**。验证方法：把 A 组的 `add(REASON.A_NOT_PACKED, …)`
  // 用 `if (false)` 禁掉，重新跑这条测试文件 —— 实测仍然 26/26 全绿。
  // 也就是说"最可能发生的真实事故"（release-build.ps1 里加了个新目录、
  // 忘了同步 package.json files）当时是零覆盖的；之前只在临时脚本 attack2.mjs
  // 里跑过 Y18，没进套件就等于没有。
  //
  // 构造注意（我连着写错两版，记下来）：源目录 7 个一级目录**全都**已在某张表里 ——
  // lib/locale/test 在 files、docs/.github 在 NPM_DIR_EXCLUSIONS、
  // sounds/tools 在 DEDICATED_COPY_DIRS。所以拿任何一个真实目录名来构造，
  // 都会先撞上别的判据：用 locale → 它已在 files，A 组根本不响（实际 []）；
  // 用 sounds → 撞 C 组「DEDICATED_COPY_DIRS 又出现在 $includeDirs」（实际 [C-矛盾]）。
  // A 组只看「在 dirSet、不在 npmSet、不在排除表」三个条件，**不检查目录是否存在**，
  // 所以这里用一个不在任何表里的名字（newdir）才能干净地只打 A 组这一路。
  {
    const mut = rb.replace('$includeDirs = @(\n', "$includeDirs = @(\n  'newdir',\n");
    assert.deepEqual(codes(dirWhitelistProblems(mut)), [REASON.A_NOT_PACKED],
      '目录只加进 $includeDirs 却没进 files，应当报「A-漏打包」');
  }
  // A6b 与 A6 配对：同一个变异里如果也补进 files，就应当恢复全绿 ——
  // 证明 A6 不是靠"随便加一行就红"骗过的。
  //
  // 注意这里不能用完全不存在的 newdir 进 files：那会被 B 组判「B-不存在」
  // （files 里的条目必须真实存在或登记为构建生成物）。所以用真实存在的 sounds。
  {
    const mut = rb
      .replace('$includeDirs = @(\n', "$includeDirs = @(\n  'sounds',\n")
      .replace(NPM_HEAD, NPM_HEAD + "    'sounds',\n");
    // sounds 进了 files 就满足 A 组；但它同时在 DEDICATED_COPY_DIRS，
    // 于是 C 组报「两处都复制会重复」—— 这正是判据该说的话，不是误报。
    assert.deepEqual(codes(dirWhitelistProblems(mut)), [REASON.C_CONTRADICT],
      'sounds 同时进 $includeDirs 与 files 会与 DEDICATED_COPY_DIRS 冲突，应报「C-矛盾」');
  }

  // A7 D 组：$includeTools 抽干 / tools 不进 files 时用户装了包却没有命令行工具。
  // 同样是补漏的：把 `if (!npmSet.has('tools')) add(REASON.D_TOOLS, …)` 用
  // `if (false)` 禁掉后重跑，实测仍然 26/26 全绿 —— D 组此前零覆盖。
  //
  // 期望两条而不是一条（实测纠正）：tools 从 files 删掉后，
  // B 组也从 DEDICATED_COPY_DIRS 那一路报「登记了却不在 files 里」。
  // 两条都说同一件事的两个侧面，都是该说的话 —— 不是误报，所以断言两条都在。
  {
    const mut = rb.replace("    'tools',\n", '');
    assert.deepEqual(codes(dirWhitelistProblems(mut)), [REASON.B_UNSOURCED, REASON.D_TOOLS].sort(),
      'files 里没有 tools 时应当同时报「B-来源不明」与「D-工具」');
  }

  // A8 `C-理由过短` 此前是**零覆盖**路径。
  //
  // 第二轮只读审查实测：把三处 `if (!reason || reason.trim().length < REASON_MIN)`
  // 全改成 `if (false)`，仍然 26/26 全绿 —— 也就是说这条判据可以被整段删掉
  // 而没有任何用例发现。原因是三张表是模块级常量，测试没法在不改源码的前提下
  // 造出一条"理由敷衍"的登记。所以把三张表抽成 dirWhitelistProblems 的可选参数，
  // 这里直接喂一张短理由的表来钉住它。
  //
  // 三条都要测，因为它们各自是一个独立的 `if`（审查报告点的是 :900/:907/:913 三处）。
  {
    // 注意（第一版写错过）：不能直接 new Map([['docs','太短']]) —— 那会把 .github
    // 一起弄没，于是 A 组先报「A-漏打包」，用例测的东西就不是理由长度了。
    // 正确做法是在**真实表**的基础上只把某一项的理由换短。
    const mut = rb.replace("  'docs',\n", '');
    const short = new Map(NPM_DIR_EXCLUSIONS);
    short.set('docs', '太短');
    assert.deepEqual(codes(dirWhitelistProblems(mut, { exclusions: short })),
      [REASON.C_REASON_SHORT, REASON.C_STALE].sort(),
      'NPM_DIR_EXCLUSIONS 的理由过短应当报「C-理由过短」（且 mutate 造成的陈旧也一并报出）');
  }
  {
    const short = new Map(DEDICATED_COPY_DIRS);
    short.set('sounds', '短');
    assert.deepEqual(codes(dirWhitelistProblems(rb, { dedicated: short })),
      [REASON.C_REASON_SHORT],
      'DEDICATED_COPY_DIRS 的理由过短应当报「C-理由过短」');
  }
  {
    const short = new Map(BUILD_GENERATED_ENTRIES);
    short.set('CHANGELOG.md', '短');
    assert.deepEqual(codes(dirWhitelistProblems(rb, { generated: short })),
      [REASON.C_REASON_SHORT],
      'BUILD_GENERATED_ENTRIES 的理由过短应当报「C-理由过短」');
  }
  // 反面对照：理由够长时必须不报，防止"永远是 C-理由过短"。
  {
    const long = new Map(BUILD_GENERATED_ENTRIES);
    long.set('CHANGELOG.md', '这是一条足够长的理由，说明它为什么由构建脚本生成而不是入库');
    assert.deepEqual(codes(dirWhitelistProblems(rb, { generated: long })), [],
      '理由足够长时不该报「C-理由过短」');
  }

  // A13 D 组的两条「兜底」分支各自零覆盖（第四轮复核 P2-3）。
  //
  // 复核实测：把 `if (tools.length === 0) add(REASON.D_TOOLS, …)` 和
  // `if (!existsSync(join(ROOT, n))) add(REASON.D_TOOLS, …)` 分别用 `if (false)`
  // 禁掉，整套仍然 28/28 全绿。原因是 A7 那条同时会触发 B 组，D 组的**独立**
  // 触发条件（空数组 / 条目拼错）从来没被单独打过。
  // 判据本身会响（手测能复现），但"能响"不等于"有人守"。
  {
    // a) $includeTools 抽成空数组 → 只能由 D 组报出（B 组看的是 files，不受影响）。
    const mut = rb.replace(
      /^[ \t]*\$includeTools[ \t]*=[ \t]*@\([\s\S]*?^\)/m,
      '$includeTools = @()',
    );
    assert.notEqual(mut, rb, '未能把 $includeTools 抽成空数组（锚点失效）');
    assert.ok(codes(dirWhitelistProblems(mut)).includes(REASON.D_TOOLS),
      '$includeTools 为空数组时 tools/ 不会随包分发，必须报「D-工具」'
      + `（实际 ${codes(dirWhitelistProblems(mut)).join(',') || '全绿'}）`);
  }
  {
    // b) 条目拼错（源目录不存在）→ 只走"条目存在性"这一路。
    const mut = rb.replace('tools\\notify-config.ps1', 'tools\\notify-confg.ps1');
    assert.notEqual(mut, rb, '未能改写 $includeTools 条目（锚点失效）');
    assert.ok(codes(dirWhitelistProblems(mut)).includes(REASON.D_TOOLS),
      '$includeTools 条目拼错时该条会被静默跳过，必须报「D-工具」'
      + `（实际 ${codes(dirWhitelistProblems(mut)).join(',') || '全绿'}）`);
  }
  {
    // c) 排除表里的目录**同时**出现在 files → 自相矛盾（一边说不打包、一边说打包）。
    //    A6b 只覆盖了 DEDICATED_COPY_DIRS 那一支，NPM_DIR_EXCLUSIONS 这一支零覆盖。
    const mut = rb.replace(NPM_HEAD, NPM_HEAD + "    'docs',\\n");
    assert.notEqual(mut, rb, '未能把 docs 注入 files（锚点失效）');
    assert.ok(codes(dirWhitelistProblems(mut)).includes(REASON.C_CONTRADICT),
      'NPM_DIR_EXCLUSIONS 里的 docs 同时出现在 files 时是自相矛盾，必须报「C-矛盾」'
      + `（实际 ${codes(dirWhitelistProblems(mut)).join(',') || '全绿'}）`);
  }

  // A9 点开头的条目也必须走存在性检查。
  //
  // 第二轮只读审查实测：原来有一句 `if (n.startsWith('.')) continue;`，
  // 于是 files 里写一个不存在的 `'.typodir'` 时判据沉默，唯一兜住它的是
  // D19f 里"项数恰好 15"这条硬编码 —— 那是偶然，不是判据。
  {
    const mut = rb.replace(NPM_HEAD, NPM_HEAD + "    '.typodir',\n");
    assert.deepEqual(codes(dirWhitelistProblems(mut)), [REASON.B_MISSING],
      'files 里点开头且不存在的条目应当报「B-不存在」');
  }

  // A10 重复定义同名变量必须失败关闭。
  //
  // PowerShell 对同名变量**最后一次赋值生效**，而解析器若只取第一处，
  // 就会去验一份根本没生效的陈旧数组（fail-open）。审查实测：在真实定义之前
  // 再插一份旧数组，可整体骗过 D19/D19b/D19c/D19f。
  {
    const mut = rb.replace(
      '$includeFiles = @(\n',
      "files = @(\n  'stale'\n)\n$includeFiles = @(\n",
    );
    assert.throws(() => dirWhitelistProblems(mut), /解析|锚点|失败/,
      '重复定义 files 时应当解析失败（失败关闭），而不是悄悄取第一处');
  }

  // A11 块注释里的锚点诱饵不得被当成真定义。
  //
  // 这是第二轮审查报的最硬的一条：行首锚点只挡住了行注释 `# files = @(`，
  // 块注释**内部**的行行首就是 `files = @(` 本身。审查的复现方式是把它塞进
  // 文件头 <# … #> 再删掉真实数组里那条 → D19/D19b/D19c/D19f 全部假绿。
  //
  // 构造（第一版写错过）：不能拿"删 .gitattributes"来测 D19c —— 那是**文件级**
  // 判据（D19b）的职责，目录级本来就看不见。目录级能判别的形态是：
  // 诱饵里那份 files **含 tools**，真实 files 里删掉 tools → 真定义应报
  // [B-来源不明, D-工具]；若被骗去信了诱饵，就会全绿。
  {
    const decoy = '<#\n'
      + 'files = @(\n'
      + "  'lib',\n  'locale',\n  'sounds',\n  'tools',\n  'test'\n"
      + ')\n'
      + '#>\n';
    const mut = decoy + rb.replace("    'tools',\n", '');
    const got = codes(dirWhitelistProblems(mut));
    assert.deepEqual(got, [REASON.B_UNSOURCED, REASON.D_TOOLS].sort(),
      `块注释里的 files 诱饵不该被当成真定义（实际 ${got.join(',') || '全绿'}）`);
  }

  // A12 只改 $includeFiles、不动 files（项数守恒）—— 第三轮审查报的「反向缺口」。
  //
  // 这是本仓踩过两次的真实事故方向：某个文件明明在 npm 的 files 白名单里，
  // 但 release-build.ps1 的 $includeFiles 不复制它 → 发布目录没有它 →
  // npm pack 静默丢弃这一条 → 用户装了包却没有这个文件。
  //
  // v0.4.80（漏 jump-handler.vbs，点 Toast 无反应）和 v0.5.1（漏 .gitattributes）
  // 都是"改了一处忘了另一处"，但方向相反：那两次是改了 $includeFiles 忘了 files；
  // 这一条测的是改了 files 忘了 $includeFiles。
  //
  // ⚠️ 构造必须**只动 $includeFiles 那一段**。我第一版用整份文件
  // `orig.replace("'tts-speak.ps1',", …)` —— 那个串在文件里出现 **2 次**
  // （$includeFiles 里一次、files 里一次），于是两处同时被改（项数都守恒），
  // 落入已知的「两边同删」盲区，实测全绿，看起来像判据失效。实际是攻击写错了。
  {
    const iOpen = rb.search(ANCHOR_INCLUDE_FILES);
    const iClose = rb.search(ANCHOR_INCLUDE_DIRS);
    assert.ok(iOpen >= 0 && iClose > iOpen, '锚点失效，无法切出 $includeFiles 段');
    const incBlock = rb.slice(iOpen, iClose);
    const from = "  'tts-speak.ps1',";
    assert.ok(incBlock.includes(from), `$includeFiles 段内未命中 ${JSON.stringify(from)}`);
    const mut = rb.slice(0, iOpen) + incBlock.replace(from, "  'README.md',") + rb.slice(iClose);

    const got = codes(dirWhitelistProblems(mut));
    assert.deepEqual(got, [REASON.B_NOT_COPIED],
      'files 里列了 tts-speak.ps1 但 $includeFiles 不再复制它时，必须报「B-未复制」'
      + `（实际 ${got.join(',') || '全绿'}）—— 否则用户包里没有 TTS 脚本而无人知晓`);
  }
});

// ── D19e: 白名单解析器的语义边界（钉住状态机本身）─────────────────────────
test('D19e: 白名单解析器对字符串/注释/嵌套的解析语义正确', () => {
  // 为什么单独测解析器：D19/D19b/D19c 的可信度**完全依赖**它把「哪几项真的在
  // 数组里」认对。它错一个方向（多认）就是假红，错另一个方向（少认）就是假绿。
  // 上一版就是因为"只剥行首 # + matchAll 盲抽单引号"而在块注释、双引号、
  // 不配对括号上全线假绿（审查实测）。
  //
  // 下面这些用例是我写状态机时逐个撞出来的，其中 @{ } 那条是真缺陷：
  // 第一版只数圆括号，于是 files 里写 `@{ k = 'v' }` 时 'v' 会在 depth===1
  // 被当成数组条目（实测：期望 ["a","b"] 实际 ["a","v","b"]）。
  // 当前 release-build.ps1 的 files 数组里没有哈希表，属"暂时没有"而非"不会发生"。
  const S = (body) => 'files = @(\n' + body + '\n)\n';

  const cases = [
    ['普通两项', S("  'a',\n  'b'"), ['a', 'b']],
    ['单引号内有 @( 和 )', S("  'a',\n  'weird @( x )'"), ['a', 'weird @( x )']],
    ['单引号内有 #（不是注释）', S("  'a#b',\n  'c'"), ['a#b', 'c']],
    ['单引号两个单引号 = 一个', S("  'it''s',\n  'b'"), ["it's", 'b']],
    ['双引号条目', S("  \"a\",\n  'b'"), ['a', 'b']],
    ['双引号内有单引号', S("  \"it's\",\n  'b'"), ["it's", 'b']],
    ['反引号转义 $', S("  \"a`$b\",\n  'c'"), ['a$b', 'c']],
    ['行内注释不产生条目', S("  'a', # 注释'\n  'b'"), ['a', 'b']],
    ['行内注释含不配对 )', S("  'a', # 见 CARD)\n  'b'"), ['a', 'b']],
    ['行内注释含不配对 (', S("  'a', # 见 CARD(\n  'b'"), ['a', 'b']],
    ['单行块注释', S("  'a',\n  <# 'x' #>\n  'b'"), ['a', 'b']],
    ['多行块注释（审查报的最硬假绿）', S("  'a',\n  <# 藏\n     'x'\n  #>\n  'b'"), ['a', 'b']],
    ['块注释里含 # >', S("  'a',\n  <# c#d > e #>\n  'b'"), ['a', 'b']],
    ['条目本身含括号', S("  'a(b)c',\n  'd'"), ['a(b)c', 'd']],
    ['嵌套 @( ) 的条目不算顶层', S("  'a',\n  @('x','y'),\n  'b'"), ['a', 'b']],
    ['嵌套 @{ } 的值不算顶层', S("  'a',\n  @{k='v'},\n  'b'"), ['a', 'b']],
    ['空数组解析成 []（不是 null）', S(''), []],
    ['只有注释也解析成 []', S('  # nothing'), []],
    // 第六轮复核报的 P3-1：这一行 `return null` 原先零覆盖 —— 把它改成
    // `return items;` 整套测试仍全绿（44 条变异里唯一存活的）。
    // 后果是「括号没闭合」会从 fail-closed 退化成"返回半截条目"，
    // 而半截条目会让下游判据误报成"你漏了某个文件"，方向指错比不报更费时间。
    // 用 slice 切掉 S 结尾的 ')'，构造出不闭合的源文本。
    ['括号没闭合 → 解析失败（fail-closed，不是返回半截）', S("  'a'").slice(0, -2), null],
    ['括号没闭合且中间有完整条目 → 仍然失败', S("  'a',\n  'b'").slice(0, -2), null],
    ['锚点在普通字符串里不命中', 'Write-Host "files = @"\n', null],
    ['$files 诱饵不命中（词边界陷阱）', "$files = @('decoy')\n", null],
    ['真锚点在诱饵之后仍能命中', "$files = @('decoy')\nfiles = @(\n  'real'\n)\n", ['real']],
  ];

  for (const [name, src, want] of cases) {
    const got = arrayBlockEntries(src, ANCHOR_NPM_FILES);
    assert.deepEqual(got, want, `解析器在「${name}」上出错：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
  }
});

// ── D19f: 解析器对**真实** release-build.ps1 的解析结果 ───────────────────
// 单独一条、单独 skip 守卫的原因（实测踩到）：
// D19e 的 21 个构造用例全是内联字符串，跑在 npm 包里也应该照常执行；
// 但这一段要读 tools/release-build.ps1 —— 那是维护者工具，**不进 npm 包**。
// 第一版把这段塞在 D19e 末尾且没有守卫，于是真实 tarball 里报
//   ENOENT ... package\tools\release-build.ps1
// 而源码目录全绿 —— 又一条「只在 npm 包里现形」的失败。
// 拆开而不是整条加 skip：构造用例的覆盖不该因为打包形态被一起关掉。
test('D19f: 解析器对真实 release-build.ps1 的解析结果与肉眼一致', { skip: SKIP_DEVONLY }, () => {
  const rb = readFileSync(RELEASE_BUILD, 'utf8');
  const realInc = arrayBlockEntries(rb, ANCHOR_INCLUDE_FILES);
  const realNpm = arrayBlockEntries(rb, ANCHOR_NPM_FILES);

  // 解析失败返回 null —— 先单独判，否则下面 .length 会抛 TypeError 掩盖真因
  assert.notEqual(realInc, null, '$includeFiles 解析失败（锚点失效或括号没闭合）');
  assert.notEqual(realNpm, null, 'files 解析失败（锚点失效或括号没闭合）');

  // 项数也用同一份 WHITELIST_COUNTS —— 原来这里写死 === 9 / === 15，
  // 而 D19b 写的是 >= 9 / >= 15，两处各维护一份数字、口径还不一致：
  // 加条目时只有这边红，把这边改成新数字就绿了，D19b 从不参与（第五轮复核 P1-3）。
  assert.equal(realInc.length, WHITELIST_COUNTS.includeFiles,
    `$includeFiles 应解析出 ${WHITELIST_COUNTS.includeFiles} 项，实际 ${realInc.length}`);
  assert.equal(realNpm.length, WHITELIST_COUNTS.npmFiles,
    `files 应解析出 ${WHITELIST_COUNTS.npmFiles} 项，实际 ${realNpm.length}`);
  assert.ok(realNpm.includes('.gitattributes'), 'files 解析结果里必须含 .gitattributes');

  // 项数对上还不够：抽出来的条目必须是真的文件名，不是注释碎片或哈希表的值。
  // 用「每一项都必须是单段路径或已存在的目录」这条弱不变量兜一下 ——
  // 上一版 matchAll 盲抽若是把注释里的词收进去，这里就会现形。
  for (const entry of realNpm) {
    assert.ok(entry.length > 0, 'files 里不该有空条目');
    assert.ok(!/[\s]/.test(entry), `files 条目不该含空白：${JSON.stringify(entry)}`);
    // ⚠️ 这里原来断言「不得含 `/`」—— 与 D19g 直接矛盾：D19g 明确认定
    // `lib/index.js` 这类子路径是**合法写法**（整个 lib/ 由 $includeDirs 复制）。
    // 第四轮复核实测：把 D19g 声称合法的子路径真写进 release-build.ps1，
    // 这条断言就会红（假红）；反过来、删掉这条后，P1-1 那批假绿立刻全绿 ——
    // 也就是说 P1-1 当时**只被这条理由错误的断言偶然挡着**，判据自己是沉默的。
    // 正确做法是断言"每项都能被 dirWhitelistProblems 解释清楚"，而不是靠形状猜。
    assert.ok(!/^\/|^[A-Za-z]:/.test(entry), `files 条目不该是绝对路径：${JSON.stringify(entry)}`);
  }
});

// ── D19g: 两条判据各自的假红/假绿（第四轮自查揪出来的）──────────────────────
//
// 这两条不是"再找一个攻击"，而是**判据自己错了**的那两种形态。它们比假绿更
// 危险，因为假红会让人去改本来正确的配置，假绿会让真问题藏起来。
test('D19g: B-未复制 不该把「子路径」误判成来源不明', { skip: SKIP_DEVONLY }, () => {
  const rb = readFileSync(RELEASE_BUILD, 'utf8');
  const open = rb.search(ANCHOR_NPM_FILES);
  const close = rb.search(ANCHOR_NPM_KEYWORDS);
  assert.ok(open > 0 && close > open, '锚点失效，无法定位 files 数组');

  const swapInFiles = (from, to) => {
    const blk = rb.slice(open, close);
    assert.ok(blk.includes(from), `files 数组内未命中 ${JSON.stringify(from)}`);
    return rb.slice(0, open) + blk.replace(from, to) + rb.slice(close);
  };

  // 三种「父目录在 $includeDirs 里、files 只是再声明一次某个文件」的合法写法。
  // 它们**确实会被复制**（整个 lib/ 由 $includeDirs 带走），所以不许报 B-未复制。
  // 第五轮实测：没加子路径豁免时，'test/docs-consistency.test.mjs' 会被报成
  // B-未复制 —— 因为 incFileSet 只有 $includeFiles 的顶级文件名。
  //
  // ⚠️ 用例必须用**真实存在**的子路径（第四轮复核后的新判据会查存在性）。
  // 原先把 'locale/zh-CN.json' 当合法样例，但那个文件根本不存在（真实的只有
  // en.json / zh.json）—— 它当时能过，恰恰证明旧豁免是"无条件放行"。
  for (const sub of ['lib/index.js', 'locale/en.json', 'test/docs-consistency.test.mjs']) {
    const probs = dirWhitelistProblems(swapInFiles("    'lib',\n", `    '${sub}',\n`));
    assert.deepEqual(
      probs.filter((p) => p.code === REASON.B_NOT_COPIED).map((p) => p.detail),
      [],
      `files 里写子路径 ${JSON.stringify(sub)} 会被误报 B-未复制（假红）：`
      + '父目录在 $includeDirs 里，该文件本来就会被复制',
    );
  }

  // ⚠️ 上面那条断言的形式是「筛出 B-未复制 后必须为空」。如果这个 code 在任何
  // 输入下都产不出来，它就是**恒真的空过滤** —— 看着绿，其实什么也没验。
  // 所以必须同时给一个"真的该报"的输入，证明同一个实现确实会产出它。
  //
  // 用 CARD.md：源目录里真有这个文件（内部决策文档），但 $includeFiles /
  // $includeDirs / $includeTools 三层都刻意不含它 → 发布目录不会有它，
  // npm 会静默丢弃这一条，用户装了包却没有这个文件。这正是 v0.4.80
  // （漏 jump-handler.vbs）/ v0.5.1（漏 .gitattributes）两次真实事故的同型。
  const attack = dirWhitelistProblems(
    swapInFiles("    'cordis.patch.yml',\n", "    'CARD.md',\n"));
  assert.ok(
    attack.some((p) => p.code === REASON.B_NOT_COPIED),
    '把 files 里的 cordis.patch.yml 换成 CARD.md（存在但三层白名单都不复制）时必须报'
    + ' B-未复制；否则上面那条"必须为空"的断言是恒真空过滤，等于没验',
  );
});

test('D19g: 一条格式错不许把别的目录的漏打包整体藏起来', { skip: SKIP_DEVONLY }, () => {
  const rb = readFileSync(RELEASE_BUILD, 'utf8');
  const open = rb.search(ANCHOR_NPM_FILES);
  const close = rb.search(ANCHOR_NPM_KEYWORDS);
  const dOpen = rb.search(ANCHOR_INCLUDE_DIRS);
  const dClose = rb.search(ANCHOR_INCLUDE_TOOLS);
  assert.ok(dOpen > 0 && dClose > dOpen, '锚点失效，无法定位 $includeDirs 数组');

  // (a) files 里的 lib 写成 'lib '（npm 实测整条丢弃）→ 应报 B-格式
  // (b) 同时给 $includeDirs 加一个 files 里没有的 'newdir' → 应独立报 A-漏打包
  //
  // 旧实现用 `npmHasFormatError` 做全局开关，实测只报 ["B-格式"]，newdir 漏打包
  // 被整体跳过。这类"一个格式错掩盖另一个真问题"在真实维护中极难发现：报错里
  // 只有格式问题，改完格式以为干净了，其实漏打包还在。
  let mut = rb.slice(0, open) + rb.slice(open, close).replace("    'lib',\n", "    'lib ',\n") + rb.slice(close);
  mut = mut.slice(0, dOpen) + mut.slice(dOpen, dClose).replace("  'lib',\n", "  'lib',\n  'newdir',\n")
    + mut.slice(dClose);

  const codes = dirWhitelistProblems(mut).map((p) => p.code);
  // 断言必须**精确**（第四轮复核 P3-1）：原来写的是两条 `codes.includes(...)`，
  // 只要这两个 code 出现过就算过 —— 多报的噪音完全看不见，于是
  // `hasBadFormatOf`（只豁免"同一个目录"的格式错）和 `badFormat → continue`
  // （格式错的条目不再往下归类）这两处改动**都是零覆盖**：把它们删掉，
  // 结果会多出 B-来源不明 / B-不存在，但旧断言照样绿。
  //
  // 精确断言：格式错的 'lib ' 只报 B-格式（不额外报"来源不明"这类噪音），
  // newdir 只报 A-漏打包，两者互不掩盖。多一条少一条都算失败。
  assert.deepEqual(codes.sort(), [REASON.A_NOT_PACKED, REASON.B_FORMAT].sort(),
    `期望恰好 [A-漏打包, B-格式] 两条，实际 [${codes.join(',')}]：`
    + '（a）files 的 \'lib \' 应只报 B-格式，不该再往下被归成 B-来源不明/不存在；'
    + '（b）newdir 必须独立报 A-漏打包，不能被别的条目的格式错整体跳过');
});

// ── D19h: 第四轮只读复核报的两个 P1（子路径豁免、与 D19f 自相矛盾）──────────────
//
// ## P1-1 子路径豁免曾经是「无条件放行」
//
// 我为了消掉一条假红，在 B 组加了：
//   `const slash = n.indexOf('/');`
//   `if (slash > 0 && (dirSet.has(p) || dedicated.has(p))) continue;`
// 它只看父目录在不在名单里，**既不查文件是否存在、也不查它是否真会被复制**。
// 复核用五类条目实测，problems 全部 `[]`：
//   `lib/indx.js`             父目录在，文件拼错
//   `tools/notify-confg.ps1`  父目录在，文件拼错
//   `tools/release-build.ps1` **真实存在、但 $includeTools 有意不发布**的维护者工具
//   `docs/audio-audit/README.md` 父目录在 NPM_DIR_EXCLUSIONS（npm 拿不到）
//   `sounds/does-not-exist.wav`
// 而顶层对照 `zzz-not-exist.ps1` 却正确报 B-不存在 —— 两条路径不一致。
// 复核还用真实插件副本跑 `npm pack`：`files=['lib','tools/release-build.ps1']`
// 时那个维护者工具**真被打进包**，exit 0。
//
// ## P1-2 当时挡住它的是一条理由错误的断言
//
// D19f 里写着 `assert.ok(!entry.includes('/'))`（"files 条目不得含 /"），
// 而 D19g 明确认定 `lib/index.js` 这类子路径合法。两条自相矛盾。
// 删掉 D19f 那条后，上面五类立刻全绿 —— 也就是说判据自己一直是沉默的。
test('D19h: 子路径豁免必须查「存在 + 真的会被复制」', { skip: SKIP_DEVONLY }, () => {
  const rb = readFileSync(RELEASE_BUILD, 'utf8');
  const open = rb.search(ANCHOR_NPM_FILES);
  const close = rb.search(ANCHOR_NPM_KEYWORDS);
  assert.ok(open > 0 && close > open, '锚点失效，无法定位 files 数组');

  // 追加（不是替换）一条 files 条目，这样 A 组不会因为"lib 没了"先红。
  const appendInFiles = (entry) => {
    const blk = rb.slice(open, close);
    assert.ok(blk.includes("    'lib',\n"), 'files 数组内未命中 lib 条目');
    return rb.slice(0, open) + blk.replace("    'lib',\n", `    'lib',\n    '${entry}',\n`) + rb.slice(close);
  };
  const codesOf = (entry) => dirWhitelistProblems(appendInFiles(entry)).map((p) => p.code);

  // ① 父目录在、但文件拼错 → 必须报 B-不存在（"名字写错了"，不是"来源不明"）。
  for (const typo of ['lib/indx.js', 'locale/zh-CN.json']) {
    assert.deepEqual(codesOf(typo), [REASON.B_MISSING],
      `${typo} 父目录会整目录复制但文件本身不存在，必须报 B-不存在`
      + `（实际 ${codesOf(typo).join(',') || '全绿'}）`);
  }

  // ② 真实存在、但**没有哪一层会复制它** → 必须报 B-未复制。
  //    `tools/release-build.ps1` 是维护者工具，$includeTools 只挑 notify-config.ps1；
  //    `docs/audio-audit/README.md` 的父目录在 NPM_DIR_EXCLUSIONS（npm 拿不到）。
  for (const notCopied of ['tools/release-build.ps1', 'docs/audio-audit/README.md']) {
    assert.deepEqual(codesOf(notCopied), [REASON.B_NOT_COPIED],
      `${notCopied} 真实存在但不会被复制进发布目录，必须报 B-未复制`
      + `（实际 ${codesOf(notCopied).join(',') || '全绿'}）—— `
      + '否则用户包里没有它而无人知晓');
  }

  // ③ 反面对照：父目录在 $includeDirs 且文件真实存在的子路径，必须**一条都不报**。
  //    没有这条，"豁免全部删掉"也能让 ①② 变红（假绿验证）。
  for (const ok of ['lib/index.js', 'test/docs-consistency.test.mjs']) {
    assert.deepEqual(codesOf(ok), [],
      `${ok} 是合法子路径（父目录整目录复制 + 文件存在），不该报任何问题`
      + `（实际 ${codesOf(ok).join(',')}）`);
  }
});

// ── D19i: B-格式 的四条判据必须按 npm 实测来写，且每条都被守住 ──────────────
//
// 第四轮复核报 P2-1：`badFormat` 的四个条件**全部零覆盖** —— 把它们逐个关掉，
// 仍然 28/28 全绿。复核还实测出我凭直觉写的两条判据是错的：
//   'lib/'  '/lib'   → npm **正常打包**，我却报 B-格式（假红，且错误文案说"npm 会整条丢弃"）
//   'lib/.'          → npm 整条丢弃，我却不认这条形态（假绿）
// 于是我按 `npm pack --dry-run --json` 逐个实测重写了四条件（探针记录见 badFormat 上方）。
// 这条用例把"哪些必须红、哪些必须绿"钉死，防止以后凭直觉再改回去。
test('D19i: files 条目的格式判据必须与 npm 实测一致', { skip: SKIP_DEVONLY }, () => {
  const rb = readFileSync(RELEASE_BUILD, 'utf8');
  const open = rb.search(ANCHOR_NPM_FILES);
  const close = rb.search(ANCHOR_NPM_KEYWORDS);
  assert.ok(open > 0 && close > open, '锚点失效，无法定位 files 数组');

  // 用"替换 lib 这一条"来注入，项数守恒（避开 D19f 的 15 条硬编码）。
  const swapLib = (entry) => {
    const blk = rb.slice(open, close);
    assert.ok(blk.includes("    'lib',\n"), 'files 数组内未命中 lib 条目');
    return rb.slice(0, open) + blk.replace("    'lib',\n", `    ${entry}\n`) + rb.slice(close);
  };
  const codesOf = (entry) => dirWhitelistProblems(swapLib(entry)).map((p) => p.code);

  // ① npm 实测会**整条丢弃**的形态 → 必须报 B-格式（缺一条就等于放过一次静默丢包）
  const mustRed = [
    ["'lib '", '首尾空白'],
    ["'lib\\\\'", '反斜杠'],
    ["'C:/temp/lib'", '盘符绝对路径'],
    ["'lib/.'", '末尾 /.（实测包里没有 lib/）'],
  ];
  for (const [entry, why] of mustRed) {
    assert.ok(codesOf(entry).includes(REASON.B_FORMAT),
      `${entry}（${why}）npm 实测会整条丢弃，必须报 B-格式`
      + `（实际 ${codesOf(entry).join(',') || '全绿'}）`);
  }

  // ② npm 实测**正常打包**的形态 → 一条都不许报（假红会让人去改本来对的配置）
  //    注：'lib/'、'/lib'、'lib//' 都实测正常打包，我第一版全判成了错。
  const mustGreen = ["'lib/'", "'/lib'", "'lib//'", "'./lib'"];
  for (const entry of mustGreen) {
    assert.deepEqual(codesOf(entry), [],
      `${entry} npm 实测正常打包，不该报任何问题（实际 ${codesOf(entry).join(',')}）`);
  }

  // ③ 通配是合法写法，但"匹配不到任何文件"的通配要报出来。
  //    这里必须用**追加**而不是替换：替换掉 'lib' 会让 A 组先报"A-漏打包"，
  //    测的就不是通配这一路了（我第一版就写错了）。
  const appendInFiles = (entry) => {
    const blk = rb.slice(open, close);
    assert.ok(blk.includes("    'lib',\n"), 'files 数组内未命中 lib 条目');
    return rb.slice(0, open) + blk.replace("    'lib',\n", `    'lib',\n    '${entry}',\n`) + rb.slice(close);
  };
  // ③ 的两条断言要靠 fs.globSync 才能判"这个通配到底匹配不匹配得到东西"。
  //    Node 20 没有这个 API（见文件头 getGlobSync 的说明），此时无法验证，
  //    只能显式跳过 —— 让它在 Node 20 上"看起来绿"是误报，让它红是假红，
  //    两者都比"写清楚这里没验"更糟。
  if (getGlobSync()) {
    assert.deepEqual(dirWhitelistProblems(appendInFiles('*.md')).map((p) => p.code), [],
      "files 里的 '*.md' 能匹配到文件，npm 正常打包，不该报错");
    assert.ok(dirWhitelistProblems(appendInFiles('*.nonexistent-ext')).map((p) => p.code)
      .includes(REASON.B_MISSING),
    '匹配不到任何文件的通配应当报 B-不存在（等于这一条什么也没声明）');
  }
});

// ── D19j: 点号段 / 越界段（第五轮只读复核报的两个 P0）─────────────────────
//
// 这两个 P0 的共同点：判据**沉默**，而 npm 实际做了坏事。上一版只认 `endsWith('/.')`，
// 于是：
//   · `lib/./`、`lib/./x.js` → npm 整条丢弃（包里 lib 一个文件都没有）
//   · `lib/..`              → npm 把**上层目录整个打进包**（实测 124 个文件，含
//                             .gitattributes / .github/workflows/** / CARD.md /
//                             docs/** / test/** / tools/release-build.ps1）
//     `lib/../CARD.md`、`lib/../docs` 同理。
//
// 后者比前者危险得多：丢包用户会发现功能坏了，泄漏是**悄悄把内部资料发出去**。
//
// 这里的期望值全部来自 `npm pack --dry-run --json` 实测（夹具＝真实插件目录副本），
// 不是凭直觉写的。改动本用例前请先重跑一遍探针。
test('D19j: 点号段与越界段必须按 npm 实测判红', { skip: SKIP_DEVONLY }, () => {
  const rb = readFileSync(RELEASE_BUILD, 'utf8');
  const open = rb.search(ANCHOR_NPM_FILES);
  const close = rb.search(ANCHOR_NPM_KEYWORDS);
  assert.ok(open > 0 && close > open, '锚点失效，无法定位 files 数组');

  const swapLib = (entry) => {
    const blk = rb.slice(open, close);
    assert.ok(blk.includes("    'lib',\n"), 'files 数组内未命中 lib 条目');
    return rb.slice(0, open) + blk.replace("    'lib',\n", `    '${entry}',\n`) + rb.slice(close);
  };
  const codesOf = (entry) => dirWhitelistProblems(swapLib(entry)).map((p) => p.code);
  // 理由文字也要能取出来：B-格式 这一个 code 覆盖了多种**相反**行为
  // （整条丢弃 vs 整包泄漏），只断言 code 时把两者说反也能过 —— 变异验证实测过。
  const detailsOf = (entry) => dirWhitelistProblems(swapLib(entry))
    .filter((p) => p.code === REASON.B_FORMAT)
    .map((p) => p.detail);

  // ① npm 实测**整条丢弃**的点号形态 —— 上一版全部漏报（P0-1）
  for (const entry of ['lib/./', 'lib/.//', 'lib/././', 'lib/./x.js', './lib/.']) {
    assert.ok(codesOf(entry).includes(REASON.B_FORMAT),
      `'${entry}' npm 实测整条丢弃（包里没有 lib/），必须报 B-格式`
      + `（实际 ${codesOf(entry).join(',') || '全绿'}）`);
  }

  // ② npm 实测**逃出包目录、把上层打进包**的形态 —— 上一版完全没管（P0-2）
  //
  //    ⚠️ 与 ③ 同理，必须钉理由而不是只钉 code：`..` 和 `.` 在同一个 badFormat 里，
  //    都报 B-格式，但行为**相反**（`..` 是泄漏、`.` 是丢弃）。
  //    第六轮复核实测：把 `..` 的理由说成「整条丢弃」→ 全绿（只断 code 看不出来）。
  //    同族的 `.` 段反过来改就会被拦（见下面「路径段里有 `.`」那条的变异记录），
  //    说明这不是断言风格问题，是这条真的漏钉了。
  for (const entry of ['lib/..', 'lib/../CARD.md', 'lib/../docs']) {
    const codes = codesOf(entry);
    assert.ok(codes.includes(REASON.B_FORMAT),
      `'${entry}' npm 实测会把上层目录打进发布包（内部资料泄漏），必须报 B-格式`
      + `（实际 ${codes.join(',') || '全绿'}）`);
    const why = detailsOf(entry).join(' ');
    // 主干必须说清是「打进/泄漏」而不是「丢弃」。
    assert.match(why, /打进发布包/,
      `'${entry}' 的理由必须说清是「把上游目录打进发布包」（实际 ${why || '无理由'}）`);
    // 反向词必须不在：否则「整条丢弃」这种把泄漏说反的写法照样能过。
    assert.doesNotMatch(why, /丢弃/,
      `'${entry}' 是泄漏，理由里不该出现「丢弃」——把泄漏说成丢弃是最危险的误导`
      + `（实际 ${why || '无理由'}）`);
  }

  // ③ 前导斜杠叠层：'./lib'、'/lib' 正常（已由 D19i 的 mustGreen 钉住），
  //    但 '././lib'、'.//lib'、'/./lib'、'//lib' 实测整条丢弃。
  //
  //    ⚠️ 断言必须钉到**具体理由**，不能只钉 B-格式 这个 code。
  //    实测：这四种写法即使删掉「前导斜杠叠层」那条分支，也会被后面的
  //    「`.` 段」或「中间空段」规则兜住，仍然报 B-格式 —— 只是理由变成
  //    另一个（变异验证：拆掉分支时 fail=0，看起来像判据无关紧要）。
  //    所以按"哪种写法由哪条规则解释"分开钉，理由对不上就算红。
  const EXPECT_SLASH = [
    ['.//lib', /前导斜杠叠了/],
    ['//lib', /前导斜杠叠了/],
    ['././lib', /路径段里有 `\.`/],
    ['/./lib', /路径段里有 `\.`/],
  ];
  for (const [entry, re] of EXPECT_SLASH) {
    const codes = codesOf(entry);
    assert.ok(codes.includes(REASON.B_FORMAT),
      `'${entry}' 前导斜杠/点叠层，npm 实测整条丢弃，必须报 B-格式`
      + `（实际 ${codes.join(',') || '全绿'}）`);
    const why = detailsOf(entry).join('\n');
    assert.match(why, /整条丢弃/,
      `'${entry}' 的理由必须说清是「整条丢弃」（实际 ${why || '无理由'}）`);
    assert.match(why, re,
      `'${entry}' 的理由必须落到 ${re} 这条规则上`
      + `（实际 ${why || '无理由'}）—— 不对说明该分支被删或被别的规则顶替了`);
  }

  // ③b 纯斜杠写法（'//' '///' '////'）与上一条**行为相反**：npm 把它当根目录，
  //     实测打包 125 个文件 —— 把 .github/ docs/ CARD.md 等内部资料一起发出去。
  //     这条必须单独钉，且理由必须说清是"泄漏"不是"丢弃"。
  //
  //     ⚠️ 断言必须拆成三条互相**排斥**的，不能写成 `/整个仓库|内部资料/` 这种"或"。
  //     第六轮复核实测：把整条理由换成「整条只有斜杠（npm 会整条丢弃，不涉及内部资料）」——
  //     主干完全说反、还明说不涉及内部资料——仍然全绿，只因句尾残留「内部资料」四字。
  //     "或"关系等于给判据留了一条只靠一个词就能蒙过去的路。
  for (const entry of ['//', '///', '////']) {
    const codes = codesOf(entry);
    assert.ok(codes.includes(REASON.B_FORMAT),
      `'${entry}' npm 实测把整个仓库打进包，必须报 B-格式（实际 ${codes.join(',') || '全绿'}）`);
    const why = detailsOf(entry).join(' ');
    // ① 必须说清会打进发布包
    assert.match(why, /打进发布包/,
      `'${entry}' 的理由必须说清是「会把整个仓库打进发布包」`
      + `（实际 ${why || '无理由'}）`);
    // ② 必须点出至少一类具体内部资料，光说"整个仓库"不够具体
    assert.match(why, /内部资料|docs\/|\.github\//,
      `'${entry}' 的理由必须点出具体泄漏了什么（内部资料 / docs/ / .github/）`
      + `（实际 ${why || '无理由'}）`);
    // ③ 反向词必须不在：说成"丢弃"就是把最危险的泄漏描述成无害的丢包
    assert.doesNotMatch(why, /丢弃/,
      `'${entry}' 是泄漏不是丢包，理由里不该出现「丢弃」`
      + `（实际 ${why || '无理由'}）`);
  }

  // ④ npm 永不打包的名字：写成 files 条目等于什么也没声明。
  for (const entry of ['lib/.git', 'lib/node_modules', '.git']) {
    assert.ok(codesOf(entry).includes(REASON.B_FORMAT),
      `'${entry}' 是 npm 永不打包的名字，必须报 B-格式（实际 ${codesOf(entry).join(',') || '全绿'}）`);
  }

  // ⑤ 尾部空段合法（'lib/'、'lib//' 实测正常打包），中间空段非法。
  //    这两条一起钉住"剥结尾空段、再看中间"的实现，防止改回一律判空段。
  for (const entry of ['lib/', 'lib//', 'lib///']) {
    assert.deepEqual(codesOf(entry), [],
      `'${entry}' 尾部空段 npm 实测正常打包，不该报任何问题（实际 ${codesOf(entry).join(',')}）`);
  }
  for (const entry of ['lib//x.js', './/lib']) {
    assert.ok(codesOf(entry).includes(REASON.B_FORMAT),
      `'${entry}' 中间空段 npm 实测整条丢弃，必须报 B-格式（实际 ${codesOf(entry).join(',') || '全绿'}）`);
  }

  // ⑥ 大小写：Windows 能打包、CI/Linux 会丢 —— 既不能放过，也不能说成"来源不明"。
  //    断言里必须点明原因，否则维护者会去改 $includeDirs（错的地方）。
  const upper = dirWhitelistProblems(swapLib('LIB'));
  assert.deepEqual(upper.map((p) => p.code), [REASON.B_FORMAT],
    "files 写 'LIB' 只该报 B-格式（Windows 能打包、Linux 会丢），"
    + `不该再附带别的归类（实际 ${upper.map((p) => p.code).join(',')}）`);
  assert.match(upper[0].detail, /大小写|Linux/i,
    'B-格式 的说明里必须点出"大小写 / CI Linux 会丢"，否则维护者不知道为什么要改');
});

// ── D19k: 两条「无人判红」的产出点补上覆盖 ──────────────────────────────
//
// 用「逐个删掉每个判据产出点、看有没有测试变红」的方式扫了全文件 31 个产出点
// （<scratch>/myrepro/sweep-coverage.mjs），抓到 **2 个零覆盖**：
//   · `$includeFiles` 条目用反斜杠 → B-格式（正则在 js 里写成 '\\' 才是 1 个反斜杠，
//     历史上很容易写成需要 2 个，导致永远不命中，而且没有任何测试会发现）
//   · `BUILD_GENERATED_ENTRIES` 登记了但不在 files 里 → B-来源不明
// 两条规则本身是好的（实测都能产出），只是**没人钉住它们**——
// 删掉也全绿，等于这两条判据随时可能被无意中改坏而无人知晓。
test('D19k: 反斜杠与「登记了却不打包」两条判据必须有覆盖', { skip: SKIP_DEVONLY }, () => {
  const rb = readFileSync(RELEASE_BUILD, 'utf8');

  // ① $includeFiles 用反斜杠 → 必须报 B-格式。
  //    注意 PowerShell 里写的是单反斜杠（'tools\notify-config.ps1'），
  //    在 js 字符串字面量里要写成 '\\'。
  {
    const iOpen = rb.search(ANCHOR_INCLUDE_FILES);
    const iClose = rb.search(ANCHOR_INCLUDE_DIRS);
    assert.ok(iOpen >= 0 && iClose > iOpen, '锚点失效，无法切出 $includeFiles 段');
    const incBlock = rb.slice(iOpen, iClose);
    const from = "  'tts-speak.ps1',";
    assert.ok(incBlock.includes(from), `$includeFiles 段内未命中 ${JSON.stringify(from)}`);

    const mut = rb.slice(0, iOpen)
      + incBlock.replace(from, "  'tools\\notify-config.ps1',")   // 1 个反斜杠
      + rb.slice(iClose);
    const hit = dirWhitelistProblems(mut).filter((p) => p.code === REASON.B_FORMAT);
    assert.equal(hit.length, 1,
      '$includeFiles 里出现反斜杠路径时必须恰好报 1 条 B-格式'
      + `（实际 ${hit.length} 条）—— 0 条说明判据里的转义写错了（要 1 个反斜杠却写成 2 个），`
      + '这种错永远不会自己暴露');
    assert.match(hit[0].detail, /反斜杠/,
      `理由必须点明是反斜杠（实际 ${hit[0].detail}）`);
  }

  // ② BUILD_GENERATED_ENTRIES 登记了但 files 里删掉 → 必须报 B-来源不明。
  //    这是"登记了却不打包，等于没登记"那一支，之前完全没覆盖。
  {
    const fOpen = rb.search(ANCHOR_NPM_FILES);
    const fClose = rb.search(ANCHOR_NPM_KEYWORDS);
    assert.ok(fOpen >= 0 && fClose > fOpen, '锚点失效，无法切出 files 段');
    const blk = rb.slice(fOpen, fClose);
    assert.ok(blk.includes("'CHANGELOG.md'"),
      'files 段内未命中 CHANGELOG.md —— 若确实移除了它，请同步改本条用例的构造');

    const mut = rb.slice(0, fOpen) + blk.replace(/\s*'CHANGELOG\.md',/, '') + rb.slice(fClose);
    const hit = dirWhitelistProblems(mut).filter((p) => p.code === REASON.B_UNSOURCED);
    assert.equal(hit.length, 1,
      'BUILD_GENERATED_ENTRIES 里的条目从 files 移除后，必须报 1 条 B-来源不明'
      + `（实际 ${hit.length} 条）—— 否则"登记了却不打包"这一支被删掉也没人发现`);
    assert.match(hit[0].detail, /CHANGELOG\.md/,
      `理由必须点名是哪个条目（实际 ${hit[0].detail}）`);

    // 反面对照：不动 files 时必须不报，防这条断言变成"永远报红"。
    assert.deepEqual(
      dirWhitelistProblems(rb).filter((p) => p.code === REASON.B_UNSOURCED), [],
      '未做任何改动时不该报 B-来源不明（否则上面那条是恒真的）',
    );
  }
});

// ── D20: engines.dsh 必须准确（市场用它决定"能不能装"）───────────────────
//
// ## 为什么这条重要（2026-10-20 发现插件已被市场收录）
//
// 本机 `profiles/desktop/.dsh-market/discovery-compatibility-v1.json`
// 里有 **3138 个条目**，其中包含 dsh-notify-say —— 市场是**全量扫描 npm**
// 上的 dsh 插件自动收录的，不是人工登记。
//
// 它抓的正是 `package.json` 的 `engines.dsh`：
//
//     "dsh-notify-say": {
//       "facts": { "version": "0.4.82", "enginesDsh": ">=0.1.7-rc.2" }
//     }
//
// DSH 的 plugin-manager 用这个字段做兼容校验（源码里有
// `requirements` / `incompatible` 结构）。**声明错了，市场就会
// 告诉不兼容的用户"能装"**，装完才发现坏。
//
// ## 原来错在哪
//
// 我们写的是 `>=0.1.7-rc.2`，但**从未在 0.1.7 上测过**（实测是 0.2.1-rc.2）。
// 而且没有上界 —— 0.3.0 若有破坏性改动，市场仍会说兼容。
//
// 生态惯例（本机市场缓存里实测）：主要插件都写 `>=X <0.3.0`，例如
//     dsh-plugin-resolver     >=0.2.0-rc.2 <0.3.0
//     dsh-dania-voice         >=0.1.7-rc.1 <0.3.0-0
//     dsh-gui-auth-url        >=0.2.1-rc.2 <0.3.0-0
test('D20: engines.dsh 必须有实测下界 + 上界，且与 README 一致', () => {
  const engines = PKG.engines || {};
  const dshRange = String(engines.dsh || '');

  assert.ok(dshRange, 'package.json 必须有 engines.dsh —— 市场靠它判断兼容性');

  // 必须有上界。没有上界 = 声称"未来所有版本都兼容"，这是不实声明
  assert.match(dshRange, /<\s*[\d.]+/,
    `engines.dsh 必须有上界（当前: ${dshRange}）—— 否则 DSH 大版本不兼容时，`
    + '市场仍会告诉用户"能装"');

  // 下界不能低于实测版本。实测环境是 0.2.1-rc.2
  const m = dshRange.match(/>=\s*([\d.]+(?:-[\w.]+)?)/);
  assert.ok(m, `engines.dsh 应有 >= 下界（当前: ${dshRange}）`);
  const lower = m[1];
  // 只做"不低于 0.2.1"的粗判（精确 semver 比较不必在这里实现）
  assert.ok(
    /^0\.[2-9]\./.test(lower) || /^[1-9]/.test(lower),
    `engines.dsh 的下界 ${lower} 低于实测版本 0.2.1-rc.2 —— ` +
    '声明支持未测过的版本等于让用户当小白鼠',
  );

  // README 必须与 engines 一致（不能一处说 0.2.1、另一处说 0.1.7）
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /0\.2\.1-rc\.2/,
    'README 必须写明实测的 DSH 版本');
  assert.doesNotMatch(readme, /0\.1\.7-rc\.2 或更高/,
    'README 不能再说"0.1.7-rc.2 或更高" —— 那个版本没测过');
});

// ── D21: 发布包生成的 package.json 必须是纯 LF ────────────────────────────
//
// ## 这条是 2026-10-25 在**发布包里**跑测试时抓出来的
//
// `release.ps1` 第 3.5 步会「在发布包里跑一遍 npm run test:all」（模拟 CI 的
// 真实环境）。D16b 在那里红了：
//
//     共扫描 107 个文件，违规 1 个: package.json
//
// 根因不在 D16b，而在生成端 —— `release-build.ps1` 用
// `ConvertTo-Json` 产出 JSON，而它**在 PowerShell 5.1 和 7.6 上都输出 CRLF**
// （实测 `.Contains([char]13)` 为 True）。于是：
//
//     源仓 package.json      纯 LF（.gitattributes 的 `*.json text eol=lf`）
//     发布包 package.json    CRLF     ← ConvertTo-Json 写出来的
//     npm 上 v0.5.2 那份     CRLF     ← 实测 CR=77，历史产物一直如此
//
// 站内 D16 系列只查**源目录**，所以这个差异从来没在开发机上暴露过；
// 只有「在发布包里跑测试」那一步才看得见。这属于"我们的产物与我们声称的
// 字节不一致"，正是 .gitattributes 注释里写明要杜绝的事。
//
// ## 为什么用静态判据而不是真跑一次 release-build
//
// 真跑一次实测 4.03 秒（复制 138 个文件 + 语音包筛选 + git log 生成 CHANGELOG），
// 超出日常检查器 ≤3 秒的预算，且会往磁盘写 6 MB。所以这里只静态断言
// 「归一化那一行还在、并且排在 WriteAllText 之前」；
// 真正的端到端证据由 `release.ps1` 的第 3.5 步（在发布包里跑全量测试）提供。
test('D21: 生成 package.json 前必须把行尾归一成 LF', { skip: SKIP_DEVONLY }, () => {
  const rb = readFileSync(RELEASE_BUILD, 'utf8');

  // ① 归一化语句必须存在
  const NORMALIZE = /^\$json\s*=\s*\$json\s*-replace\s+"`r`n"\s*,\s*"`n"/m;
  const mNorm = rb.match(NORMALIZE);
  assert.ok(mNorm,
    'release-build.ps1 里找不到把 $json 行尾归一成 LF 的语句。\n'
    + 'ConvertTo-Json 在 PowerShell 5.1 与 7.6 上都输出 CRLF，'
    + '不归一化就会让发布包/npm 上的 package.json 与源仓字节不同'
    + '（2026-10-25 实测 v0.5.2 的 npm 包 CR=77）。');

  // ② 它必须排在写 package.json 之前 —— 否则"归一化了但没写进去"
  const iNorm = rb.indexOf(mNorm[0]);
  const NORM_NOTE = '归一化语句必须出现在写 package.json 之前，否则等于没生效';
  const writePj = rb.indexOf("WriteAllText((Join-Path $Destination 'package.json')");
  assert.ok(writePj > 0,
    '找不到写 package.json 的 WriteAllText —— 若生成方式变了，请同步改本条用例');
  assert.ok(iNorm < writePj, NORM_NOTE);

  // ③ 归一化之后不许再整体重赋 $json —— 否则归一化会被后面那行覆盖掉。
  //    ⚠️ 第一版这里写成 `/\$json\s*=\s*(?!\$json)/`，**判据本身是错的**：
  //    `\s*` 可以回溯到只匹配 0 个字符，负向先行断言落在空格上就通过了，
  //    于是 `$json = $json -replace ...` 这**唯一合法**的形态反被判违规（假红）。
  //    改成数赋值次数：区间内 `$json =` 只该出现 1 次（即归一化那行自己的左边）。
  const tail = rb.slice(iNorm, writePj);
  const assigns = tail.match(/\$json\s*=/g) || [];
  assert.equal(assigns.length, 1,
    '归一化语句与写入之间又出现了 $json 赋值（共 ' + assigns.length + ' 处 '
    + '`$json =`，只该有归一化那一处） —— 后赋值会把归一化结果覆盖掉');

  // ④ 写入用的必须就是 $json 本身（不是被改名/被换掉的另一个变量）
  const writeStmt = rb.slice(writePj, writePj + 200);
  assert.ok(/\$json\s*\+/.test(writeStmt),
    '写 package.json 时用的不是 $json —— 归一化作用不到真正落盘的字节上');

  // ④ 反向证明：把归一化那行删掉，判据必须能报红
  //    （照搬 D19d 的做法：不能只有"看起来还在"，要能证明它真的会失败）
  {
    const mutated = rb.replace(mNorm[0], '# [D21 变异：删掉归一化]');
    assert.notEqual(mutated, rb, 'D21 变异未生效 —— 正则与真实源码不匹配');
    assert.ok(!NORMALIZE.test(mutated),
      'D21 的判据抓不住"归一化被删掉"这种情况，等于装饰');
  }
});
