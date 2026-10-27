require('ts-node/register');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
function mock(module, exports) {
  const id = require.resolve(module);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
let issue, articles = [], sent = [], copyCalls = 0;
// Deliberately expose only reads: any accidental production state write fails.
mock('../src/db/prisma', { prisma: {
  dailyDigest: { findUnique: async () => structuredClone(issue) },
  article: { findMany: async () => structuredClone(articles) },
} });
mock('../src/services/telegram.service', { sendDigestPhoto: async (photo, caption, chatId) => {
  sent.push({ photo, caption, chatId }); return 123;
} });
mock('../src/services/dontskip-copy.service', { generateDigestDisplay: async stories => {
  copyCalls++;
  return stories.map(item => ({ id: item.id, kicker: 'NEWS', displayHeadline: 'NEW DISPLAY COPY' }));
} });
const { runDontSkipOnce } = require('../src/jobs/test-dontskip-once.job');
const directory = fs.mkdtemp(path.join(os.tmpdir(), 'digest-once-'));
after(async () => fs.rm(await directory, { recursive: true, force: true }));
const story = (id, score) => ({ id, title: `Story ${id}`, url: `https://example.com/${id}`, score,
  display: { kicker: 'NEWS', displayHeadline: `STORY ${id.toUpperCase()}` } });

test('rerenders a published issue with saved selection and copy, sends only to owner, leaves state intact', async () => {
  process.env.CHAT_ID = 'owner'; process.env.HTTPAPI_TG = 'test-token';
  process.env.TELEGRAM_CHANNEL_ID = 'public-channel';
  issue = { status: 'PUBLISHED', selectedIds: ['second', 'first'],
    candidates: [story('first', 9), story('second', 8)] };
  const before = structuredClone(issue);
  const output = path.join(await directory, 'published.png');
  const result = await runDontSkipOnce({ date: '2026-10-27', output });
  assert.deepEqual(issue, before);
  assert.equal(copyCalls, 0);
  assert.equal(result.messageId, 123);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, 'owner');
  assert.match(sent[0].caption, /^TEST — 2026-10-27 UTC/);
  assert.ok(sent[0].caption.indexOf('Story second') < sent[0].caption.indexOf('Story first'));
  assert.deepEqual(await fs.readFile(output), sent[0].photo);
  assert.equal((await sharp(sent[0].photo).metadata()).width, 1200);
});

test('no saved issue uses ranked publications and generates copy without creating a digest', async () => {
  issue = null;
  articles = [story('first', 8), story('second', 9)].map(({ display, ...item }) => item);
  const result = await runDontSkipOnce({ date: '2026-10-27', localOnly: true,
    output: path.join(await directory, 'new.png') });
  assert.equal(copyCalls, 1);
  assert.equal(sent.length, 1);
  assert.equal(result.messageId, undefined);
  assert.equal(issue, null);
});

test('sample works without published articles, model calls or Telegram credentials', async () => {
  delete process.env.CHAT_ID; delete process.env.HTTPAPI_TG;
  articles = [];
  const result = await runDontSkipOnce({ date: '2026-10-27', sample: true, localOnly: true,
    output: path.join(await directory, 'sample.png') });
  assert.equal((await sharp(result.output).metadata()).height, 1200);
  assert.equal(copyCalls, 1);
  assert.equal(sent.length, 1);
  await assert.rejects(runDontSkipOnce({ date: '2026-02-30', localOnly: true }), /YYYY-MM-DD/);
  await assert.rejects(runDontSkipOnce({ date: '2026-10-27', localOnly: true }), /Not enough/);
});
