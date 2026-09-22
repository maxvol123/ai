import * as cheerio from 'cheerio';
import { Article } from '../types/article';

const MAX_CONTENT_LENGTH = 12_000;
const userAgent = 'AI-News-Bot/1.0 (+article-content-fetcher)';

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Fetches readable page text for a second screening pass. */
export async function fetchArticleContent(article: Pick<Article, 'url'>): Promise<string | undefined> {
  const response = await fetch(article.url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml',
      'User-Agent': userAgent,
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Article returned HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) {
    return undefined;
  }

  const $ = cheerio.load(await response.text());
  $('script, style, noscript, nav, header, footer, aside, svg').remove();

  const content = normalizeText(
    $('article').first().text() || $('main').first().text() || $('body').text(),
  );

  return content.length >= 200 ? content.slice(0, MAX_CONTENT_LENGTH) : undefined;
}
