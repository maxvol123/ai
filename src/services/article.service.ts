import { prisma } from '../db/prisma';
import { Article } from '../types/article';
import { ArticleAnalysis, ArticleScreening } from './analysis.service';
import { RankingResult } from './ranking.service';
import { REVIEW_THRESHOLD, qualifiesForReview } from './editorial-config';
import { validateTelegramCaption } from './telegram-caption';
import { normalizeImageUrl } from './article-image';

export async function saveArticles(articles: Article[]) {
  const normalized = articles.map(article => ({ ...article, imageUrl: normalizeImageUrl(article.imageUrl, article.url) }));
  for (const article of normalized) {
    if (article.imageUrl) {
      const existing = await prisma.article.findUnique({ where: { url: article.url }, select: { imageUrl: true } });
      if (existing && !normalizeImageUrl(existing.imageUrl, article.url)) {
        await prisma.article.updateMany({ where: { url: article.url, imageUrl: existing.imageUrl }, data: { imageUrl: article.imageUrl } });
      }
    }
  }
  return prisma.article.createManyAndReturn({
    data: normalized,
    skipDuplicates: true,
  });
}

export async function saveArticleAnalysis(
  articleId: string,
  analysis: ArticleAnalysis,
  ranking: RankingResult,
  preliminaryScore: number,
): Promise<void> {
  await prisma.article.update({
    where: { id: articleId },
    data: {
      score: ranking.score,
      preliminaryScore,
      impact: analysis.impact,
      novelty: analysis.novelty,
      reach: analysis.reach,
      sourceAuthority: ranking.sourceAuthority,
      expectedAttention: analysis.expectedAttention,
      confidence: analysis.confidence,
      eventHint: analysis.eventHint,
      category: analysis.category,
      summary: analysis.summary,
      whyItMatters: analysis.whyItMatters,
      recommendedForPublish: qualifiesForReview(preliminaryScore) && ranking.recommendedForPublish,
      skipReason: !qualifiesForReview(preliminaryScore)
        ? `Review skipped: ranking score ${preliminaryScore}/10 is below ${REVIEW_THRESHOLD}/10.`
        : ranking.score < 5
        ? `Telegram skipped: ranking score ${ranking.score}/10 is below the 5/10 threshold.`
        : null,
      status: qualifiesForReview(preliminaryScore) ? 'ANALYZED' : 'PRELIMINARY_SKIPPED',
    },
  });
}

export async function saveArticleScreening(
  articleId: string,
  screening: ArticleScreening,
): Promise<void> {
  await prisma.article.update({
    where: { id: articleId },
    data: {
      screeningPassed: screening.decision === 'PASS',
      screeningDecision: screening.decision,
      screeningReason: screening.reason,
      ...(screening.decision === 'REJECT' ? {
        status: 'REJECTED',
        score: null,
        preliminaryScore: null,
        impact: null,
        novelty: null,
        reach: null,
        sourceAuthority: null,
        expectedAttention: null,
        confidence: null,
        eventHint: null,
        recommendedForPublish: false,
        skipReason: `Screening rejected: ${screening.reason}`,
      } : screening.decision === 'NEEDS_CONTENT' ? {
        status: 'NEEDS_CONTENT',
        recommendedForPublish: false,
        skipReason: null,
      } : {}),
    },
  });
}

export async function saveArticleContent(
  articleId: string,
  content: string,
): Promise<void> {
  await prisma.article.update({
    where: { id: articleId },
    data: { content },
  });
}

export async function saveTelegramMessageId(
  articleId: string,
  telegramMessageId: number,
): Promise<void> {
  await prisma.article.update({
    where: { id: articleId },
    data: { telegramMessageId },
  });
}

export async function saveTelegramPost(articleId: string, telegramPost: string): Promise<void> {
  if (!validateTelegramCaption(telegramPost).valid) throw new Error('Invalid Telegram caption');
  const saved = await prisma.article.updateMany({
    where: { id: articleId, status: 'ANALYZED', telegramPost: null }, data: { telegramPost },
  });
  if (saved.count !== 1) throw new Error(`Draft already saved or article ${articleId} is not reviewable`);
}

export async function setArticleApproval(
  articleId: string,
  approved: boolean,
): Promise<boolean> {
  const result = await prisma.article.updateMany({
    where: { id: articleId, status: 'ANALYZED', preliminaryScore: { gte: REVIEW_THRESHOLD },
      ...(approved ? { telegramPost: { not: null } } : {}) },
    data: { status: approved ? 'APPROVED' : 'REJECTED' },
  });

  return result.count === 1;
}

export async function getApprovedArticleForPublishing(articleId: string) {
  return prisma.article.findFirst({
    where: { id: articleId, status: 'APPROVED' },
    select: {
      id: true,
      imageUrl: true,
      title: true,
      preliminaryScore: true,
      url: true,
      source: true,
      description: true,
      content: true,
      summary: true,
      whyItMatters: true,
      category: true,
      telegramPost: true,
      event: { select: { title: true, summary: true } },
    },
  });
}

export async function markArticlePublished(articleId: string, telegramMessageId: number): Promise<boolean> {
  const result = await prisma.article.updateMany({
    where: { id: articleId, status: 'APPROVED' },
    data: { status: 'PUBLISHED', publishedAt: new Date(), telegramMessageId },
  });

  return result.count === 1;
}
