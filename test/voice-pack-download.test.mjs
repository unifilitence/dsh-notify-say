/**
 * 语音包下载与安装测试（v0.4.31）。
 *
 * ## 这是本项目唯一写盘的功能，所以测的重点是**拒绝**
 *
 * 正常路径只有一条（下载 → 校验 → 解压 → 安装），
 * 但错误路径很多，每一条都可能是安全漏洞：
 *
 *   · zip 里藏 `../../evil.wav`          → zip-slip
 *   · 哈希不匹配（被替换/损坏）           → 必须丢弃
 *   · zip 炸弹（解压后几十 GB）           → 必须限流
 *   · 不支持的压缩方法                    → 必须报错，不能静默产出坏文件
 *
 * 所以下面的测试大多在验证「该失败的时候真的失败了」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';

import {
  safeZipEntry,
  listZipEntries,
  sha256Of,
  packDownloadUrl,
  fetchPackIndex,
  installVoicePack,
  uninstallVoicePack,
  readInstalledManifest,
} from '../lib/voice-pack-download.js';
import { userKeyDir } from '../lib/voice-pack-store.js';

/**
 * 造一个最小 zip（支持 stored 与 deflate）。
 *
 * 手写而不是用库：本模块的解压逻辑就是自己实现的，
 * 用同一个库生成会掩盖实现对不上的问题。
 *
 * @param {Array<{name: string, data: Buffer, method?: number}>} entries
 * @returns {Buffer}
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const method = e.method === undefined ? 0 : e.method;
    const raw = e.data;
    const comp = method === 8 ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(0, 10);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(0, 12);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + comp.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cd, eocd]);
}

/** CRC32（zip 用）。 */
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? ((c >>> 1) ^ 0xEDB88320) : (c >>> 1);
    }
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** 假 fetch：返回指定 buffer。 */
function fakeFetch(buf, { status = 200 } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => String(buf ? buf.length : 0) },
    arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    json: async () => JSON.parse(buf.toString('utf8')),
  });
}

/** 临时切换数据目录。 */
async function withDataDir(fn) {
  const old = process.env.DSH_NOTIFY_SAY_DATA_DIR;
  const dir = mkdtempSync(join(tmpdir(), 'vpd-'));
  process.env.DSH_NOTIFY_SAY_DATA_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (old === undefined) delete process.env.DSH_NOTIFY_SAY_DATA_DIR;
    else process.env.DSH_NOTIFY_SAY_DATA_DIR = old;
  }
}

// ── W1: zip-slip 路径必须拒绝 ───────────────────────────────────────────
test('W1: safeZipEntry 拒绝所有逃逸路径', () => {
  const bad = [
    '../../evil.wav',
    'a/../../evil.wav',
    '/etc/passwd',
    'C:\\Windows\\evil.wav',
    '..\\..\\evil.wav',
    '',
  ];
  for (const p of bad) {
    const r = safeZipEntry(p);
    assert.equal(r.ok, false, `应拒绝：${p}`);
  }
});

// ── W2: 正常路径放行 ────────────────────────────────────────────────────
test('W2: safeZipEntry 放行正常的相对路径', () => {
  for (const p of ['zundamon-normal/done/a.wav', 'a/b/c.wav', 'file.wav']) {
    assert.equal(safeZipEntry(p).ok, true, `应放行：${p}`);
  }
});

// ── W3: 哈希校验 —— 不匹配必须拒绝 ──────────────────────────────────────
test('W3: sha256 不匹配时拒绝安装（挡住被替换的包）', async () => {
  await withDataDir(async () => {
    const zip = makeZip([{ name: 'k/a.wav', data: Buffer.from('hello') }]);
    const r = await installVoicePack('k', {
      url: 'x',
      sha256: '0'.repeat(64),      // 故意给错的
      fetchImpl: fakeFetch(zip),
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'sha256-mismatch');
    assert.equal(existsSync(userKeyDir('k')), false, '失败时不该留下任何目录');
  });
});

// ── W4: 正常安装（stored）──────────────────────────────────────────────
test('W4: stored 压缩的包能正常安装', async () => {
  await withDataDir(async () => {
    const zip = makeZip([
      { name: 'k/a.wav', data: Buffer.from('AAA'), method: 0 },
      { name: 'k/fail/b.wav', data: Buffer.from('BBB'), method: 0 },
    ]);
    const r = await installVoicePack('k', {
      url: 'x',
      sha256: sha256Of(zip),
      fetchImpl: fakeFetch(zip),
    });
    assert.equal(r.ok, true, `应成功，实际 ${r.error}`);
    assert.equal(r.files, 2);
    assert.ok(existsSync(join(userKeyDir('k'), 'a.wav')));
    assert.ok(existsSync(join(userKeyDir('k'), 'fail', 'b.wav')));
  });
});

// ── W5: deflate 压缩的包也能装 ──────────────────────────────────────────
test('W5: deflate 压缩的包能正常安装', async () => {
  await withDataDir(async () => {
    const content = Buffer.from('x'.repeat(2000));
    const zip = makeZip([{ name: 'k/a.wav', data: content, method: 8 }]);
    const r = await installVoicePack('k', {
      url: 'x',
      sha256: sha256Of(zip),
      fetchImpl: fakeFetch(zip),
    });
    assert.equal(r.ok, true, `应成功，实际 ${r.error}`);
    const got = readFileSync(join(userKeyDir('k'), 'a.wav'));
    assert.equal(got.length, 2000, '解压后内容应与原数据等长');
  });
});

// ── W6: zip 内含逃逸路径时整体拒绝 ──────────────────────────────────────
test('W6: zip 里有逃逸条目时整个安装失败（不留半装状态）', async () => {
  await withDataDir(async () => {
    const zip = makeZip([
      { name: 'k/ok.wav', data: Buffer.from('OK') },
      { name: '../../escape.wav', data: Buffer.from('EVIL') },
    ]);
    const r = await installVoicePack('k', {
      url: 'x',
      sha256: sha256Of(zip),
      fetchImpl: fakeFetch(zip),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /zip-unsafe-entry/);
    assert.equal(existsSync(userKeyDir('k')), false, '不能留下任何安装痕迹');
  });
});

// ── W7: 空 zip 拒绝 ────────────────────────────────────────────────────
test('W7: 不含文件的 zip 被拒绝', async () => {
  await withDataDir(async () => {
    const zip = makeZip([]);
    const r = await installVoicePack('k', {
      url: 'x',
      sha256: sha256Of(zip),
      fetchImpl: fakeFetch(zip),
    });
    assert.equal(r.ok, false);
    assert.match(r.error, /zip-empty/);
  });
});

// ── W8: 非法 key 拒绝（防路径注入）──────────────────────────────────────
test('W8: 非法音色 key 被拒绝（防把 ../ 当 key）', async () => {
  await withDataDir(async () => {
    for (const key of ['../evil', 'a/b', '', 'a b']) {
      const r = await installVoicePack(key, { url: 'x', sha256: '0'.repeat(64) });
      assert.equal(r.ok, false, `应拒绝 key：${key}`);
      assert.equal(r.error, 'bad-key');
    }
  });
});

// ── W9: 下载失败时给出结构化错误 ────────────────────────────────────────
test('W9: HTTP 404 时返回错误而不是抛', async () => {
  await withDataDir(async () => {
    const r = await installVoicePack('k', {
      url: 'x',
      sha256: '0'.repeat(64),
      fetchImpl: fakeFetch(Buffer.alloc(0), { status: 404 }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.error, 'http-404');
  });
});

// ── W10: 卸载只删用户目录 ───────────────────────────────────────────────
test('W10: uninstall 删掉整个音色目录', async () => {
  await withDataDir(async () => {
    const zip = makeZip([{ name: 'k/a.wav', data: Buffer.from('A') }]);
    await installVoicePack('k', { url: 'x', sha256: sha256Of(zip), fetchImpl: fakeFetch(zip) });
    assert.ok(existsSync(userKeyDir('k')));

    const r = uninstallVoicePack('k');
    assert.equal(r.ok, true);
    assert.equal(existsSync(userKeyDir('k')), false, '卸载后整个目录应消失');
  });
});

// ── W11: 卸载不存在的音色给明确原因 ─────────────────────────────────────
test('W11: 卸载未安装的音色返回 not-installed', async () => {
  await withDataDir(() => {
    const r = uninstallVoicePack('never-installed');
    assert.equal(r.ok, false);
    assert.equal(r.error, 'not-installed');
  });
});

// ── W12: 索引解析只保留形状正确的条目 ───────────────────────────────────
test('W12: fetchPackIndex 过滤掉形状不对的条目', async () => {
  const index = {
    version: '1.0.0',
    packs: [
      { key: 'good', file: 'good.zip', sha256: 'a'.repeat(64) },
      { key: 'no-hash', file: 'x.zip' },                       // 缺 sha256
      { key: 'short-hash', file: 'y.zip', sha256: 'abc' },      // 长度不对
      { file: 'z.zip', sha256: 'b'.repeat(64) },                // 缺 key
    ],
  };
  const buf = Buffer.from(JSON.stringify(index));
  const r = await fetchPackIndex({ url: 'x', fetchImpl: fakeFetch(buf) });
  assert.equal(r.ok, true);
  assert.equal(r.packs.length, 1, '只有完整条目应保留');
  assert.equal(r.packs[0].key, 'good');
});

// ── W13: packDownloadUrl 拼出正确地址 ───────────────────────────────────
test('W13: packDownloadUrl 从索引算下载地址', () => {
  const packs = [{ key: 'k', file: 'k.zip', sha256: 'a'.repeat(64) }];
  const r = packDownloadUrl(packs, 'k', 'https://example.com/dl/');
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://example.com/dl/k.zip');

  const miss = packDownloadUrl(packs, 'nope', 'https://example.com/dl/');
  assert.equal(miss.ok, false);
  assert.equal(miss.error, 'not-in-index');
});

// ── W14: 读取已装包的 MANIFEST ──────────────────────────────────────────
test('W14: readInstalledManifest 能读回安装时写入的清单', async () => {
  await withDataDir(async () => {
    const manifest = { key: 'k', name: '测试音色', files: [] };
    const zip = makeZip([
      { name: 'k/a.wav', data: Buffer.from('A') },
      { name: 'k/MANIFEST.json', data: Buffer.from(JSON.stringify(manifest)) },
    ]);
    await installVoicePack('k', { url: 'x', sha256: sha256Of(zip), fetchImpl: fakeFetch(zip) });

    const got = readInstalledManifest('k');
    assert.ok(got, '应能读回 MANIFEST');
    assert.equal(got.name, '测试音色');
  });
});

// ── W15: 重复安装会覆盖（不是叠加）──────────────────────────────────────
test('W15: 重复安装同一音色是覆盖，不是叠加', async () => {
  await withDataDir(async () => {
    const zip1 = makeZip([{ name: 'k/old.wav', data: Buffer.from('OLD') }]);
    await installVoicePack('k', { url: 'x', sha256: sha256Of(zip1), fetchImpl: fakeFetch(zip1) });
    assert.ok(existsSync(join(userKeyDir('k'), 'old.wav')));

    const zip2 = makeZip([{ name: 'k/new.wav', data: Buffer.from('NEW') }]);
    await installVoicePack('k', { url: 'x', sha256: sha256Of(zip2), fetchImpl: fakeFetch(zip2) });

    assert.ok(existsSync(join(userKeyDir('k'), 'new.wav')));
    assert.equal(existsSync(join(userKeyDir('k'), 'old.wav')), false,
      '旧文件应被清掉 —— 否则升级后会留下"半新半旧"的语音');
  });
});

// ── W16: listZipEntries 能解析真实结构 ──────────────────────────────────
test('W16: listZipEntries 列出条目与压缩方法', () => {
  const zip = makeZip([
    { name: 'a.wav', data: Buffer.from('A'), method: 0 },
    { name: 'b/c.wav', data: Buffer.from('CC'), method: 8 },
  ]);
  const r = listZipEntries(zip);
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 2);
  assert.equal(r.entries[0].method, 0);
  assert.equal(r.entries[1].method, 8);
  assert.equal(r.entries[0].name, 'a.wav');
});

// ── W17: 损坏的 zip 给出明确错误 ────────────────────────────────────────
test('W17: 损坏的 zip 返回结构化错误而不是崩溃', () => {
  const r = listZipEntries(Buffer.from('not a zip at all'));
  assert.equal(r.ok, false);
  assert.ok(r.error, '应给出错误原因');
});

// ── W18: 索引地址不能依赖 /releases/latest（否则发个插件版就把音色列表弄坏）──
test('W18: 索引用固定 tag，latest 只作回退', async () => {
  const { PACK_INDEX_URL, PACK_INDEX_URL_FALLBACK, fetchPackIndex } =
    await import('../lib/voice-pack-download.js');

  // 外部审阅 2026-10-18 指出：`/releases/latest/download/packs.json` 的问题是，
  // latest 指向最新 Release —— 若哪天发了个只有插件的版本，
  // 它没有 packs.json → 404 → 旧下载器的音色列表整个失效。
  assert.doesNotMatch(PACK_INDEX_URL, /releases\/latest/,
    '主地址不能用 latest —— 发一个不带 packs.json 的 Release 就会让它 404');
  assert.match(PACK_INDEX_URL, /releases\/download\/voice-packs\/packs\.json/,
    '主地址应是固定 tag voice-packs');
  assert.match(PACK_INDEX_URL_FALLBACK, /releases\/latest/,
    'latest 保留为回退（固定 tag 还没建好时仍能用）');
});

// ── W19: 固定地址失败要自动回退 ─────────────────────────────────────────
test('W19: 固定地址失败时回退到 latest', async () => {
  const { PACK_INDEX_URL, PACK_INDEX_URL_FALLBACK, fetchPackIndex } =
    await import('../lib/voice-pack-download.js');

  const seen = [];
  const fake = async (url) => {
    seen.push(url);
    if (url === PACK_INDEX_URL) return { ok: false, status: 404 };
    return {
      ok: true,
      json: async () => ({ packs: [{ key: 'k', file: 'k.zip', sha256: 'a'.repeat(64) }] }),
    };
  };

  const r = await fetchPackIndex({ fetchImpl: fake });
  assert.equal(r.ok, true, '回退后应成功');
  assert.equal(r.source, 'fallback', '应标明用的是回退地址（排查"列表是旧的"时有用）');
  assert.deepEqual(seen, [PACK_INDEX_URL, PACK_INDEX_URL_FALLBACK],
    '应先试固定地址，失败再试 latest');
});

// ── W20: 两个地址都失败时要报错，不能静默成功 ───────────────────────────
test('W20: 两个地址都失败时明确报错', async () => {
  const { fetchPackIndex } = await import('../lib/voice-pack-download.js');
  const fake = async () => ({ ok: false, status: 503 });
  const r = await fetchPackIndex({ fetchImpl: fake });
  assert.equal(r.ok, false);
  assert.match(r.error, /503/, '应把最后一次的失败原因带出来');
});
// ── W21: 下载走流式限额（不先读完整响应）────────────────────────────────
test('W21: 有 res.body 时用流式读取，超限立即中止', async () => withDataDir(async () => {
  // 第三轮审阅指出：原来 `res.arrayBuffer()` 读完整响应才查大小 ——
  // Content-Length 是服务器说了算的，谎报时内存会被吃满再检查。
  const { installVoicePack } = await import('../lib/voice-pack-download.js');

  // 造一个永远吐 1 MB 块的流，总共吐 40 块（40 MB > 32 MB 上限）
  let pulled = 0;
  let cancelled = false;
  const chunk = Buffer.alloc(1024 * 1024, 0x41);

  const fakeFetch = async () => ({
    ok: true,
    // ⚠️ 故意谎报 Content-Length：报 1 KB，实际 40 MB
    headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? '1024' : null) },
    body: {
      getReader() {
        return {
          async read() {
            if (pulled >= 40) return { done: true, value: undefined };
            pulled++;
            return { done: false, value: chunk };
          },
          async cancel() { cancelled = true; },
        };
      },
    },
    arrayBuffer: async () => { throw new Error('不应调用 arrayBuffer（应走流式）'); },
  });

  const r = await installVoicePack('w21-test', {
    url: 'https://example.invalid/x.zip',
    sha256: 'a'.repeat(64),
    fetchImpl: fakeFetch,
    logger: { info() {}, warn() {} },
  });

  assert.equal(r.ok, false);
  assert.equal(r.error, 'pack-too-large', '超限应报 pack-too-large');
  assert.equal(cancelled, true, '超限后必须 cancel 流，停止继续拉取');
  assert.ok(pulled < 40,
    `应在超过 32 MB 时立即中止，不该读完 40 块（实际拉了 ${pulled} 块）`);
}));

// ── W22: 没有 res.body 时退回 arrayBuffer（老运行时兼容）────────────────
test('W22: 没有 res.body 时退回整块读取，并事后校验大小', async () => withDataDir(async () => {
  const { installVoicePack } = await import('../lib/voice-pack-download.js');

  // 32 MB + 1 字节，且不带 body → 走 arrayBuffer 分支，事后应被拒
  const big = Buffer.alloc(32 * 1024 * 1024 + 1, 0x42);
  const fakeFetch = async () => ({
    ok: true,
    headers: { get: () => null },   // 不报 Content-Length
    arrayBuffer: async () => big.buffer.slice(big.byteOffset, big.byteOffset + big.length),
  });

  const r = await installVoicePack('w22-test', {
    url: 'https://example.invalid/x.zip',
    sha256: 'a'.repeat(64),
    fetchImpl: fakeFetch,
    logger: { info() {}, warn() {} },
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'pack-too-large', '退回分支也必须事后校验大小');
}));

// ── W23: 流式路径能正确拼接分块 ─────────────────────────────────────────
// ⚠️ 必须包 withDataDir：installVoicePack 会往**真实**的用户目录写盘
// （%LOCALAPPDATA%\dsh-notify-say\voice-lines\<key>）。W21~W23 原来没包，
// 于是在 2026-11-23 实测发现：跑一次 `npm test` 就往本机用户目录里留下
// 一个 w23-test（里面只有一个 a.txt，零 wav），并且它会被当成"已安装音色"
// 出现在设置页的音色下拉里 —— 测试污染了用户数据。
// 教训同 test-env-setup.mjs 的 notify.log 那次：**只隔离 DSH_HOME 不够**，
// 凡是有写盘路径的模块，都要把它的根目录一起指到临时目录。
test('W23: 流式分块能正确拼成完整 zip（不是只拿第一块）', async () => withDataDir(async () => {
  const { installVoicePack, listZipEntries } = await import('../lib/voice-pack-download.js');
  const { createHash } = await import('node:crypto');

  // 造一个真实的小 zip，把它切成多块喂进去
  const zip = buildTinyZip('a.txt', Buffer.from('hello', 'utf8'));
  const sha = createHash('sha256').update(zip).digest('hex');

  const parts = [];
  for (let i = 0; i < zip.length; i += 7) parts.push(zip.subarray(i, i + 7));
  let idx = 0;

  const fakeFetch = async () => ({
    ok: true,
    headers: { get: () => String(zip.length) },
    body: {
      getReader() {
        return {
          async read() {
            if (idx >= parts.length) return { done: true, value: undefined };
            const v = parts[idx++];
            return { done: false, value: new Uint8Array(v) };
          },
          async cancel() {},
        };
      },
    },
  });

  const r = await installVoicePack('w23-test', {
    url: 'https://example.invalid/x.zip',
    sha256: sha,
    fetchImpl: fakeFetch,
    logger: { info() {}, warn() {} },
  });

  // 这个小 zip 没有 wav，install 会因为"找不到可安装文件"之类的理由失败，
  // 但**绝不该是 sha256-mismatch** —— 那说明分块没拼对。
  assert.notEqual(r.error, 'sha256-mismatch',
    '分块拼接错误会导致哈希对不上；这里哈希应匹配，说明拼装正确');
}));
// ── 测试辅助：构造最小 stored ZIP ────────────────────────────────────────
function buildTinyZip(name, content) {
  const nameBuf = Buffer.from(name, 'utf8');
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(0, 8);                 // stored
  lfh.writeUInt32LE(content.length, 18);   // compSize
  lfh.writeUInt32LE(content.length, 22);   // uncompSize
  lfh.writeUInt16LE(nameBuf.length, 26);

  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt32LE(content.length, 20);
  cd.writeUInt32LE(content.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);

  const local = Buffer.concat([lfh, nameBuf, content]);
  const central = Buffer.concat([cd, nameBuf]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length, 12);
  eocd.writeUInt32LE(local.length, 16);

  return Buffer.concat([local, central, eocd]);
}