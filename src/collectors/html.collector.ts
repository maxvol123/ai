import * as cheerio from 'cheerio';
import { Article } from '../types/article';
import { ARTICLES_PER_SOURCE } from './rss.collector';

export interface HtmlSource {
  source: string;
  url: string;
  articlePath: string;
}

const userAgent = 'AI-News-Bot/1.0 (+official-news-monitor)';

function normaliseUrl(href: string, pageUrl: string): string | undefined {
  try {
    const url = new URL(href, pageUrl);
    return url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Collects article cards from an official news page when that publisher does
 * not expose an RSS feed. The path check prevents navigation links from being
 * stored as news items.
 */
export async function collectHtmlNews(source: HtmlSource): Promise<Article[]> {
  const response = await fetch(source.url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': userAgent,
    },
  });

  if (!response.ok) {
    throw new Error(`${source.source} returned HTTP ${response.status}`);
  }

  const $ = cheerio.load(await response.text());
  const articles = new Map<string, Article>();

  $('a[href]').each((_, element) => {
    const href = $(element).attr('href');
    if (!href) return;

    const url = normaliseUrl(href, source.url);
    if (!url || new URL(url).pathname === source.articlePath) return;
    if (!new URL(url).pathname.startsWith(`${source.articlePath}/`)) return;

    const card = $(element).closest('article, li, [class*="card"], [class*="post"]').first();
    const title = card.find('h1, h2, h3, h4').first().text().trim() || $(element).text().trim();
    if (!title || title.length < 8) return;

    const description = card.find('p').first().text().trim() || undefined;
    const dateText = card.find('time').first().attr('datetime') || card.find('time').first().text().trim();
    const publishedAt = dateText ? new Date(dateText) : undefined;

    articles.set(url, {
      source: source.source,
      title,
      url,
      description,
      publishedAt: publishedAt && !Number.isNaN(publishedAt.valueOf()) ? publishedAt : undefined,
    });
  });

  return [...articles.values()].slice(0, ARTICLES_PER_SOURCE);
}
