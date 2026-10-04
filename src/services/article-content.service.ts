import * as cheerio from 'cheerio';
import { Article } from '../types/article';
import { prisma } from '../db/prisma';
import { extractEmbeddedImage, extractJsonLdImage, imageValue, normalizeImageUrl } from './article-image';

const MAX_CONTENT_LENGTH = 12_000;
const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';
type ImageArticle = Pick<Article, 'url'> & Partial<Pick<Article, 'source' | 'imageUrl'>> & { id?: string };

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function extractImageUrl($: cheerio.CheerioAPI, articleUrl: string): string | null {
  for (const selector of ['meta[property="og:image"]', 'meta[property="og:image:secure_url"]',
    'meta[name="twitter:image"], meta[property="twitter:image"]',
    'meta[name="twitter:image:src"], meta[property="twitter:image:src"]', 'link[rel~="image_src"]']) {
    const candidates = $(selector).toArray().map(element => {
      const details = $(element).nextUntil('meta[property="og:image"], meta[property="og:image:secure_url"]');
      return { url: $(element).attr('content') ?? $(element).attr('href'),
        width: details.filter('meta[property="og:image:width"]').first().attr('content'),
        height: details.filter('meta[property="og:image:height"]').first().attr('content') };
    });
    const url = imageValue(candidates, articleUrl);
    if (url) return url;
  }
  const structured = extractJsonLdImage($, articleUrl);
  if (structured) return structured;
  for (const element of $('article, main').toArray()) {
    const url = extractEmbeddedImage($(element).html(), articleUrl);
    if (url) return url;
  }
  return null;
}

interface ArticlePage { content?: string; imageUrl: string | null }
// The screening and review stages share the article object. Weak keys avoid
// retaining page bodies across collector runs and reuse even missing metadata.
const pages = new WeakMap<Pick<Article, 'url'>, Promise<ArticlePage>>();

export function fetchArticlePage(article: ImageArticle): Promise<ArticlePage> {
  let page = pages.get(article);
  if (!page) {
    // Cache failed fetches for this article as well; do not retry during review.
    page = loadArticlePage(article).catch(error => {
      console.warn(`[image] source=${article.source ?? 'unknown'} article=${article.id ?? article.url} url=${article.url} htmlFetch=${error instanceof Error ? error.message : String(error)}`);
      return unavailablePage(article);
    });
    pages.set(article, page);
  }
  return page;
}

/** Fetches readable page text for a second screening pass. */
export async function fetchArticleContent(article: ImageArticle): Promise<string | undefined> {
  const page = await fetchArticlePage(article);
  if (page.imageUrl && 'id' in article && typeof article.id === 'string') {
    // Page metadata is lower priority than an image already saved by collection.
    const stored = await prisma.article.findUniqueOrThrow({ where: { id: article.id }, select: { imageUrl: true } });
    if (!normalizeImageUrl(stored.imageUrl, article.url)) {
      await prisma.article.updateMany({ where: { id: article.id, imageUrl: stored.imageUrl }, data: { imageUrl: page.imageUrl } });
    }
  }
  return page.content;
}

function unavailablePage(article: ImageArticle): ArticlePage {
  const imageUrl = normalizeImageUrl(article.imageUrl, article.url);
  if (!imageUrl) console.log(`[image] article=${article.id ?? article.url} no image available`);
  return { imageUrl };
}

async function loadArticlePage(article: ImageArticle): Promise<ArticlePage> {
  const response = await fetch(article.url, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'User-Agent': userAgent,
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    console.warn(`[image] source=${article.source ?? 'unknown'} article=${article.id ?? article.url} url=${article.url} feedImage=${Boolean(normalizeImageUrl(article.imageUrl, article.url))} htmlFetch=${response.status}`);
    return unavailablePage(article);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
    console.log(`[article] url=${article.url} missing image metadata (non-HTML response)`);
    return unavailablePage(article);
  }

  const $ = cheerio.load(await response.text());
  const imageUrl = normalizeImageUrl(article.imageUrl, article.url) ?? extractImageUrl($, article.url);
  console.log(`[article] url=${article.url} ${imageUrl ? `imageUrl=${imageUrl}` : 'missing image metadata'}`);
  $('script, style, noscript, nav, header, footer, aside, svg').remove();

  const content = normalizeText(
    $('article').first().text() || $('main').first().text() || $('body').text(),
  );

  return { content: content.length >= 200 ? content.slice(0, MAX_CONTENT_LENGTH) : undefined, imageUrl };
}
