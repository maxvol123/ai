require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extractFeedImage, extractEmbeddedImage, normalizeImageUrl, selectSrcset } = require('../src/services/article-image');
const { extractImageUrl, fetchArticlePage, fetchArticleContent } = require('../src/services/article-content.service');
const cheerio = require('cheerio');
const { rssParser, collectRSS } = require('../src/collectors/rss.collector');
const { collectHtmlNews } = require('../src/collectors/html.collector');
const base = 'https://example.com/news/article';
const rss = body => `<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>News</title><link>https://example.com</link><image><url>https://example.com/logo.png</url></image><item><title>Article title</title><link>${base}</link>${body}</item></channel></rss>`;

test('real RSS parser retains media content, thumbnail, enclosure priority', async () => {
  const fields = [
    '<media:content url="/media.jpg" type="image/jpeg"/>',
    '<media:thumbnail url="/thumb.jpg"/>',
    '<enclosure url="/enclosed.jpg" type="image/jpeg"/>',
  ];
  const expected = ['media', 'thumb', 'enclosed'];
  for (let i = 0; i < fields.length; i++) {
    const feed = await rssParser.parseString(rss(fields.slice(i).join('')));
    assert.equal(extractFeedImage(feed.items[0], base), `https://example.com/${expected[i]}.jpg`);
  }
  const feed = await rssParser.parseString(rss(''));
  assert.equal(extractFeedImage(feed.items[0], base), null, 'channel logos are excluded');
});

test('media precedes feed HTML; invalid and non-image candidates fall through', async () => {
  const feed = await rssParser.parseString(rss('<description><![CDATA[<img src="../embedded.jpg">Story]]></description><media:content url="/media.jpg"/>'));
  assert.equal(extractFeedImage(feed.items[0], base), 'https://example.com/media.jpg');
  const parsed = await rssParser.parseString(rss('<image>javascript:bad</image><media:content url="/video.mp4" type="video/mp4"/><media:thumbnail url="data:bad"/><enclosure url="/audio.mp3" type="audio/mpeg"/><enclosure url="/photo.png" type="image/png"/>'));
  assert.equal(extractFeedImage(parsed.items[0], base), 'https://example.com/photo.png');
});

test('content:encoded, description and summary HTML retain meaningful relative images', async () => {
  for (const field of ['content:encoded', 'description', 'summary']) {
    const feed = await rssParser.parseString(rss(`<${field}><![CDATA[<img src="/logo.png"><img src="../story.jpg">]]></${field}>`));
    assert.equal(extractFeedImage(feed.items[0], base), 'https://example.com/story.jpg');
  }
  const feed = await rssParser.parseString(rss('<content:encoded><![CDATA[<img src="/full.jpg">]]></content:encoded><description><![CDATA[<img src="/description.jpg">]]></description>'));
  assert.equal(extractFeedImage(feed.items[0], base), 'https://example.com/full.jpg');
});

test('HTML metadata supports og, secure og, twitter variants and image_src', () => {
  for (const metadata of [
    '<meta property="og:image" content="/hero.jpg">',
    '<meta property="og:image:secure_url" content="/hero.jpg">',
    '<meta name="twitter:image" content="/hero.jpg">',
    '<meta property="twitter:image:src" content="/hero.jpg">',
    '<link rel="image_src" href="/hero.jpg">',
  ]) assert.equal(extractImageUrl(cheerio.load(metadata), base), 'https://example.com/hero.jpg');
  assert.equal(extractImageUrl(cheerio.load('<meta property="og:image" content="/first.jpg"><meta property="og:image:secure_url" content="/second.jpg">'), base), 'https://example.com/first.jpg');
});

test('JSON-LD images support strings, arrays, objects, thumbnailUrl, graphs and multiple scripts', () => {
  for (const image of ['/ld.jpg', ['/logo.png', '/ld.jpg'], { url: '/ld.jpg' }]) {
    for (const wrap of [value => value, value => [value], value => ({ '@graph': [value] })]) {
      const json = wrap({ '@type': 'NewsArticle', image });
      assert.equal(extractImageUrl(cheerio.load(`<script type="application/ld+json">${JSON.stringify(json)}</script>`), base), 'https://example.com/ld.jpg');
    }
  }
  assert.equal(extractImageUrl(cheerio.load('<script type="application/ld+json">bad json</script><script type="application/ld+json">{"@type":"BlogPosting","thumbnailUrl":"/ld.jpg"}</script>'), base), 'https://example.com/ld.jpg');
});

test('srcset chooses the largest reasonable valid image and supports lazy loading', () => {
  assert.equal(selectSrcset('/small.jpg 320w, /large.jpg 1600w, /huge.jpg 10000w', base), 'https://example.com/large.jpg');
  assert.equal(selectSrcset('/one.jpg 1x, /two.jpg 2x', base), 'https://example.com/two.jpg');
  assert.equal(selectSrcset('data:image/png;base64,ABC 1x, /two.jpg 2x', base), 'https://example.com/two.jpg');
  for (const attrs of ['src="data:image/png;base64,ABC" data-src="/large.jpg"', 'data-lazy-src="/large.jpg"', 'src="/small.jpg" srcset="/small.jpg 320w, /large.jpg 1600w"']) {
    assert.equal(extractEmbeddedImage(`<img ${attrs}>`, base), 'https://example.com/large.jpg');
  }
});

test('validation ignores icons, tiny images, SVG and invalid schemes, decodes entities, and prefers large media', () => {
  for (const raw of ['/logo.png', '/avatar.jpg', '/icon-32.png', '/art.svg', 'data:image/png;base64,ABC', 'javascript:alert(1)']) {
    assert.equal(normalizeImageUrl(raw, base), null);
  }
  assert.equal(normalizeImageUrl(' /photo.jpg?a=1&amp;b=2 ', base), 'https://example.com/photo.jpg?a=1&b=2');
  assert.equal(extractEmbeddedImage('<img src="/tiny.jpg" width="16" height="16"><img src="/story.jpg">', base), 'https://example.com/story.jpg');
  assert.equal(extractFeedImage({ 'media:content': [{ $: { url: '/small.jpg', width: '320' } }, { $: { url: '/large.jpg', width: '1600' } }] }, base), 'https://example.com/large.jpg');
  assert.equal(extractImageUrl(cheerio.load('<header><img src="/navigation.jpg"></header><main><img src="/logo.png"><img data-src="/story.jpg"></main>'), base), 'https://example.com/story.jpg');
});

test('403 preserves a feed image or returns null, uses browser headers, and does not retry', async () => {
  const original = global.fetch;
  try {
    for (const imageUrl of ['https://example.com/feed.jpg', null]) {
      let calls = 0;
      global.fetch = async (url, options) => {
        calls++;
        assert.equal(options.redirect, 'follow');
        assert.ok(options.headers['User-Agent'].includes('Chrome/154.0.0.0'));
        assert.equal(options.headers['Accept-Language'], 'en-US,en;q=0.9');
        assert.ok(options.signal);
        return { ok: false, status: 403 };
      };
      const candidate = { url: base, source: 'Example', imageUrl };
      assert.equal((await fetchArticlePage(candidate)).imageUrl, imageUrl);
      assert.equal(await fetchArticleContent(candidate), undefined);
      assert.equal(calls, 1);
    }
  } finally { global.fetch = original; }
});

test('Atom image enclosures and Media RSS groups are retained', async () => {
  const atom = await rssParser.parseString(`<feed xmlns="http://www.w3.org/2005/Atom"><title>News</title><entry><title>Article</title><link href="${base}"/><link rel="enclosure" href="/sound.mp3" type="audio/mpeg"/><link rel="enclosure" href="/atom.jpg" type="image/jpeg"/></entry></feed>`);
  assert.equal(extractFeedImage(atom.items[0], base), 'https://example.com/atom.jpg');
  const grouped = await rssParser.parseString(rss('<media:group><media:content url="/clip.mp4" medium="video"/><media:content url="/group.jpg" medium="image"/><media:thumbnail url="/thumb.jpg"/></media:group>'));
  assert.equal(extractFeedImage(grouped.items[0], base), 'https://example.com/group.jpg');
});

test('RSS collector carries the image into Article without fetching article HTML', async () => {
  const original = rssParser.parseURL;
  rssParser.parseURL = async () => rssParser.parseString(rss('<media:thumbnail url="/thumb.jpg"/>'));
  try {
    const articles = await collectRSS('Example', 'https://example.com/feed');
    assert.equal(articles[0].imageUrl, 'https://example.com/thumb.jpg');
  } finally { rssParser.parseURL = original; }
});

test('HTML collector extracts source card images from its existing listing fetch', async () => {
  const original = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: true, text: async () => '<article><a href="/news/article"><img src="/card.jpg"><h2>Article title</h2></a></article>' }; };
  try {
    const articles = await collectHtmlNews({ source: 'Example', url: 'https://example.com/news', articlePath: '/news' });
    assert.equal(articles[0].imageUrl, 'https://example.com/card.jpg');
    assert.equal(calls, 1);
  } finally { global.fetch = original; }
});
