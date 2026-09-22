import { prisma } from '../db/prisma';
import { Article } from '../types/article';
import { ArticleAnalysis, ArticleScreening } from './analysis.service';
import { RankingResult } from './ranking.service';

export async function saveArticles(articles: Article[]) {
  return prisma.article.createManyAndReturn({
    data: articles,
    skipDuplicates: true,
  });
}

export async function saveArticleAnalysis(
  articleId: string,
  analysis: ArticleAnalysis,
  ranking: RankingResult,
): Promise<void> {
  await prisma.article.update({
    where: { id: articleId },
    data: {
      score: ranking.score,
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
      recommendedForPublish: ranking.recommendedForPublish,
      skipReason: ranking.score < 5
        ? `Telegram skipped: ranking score ${ranking.score}/10 is below the 5/10 threshold.`
        : null,
      status: 'ANALYZED',
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
  await prisma.article.update({ where: { id: articleId }, data: { telegramPost } });
}

export async function setArticleApproval(
  articleId: string,
  approved: boolean,
): Promise<boolean> {
  const result = await prisma.article.updateMany({
    where: { id: articleId, status: 'ANALYZED' },
    data: { status: approved ? 'APPROVED' : 'REJECTED' },
  });

  return result.count === 1;
}

export async function getApprovedArticleForPublishing(articleId: string) {
  return prisma.article.findFirst({
    where: { id: articleId, status: 'APPROVED' },
    select: {
      title: true,
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

export async function markArticlePublished(articleId: string): Promise<boolean> {
  const result = await prisma.article.updateMany({
    where: { id: articleId, status: 'APPROVED' },
    data: { status: 'PUBLISHED', publishedAt: new Date() },
  });

  return result.count === 1;
}
