require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { gzipSync, deflateSync, brotliCompressSync } = require('node:zlib');
const { collectRSS } = require('../src/collectors/rss.collector');

test('RSS collection decodes compressed responses and follows redirects', async t => {
  const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel>
    <title>Google DeepMind News</title><link>https://deepmind.google/blog/</link>
    <item><title>Research &amp; discovery</title><link>https://deepmind.google/blog/research/</link>
    <description>New research results</description><pubDate>Mon, 19 Oct 2026 09:00:00 GMT</pubDate>
    <media:thumbnail url="https://example.com/research.jpg"/></item></channel></rss>`;
  const encodings = { gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync };
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/gzip' });
      return res.end();
    }
    if (req.url === '/unavailable') {
      res.writeHead(503);
      return res.end('Service unavailable');
    }
    if (req.url === '/invalid') return res.end('<html>Not a feed</html>');
    const encoding = req.url.slice(1);
    const compress = encodings[encoding];
    res.setHeader('Content-Type', 'application/xml');
    if (compress) res.setHeader('Content-Encoding', encoding);
    res.end(compress ? compress(Buffer.from(xml)) : xml);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const route of ['gzip', 'deflate', 'br', 'plain', 'redirect']) {
    const articles = await collectRSS('Google DeepMind', `${base}/${route}`);
    assert.equal(articles.length, 1, route);
    assert.equal(articles[0].source, 'Google DeepMind');
    assert.equal(articles[0].title, 'Research & discovery');
    assert.equal(articles[0].url, 'https://deepmind.google/blog/research/');
    assert.equal(articles[0].description, 'New research results');
    assert.equal(articles[0].imageUrl, 'https://example.com/research.jpg');
    assert.equal(articles[0].publishedAt.toISOString(), '2026-10-19T09:00:00.000Z');
  }
  await assert.rejects(collectRSS('Google DeepMind', `${base}/unavailable`), /HTTP 503/);
  await assert.rejects(collectRSS('Google DeepMind', `${base}/invalid`), /Feed not recognized/);
});
