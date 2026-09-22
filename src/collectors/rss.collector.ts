import Parser from 'rss-parser';
import * as cheerio from 'cheerio';
import { Article } from '../types/article';

const parser = new Parser();

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
  const feed = await parser.parseURL(feedUrl);

  return feed.items
    .filter((item) => item.title && item.link)
    .slice(0, ARTICLES_PER_SOURCE)
    .map((item) => ({
      source,
      title: decodeHtmlEntities(item.title)!,
      url: item.link!,
      description: decodeHtmlEntities(item.contentSnippet),
      publishedAt: item.pubDate ? new Date(item.pubDate) : undefined,
    }));
}
