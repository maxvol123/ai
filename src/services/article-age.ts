export class ArticlePublicationAgeError extends Error {}

export function assertArticleFreshForPublication(
  article: { publishedAt?: Date | null },
  now = Date.now(),
): void {
  const maxHours = Number(process.env.MAX_ARTICLE_AGE_HOURS);
  if (!Number.isFinite(maxHours) || maxHours <= 0) {
    throw new Error('MAX_ARTICLE_AGE_HOURS must be a positive number');
  }
  const publishedAt = article.publishedAt?.getTime();
  if (publishedAt === undefined || !Number.isFinite(publishedAt)) {
    throw new ArticlePublicationAgeError('Publication blocked: source publication date is missing or invalid');
  }
  if (now - publishedAt > maxHours * 3_600_000) {
    throw new ArticlePublicationAgeError(`Publication blocked: article is older than MAX_ARTICLE_AGE_HOURS (${maxHours} hours)`);
  }
}
