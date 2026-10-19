import Parser from 'rss-parser';
import * as cheerio from 'cheerio';
import { Article } from '../types/article';
import { extractFeedImage } from '../services/article-image';

export const rssParser = new Parser({ customFields: { item: [
  'image', 'imageUrl', 'description', 'summary', 'content:encoded',
  ['media:content', 'media:content', { keepArray: true }],
  ['media:thumbnail', 'media:thumbnail', { keepArray: true }],
  ['media:group', 'media:group', { keepArray: true }],
  ['enclosure', 'enclosures', { keepArray: true }],
  ['link', 'atomLinks', { keepArray: true }],
] } });

// Request 60 items so the database can deduplicate the first 30 already
// processed items and pass the next batch through the workflow.
export const ARTICLES_PER_SOURCE = 60;

function decodeHtmlEntities(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  return cheerio.load(value).text().trim() || undefined;
}

export async function collectRSS(
  source: string,
  feedUrl: string,
): Promise<Article[]> {
  // parseURL passes compressed HTTP bodies straight to the XML parser.
  // DeepMind serves gzip to rss-parser; fetch decodes HTTP compression first.
  const response = await fetch(feedUrl, {
    headers: {
      'User-Agent': 'rss-parser',
      Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`RSS ${feedUrl} returned HTTP ${response.status}`);
  }
  const feed = await rssParser.parseString(await response.text());

  return feed.items
    .filter((item) => item.title && item.link)
    .slice(0, ARTICLES_PER_SOURCE)
    .map((item) => ({
      source,
      title: decodeHtmlEntities(item.title)!,
      url: item.link!,
      imageUrl: extractFeedImage(item, item.link!),
      description: decodeHtmlEntities(item.contentSnippet),
      publishedAt: item.pubDate ? new Date(item.pubDate) : undefined,
    }));
}
