require('ts-node/register');
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
process.env.CHAT_ID = '123';
process.env.TELEGRAM_CHANNEL_ID = '@testchannel';
process.env.HTTPAPI_TG = 'test-token';
function mock(module, exports) {
  const id = require.resolve(module);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
let row, requests, articleQuery, uploads, failUpload;
const candidates = Array.from({ length: 12 }, (_, i) => ({ id: `article${i}`,
  title: `Story <${i}> & details`, url: `https://example.com/${i}`, telegramMessageId: 100 + i, score: i / 2 }));
const db = {
  findUnique: async () => row && structuredClone(row),
  upsert: async ({ create }) => {
    row ??= { ...create, selectedIds: [], reviewMessageIds: [], version: 0 };
    return structuredClone(row);
  },
  updateMany: async ({ where, data }) => {
    if (!row || (where.status && row.status !== where.status) ||
      (where.version !== undefined && row.version !== where.version)) return { count: 0 };
    Object.assign(row, data, { version: data.version ? row.version + 1 : row.version });
    return { count: 1 };
  },
  update: async ({ data }) => {
    if (data.reviewMessageIds?.push) row.reviewMessageIds.push(data.reviewMessageIds.push);
    else Object.assign(row, data);
    return structuredClone(row);
  },
};
mock('../src/db/prisma', { prisma: { dailyDigest: db, article: {
  findMany: async query => { articleQuery = query; return candidates; },
}}});
mock('../src/services/telegram.service', {
  telegramRequest: async (method, body) => { requests.push({ method, body }); return { message_id: requests.length }; },
  sendDigestPhoto: async (image, caption) => {
    uploads.push({ image, caption });
    if (failUpload) throw Error('timeout');
    return 999;
  },
});
const { runDailyDigestTick, handleDigestCallback, digestSchedule, digestCaption, selectDigestCandidates } = require('../src/services/daily-digest.service');
const { generateDontSkipImage, wrapHeadline } = require('../src/services/dontskip-image');
let fixtureDirectory;
const originalTemplate = process.env.DONTSKIP_TEMPLATE_PATH;
before(async () => {
  fixtureDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'dontskip-tests-'));
  process.env.DONTSKIP_TEMPLATE_PATH = path.join(fixtureDirectory, 'template.png');
  await sharp({ create: { width: 1200, height: 1200, channels: 3, background: 'black' } })
    .png().toFile(process.env.DONTSKIP_TEMPLATE_PATH);
});
after(async () => {
  if (originalTemplate === undefined) delete process.env.DONTSKIP_TEMPLATE_PATH;
  else process.env.DONTSKIP_TEMPLATE_PATH = originalTemplate;
  await fs.rm(fixtureDirectory, { recursive: true, force: true });
});
const at = time => new Date(`2026-10-15T${time}Z`);
function reset() { row = null; requests = []; uploads = []; articleQuery = null; failUpload = false; }
function callback(index, chat = '123', message_id = 1) {
  return { id: 'callback', data: `digest:2026-10-15:${index}`, message: { message_id, chat: { id: chat } } };
}

test('UTC boundaries and all candidates are snapshotted once across selection pages and restarts', async () => {
  reset();
  assert.equal(digestSchedule(new Date('2026-10-16T00:30:00+03:00')).date, '2026-10-15');
  await runDailyDigestTick(at('18:49:59.999'));
  assert.equal(row, null);
  await runDailyDigestTick(at('18:50:00'));
  assert.deepEqual(articleQuery.where.channelPublishedAt, { gte: at('00:00:00'), lte: at('18:50:00') });
  assert.equal(articleQuery.where.status, 'PUBLISHED');
  assert.equal(row.candidates.length, 12);
  assert.equal(row.reviewMessageIds.length, 3);
  assert.match(row.candidates[0].url, /https:\/\/t.me\/testchannel\/100/);
  assert.match(requests[0].body.text, /Story &lt;0&gt; &amp; details/);
  await runDailyDigestTick(at('18:55:00'));
  assert.equal(requests.length, 3);
  assert.equal(uploads.length, 0);
});

test('owner can toggle exactly two saved choices; foreign, stale and forged buttons are rejected', async () => {
  reset(); await runDailyDigestTick(at('18:50:00'));
  await handleDigestCallback(callback(0, 'other'), at('18:55:00'));
  await handleDigestCallback(callback(0, '123', 900), at('18:55:00'));
  assert.equal(row.selectedIds.length, 0);
  assert.match(await handleDigestCallback(callback(0), at('18:55:00')), /1\/2/);
  await handleDigestCallback(callback(1), at('18:55:00'));
  assert.match(await handleDigestCallback(callback(2), at('18:55:00')), /Уже выбраны/);
  await handleDigestCallback(callback(0), at('18:55:00'));
  await handleDigestCallback(callback(2), at('18:55:00'));
  assert.deepEqual(row.selectedIds, ['article1', 'article2']);
  assert.match(await handleDigestCallback(callback(2), at('19:00:00')), /завершён/);
  assert.deepEqual(row.selectedIds, ['article1', 'article2']);
});

test('19:00 sends one real PNG with selected titles and links, with duplicate tick protection', async () => {
  reset(); await runDailyDigestTick(at('18:50:00'));
  await handleDigestCallback(callback(1), at('18:55:00'));
  await handleDigestCallback(callback(2), at('18:55:00'));
  await runDailyDigestTick(at('18:59:59.999'));
  assert.equal(uploads.length, 0);
  await Promise.all([runDailyDigestTick(at('19:00:00')), runDailyDigestTick(at('19:00:00'))]);
  assert.equal(uploads.length, 1);
  assert.equal(row.status, 'PUBLISHED');
  assert.equal(row.telegramMessageId, 999);
  assert.match(uploads[0].caption, /^#DONTSKIP\n\n<a href="https:\/\/t.me\/testchannel\/101">/);
  const metadata = await sharp(uploads[0].image).metadata();
  assert.equal(metadata.width, 1200); assert.equal(metadata.height, 1200);
  await runDailyDigestTick(at('19:01:00'));
  assert.equal(uploads.length, 1);
});

test('one manual choice is retained and the second story is filled by overall score', async () => {
  reset(); await runDailyDigestTick(at('19:00:00'));
  assert.equal(row, null);
  await runDailyDigestTick(at('18:50:00'));
  await handleDigestCallback(callback(1), at('18:55:00'));
  await runDailyDigestTick(at('19:00:00'));
  assert.equal(row.status, 'PUBLISHED');
  assert.deepEqual(row.selectedIds, ['article1', 'article11']);
  const count = requests.length;
  await runDailyDigestTick(at('19:00:01'));
  assert.equal(requests.length, count);
  assert.equal(uploads.length, 1);
});

test('no manual selection publishes the two highest overall scores and persists the final choices', async () => {
  reset(); await runDailyDigestTick(at('18:50:00'));
  assert.equal(articleQuery.select.score, true);
  await runDailyDigestTick(at('19:00:00'));
  assert.deepEqual(row.selectedIds, ['article11', 'article10']);
  assert.equal(row.status, 'PUBLISHED');
  assert.equal(uploads.length, 1);
  assert.match(uploads[0].caption, /\/111/);
  assert.match(uploads[0].caption, /\/110/);
});

test('automatic choice skips missing scores, breaks ties by candidate order and avoids duplicates', () => {
  const items = [
    { id: 'a', score: null }, { id: 'b', score: 0 }, { id: 'c', score: 9 },
    { id: 'd', score: 9 }, { id: 'e', score: NaN }, { id: 'f', score: Infinity },
  ];
  assert.deepEqual(selectDigestCandidates(items, []).map(item => item.id), ['c', 'd']);
  assert.deepEqual(selectDigestCandidates(items, ['a']).map(item => item.id), ['a', 'c']);
  assert.deepEqual(selectDigestCandidates(items, ['b', 'a']).map(item => item.id), ['b', 'a']);
  assert.deepEqual(selectDigestCandidates(items, ['c', 'c']).map(item => item.id), ['c', 'd']);
  assert.deepEqual(selectDigestCandidates(items.slice(0, 2), []).map(item => item.id), ['b']);
});

test('older candidate snapshots get scores without adding candidates from outside the original window', async () => {
  reset(); await runDailyDigestTick(at('18:50:00'));
  row.candidates.forEach(item => { delete item.score; });
  await runDailyDigestTick(at('19:00:00'));
  assert.deepEqual(row.selectedIds, ['article11', 'article10']);
  assert.deepEqual(articleQuery.where.id.in, candidates.map(item => item.id));
  assert.equal(row.status, 'PUBLISHED');
});

test('insufficient scored candidates skip the issue once', async () => {
  reset(); await runDailyDigestTick(at('18:50:00'));
  row.candidates.forEach(item => { item.score = null; });
  row.candidates[0].score = 8;
  await runDailyDigestTick(at('19:00:00'));
  assert.equal(row.status, 'SKIPPED');
  assert.equal(uploads.length, 0);
  const count = requests.length;
  await runDailyDigestTick(at('19:01:00'));
  assert.equal(requests.length, count);
});

test('ambiguous Telegram send is retained for reconciliation and never resent', async () => {
  reset(); await runDailyDigestTick(at('18:50:00'));
  await handleDigestCallback(callback(0), at('18:55:00'));
  await handleDigestCallback(callback(1), at('18:55:00'));
  failUpload = true;
  await assert.rejects(runDailyDigestTick(at('19:00:00')), /timeout/);
  assert.equal(row.status, 'PUBLISHING');
  await runDailyDigestTick(at('19:01:00'));
  assert.equal(uploads.length, 1);
});

test('image handles Unicode, escaped text, overflowing tokens, UTC date and missing logo', async () => {
  assert.equal(wrapHeadline('word '.repeat(50)).length, 3);
  assert.match(wrapHeadline('word '.repeat(50))[2], /…$/);
  assert.ok(wrapHeadline('x'.repeat(100)).every(line => line.length <= 32));
  const image = await generateDontSkipImage({ firstHeadline: 'Новость <one> & "two"',
    secondHeadline: 'Second story', date: at('19:00:00') });
  assert.equal((await sharp(image).metadata()).format, 'png');
  assert.throws(() => digestCaption([{ title: 'Bad', url: 'javascript:alert(1)' }, candidates[0]]), /Invalid/);
});

test('PNG template is preserved under text overlays and invalid template sizes fail', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dontskip-template-'));
  const previous = process.env.DONTSKIP_TEMPLATE_PATH;
  const template = path.join(directory, 'template.png');
  process.env.DONTSKIP_TEMPLATE_PATH = template;
  const params = { firstHeadline: 'First headline', secondHeadline: 'Second headline', date: at('19:00:00') };
  try {
    await assert.rejects(generateDontSkipImage(params), /Cannot read DONTSKIP_TEMPLATE_PATH/);
    await sharp({ create: { width: 1200, height: 1200, channels: 3, background: '#123456' } }).png().toFile(template);
    const output = await generateDontSkipImage(params);
    const { data, info } = await sharp(output).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixel = (x, y) => [...data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3)];
    assert.deepEqual(pixel(0, 0), [18, 52, 86]);
    assert.deepEqual(pixel(600, 550), [18, 52, 86], 'existing branding area must remain untouched');
    let textPixels = 0;
    for (let y = 210; y < 265; y++) {
      for (let x = 200; x < 1000; x++) {
        if (pixel(x, y).every(value => value > 230)) textPixels++;
      }
    }
    assert.ok(textPixels > 100, 'headline must be composited onto the template');
    await sharp({ create: { width: 600, height: 600, channels: 3, background: 'black' } }).png().toFile(template);
    await assert.rejects(generateDontSkipImage(params), /1200x1200/);
  } finally {
    if (previous === undefined) delete process.env.DONTSKIP_TEMPLATE_PATH;
    else process.env.DONTSKIP_TEMPLATE_PATH = previous;
    await fs.rm(directory, { recursive: true, force: true });
  }
});
