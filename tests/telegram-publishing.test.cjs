require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');
process.env.OPENAI_API = 'test-key';
process.env.HTTPAPI_TG = 'test-token';
process.env.CHAT_ID = 'review';
process.env.TELEGRAM_CHANNEL_ID = 'channel';
process.env.SCREENING_MODEL = 'cheap-screening-model';

function mock(path, exports) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
let outputs = [];
let modelRequests = [];
mock('openai', class OpenAI {
  responses = { create: async request => {
    modelRequests.push(request);
    assert.ok(outputs.length, 'Unexpected model request');
    return { status: 'completed', output_text: outputs.shift() };
  }};
});
let row;
let updates = [];
mock('../src/db/prisma', { prisma: { article: {
  findUnique: async () => ({ ...row }),
  findUniqueOrThrow: async () => ({ ...row }),
  findFirst: async () => row.status === 'APPROVED' ? { ...row } : null,
  update: async ({ data }) => { updates.push(data); Object.assign(row, data); return row; },
  updateMany: async ({ where, data }) => {
    updates.push(data);
    if (where.status && where.status !== row.status) return { count: 0 };
    if (where.telegramPost === null && row.telegramPost !== null) return { count: 0 };
    if (where.telegramPost?.not === null && row.telegramPost === null) return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  },
  createManyAndReturn: async () => [],
}}});
const { extractImageUrl, fetchArticleContent, fetchArticlePage } = require('../src/services/article-content.service');
const { validateTelegramCaption, renderCaption } = require('../src/services/telegram-caption');
const { writeTelegramPost } = require('../src/services/telegram-writer.service');
const { publishArticleToChannel, sendApprovalRequest } = require('../src/services/telegram.service');
const { saveArticles } = require('../src/services/article.service');
const { handleCallback } = require('../src/jobs/telegram-approval.job');
const plain = (body = 'OpenAI released a model.') =>
  `New model\n\n${body}\n\nWhy it matters: Developers have another option.\n\nSource: OpenAI\n\n#OpenAI #Models #Developers`;
const article = { id: 'article123', url: 'https://example.com/news', source: 'OpenAI',
  title: 'New model', summary: 'Summary', whyItMatters: 'Impact', preliminaryScore: 8 };
const caption = renderCaption(plain(), article.source, article.url);
function reset() {
  row = { ...article, status: 'ANALYZED', imageUrl: 'https://example.com/image.jpg', telegramPost: caption };
  updates = []; modelRequests = []; outputs = [];
}
function telegramFetch({ photoFails = false, textFails = false } = {}) {
  const requests = [];
  global.fetch = async (url, init) => {
    const method = url.split('/').at(-1);
    const body = JSON.parse(init.body);
    requests.push({ method, body });
    const failed = method === 'sendPhoto' ? photoFails : method === 'sendMessage' && textFails;
    return { ok: !failed, json: async () => ({ ok: !failed, description: 'remote failure',
      result: method === 'answerCallbackQuery' ? true : { message_id: method === 'sendPhoto' ? 101 : 202 } }) };
  };
  return requests;
}

test('image metadata priority, fallback variants, whitespace and relative URLs', () => {
  const extract = html => extractImageUrl(cheerio.load(html), article.url);
  assert.equal(extract('<meta name="twitter:image" content="/twitter.jpg"><meta property="og:image" content=" /og.jpg ">'), 'https://example.com/og.jpg');
  for (const attributes of ['name="twitter:image"', 'property="twitter:image"', 'name="twitter:image:src"']) {
    assert.equal(extract(`<meta property="og:image" content=" "><meta ${attributes} content="../photo.jpg">`), 'https://example.com/photo.jpg');
  }
  for (const value of ['', ' ', 'data:image/png;base64,test', 'javascript:alert(1)', 'ftp://example.com/a', 'https://[bad']) {
    assert.equal(extract(`<meta property="og:image" content="${value}">`), null);
  }
  assert.equal(extract('<meta property="og:image" content="http://example.com/a">'), 'http://example.com/a');
  assert.equal(extract(''), null);
});

test('screening and enrichment reuse one fetch, including missing metadata', async () => {
  reset();
  for (const metadata of ['', '<meta property="og:image" content="/a.jpg">']) {
    let fetches = 0;
    global.fetch = async () => { fetches++; return { ok: true, headers: new Headers({ 'content-type': 'text/html' }),
      text: async () => metadata + '<article>' + 'text '.repeat(60) + '</article>' }; };
    const candidate = { ...article };
    assert.ok(await fetchArticleContent(candidate));
    assert.equal((await fetchArticlePage(candidate)).imageUrl, metadata ? 'https://example.com/a.jpg' : null);
    assert.equal(fetches, 1);
    assert.equal(row.imageUrl, 'https://example.com/image.jpg');
  }
});

test('caption boundaries count JS characters and HTML rendering escapes all model text', () => {
  assert.deepEqual(validateTelegramCaption('x'.repeat(900)), { valid: true, length: 900, maxLength: 900 });
  assert.equal(validateTelegramCaption('x'.repeat(901)).valid, false);
  assert.equal(validateTelegramCaption('😀'.repeat(450)).length, 900);
  assert.equal(validateTelegramCaption('').valid, false);
  const html = renderCaption(plain('A <b>claim</b> & evidence.'), 'A & B', 'https://example.com/?a=1&b=2');
  assert.ok(html.includes('&lt;b&gt;claim&lt;/b&gt; &amp; evidence.'));
  assert.ok(html.includes('href="https://example.com/?a=1&amp;b=2"'));
  assert.throws(() => renderCaption(plain(), 'Source', 'javascript:alert(1)'), /Invalid/);
});

test('writer shortens only oversized captions, once, using the configured low-cost model', async () => {
  reset(); outputs = [plain()];
  assert.equal(await writeTelegramPost(article), caption);
  assert.equal(modelRequests.length, 1);
  reset(); outputs = [plain('Secondary context '.repeat(65) + '.'), plain()];
  assert.equal(await writeTelegramPost(article), caption);
  assert.equal(modelRequests.length, 2);
  assert.ok(modelRequests.every(r => r.model === 'cheap-screening-model'));
  reset(); outputs = [plain('Context '.repeat(150)), plain('Context '.repeat(150))];
  await assert.rejects(writeTelegramPost(article), /after shortening/);
  assert.equal(modelRequests.length, 2);
});

test('photo succeeds or falls back with the identical saved caption and final message ID', async () => {
  reset(); let requests = telegramFetch();
  assert.equal(await publishArticleToChannel(row), 101);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.caption, caption);
  requests = telegramFetch({ photoFails: true });
  assert.equal(await publishArticleToChannel(row), 202);
  assert.deepEqual(requests.map(r => r.method), ['sendPhoto', 'sendMessage']);
  assert.equal(requests[0].body.caption, requests[1].body.text);
  assert.equal(requests[1].body.disable_web_page_preview, true);
  requests = telegramFetch(); row.imageUrl = null;
  assert.equal(await publishArticleToChannel(row), 202);
  assert.deepEqual(requests.map(r => r.method), ['sendMessage']);
  assert.equal(modelRequests.length, 0);
});

test('publication state and final message ID are saved only after a successful send; duplicate callbacks do not send', async () => {
  for (const photoFails of [false, true]) {
    reset(); const requests = telegramFetch({ photoFails });
    await handleCallback({ id: 'callback', data: 'approve:article123' });
    assert.equal(row.status, 'PUBLISHED');
    assert.equal(row.telegramMessageId, photoFails ? 202 : 101);
    const sent = requests.filter(r => r.method.startsWith('send')).length;
    await handleCallback({ id: 'duplicate', data: 'approve:article123' });
    assert.equal(requests.filter(r => r.method.startsWith('send')).length, sent);
    assert.equal(modelRequests.length, 0);
  }
  reset(); telegramFetch({ photoFails: true, textFails: true });
  await assert.rejects(handleCallback({ id: 'callback', data: 'approve:article123' }), /sendMessage failed/);
  assert.equal(row.status, 'APPROVED');
  assert.equal(updates.some(data => data.status === 'PUBLISHED'), false);
});

test('repeat collection preserves valid images and fills missing images', async () => {
  reset(); const original = row.imageUrl;
  await saveArticles([{ ...article, imageUrl: null }]);
  assert.equal(row.imageUrl, original);
  await saveArticles([{ ...article, imageUrl: 'https://example.com/new.jpg' }]);
  assert.equal(row.imageUrl, original);
  row.imageUrl = null;
  await saveArticles([{ ...article, imageUrl: 'https://example.com/new.jpg' }]);
  assert.equal(row.imageUrl, 'https://example.com/new.jpg');
});

test('review saves the generated draft before sending and approval publishes exactly that draft', async () => {
  reset(); row.telegramPost = null; outputs = [plain()];
  const requests = telegramFetch();
  await sendApprovalRequest(article, { summary: 'Summary', whyItMatters: 'Impact' }, { score: 8 });
  assert.equal(row.telegramPost, caption);
  assert.equal(requests[0].method, 'sendPhoto');
  assert.equal(requests[0].body.caption, row.telegramPost);
  assert.equal(requests[0].body.reply_markup.inline_keyboard[0][0].callback_data, 'approve:article123');
  await handleCallback({ id: 'callback', data: 'approve:article123' });
  assert.equal(requests.find(r => r.body.chat_id === 'channel').body.caption, requests[0].body.caption);
  assert.equal(modelRequests.length, 1);
});

test('missing and oversized saved drafts are never published or regenerated', async () => {
  reset(); const requests = telegramFetch();
  for (const post of [null, '', 'x'.repeat(901)]) {
    await assert.rejects(publishArticleToChannel({ ...row, telegramPost: post }), /no valid reviewed draft/);
  }
  assert.equal(requests.length, 0);
  assert.equal(modelRequests.length, 0);
});

test('unsafe saved HTML is rejected without changing it', async () => {
  reset(); const requests = telegramFetch();
  row.telegramPost = caption.replace('New model', '<script>bad</script>');
  await assert.rejects(publishArticleToChannel(row), /unsafe HTML/);
  assert.equal(requests.length, 0);
});

test('invalid or still oversized drafts never get saved or sent for review', async () => {
  for (const drafts of [
    [plain('First sentence. Second sentence. Third sentence.')],
    [plain('Context '.repeat(150)), plain('Context '.repeat(150))],
  ]) {
    reset(); row.telegramPost = null; outputs = drafts;
    const requests = telegramFetch();
    await assert.rejects(sendApprovalRequest(article, {}, {}), /structure|after shortening/);
    assert.equal(row.telegramPost, null);
    assert.equal(requests.length, 0);
  }
});

test('missing metadata during review never clears an existing image and fresh metadata is persisted', async () => {
  for (const metadata of ['', '<meta property="og:image" content="/fresh.jpg">']) {
    reset(); row.imageUrl = null;
    const send = telegramFetch(); const telegram = global.fetch;
    global.fetch = async (url, init) => url.startsWith('https://api.telegram.org/') ? telegram(url, init) : {
      ok: true, headers: new Headers({ 'content-type': 'text/html' }), text: async () => metadata,
    };
    await sendApprovalRequest({ ...article }, {}, {});
    assert.equal(row.imageUrl, metadata ? 'https://example.com/fresh.jpg' : null);
    assert.equal(send.length, 1);
  }
});

test('review photo failure keeps exactly the same saved draft and approval keyboard', async () => {
  reset(); const requests = telegramFetch({ photoFails: true });
  assert.equal(await sendApprovalRequest(article, {}, {}), 202);
  assert.deepEqual(requests.map(r => r.method), ['sendPhoto', 'sendMessage']);
  assert.equal(requests[0].body.caption, caption);
  assert.equal(requests[1].body.text, caption);
  assert.deepEqual(requests[0].body.reply_markup, requests[1].body.reply_markup);
  assert.deepEqual(requests[1].body.reply_markup.inline_keyboard[0].map(b => b.callback_data),
    ['approve:article123', 'reject:article123']);
  assert.equal(modelRequests.length, 0);
  await handleCallback({ id: 'reject', data: 'reject:article123' });
  assert.equal(row.status, 'REJECTED');
  assert.equal(requests.filter(r => r.body.chat_id === 'channel').length, 0);
});

test('403 and timeout on image enrichment still send saved text with both controls', async () => {
  for (const failure of ['403', 'timeout']) {
    reset(); row.imageUrl = null;
    const requests = telegramFetch(); const telegram = global.fetch;
    global.fetch = async (url, init) => {
      if (url.startsWith('https://api.telegram.org/')) return telegram(url, init);
      if (failure === 'timeout') throw new Error('timeout');
      return { ok: false, status: 403 };
    };
    await sendApprovalRequest({ ...article }, {}, {});
    assert.equal(row.imageUrl, null);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'sendMessage');
    assert.equal(requests[0].body.text, caption);
    assert.equal(requests[0].body.reply_markup.inline_keyboard[0].length, 2);
  }
});

test('stored images take priority and skip page fetches; invalid collection images cannot replace them', async () => {
  reset(); const requests = telegramFetch();
  const sourceImage = row.imageUrl;
  await sendApprovalRequest({ ...article, imageUrl: 'https://example.com/source.jpg' }, {}, {});
  assert.equal(row.imageUrl, sourceImage);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.photo, sourceImage);
  for (const imageUrl of [null, '', 'javascript:bad', 'data:image/png;base64,abc']) {
    await saveArticles([{ ...article, imageUrl }]);
    assert.equal(row.imageUrl, sourceImage);
  }
});

test('content enrichment persists metadata only when no valid stored image exists', async () => {
  reset(); row.imageUrl = null;
  global.fetch = async () => ({ ok: true, headers: new Headers({ 'content-type': 'text/html' }),
    text: async () => '<meta property="og:image" content="/metadata.jpg"><article>' + 'text '.repeat(60) + '</article>' });
  await fetchArticleContent({ ...article });
  assert.equal(row.imageUrl, 'https://example.com/metadata.jpg');
});
