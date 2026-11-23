/**
 * config-route 测试：HTTP 配置读写的完整验证。
 *
 * ## 为什么必须有
 *
 * 这是**唯一会写用户配置文件的代码路径**。它写错的表现是静默的：
 * 用户的音量/音色被改掉而不知道，或者配置被写坏后插件行为异常。
 *
 * ## 覆盖
 *
 * - R1  GET 返回**生效值**，不是文件层（关键：patch 的 volume=100 不能被显示成 80）
 * - R2  保存后响应仍返回生效值（防止其它控件回弹）
 * - R3  保存单个开关只写那一个键，不动其它
 * - R4  非法输入被拒绝，不写盘
 * - R5  只认 /config/set 为写，且必须 POST
 * - R6  clear 后返回生效值（回到 patch/schema 层）
 * - R7  路径分流辅助：/config vs /consume 不会互相误判
 * - R8  文件损坏时不覆盖（fail-closed）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// ⚠️ 必须在 import 前隔离 DSH_HOME
const HOME = mkdtempSync(join(tmpdir(), 'notify-cfgroute-'));
process.env.DSH_HOME = HOME;
process.on('exit', () => { try { rmSync(HOME, { recursive: true, force: true }); } catch { /* ignore */ } });

const { createConfigRoute } = await import('../lib/config-route.js');
const { configPath } = await import('../lib/config-store.js');

/** 造一个记录 code/body 的假 res。 */
function mkRes() {
  const o = {
    code: 0, body: null,
    writeHead(c) { o.code = c; },
    end(t) { o.body = t == null ? '' : String(t); },
  };
  return o;
}

/** 调一次 handler 并解析 JSON。 */
async function call(route, { method = 'GET', url, body } = {}) {
  const res = mkRes();
  await route.handler({ method, url, body }, res);
  let doc = null;
  try { doc = res.body ? JSON.parse(res.body) : null; } catch { doc = null; }
  return { code: res.code, doc };
}

/**
 * 每次测试用全新 route，并**清掉文件层**，避免用例之间串味。
 *
 * ⚠️ 所有用例共享同一个 $DSH_HOME（同一个 config.json），
 * 不清的话前一个用例写的 volume=55 会留到后一个，导致假失败（实测踩到）。
 */
function mkRoute(effective) {
  const p = configPath();
  try { if (p && existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
  return createConfigRoute({
    onChanged: () => {},
    getEffective: () => effective,
  });
}

const GET_URL = '/api/dsh-notify-say/config';
const SET_URL = '/api/dsh-notify-say/config/set';

// ── R1: GET 返回生效值 ─────────────────────────────────────────────────────
test('R1: GET 返回生效值，而不是文件层覆盖值', async () => {
  // patch 里 volume=100，文件层什么都没存 —— 这正是真实的默认状态
  const effective = { voice: true, volume: 100, voiceMode: 'fixed', voiceName: 'zundamon-normal', idleGate: true };
  const r = mkRoute(effective);
  const { code, doc } = await call(r, { url: GET_URL });

  assert.equal(code, 200);
  assert.equal(doc.ok, true);
  assert.equal(doc.values.volume, 100,
    '必须显示生效值 100；显示 80 会让用户误拖滑块把 100 覆盖成 80');
  assert.equal(doc.values.voiceMode, 'fixed');
  // 文件层覆盖值单独给出，便于判断"哪些是用户显式设过的"
  assert.ok(doc.overrides && typeof doc.overrides === 'object');
});

// ── R2: 保存后响应仍是生效值 ───────────────────────────────────────────────
test('R2: 保存一个开关后，响应里其它键仍是生效值（不回弹）', async () => {
  // 用一个可变的"生效配置"模拟 host：保存后 onChanged 会刷新它
  let effective = { voice: true, volume: 100, voiceMode: 'fixed', voiceName: 'zundamon-normal', idleGate: true };
  const r = createConfigRoute({
    onChanged: () => {
      // 模拟 refreshConfig：把文件层合并进生效值
      effective = { ...effective, idleGate: false };
    },
    getEffective: () => effective,
  });

  const { code, doc } = await call(r, {
    method: 'POST', url: SET_URL, body: { values: { idleGate: false } },
  });

  assert.equal(code, 200);
  assert.equal(doc.ok, true);
  assert.equal(doc.values.idleGate, false, '改动应生效');
  assert.equal(doc.values.volume, 100,
    'volume 不在这次写入里，响应必须仍返回 100；否则 client 会把它覆盖成硬编码 80');
});

// ── R3: 只写指定的键 ──────────────────────────────────────────────────────
test('R3: 保存只写指定键，不污染其它配置', async () => {
  const r = mkRoute({ voice: true, volume: 100, voiceMode: 'fixed' });
  await call(r, { method: 'POST', url: SET_URL, body: { values: { volume: 55 } } });

  // 直接读文件层，确认只写了 volume
  const raw = JSON.parse(readFileSync(configPath(), 'utf8'));
  assert.equal(raw.values.volume, 55);
  assert.equal(raw.values.voice, undefined, '不该写入未提交的键');
  assert.equal(raw.values.voiceMode, undefined);
});

// ── R4: 非法输入被拒绝 ────────────────────────────────────────────────────
test('R4: 非法输入被拒绝且不写盘', async () => {
  const r = mkRoute({ volume: 100 });

  // 未知键
  let res = await call(r, { method: 'POST', url: SET_URL, body: { values: { notAKey: 1 } } });
  assert.equal(res.code, 400);
  assert.equal(res.doc.ok, false);

  // 越界值
  res = await call(r, { method: 'POST', url: SET_URL, body: { values: { volume: 9999 } } });
  assert.equal(res.code, 400);

  // 空 body
  res = await call(r, { method: 'POST', url: SET_URL, body: {} });
  assert.equal(res.code, 400);

  // 全部拒绝后，文件层应仍是空的
  const p = configPath();
  if (existsSync(p)) {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    assert.deepEqual(raw.values || {}, {}, '非法写入不应留下任何键');
  }
});

// ── R5: 方法与路径 ────────────────────────────────────────────────────────
test('R5: 只认 /config/set 为写，且必须 POST', async () => {
  const r = mkRoute({ volume: 100 });

  // POST 到 /config（不是 /set）不应被当成写
  const res1 = await call(r, { method: 'POST', url: GET_URL, body: { values: { volume: 7 } } });
  assert.equal(res1.code, 200, 'POST /config 应按读处理');
  assert.equal(res1.doc.values.volume, 100, '不应写入');

  // GET 到 /config/set 应被拒（405）
  const res2 = await call(r, { method: 'GET', url: SET_URL });
  assert.equal(res2.code, 405);
});

// ── R6: clear 返回生效值 ──────────────────────────────────────────────────
test('R6: clear 清掉文件层后返回生效值（回到 patch/schema）', async () => {
  let effective = { volume: 100 };
  const r = createConfigRoute({
    onChanged: () => { effective = { volume: 100 }; },   // clear 后回到 patch 值
    getEffective: () => effective,
  });

  // 先存一个覆盖
  await call(r, { method: 'POST', url: SET_URL, body: { values: { volume: 30 } } });

  // 再清空
  const { code, doc } = await call(r, { method: 'POST', url: SET_URL, body: { clear: true } });
  assert.equal(code, 200);
  assert.equal(doc.values.volume, 100, '清空后应回到 patch 的 100，不是空对象');

  assert.equal(existsSync(configPath()), false, 'clear 应删除文件层');
});

// ── R7: 路径分流 ──────────────────────────────────────────────────────────
test('R7: 路径按段分流，查询串里的 /config 不会误判', () => {
  const PREFIX = '/api/dsh-notify-say';
  function route(raw) {
    const pathname = raw.split('?')[0].split('#')[0];
    const rest = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) : pathname;
    const head = rest.replace(/^\/+/, '').split('/')[0];
    return head === 'config' ? 'config' : 'bridge';
  }
  assert.equal(route('/api/dsh-notify-say/config'), 'config');
  assert.equal(route('/api/dsh-notify-say/config/set'), 'config');
  assert.equal(route('/api/dsh-notify-say/consume'), 'bridge');
  assert.equal(route('/api/dsh-notify-say/consume?next=/config'), 'bridge',
    '查询串不应影响分流');
  assert.equal(route('/api/dsh-notify-say/last-session'), 'bridge');
});

// ── R8: 文件损坏时不覆盖 ──────────────────────────────────────────────────
test('R8: 文件层损坏时拒绝写入（不覆盖用户数据）', async () => {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, '{ this is not valid json', 'utf8');

  // ⚠️ 不能用 mkRoute —— 它会先删掉 config.json，把这个用例精心造的损坏文件清掉。
  const r = createConfigRoute({ onChanged: () => {}, getEffective: () => ({ volume: 100 }) });
  const { code, doc } = await call(r, { method: 'POST', url: SET_URL, body: { values: { volume: 42 } } });

  assert.equal(code, 409, '损坏的文件不该被覆盖');
  assert.equal(doc.ok, false);

  // 原文件必须保持原样，供人工救
  assert.equal(readFileSync(p, 'utf8'), '{ this is not valid json');
});

// ── R9: installed 字段（v0.5.6，issue #3 的后端一半）────────────────────────
//
// 为什么这条必须在**后端**测：前端 voice-options.test.mjs 是拿桩数据渲染的，
// 它证明"拿到 installed 就能多出选项"，证明不了"/config 真的会返回 installed"。
// 中间隔着 createConfigRoute 的 opts 透传、installedList() 的过滤与异常兜底，
// 任何一处写错，前端那 6 条断言照样全绿 —— 而用户的下拉依旧看不到已下载音色。
test('R9: 注入 getInstalled 时，GET /config 带上已安装音色列表', async () => {
  const p = configPath();
  try { if (p && existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
  const r = createConfigRoute({
    onChanged: () => {},
    getEffective: () => ({ volume: 100 }),
    getInstalled: () => ['zundamon-normal', 'zh-soft-female', 'tohoku-zunko'],
  });

  const { code, doc } = await call(r, { url: GET_URL });
  assert.equal(code, 200);
  assert.deepEqual(doc.installed, ['zundamon-normal', 'zh-soft-female', 'tohoku-zunko']);
  // 原有字段一个都不能少 —— 这是改响应形状时最容易碰坏的地方
  assert.ok(doc.values && typeof doc.values === 'object', 'values 必须仍在');
  assert.ok(Array.isArray(doc.keys), 'keys 必须仍在');
});

test('R10: 没注入 getInstalled 时不返回 installed（既有行为逐字不变）', async () => {
  const p = configPath();
  try { if (p && existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
  const r = createConfigRoute({ onChanged: () => {}, getEffective: () => ({ volume: 100 }) });

  const { code, doc } = await call(r, { url: GET_URL });
  assert.equal(code, 200);
  assert.equal(Object.prototype.hasOwnProperty.call(doc, 'installed'), false,
    '不注入就不该出现这个键：老的调用方/测试不该看到新字段');
});

test('R11: getInstalled 抛异常时退回空数组，而不是让 /config 整个 500', async () => {
  // 真实场景：用户目录权限异常、盘符掉了、readdir 抛 EPERM。
  // 这时正确的降级是"下拉退回内置清单"，绝不能连配置页都打不开。
  const p = configPath();
  try { if (p && existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
  const r = createConfigRoute({
    onChanged: () => {},
    getEffective: () => ({ volume: 100 }),
    getInstalled: () => { throw new Error('EPERM'); },
  });

  const { code, doc } = await call(r, { url: GET_URL });
  assert.equal(code, 200, '一个可选字段拿不到，不该拖垮整个配置读取');
  assert.deepEqual(doc.installed, []);
});

test('R12: getInstalled 返回脏数据时只保留非空字符串', async () => {
  const p = configPath();
  try { if (p && existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
  const r = createConfigRoute({
    onChanged: () => {},
    getEffective: () => ({ volume: 100 }),
    getInstalled: () => ['ok-key', '', null, 42, { a: 1 }, 'zh-mid-male'],
  });

  const { code, doc } = await call(r, { url: GET_URL });
  assert.equal(code, 200);
  assert.deepEqual(doc.installed, ['ok-key', 'zh-mid-male'],
    '非字符串必须滤掉，否则前端 appendInstalled 会拿对象去算前缀');
});
