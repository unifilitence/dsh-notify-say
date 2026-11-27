/**
 * 空闲门契约测试（防回归：这些规则每一条都对应一次真实事故）。
 *
 * ## 历史
 *
 * · v0.4.65：删除 `lastTurn` 递增判定（被实测证伪）→ K3 反过来断言它不许回来。
 * · v0.5.11：把"看到空闲就播"改成"静默期判定"（尾沿防抖）。原因：DSH 的
 *   `agent/status=idle` 比结算消息投递早 139~172ms，那一刻从任何单一快照看
 *   都是"真空闲"，于是旧实现立刻播「完成」，而父代理随即被叫起来继续干
 *   （用户原话："主代理还没开始，这个时候它会播报一次，这应该算是误播"）。
 *   对应新增 K13~K18，并把 K1/K2/K4/K5/K7/K12 的锚点从 reevaluatePending
 *   挪到 gateHoldReason / 新签名上。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { quietVerdict, quietBackoffMs } from '../lib/index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = readFileSync(join(ROOT, 'lib/index.js'), 'utf8');

/**
 * 取出一个函数的源码文本。
 *
 * ## 为什么不用「找 indent + '}'」（v0.4.84 改）
 *
 * 原实现按「缩进相同且该行只有 `}`」找终点。这依赖一个隐含假设：
 * **函数体内部不会出现独立成行的 `}`**。一旦有人写出格式化的空对象：
 *
 *     const opts = {
 *     }
 *
 * 就会被误判成函数结束，`fnBody` 返回**截断的半截函数**，
 * 于是下面所有 `assert.doesNotMatch` 都对着半截文本做判断 ——
 * **测试从"能抓到回归"退化成"永远通过"**，而且没有任何报错。
 *
 * 2026-10-20 我正因同类写法（找 indent 边界）在改 `index.js` 时
 * 误删了整个 `registerJumpProtocol`，所以这里改用**花括号配平**。
 *
 * 配平算法对注释里的 `}` 也不敏感（注释里的花括号会参与计数，
 * 但只要代码本身配平，结果仍然正确）。
 */
function fnBody(sig) {
  const lines = INDEX.split(/\r?\n/);
  const i = lines.findIndex((l) => l.includes(sig));
  assert.ok(i >= 0, '找不到函数: ' + sig);

  let depth = 0;
  let started = false;
  let end = -1;
  for (let k = i; k < lines.length; k++) {
    for (const ch of lines[k]) {
      if (ch === '{') { depth++; started = true; }
      else if (ch === '}') { depth--; }
    }
    if (started && depth === 0) { end = k; break; }
  }
  assert.ok(end > i, '找不到函数终点: ' + sig);

  // 护栏：截断会静默削弱断言，这里主动拦一次。
  // 判据：函数体最后一行应当只有 `}`（允许缩进）。
  assert.match(
    lines[end].trim(), /^\}$/,
    `${sig} 的终点行不像函数结束（实际: ${JSON.stringify(lines[end].trim())}）`
    + ' —— 花括号可能不配平，或者这里有语法问题',
  );
  return lines.slice(i, end + 1).join('\n');
}

// ══ 已删除的规则（反断言，防回归）══════════════════════════════════════
test('K3: 不得再用 lastTurn 递增判定「用户新消息」（已实测证伪）', () => {
  const body = fnBody('function gateHoldReason(id, trigger) {');
  assert.doesNotMatch(body, /tb\.lastTurn\s*>\s*p\.lastTurn/,
    'lastTurn 递增不能当用户输入证据 —— 主 Agent 处理子任务返回时内部续跑也会递增');
});

test('K3b: 不得出现「pending dropped: new turn started」的日志', () => {
  // 该日志随判定一起删除。若它回来，说明有人把误判加回去了。
  assert.doesNotMatch(INDEX, /pending dropped: new turn started/,
    '这条日志对应被证伪的判定，不该存在');
});

// ══ 保留的规则 ═════════════════════════════════════════════════════════
test('K1: 不得因 agent.status === running 就 clearPending', () => {
  const body = fnBody('function gateHoldReason(id, trigger) {');
  assert.doesNotMatch(body, /agent\.status\s*===\s*'running'\)\s*\{\s*clearPending/,
    '主 Agent 处理子任务返回时也是 running（T3 的规则）');
});

test('K2: agent 拿不到时必须保留（返回原因码），不能 flush 也不能进静默期', () => {
  const body = fnBody('function gateHoldReason(id, trigger) {');
  const idx = body.indexOf('if (!agent)');
  assert.ok(idx > 0, '要有 agent 判空');
  const seg = body.slice(idx, idx + 400);
  assert.match(seg, /return 'agent-unavailable'/, 'agent 读不到 ≠ 完成，必须保留（T12）');
  assert.doesNotMatch(seg, /flushPending/, 'agent 读不到时绝不能 flush');
  assert.doesNotMatch(seg, /armQuiet/, 'agent 读不到时也不能进静默期（白等一轮还会播错）');
});

test('K4: 轮次还开着（open !== null）→ 保留，不播', () => {
  const body = fnBody('function gateHoldReason(id, trigger) {');
  assert.match(body, /tb\.open\s*!==\s*null/, '要有"轮次进行中"判定（T3）');
  const idx = body.indexOf('tb.open !== null');
  const seg = body.slice(idx, idx + 200);
  assert.match(seg, /return 'turn-open'/, '轮次开着要继续等');
});

test('K5: 判据全过也不许直接播 —— 必须先过静默期（v0.5.11）', () => {
  // ① 判据本身必须是纯判定，不许顺手播报（否则"到点重跑判据"会播两次）
  const hold = fnBody('function gateHoldReason(id, trigger) {');
  assert.match(hold, /inflight\.length > 0/, '要有在飞判定（T7）');
  assert.doesNotMatch(hold, /flushPending/, 'gateHoldReason 只回答"能不能播"，不许产生副作用');
  assert.doesNotMatch(hold, /armQuiet/, '同上：起窗不是判据的职责');

  // ② 重估路径必须先进静默期，绝不能再出现"判据过了就 flush"
  const re = fnBody('function reevaluatePending(trigger) {');
  assert.match(re, /gateHoldReason\(id, trigger\) !== null\) continue;/, '先跑判据');
  assert.match(re, /armQuiet\(id\)/, '判据全过 → 进静默期');
  assert.doesNotMatch(re, /flushPending/,
    '静默期内直接播报就是误播入口（DSH 先 idle、139ms 后才投递结算消息）');
});

test('K6: 超时走 onIdleGateTimeout（进度提醒），不直接消耗完成通知', () => {
  // 定时器必须指向 onIdleGateTimeout
  assert.match(INDEX, /setTimeout\(\(\) => \{ try \{ onIdleGateTimeout\(id\); \}/,
    '超时定时器必须走进度提醒路径');

  const body = fnBody('function onIdleGateTimeout(id) {');
  assert.match(body, /progressNotified/, '进度提醒最多一次');
  assert.match(body, /这不是完成提醒/, '文案必须明确否定"完成"');
  // 关键：进度提醒路径不能 delete pending
  const progressBranch = body.slice(body.indexOf('if (!p.progressNotified)'), body.indexOf('recheckTimer'));
  assert.doesNotMatch(progressBranch, /pendingDone\.delete/,
    '进度提醒**不得**消耗 pending —— 真正完成时还要再播一次');
});

test('K7: flushPending 不再接受 viaTimeout；但必须记录静默期账目', () => {
  const body = fnBody('function flushPending(id, quiet) {');
  assert.doesNotMatch(body, /viaTimeout/,
    'viaTimeout 已拆到 onIdleGateTimeout，flushPending 只管"真完成"');
  assert.match(body, /worktree-idle/, 'flush 的 reason 固定是 worktree-idle');
  // v0.5.11：误播/延迟排查全靠这两个字段
  assert.match(body, /quiet=\$\{quietMs\}/, '日志要记 quiet=<ms>');
  assert.match(body, /resets=\$\{resets\}/, '日志要记 resets=<次数>');
  assert.match(body, /clearTimeout\(p\.quietTimer\)/, '放行时必须把静默期定时器一并清掉');
});

test('K8: turnBoundaryOf 读不到要返回 null', () => {
  const body = fnBody('function turnBoundaryOf(session) {');
  assert.match(body, /catch/, '必须自己兜异常');
  assert.match(body, /return null/, '失败返回 null');
  assert.match(body, /openTurnStartSeq/, '要读 openTurnStartSeq');
});

test('K9: 对齐官方 hasDesktopActiveTasks —— 要查 inbox 排队', () => {
  const body = fnBody('function inFlightOf(agent) {');
  assert.match(body, /inbox/, '官方还会查 agent.inbox.nextTurn / nextStep（防"刚播完成又开始干"）');
  assert.match(body, /nextTurn/, '要查 nextTurn');
  assert.match(body, /nextStep/, '要查 nextStep');
});

test('K10: inbox 读不到时不能判定"有活"（防永远不播）', () => {
  const body = fnBody('function inFlightOf(agent) {');
  const idx = body.indexOf('inbox');
  assert.ok(idx > 0);
  // 该段必须包在 try/catch 里，且注释说明"读不到不算有活"
  const seg = body.slice(Math.max(0, idx - 400), idx + 800);
  assert.match(seg, /catch/, 'inbox 读取要兜异常');
});

// ══ 互斥（2026-10-19 真机抓到重复播报）══════════════════════════════════
test('K11: emitDone 必须有事件级互斥（同一 evKey 只播一次）', () => {
  const body = fnBody('function emitDone(session, psKind, title, body, evKey) {');
  assert.match(body, /lastEmittedKey/, '要有事件级去重表');
  assert.match(body, /seen === evKey/, '同一 evKey 要拦下');
  assert.match(body, /duplicate-event/, '拦下时要留痕');
});

test('K12: 两条播报路径必须用同一个 evKey（同一轮互斥）', () => {
  // scheduleOrNotify 生成的 evKey
  const sched = fnBody('function scheduleOrNotify(session, agent, psKind, title, body) {');
  assert.match(sched, /const evKey = tbNow \?/, 'scheduleOrNotify 要生成 evKey');
  assert.match(sched, /emitDone\(session, psKind, title, body, evKey\)/, '直接播报要带 evKey');
  assert.match(sched, /evKey,/, 'pending 要存 evKey');

  // flushPending 用 pending 里存的 evKey
  const flush = fnBody('function flushPending(id, quiet) {');
  assert.match(flush, /p\.evKey/, 'flush 要用 pending 里的 evKey');
});

// ══ v0.5.11：静默期（尾沿防抖）══════════════════════════════════════════
test('K13: 静默期只用单调 activitySeq，不读墙钟算剩余时间', () => {
  const mark = fnBody('function markActivity() {');
  assert.match(mark, /activitySeq \+= 1/, '活动边沿必须递增序号');
  assert.doesNotMatch(mark, /Date\.now/, '不得用墙钟：校时/改表会让窗口瞬间到期或永不到期');
  // 重置点必须真的把窗口清掉，否则"起窗后动过"仍会按时放行
  assert.match(mark, /clearTimeout\(p\.quietTimer\)/, '记活动时必须清掉旧窗口');

  for (const sig of ['function armQuiet(id, delayMs) {', 'function verifyQuiet(id, armedSeq) {']) {
    assert.doesNotMatch(fnBody(sig), /Date\.now/, sig + ' 不得读墙钟');
  }
  const arm = fnBody('function armQuiet(id, delayMs) {');
  assert.match(arm, /const armedSeq = activitySeq;/, '起窗时要记下当时的序号');
  assert.match(arm, /setTimeout\(/, '起窗要挂定时器');
});

test('K14: 静默期到点必须"先验序号、再重跑判据"，才允许放行', () => {
  const body = fnBody('function verifyQuiet(id, armedSeq) {');
  assert.match(body, /quietVerdict\(/, '裁决必须走纯函数（ABA 才能被单测覆盖）');
  assert.match(body, /armedSeq, activitySeq,/, '要把起窗序号与当前序号一起交给裁决');
  assert.match(body, /gateHoldReason\(id, 'quiet-verify'\)/, '到点必须重跑判据 —— 窗口安静 ≠ 状态干净');
  assert.ok(body.indexOf('quietVerdict') < body.indexOf('flushPending'),
    '必须先裁决再放行');
  // 反断言：放行必须带裁决结果（quiet/resets），不能是"到点就播"
  const flushes = body.match(/flushPending\(id[^)]*\)/g) || [];
  assert.equal(flushes.length, 2, '只允许两个放行点：quiet-disabled 与 release');
  for (const f of flushes) {
    assert.match(f, /quiet:/, '每次放行都要把静默期账目传给日志（' + f + '）');
  }
  assert.ok(body.lastIndexOf('verdict') < body.lastIndexOf('flushPending'),
    '最后一次放行必须在裁决之后');
});

test('K15: markActivity 只挂在"状态真的变了"的边沿（防心跳饿死窗口）', () => {
  // ① agent/status：必须先判状态值变了，再记活动
  // 注：这个 handler 以 `}, { global: true });` 收尾，fnBody 的"最后一行只有 }"
  // 护栏会误判，所以这里直接切片。
  const stAt = INDEX.indexOf("ctx.on('agent/status', (payload) => {");
  assert.ok(stAt > 0, '应能找到 agent/status 处理器');
  const stEnd = INDEX.indexOf('{ global: true });', stAt);
  assert.ok(stEnd > stAt, '应能找到 agent/status 处理器结尾');
  const st = INDEX.slice(stAt, stEnd);
  const callIdx = st.indexOf('markActivity()');
  assert.ok(callIdx > 0, 'agent/status 要记活动');
  assert.match(st.slice(0, callIdx), /prev\.status !== status/,
    '必须先判"状态值变了"再记活动；重复推送同一状态不能重置窗口');

  // ② jobs 事件：output 洪流必须先被挡掉
  const jobsAt = INDEX.indexOf("js.events.subscribe({ owners: 'all' }");
  assert.ok(jobsAt > 0, '应能找到 jobs 订阅');
  const jobs = INDEX.slice(jobsAt, jobsAt + 1200);
  const outIdx = jobs.indexOf("event.type === 'output'");
  const actIdx = jobs.indexOf('markActivity()');
  assert.ok(outIdx > 0, 'jobs 订阅要先过滤 output');
  assert.ok(actIdx > outIdx, 'markActivity 必须在 output 过滤之后（否则高频输出永不收尾）');
});

test('K16: 卸载/热重载必须清掉静默期定时器（防幽灵播报）', () => {
  const at = INDEX.indexOf('ctx.effect(() => () => {');
  assert.ok(at > 0, '应能找到卸载清理路径');
  const seg = INDEX.slice(at, at + 900);
  assert.match(seg, /clearTimeout\(p\.quietTimer\)/, '卸载清理必须清 quietTimer');

  const clears = INDEX.split('clearTimeout(p.quietTimer)').length - 1;
  assert.ok(clears >= 3,
    `quietTimer 至少在 markActivity / clearPending / flushPending / dispose 里清理（实际 ${clears} 处）`);
});

test('K17: idleGateQuietMs=0 必须退回 v0.5.10 的即时释放（一步回退开关）', () => {
  const body = fnBody('function armQuiet(id, delayMs) {');
  assert.match(body, /if \(!\(quietMs > 0\)\)/,
    '判据要写成 !(quietMs > 0)，别用 === 0 —— 负数/NaN 也得进兜底');
  const at = body.indexOf('!(quietMs > 0)');
  assert.match(body.slice(at, at + 260), /flushPending\(id/, '关闭时立刻放行，不许卡住不播');
  // 而且必须有注释/常量来源，免得后人以为是魔法数
  assert.match(body, /quietMsOf\(\)/, '静默期长度要从配置读（不是写死 1500）');
});

test('K18: quietVerdict —— ABA 必须判 activity-since-arm，顺序不许换', () => {
  const base = { armedSeq: 7, activitySeq: 7, holdReason: null, quietMs: 1500 };
  assert.equal(quietVerdict(base), 'release', '期间无人动 + 判据全干净 → 放行');

  // ABA：期间"瞬间启动又结束"，前后快照一样，只有序号能证明中间动过
  assert.equal(quietVerdict({ ...base, activitySeq: 8 }), 'activity-since-arm',
    '序号前进 = 期间动过 → 必须重新计时，绝不能放行');

  assert.equal(quietVerdict({ ...base, holdReason: 'inflight' }), 'still-busy');
  assert.equal(quietVerdict({ ...base, quietMs: 0 }), 'quiet-disabled', '0 = 关闭');
  assert.equal(quietVerdict({ ...base, quietMs: Number.NaN }), 'quiet-disabled', 'NaN 按关闭处理');

  // 顺序：动过优先于"仍然忙"
  assert.equal(quietVerdict({ ...base, activitySeq: 9, holdReason: 'turn-open' }),
    'activity-since-arm', '先验序号再认 busy —— 否则"动过又回到忙"会被误判成普通等待');

  // 脏输入不许抛
  assert.equal(quietVerdict(null), 'quiet-disabled');
});

// ── v0.5.11 复审补强（独立审查 2026-11-27 指出的三处「窗口会丢掉」）──────────

test('K19: markActivity 清掉窗口后必须重新起窗（否则饿到 10 分钟超时）', () => {
  const body = fnBody('function markActivity() {');
  // ① 序号必须 +1（静默期只认序号，不读墙钟）
  assert.match(body, /activitySeq \+= 1/, '活动必须推进 activitySeq');
  assert.doesNotMatch(body, /Date\.now\(\)/,
    '静默期不许读墙钟算时间（墙钟会跳变；活动序号才是单调的）');
  // ② 清定时器时必须记账，"清过"和"没清过"要走不同路径
  assert.match(body, /cleared/, '清定时器要留痕，否则无法决定是否重估');
  // ③ 清完必须异步重跑判据 → 重新起窗。只清不挂 = 这条挂起项失去窗口。
  assert.match(body, /queueMicrotask\(/,
    '清窗口后必须排一次重估（同步重跑会在事件回调里递归走完整判据）');
  assert.match(body, /reevaluatePending\(/, '重估入口不许绕过 reevaluatePending');
});

test('K20: 复查发现仍忙 → 短退避重挂，不许「撂挑子等事件」', () => {
  const body = fnBody('function verifyQuiet(id, armedSeq) {');
  const at = body.indexOf("verdict === 'still-busy'");
  assert.ok(at > 0, 'still-busy 分支必须存在');
  const seg = body.slice(at, at + 700);
  const armAt = seg.indexOf('armQuiet(id, quietBackoffMs(');
  assert.ok(armAt > 0,
    'still-busy 必须短退避重挂：agent-unavailable / turn-boundary-unavailable '
    + '这类原因没有必然后续边沿事件，只等事件会饿到超时兜底（超时播的是进度提醒）');
  // 允许 return，但它必须在重挂之后 —— 先 return 就等于"等下一个事件"
  const firstReturn = seg.indexOf('return;');
  assert.ok(firstReturn < 0 || armAt < firstReturn,
    'still-busy 分支必须先重挂再 return，不许裸 return（那就是「等下一个事件」）');
});

test('K21: 超时复查放行也要记 quiet/resets 账目（否则 quiet=0 语义被污染）', () => {
  const body = fnBody('function onIdleGateTimeout(id) {');
  assert.match(body, /flushPending\(id, \{ quiet: quietMsOf\(\)/,
    '超时复查确认真空闲后的放行，必须如实传 quiet（quiet=0 专指「静默期没参与」）');
  // 全文件不得再有裸 flushPending(id) —— 那会恒记 quiet=0 resets=0
  const bare = INDEX.split(/flushPending\(id\);|\n\s*flushPending\(id\)\n/).length - 1;
  assert.equal(bare, 0, `不允许裸 flushPending(id)（实测 ${bare} 处）—— 账目会记成 quiet=0`);
});

test('K22: idleGateQuietMs 必须三处登记（漏一处 = 用户改了不生效）', () => {
  const store = readFileSync(join(ROOT, 'lib/config-store.js'), 'utf8');
  const schema = readFileSync(join(ROOT, 'lib/config-schema.js'), 'utf8');
  assert.match(store, /^\s*idleGateQuietMs:\s*\(v\)/m,
    'config-store.js 的 RULES 必须收这个键：白名单外的键保存时被 sanitize 丢弃');
  assert.match(store, /idleGateQuietMs:\s*Math\.round/,
    'config-store.js 的客户端形状映射必须回传它');
  assert.match(INDEX, /idleGateQuietMs:\s*Math\.round/,
    'effectiveForClient 必须映射它，否则前端 GET 拿不到（v0.4.18 同类事故）');
  assert.match(schema, /^\s*idleGateQuietMs:/m, 'config-schema 的 FIELD_DEFAULTS 要有它');
  assert.match(INDEX, /out\.idleGateQuietMs\s*=/, 'normalizeConfig 要算它');
});

test('K23: quietBackoffMs —— 上限 500ms 且不超过静默期本身', () => {
  assert.equal(quietBackoffMs(1500), 500, '默认 1500 → 退避 500');
  assert.equal(quietBackoffMs(300), 300, '静默期比上限短时取静默期（不许比它长）');
  assert.equal(quietBackoffMs(0), 0, '0 = 关闭，退避也是 0（由调用方走即时放行）');
  assert.equal(quietBackoffMs(Number.NaN), 0, 'NaN 不许变成 NaN 毫秒定时器');
  assert.equal(quietBackoffMs(-1), 0, '负数按关闭处理');
  assert.equal(quietBackoffMs(60000), 500, '上限 60 秒时退避仍是 500（不许跟着变长）');
});
