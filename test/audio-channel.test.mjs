/**
 * 播放通道契约测试（v0.5.12）。
 *
 * 这些断言锁的是"出问题会让人听不见声音或听见两遍"的那几条性质：
 *
 *   1. 认领是**原子**的：同一 token 只喂一个窗口，其余 204（否则多窗口同时播 = 回声）
 *   2. 无人认领 → **恰好一次** PowerShell 回退（reason=no-client）
 *   3. `ack ok:false` → **立刻**回退，不等 ack 宽限（reason=play-fail）
 *   4. ack 超时 → 回退一次（reason=timeout）；已 ack 之后**绝不再回退**（双重出声）
 *   5. `volume === 0` → 既不广播也不回退（与 ps1 的"0 = 真静音"一致）
 *   6. 临时文件（增益产物 / TTS 合成）用完即删，**绝不删用户原文件**
 *   7. `dispose` 之后定时器全部失效，不会在卸载后突然回退一次（幽灵播报）
 *
 * 历史背景：2026-11-27 用户把「Windows PowerShell」在混音器里拉到 1%，
 * 插件永久静默且毫无提示。本通道就是为了让声音走渲染进程（混音器里是
 * 独立条目「DeepSeek Harness」）—— 所以"能不能可靠地播一次"必须被测试锁死。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clampVolume, pickTargets, claimVerdict, settleVerdict, createAudioChannel,
  CLAIM_MS, ACK_GRACE_MS,
} from '../lib/audio-channel.js';

// ── 测试替身 ────────────────────────────────────────────────────────────────

function mkRes() {
  const res = {
    statusCode: 0,
    headers: null,
    chunks: [],
    ended: false,
    writeHead(code, headers) { res.statusCode = code; res.headers = headers || {}; },
    write(s) { res.chunks.push(String(s)); return true; },
    end(s) { if (s !== undefined) res.chunks.push(String(s)); res.ended = true; },
    on() { /* 流关闭回调由用例按需触发 */ },
  };
  return res;
}

function mkReq(method, url) {
  const handlers = {};
  return {
    method,
    url,
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return this; },
    emit(ev) { for (const fn of handlers[ev] || []) fn(); },
  };
}

/** POST 请求：按 readJson 的预期顺序把 body 喂进去。 */
function mkPostReq(url, body) {
  const raw = JSON.stringify(body || {});
  const handlers = {};
  return {
    method: 'POST',
    url,
    on(ev, fn) {
      handlers[ev] = fn;
      if (ev === 'data') setTimeout(() => fn(raw), 0);
      if (ev === 'end') setTimeout(() => fn(), 1);
      return this;
    },
  };
}

/** 从 SSE 响应里取出所有 data 事件的 JSON。 */
function sseEvents(res) {
  const out = [];
  for (const chunk of res.chunks) {
    for (const line of String(chunk).split('\n')) {
      if (line.indexOf('data: ') === 0) {
        try { out.push(JSON.parse(line.slice(6))); } catch { /* 忽略非 JSON 行 */ }
      }
    }
  }
  return out;
}

/** 建一个通道 + 一个已连上的客户端，返回常用句柄。 */
function setup(overrides = {}) {
  const logs = [];
  const deleted = [];
  const ch = createAudioChannel({
    log: (m) => logs.push(String(m)),
    readFile: () => Buffer.from('RIFF-fake-wav'),
    unlink: (p) => deleted.push(p),
    claimMs: 25,
    ackMs: 30,
    ...overrides,
  });
  const res = mkRes();
  const req = mkReq('GET', '/api/dsh-notify-say/audio/stream');
  ch.handler(req, res);
  const cid = (sseEvents(res).find((e) => e.type === 'hello') || {}).cid;
  return { ch, res, req, cid, logs, deleted };
}

/** 从 SSE 里拿最近一条 play 事件。 */
function lastPlay(res) {
  const evs = sseEvents(res).filter((e) => e.type === 'play');
  return evs[evs.length - 1] || null;
}

// ── 纯函数 ──────────────────────────────────────────────────────────────────

test('clampVolume：0~100 取整，越界夹取，脏输入归 0', () => {
  assert.equal(clampVolume(0), 0);
  assert.equal(clampVolume(82), 82);
  assert.equal(clampVolume(82.6), 83);
  assert.equal(clampVolume(100), 100);
  assert.equal(clampVolume(150), 100);
  assert.equal(clampVolume(-5), 0);
  assert.equal(clampVolume('abc'), 0);
  assert.equal(clampVolume(undefined), 0);
});

test('pickTargets：有可见客户端就只推可见的，全隐藏才全推', () => {
  const clients = new Map([
    ['a', { cid: 'a', visible: false }],
    ['b', { cid: 'b', visible: true }],
  ]);
  assert.deepEqual(pickTargets(clients).map((c) => c.cid), ['b']);

  clients.get('b').visible = false;
  assert.deepEqual(pickTargets(clients).map((c) => c.cid).sort(), ['a', 'b']);

  assert.deepEqual(pickTargets(new Map()), []);
});

test('claimVerdict：missing / taken / expired / ok', () => {
  assert.equal(claimVerdict(null, 1000), 'missing');
  assert.equal(claimVerdict({ claimed: true, createdAt: 0 }, 1000), 'taken');
  assert.equal(claimVerdict({ claimed: false, createdAt: 0 }, 60_000), 'expired');
  assert.equal(claimVerdict({ claimed: false, createdAt: 59_000 }, 60_000), 'ok');
});

test('settleVerdict：先看认领，再看 ack（没人认领就不必等 ack）', () => {
  assert.equal(settleVerdict({ claimed: false, acked: false }), 'fallback-no-client');
  assert.equal(settleVerdict({ claimed: true, acked: false }), 'fallback-timeout');
  assert.equal(settleVerdict({ claimed: true, acked: true, ackOk: false }), 'fallback-play-fail');
  assert.equal(settleVerdict({ claimed: true, acked: true, ackOk: true }), 'release');
});

// ── 通道行为 ────────────────────────────────────────────────────────────────

test('SSE：建连即发 hello，带 cid', () => {
  const { res, cid } = setup();
  assert.ok(cid, 'hello 里必须有 cid');
  assert.match(String(res.chunks[0]), /retry: 1000/);
  assert.match(String(res.chunks[1]), /: hello/);
});

test('没有客户端：不等 400ms，直接回退一次 reason=no-client', async () => {
  const logs = [];
  const deleted = [];
  const fallbacks = [];
  const ch = createAudioChannel({
    log: (m) => logs.push(String(m)),
    readFile: () => Buffer.from('x'),
    unlink: (p) => deleted.push(p),
  });
  const r = await ch.play({
    file: 'C:/tmp/gained.wav',
    fileToDelete: 'C:/tmp/gained.wav',
    volume: 82,
    meta: { kind: 'done' },
    fallback: () => fallbacks.push('ps'),
  });
  assert.equal(fallbacks.length, 1);
  assert.equal(r.via, 'ps-fallback');
  assert.equal(r.reason, 'no-client');
  assert.deepEqual(deleted, ['C:/tmp/gained.wav'], '临时文件必须删');
  assert.equal(ch.stats().pending, 0);
  assert.ok(logs.some((l) => l.includes('via=ps-fallback reason=no-client')));
});

test('volume=0：既不广播也不回退（0 = 真静音）', async () => {
  const { ch, res, deleted } = setup();
  const fallbacks = [];
  const r = await ch.play({
    file: 'C:/tmp/a.wav',
    fileToDelete: 'C:/tmp/a.wav',
    volume: 0,
    meta: { kind: 'done' },
    fallback: () => fallbacks.push('ps'),
  });
  assert.equal(r.via, 'muted');
  assert.equal(fallbacks.length, 0);
  assert.equal(sseEvents(res).filter((e) => e.type === 'play').length, 0, '不该广播');
  assert.deepEqual(deleted, ['C:/tmp/a.wav']);
});

test('认领原子性 + ack ok：第二个 GET 得 204，且不回退', async () => {
  const { ch, res, deleted } = setup();
  const fallbacks = [];
  const p = ch.play({
    file: 'C:/tmp/g.wav',
    fileToDelete: 'C:/tmp/g.wav',
    volume: 82,
    meta: { kind: 'done' },
    fallback: () => fallbacks.push('ps'),
  });

  const ev = lastPlay(res);
  assert.ok(ev && ev.token, '必须广播 play 事件');
  assert.equal(ev.volume, 82);

  const ok1 = mkRes();
  ch.handler(mkReq('GET', '/api/dsh-notify-say/audio/t/' + ev.token), ok1);
  assert.equal(ok1.statusCode, 200);
  assert.equal(ok1.headers['content-type'], 'audio/wav');
  assert.equal(ok1.headers['cache-control'], 'no-store');

  const ok2 = mkRes();
  ch.handler(mkReq('GET', '/api/dsh-notify-say/audio/t/' + ev.token), ok2);
  assert.equal(ok2.statusCode, 204, '重复认领必须 204，否则多窗口回声');

  ch.handler(mkPostReq('/api/dsh-notify-say/audio/ack', { token: ev.token, ok: true }), mkRes());
  const r = await p;
  assert.equal(r.via, 'webaudio');
  assert.equal(fallbacks.length, 0, 'ack 成功后绝不能再回退');
  assert.deepEqual(deleted, ['C:/tmp/g.wav']);
});

test('ack ok:false → 立刻回退 reason=play-fail（不等宽限）', async () => {
  const { ch, res } = setup();
  const fallbacks = [];
  const p = ch.play({
    file: 'C:/tmp/f.wav',
    volume: 82,
    meta: { kind: 'done' },
    fallback: () => fallbacks.push('ps'),
  });
  const ev = lastPlay(res);
  ch.handler(mkReq('GET', '/api/dsh-notify-say/audio/t/' + ev.token), mkRes());
  ch.handler(mkPostReq('/api/dsh-notify-say/audio/ack', { token: ev.token, ok: false, err: 'NotAllowedError' }), mkRes());
  const r = await p;
  assert.equal(r.via, 'ps-fallback');
  assert.equal(r.reason, 'fallback-play-fail');
  assert.equal(fallbacks.length, 1);
});

test('认领后无 ack → 宽限到点回退 reason=timeout（只回退一次）', async () => {
  const { ch, res, logs } = setup({ ackMs: 20 });
  const fallbacks = [];
  const p = ch.play({
    file: 'C:/tmp/t.wav',
    volume: 82,
    meta: { kind: 'done' },
    fallback: () => fallbacks.push('ps'),
  });
  const ev = lastPlay(res);
  ch.handler(mkReq('GET', '/api/dsh-notify-say/audio/t/' + ev.token), mkRes());
  const r = await p;
  assert.equal(r.reason, 'fallback-timeout');
  assert.equal(fallbacks.length, 1, '恰好一次');
  assert.ok(logs.some((l) => l.includes('reason=timeout')));
});

test('无人认领 → 认领超时后回退 reason=no-client（客户端连着但没来取）', async () => {
  const { ch } = setup({ claimMs: 15 });
  const fallbacks = [];
  const r = await ch.play({
    file: 'C:/tmp/n.wav',
    volume: 50,
    meta: { kind: 'fail' },
    fallback: () => fallbacks.push('ps'),
  });
  assert.equal(r.reason, 'fallback-no-client');
  assert.equal(fallbacks.length, 1);
});

test('可见性上报：hidden 之后 pickTargets 不再选它', async () => {
  const { ch, cid } = setup();
  const res2 = mkRes();
  ch.handler(mkReq('GET', '/api/dsh-notify-say/audio/stream'), res2);
  const cid2 = (sseEvents(res2).find((e) => e.type === 'hello') || {}).cid;

  ch.handler(mkPostReq('/api/dsh-notify-say/audio/visible', { cid, state: 'hidden' }), mkRes());
  ch.handler(mkPostReq('/api/dsh-notify-say/audio/visible', { cid: cid2, state: 'visible' }), mkRes());
  // handleVisible 是异步读 body 的：等一拍再断言，否则读到的是旧值
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ch._clients.get(cid).visible, false);
  assert.equal(ch._clients.get(cid2).visible, true);

  const targets = pickTargets(ch._clients).map((c) => c.cid);
  assert.deepEqual(targets, [cid2], '只推可见窗口');
});

test('刚连上的窗口默认不可见（先上报再算数，免得被遮挡的窗口抢走广播）', async () => {
  const { ch, cid } = setup();
  assert.equal(ch._clients.get(cid).visible, false);
});

test('未知 token 的 ack 不报错（回 unknown-token），未知路径 404', async () => {
  const { ch } = setup();
  const res = mkRes();
  ch.handler(mkPostReq('/api/dsh-notify-say/audio/ack', { token: 'nope', ok: true }), res);
  await new Promise((r) => setTimeout(r, 10));
  assert.match(res.chunks.join(''), /unknown-token/);

  const r404 = mkRes();
  ch.handler(mkReq('GET', '/api/dsh-notify-say/audio/whatever'), r404);
  assert.equal(r404.statusCode, 404);
});

test('dispose：结束 SSE、清 token、删临时文件、之后不再回退', async () => {
  const { ch, res, deleted } = setup({ ackMs: 40 });
  const fallbacks = [];
  const p = ch.play({
    file: 'C:/tmp/d.wav',
    fileToDelete: 'C:/tmp/d.wav',
    volume: 82,
    meta: { kind: 'done' },
    fallback: () => fallbacks.push('ps'),
  });
  const ev = lastPlay(res);
  ch.handler(mkReq('GET', '/api/dsh-notify-say/audio/t/' + ev.token), mkRes());

  ch.dispose();
  assert.equal(res.ended, true, 'SSE 必须被关掉');
  assert.equal(ch.stats().connected, 0);
  assert.equal(ch.stats().pending, 0);
  assert.deepEqual(deleted, ['C:/tmp/d.wav'], '未消费的临时文件必须删');

  // 等过 ack 宽限：定时器已清，不该再回退（幽灵播报）
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(fallbacks.length, 0, 'dispose 之后不得再回退');
  await p;   // 避免悬挂的 Promise 报警
});

test('默认超时常量就是实测结论（400 / 1500）', () => {
  assert.equal(CLAIM_MS, 400);
  assert.equal(ACK_GRACE_MS, 1500);
});

// ── v0.5.12 复审补的 4 条（都是"会让人听见两遍"或"留下垃圾"的路径）─────────

test('非认领者的 ack(false) 被忽略：A 在播，B 失败不得触发回退', async () => {
  const { ch, res, cid } = setup();
  const fallbacks = [];
  const p = ch.play({
    file: 'C:/tmp/x.wav',
    volume: 82,
    meta: { kind: 'done' },
    fallback: () => fallbacks.push('ps'),
  });
  const ev = lastPlay(res);

  // A（认领者）取走字节
  const okA = mkRes();
  ch.handler(mkReq('GET', '/api/dsh-notify-say/audio/t/' + ev.token + '?cid=' + cid), okA);
  assert.equal(okA.statusCode, 200);

  // B 没抢到 token（204），但它的 fetch 也失败并误发 ack(false)
  const ackB = mkRes();
  ch.handler(mkPostReq('/api/dsh-notify-say/audio/ack',
    { token: ev.token, ok: false, cid: 'another-window' }), ackB);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(fallbacks.length, 0, '非认领者的失败 ack 绝不能触发回退（否则双声）');

  // 认领者自己 ack 成功才算数
  ch.handler(mkPostReq('/api/dsh-notify-say/audio/ack',
    { token: ev.token, ok: true, cid }), mkRes());
  const r = await p;
  assert.equal(r.via, 'webaudio');
  assert.equal(fallbacks.length, 0);
});

test('dispose 时 in-flight 的 play 以 via=disposed 收尾（不悬挂、不回退）', async () => {
  const { ch, res } = setup({ ackMs: 1000 });
  const fallbacks = [];
  const p = ch.play({
    file: 'C:/tmp/y.wav',
    volume: 82,
    meta: { kind: 'done' },
    fallback: () => fallbacks.push('ps'),
  });
  const ev = lastPlay(res);
  ch.handler(mkReq('GET', '/api/dsh-notify-say/audio/t/' + ev.token), mkRes());

  ch.dispose();
  const r = await p;              // 必须能等到结论，否则调用方永久挂起
  assert.equal(r.via, 'disposed');
  assert.equal(fallbacks.length, 0);
});

test('dispose 之后再 play：直接 via=disposed，不广播也不回退', async () => {
  const { ch } = setup();
  ch.dispose();
  const fallbacks = [];
  const r = await ch.play({
    file: 'C:/tmp/z.wav',
    fileToDelete: 'C:/tmp/z.wav',
    volume: 82,
    meta: { kind: 'done' },
    fallback: () => fallbacks.push('ps'),
  });
  assert.equal(r.via, 'disposed');
  assert.equal(fallbacks.length, 0, '卸载后回退 = 幽灵播报');
});

test('没有增益产物时不删用户原文件（fileToDelete 为空即不动）', async () => {
  const { ch, res, deleted } = setup();
  const p = ch.play({
    file: 'C:/music/user.wav',   // 用户自己的文件：无增益时直读
    volume: 82,
    meta: { kind: 'done' },
    fallback: () => {},
  });
  const ev = lastPlay(res);
  ch.handler(mkReq('GET', '/api/dsh-notify-say/audio/t/' + ev.token), mkRes());
  ch.handler(mkPostReq('/api/dsh-notify-say/audio/ack', { token: ev.token, ok: true }), mkRes());
  await p;
  assert.deepEqual(deleted, [], '用户原文件绝不能被删');
});
