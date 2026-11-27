/**
 * WebAudio 播放通道（v0.6.0）
 *
 * ## 它解决什么
 *
 * 2026-11-27 真机踩到：插件所有声音都由 `powershell.exe` 经 MCI 播放，
 * 而 Windows **按 exe 记忆应用音量**。用户把「Windows PowerShell」在混音器里
 * 拉到 1%（早前为了消音控制台），插件从此**永久静默且毫无提示** ——
 * 排查花了两小时，最后靠用户自己发现。
 *
 * 渲染进程播放的音频在混音器里是独立条目「DeepSeek Harness」，
 * 用户能看见、能单独调，这类"全机性静音"就伤不到它。
 *
 * ## 协议（两段超时，防双重回声）
 *
 * ```
 * 服务端：选好文件 → 读成字节 → 生成一次性 playToken → SSE 广播
 *   → claimTimer 400ms：无人来取 → 回退 PowerShell（reason=no-client）
 *   → 有人 GET audio/t/<token>（首个原子抢占，其余 204）
 *        → ackTimer 1500ms：
 *             ack ok:true  → 完成
 *             ack ok:false → 立刻回退（reason=play-fail，不等超时）
 *             无 ack       → 回退（reason=timeout）
 * ```
 *
 * 参数依据（2026-11-27 实测 11 发）：SSE 投递 `netLat` 1~4ms、
 * `play()` 到真正出声 `playMs` 233~244ms（最小化 6 分半后无劣化）。
 * 400ms 比网络延迟高两个数量级、又低于 playMs，正好卡在"确实没客户端"的缝里；
 * 1500ms 是 playMs 的 6 倍余量，系统略卡也不至于误判超时。
 *
 * ## 为什么字节存内存而不是让前端直接拉文件
 *
 * 前端 `<audio src>` 会发起多次 Range 请求，撞上"一次性 token"会拿到 204。
 * 前端改为 `fetch → Blob → URL.createObjectURL`，服务端只需在认领时吐一次字节。
 * 字节随 token 管理，播完/超时/回退即释放；增益产生的临时 wav 一并删除。
 *
 * 本文件不做任何选音/增益决策 —— 那是 `dsh-notify.ps1 -Resolve` 的职责，
 * 规则只有一份，避免两边各写一套必然漂移。
 */

import { readFileSync, unlinkSync } from 'node:fs';

/** 无人认领就回退 PowerShell 的等待时间。 */
export const CLAIM_MS = 400;
/** 已认领后等前端 ack 的宽限。 */
export const ACK_GRACE_MS = 1500;
/** token 未认领的存活上限（防泄漏）。 */
export const TOKEN_TTL_MS = 30_000;
/** SSE 心跳间隔。 */
export const KEEPALIVE_MS = 25_000;

/**
 * 音量夹取：0~100 取整。
 *
 * 与 `dsh-notify.ps1` 的 `-Volume` 同语义（0 = 完全静音，100 = 原始幅度）。
 * 前端拿到后直接 `audio.volume = vol/100` —— 两者都是线性衰减，听感等价。
 */
export function clampVolume(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 100) return 100;
  return Math.round(n);
}

/**
 * 挑出要广播的客户端：**优先只推可见窗口**。
 *
 * 为什么：多开窗口时若把事件推给隐藏窗口，声音会在后台播，
 * 用户以为"没响"；而可见窗口通常就是用户正在看的那个。
 * 没有可见客户端时（比如全都最小化）才推给全部 —— 最小化也要能听到。
 */
export function pickTargets(clients) {
  const all = Array.from(clients.values());
  const visible = all.filter((c) => c.visible === true);
  return visible.length > 0 ? visible : all;
}

/**
 * 认领判定（纯函数，供测试锁住）。
 *
 * @returns {'ok'|'missing'|'taken'|'expired'}
 */
export function claimVerdict(rec, nowMs) {
  if (!rec) return 'missing';
  if (rec.claimed) return 'taken';
  if (nowMs - rec.createdAt > TOKEN_TTL_MS) return 'expired';
  return 'ok';
}

/**
 * 一段播放最终该走哪条路（纯函数）。
 *
 * 顺序有讲究：**先看认领，再看 ack** —— 没人认领就没必要等 ack。
 */
export function settleVerdict({ claimed, acked, ackOk }) {
  if (!claimed) return 'fallback-no-client';
  if (!acked) return 'fallback-timeout';
  if (ackOk === false) return 'fallback-play-fail';
  return 'release';
}

/**
 * 创建播放通道。
 *
 * @param {object} opts
 * @param {(msg: string) => void} [opts.log] 写 notify.log 的函数
 * @param {() => number} [opts.now]
 * @param {(p: string) => Buffer} [opts.readFile]
 * @param {(p: string) => void} [opts.unlink]
 * @returns {object} 通道实例
 */
export function createAudioChannel(opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const readFile = typeof opts.readFile === 'function' ? opts.readFile : (p) => readFileSync(p);
  const unlink = typeof opts.unlink === 'function' ? opts.unlink : (p) => unlinkSync(p);
  // 两段超时可注入：测试要跑得快（否则每条用例都要真等 1.5s），
  // 现场调参时也不必改源码。默认值就是上面那两个常量。
  const claimMs = Number.isFinite(Number(opts.claimMs)) ? Number(opts.claimMs) : CLAIM_MS;
  const ackMs = Number.isFinite(Number(opts.ackMs)) ? Number(opts.ackMs) : ACK_GRACE_MS;

  /** @type {Map<string, {res: any, visible: boolean, cid: string}>} */
  const clients = new Map();
  /** @type {Map<string, object>} */
  const tokens = new Map();
  const keepalives = new Set();
  let seq = 0;
  let disposed = false;

  function safeLog(m) {
    try { log(m); } catch { /* 日志失败不影响播放 */ }
  }

  function safeUnlink(p) {
    if (!p) return;
    try { unlink(p); } catch { /* 文件可能已被删 */ }
  }

  function json(res, code, obj) {
    try {
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(obj));
    } catch { /* 响应已发出 */ }
  }

  function sseSend(client, obj) {
    try { client.res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* 连接已断 */ }
  }

  function broadcast(obj) {
    const targets = pickTargets(clients);
    for (const c of targets) sseSend(c, obj);
    return targets.length;
  }

  function dropToken(token) {
    const rec = tokens.get(token);
    if (!rec) return;
    tokens.delete(token);
    try { clearTimeout(rec.claimTimer); } catch { /* ignore */ }
    try { clearTimeout(rec.ackTimer); } catch { /* ignore */ }
    safeUnlink(rec.fileToDelete);
  }

  // ── HTTP 处理 ────────────────────────────────────────────────────────────

  function handleStream(req, res) {
    if (disposed) { json(res, 503, { ok: false, reason: 'disposed' }); return; }
    seq += 1;
    const cid = `c${seq}`;
    try {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-cache, must-revalidate',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 1000\n\n');
      res.write(': hello\n\n');
    } catch {
      return;
    }
    // 默认不可见：刚连上的窗口可能正是被遮挡的那个，先上报再算数。
    // （全都没上报时 pickTargets 会退化成"全推"，不会因此播不出去。）
    const client = { cid, res, visible: false };
    clients.set(cid, client);
    sseSend(client, { type: 'hello', cid });
    safeLog(`[audio] sse open cid=${cid} connected=${clients.size}`);

    const timer = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* 断了会走 close */ }
    }, KEEPALIVE_MS);
    try { timer.unref && timer.unref(); } catch { /* ignore */ }
    keepalives.add(timer);

    const bye = () => {
      clearInterval(timer);
      keepalives.delete(timer);
      clients.delete(cid);
      safeLog(`[audio] sse close cid=${cid} connected=${clients.size}`);
    };
    try { req.on('close', bye); } catch { /* ignore */ }
    try { res.on('close', bye); } catch { /* ignore */ }
  }

  function handleToken(res, token, cid) {
    const rec = tokens.get(token);
    const verdict = claimVerdict(rec, now());
    if (verdict !== 'ok') {
      // 204：前端据此知道"这发不是我的"，不报错、不重试。
      try { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); } catch { /* ignore */ }
      return;
    }
    rec.claimed = true;
    rec.claimedBy = cid || '';
    rec.claimedAt = now();
    rec.claimMs = rec.claimedAt - rec.createdAt;
    try { clearTimeout(rec.claimTimer); } catch { /* ignore */ }

    // 已认领 → 起 ack 宽限
    rec.ackTimer = setTimeout(() => {
      const live = tokens.get(token);
      if (!live || live.acked) return;
      live.ackTimer = null;
      conclude(token, { acked: false });
    }, ackMs);
    try { rec.ackTimer.unref && rec.ackTimer.unref(); } catch { /* ignore */ }

    try {
      res.writeHead(200, {
        'content-type': rec.contentType || 'audio/wav',
        'content-length': String(rec.bytes.length),
        'cache-control': 'no-store',
      });
      res.end(rec.bytes);
    } catch { /* 连接已断，ack 超时会兜住 */ }
  }

  function readJson(req) {
    return new Promise((resolve) => {
      let raw = '';
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      try {
        req.on('data', (c) => {
          if (raw.length < 4096) raw += c;
        });
        req.on('end', () => {
          try { finish(JSON.parse(raw || '{}')); } catch { finish({}); }
        });
        req.on('error', () => finish({}));
        setTimeout(() => finish({}), 2000).unref?.();
      } catch { finish({}); }
    });
  }

  async function handleAck(req, res) {
    const body = await readJson(req);
    const token = String(body && body.token || '');
    const cid = String(body && body.cid || '');
    const rec = tokens.get(token);
    if (!rec) { json(res, 200, { ok: false, reason: 'unknown-token' }); return; }

    // **只认领主的结论**：另一个窗口虽然没抢到 token（GET 回 204），但它自己
    // 的 fetch 也可能失败并误发 ack(false) —— 那会把正在播放的窗口判成失败，
    // 于是 PowerShell 又出声一遍（双声）。带 cid 的 ack 必须对得上认领者。
    if (rec.claimedBy && cid && rec.claimedBy !== cid) {
      json(res, 200, { ok: true, ignored: 'not-claimer' });
      return;
    }

    rec.acked = true;
    rec.ackOk = body.ok !== false;
    rec.ackMs = now() - (rec.claimedAt || rec.createdAt);
    try { clearTimeout(rec.ackTimer); } catch { /* ignore */ }
    json(res, 200, { ok: true });
    conclude(token, { acked: true, ackOk: rec.ackOk });
  }

  async function handleVisible(req, res) {
    const body = await readJson(req);
    const cid = String(body && body.cid || '');
    const c = clients.get(cid);
    if (!c) { json(res, 200, { ok: false, reason: 'unknown-client' }); return; }
    c.visible = body.state !== 'hidden';
    json(res, 200, { ok: true, cid, visible: c.visible });
  }

  function stats() {
    return { ok: true, connected: clients.size, pending: tokens.size, disposed };
  }

  function handler(req, res) {
    let pathname = '/';
    let query = '';
    try {
      const u = new URL(String(req.url || '/'), 'http://127.0.0.1');
      pathname = u.pathname;
      query = u.search || '';
    } catch { /* ignore */ }
    const idx = pathname.indexOf('/audio/');
    const sub = idx >= 0 ? pathname.slice(idx + '/audio/'.length) : '';
    const method = String((req && req.method) || 'GET').toUpperCase();
    // 认领时带上的 cid 用来锁定"谁是认领者"，供 ack 校验（见 handleAck）
    let qCid = '';
    try { qCid = new URLSearchParams(query).get('cid') || ''; } catch { /* ignore */ }

    if (method === 'GET' && sub === 'stream') return handleStream(req, res);
    if (method === 'GET' && sub.indexOf('t/') === 0) return handleToken(res, sub.slice(2), qCid);
    if (method === 'POST' && sub === 'ack') return handleAck(req, res);
    if (method === 'POST' && sub === 'visible') return handleVisible(req, res);
    if (method === 'GET' && (sub === '' || sub === 'stats')) return json(res, 200, stats());
    return json(res, 404, { ok: false, reason: 'not-found' });
  }

  // ── 播放编排 ─────────────────────────────────────────────────────────────

  /**
   * 让前端播一段音频；前端不接就自动回退 PowerShell。
   *
   * @param {object} p
   * @param {string} p.file 已选好的音频文件（可能是增益后的临时 wav）
   * @param {string} [p.contentType]
   * @param {string} [p.fileToDelete] 播完/回退后要删的临时文件
   * @param {number} p.volume 0~100
   * @param {object} [p.meta] 只用于日志（kind / playId 等）
   * @param {() => void} p.fallback 回退动作（走 PowerShell）
   * @returns {Promise<object>} 结论（便于测试与日志）
   */
  function play(p) {
    const { file, contentType, fileToDelete, volume, meta = {}, fallback } = p || {};
    const vol = clampVolume(volume);

    // 通道已卸载（插件 dispose / 热重载）：既不播也不回退。
    // 否则卸载瞬间还在 await 的那一发会在之后把 PowerShell 拉起来 —— 幽灵播报。
    if (disposed) {
      safeUnlink(fileToDelete);
      safeLog(`[play] via=disposed kind=${meta.kind || '?'}`);
      return Promise.resolve({ via: 'disposed', reason: 'disposed' });
    }

    // 音量 0 = 真静音：既不广播也不回退（与 ps1 的早退语义一致）
    if (vol === 0) {
      safeUnlink(fileToDelete);
      safeLog(`[play] via=muted kind=${meta.kind || '?'} vol=0`);
      return Promise.resolve({ via: 'muted' });
    }

    let bytes;
    try {
      bytes = readFile(file);
    } catch (e) {
      safeUnlink(fileToDelete);
      safeLog(`[play] via=ps-fallback reason=no-file kind=${meta.kind || '?'} err=${String((e && e.message) || e).slice(0, 120)}`);
      try { fallback && fallback(); } catch { /* ignore */ }
      return Promise.resolve({ via: 'ps-fallback', reason: 'no-file' });
    }

    // 没有客户端：不用等 400ms，直接回退（窗口关着是最常见情况）
    if (clients.size === 0) {
      safeUnlink(fileToDelete);
      safeLog(`[play] via=ps-fallback reason=no-client kind=${meta.kind || '?'} connected=0`);
      try { fallback && fallback(); } catch { /* ignore */ }
      return Promise.resolve({ via: 'ps-fallback', reason: 'no-client' });
    }

    seq += 1;
    const token = `p${seq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const rec = {
      token,
      bytes,
      contentType: contentType || 'audio/wav',
      fileToDelete,
      volume: vol,
      createdAt: now(),
      claimed: false,
      acked: false,
      ackOk: null,
      claimTimer: null,
      ackTimer: null,
      meta,
      fallback,
      resolve: null,
    };
    rec.promise = new Promise((resolve) => { rec.resolve = resolve; });
    tokens.set(token, rec);

    const delivered = broadcast({
      type: 'play',
      token,
      url: `audio/t/${token}`,
      volume: vol,
      expectMs: 240,
      kind: meta.kind || '',
    });

    // 无人认领 → 回退
    rec.claimTimer = setTimeout(() => {
      const live = tokens.get(token);
      if (!live || live.claimed) return;
      live.claimTimer = null;
      conclude(token, { claimed: false, acked: false });
    }, claimMs);
    try { rec.claimTimer.unref && rec.claimTimer.unref(); } catch { /* ignore */ }

    safeLog(`[play] broadcast playId=${token} kind=${meta.kind || '?'} vol=${vol} delivered=${delivered}`);
    return rec.promise;
  }

  /** 收尾：按状态回退或放行，保证**只回退一次**。 */
  function conclude(token, state) {
    const rec = tokens.get(token);
    if (!rec || rec.concluded) return;
    rec.concluded = true;

    const claimed = state.claimed !== undefined ? state.claimed : rec.claimed;
    const acked = state.acked !== undefined ? state.acked : rec.acked;
    const ackOk = state.ackOk !== undefined ? state.ackOk : rec.ackOk;
    const verdict = settleVerdict({ claimed, acked, ackOk });

    try { clearTimeout(rec.claimTimer); } catch { /* ignore */ }
    try { clearTimeout(rec.ackTimer); } catch { /* ignore */ }

    if (verdict === 'release') {
      safeLog(`[play] via=webaudio playId=${token} kind=${rec.meta.kind || '?'} `
        + `claimMs=${rec.claimMs || 0} ackMs=${rec.ackMs || 0} vol=${rec.volume}`);
    } else {
      const reason = verdict === 'fallback-no-client' ? 'no-client'
        : verdict === 'fallback-play-fail' ? 'play-fail' : 'timeout';
      safeLog(`[play] via=ps-fallback reason=${reason} playId=${token} `
        + `kind=${rec.meta.kind || '?'} claimMs=${rec.claimMs || 0}`);
      try { rec.fallback && rec.fallback(); } catch (e) {
        safeLog(`[play] fallback threw: ${String((e && e.message) || e).slice(0, 120)}`);
      }
    }

    tokens.delete(token);
    safeUnlink(rec.fileToDelete);
    try { rec.resolve && rec.resolve({ via: verdict === 'release' ? 'webaudio' : 'ps-fallback', reason: verdict, claimMs: rec.claimMs || 0, ackMs: rec.ackMs || 0 }); } catch { /* ignore */ }
  }

  function dispose() {
    disposed = true;
    for (const t of Array.from(tokens.keys())) {
      const rec = tokens.get(t);
      try { clearTimeout(rec.claimTimer); } catch { /* ignore */ }
      try { clearTimeout(rec.ackTimer); } catch { /* ignore */ }
      safeUnlink(rec.fileToDelete);
      tokens.delete(t);
      // ⚠️ 必须 resolve：调用方在 await 这个 Promise，卸载时不 resolve 会
      // 让 await 永远悬着（测试里表现为"进程不退出"，生产里是内存泄漏）。
      // 卸载时不回退 —— 通道都关了，再拉 ps1 就是幽灵播报。
      try {
        rec.resolve && rec.resolve({ via: 'disposed', reason: 'disposed' });
      } catch { /* ignore */ }
    }
    for (const timer of keepalives) {
      try { clearInterval(timer); } catch { /* ignore */ }
    }
    keepalives.clear();
    for (const c of clients.values()) {
      try { c.res.end(); } catch { /* ignore */ }
    }
    clients.clear();
  }

  return { handler, play, stats, dispose, broadcast, _clients: clients, _tokens: tokens };
}
