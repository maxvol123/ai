import { StoredArticle } from '../types/article';
import {
  analyzeArticle,
  ArticleAnalysis,
  ArticleScreening,
  compareEvents,
  screenArticle,
  updateEventFromArticle,
} from './analysis.service';
import {
  saveArticleAnalysis,
  saveArticleContent,
  saveArticleScreening,
} from './article.service';
import { fetchArticleContent } from './article-content.service';
import { createEventEmbedding } from './embedding.service';
import {
  attachArticleToEvent,
  AUTO_ATTACH_SIMILARITY_THRESHOLD,
  createEventForArticle,
  findNearestEvents,
  getEventForComparison,
  NearestEvent,
  NEW_EVENT_SIMILARITY_THRESHOLD,
  updateEventDetails,
  updateEventImportance,
} from './event.service';
import { rankArticle, RankingResult } from './ranking.service';
import { qualifiesForReview } from './editorial-config';

export interface ProcessedArticle {
  kind: 'PROCESSED';
  analysis: ArticleAnalysis;
  ranking: RankingResult;
  eventId: string;
  nearestEvents: NearestEvent[];
  preliminaryScore: number;
}

export interface NeedsContentArticle {
  kind: 'NEEDS_CONTENT';
  screening: ArticleScreening;
}

export interface BelowPreliminaryThresholdArticle {
  kind: 'BELOW_PRELIMINARY_THRESHOLD';
  preliminaryScore: number;
  eventId: string;
}

export type ProcessArticleResult = ProcessedArticle | NeedsContentArticle | BelowPreliminaryThresholdArticle | undefined;

export async function processArticle(article: StoredArticle): Promise<ProcessArticleResult> {
  let articleForProcessing = article;
  let screening = await screenArticle(articleForProcessing);

  if (screening.decision === 'NEEDS_CONTENT') {
    try {
      const content = await fetchArticleContent(article);

      if (!content) {
        screening = {
          decision: 'NEEDS_CONTENT',
          reason: 'Screening needs content, but readable article content could not be fetched.',
        };
      } else {
        await saveArticleContent(article.id, content);
        articleForProcessing = { ...article, content };
        screening = await screenArticle(articleForProcessing);

        if (screening.decision === 'NEEDS_CONTENT') {
          screening = {
            decision: 'NEEDS_CONTENT',
            reason: 'Screening still needs more content after the article page was fetched.',
          };
        }
      }
    } catch (error) {
      screening = {
        decision: 'NEEDS_CONTENT',
        reason: `Screening needs content, but fetching failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  await saveArticleScreening(article.id, screening);

  if (screening.decision !== 'PASS') {
    return screening.decision === 'NEEDS_CONTENT'
      ? { kind: 'NEEDS_CONTENT', screening }
      : undefined;
  }

  const embedding = await createEventEmbedding(
    articleForProcessing.title.slice(0, 1000),
    (articleForProcessing.content ?? articleForProcessing.description ?? '').slice(0, 6000),
  );
  const nearestEvents = await findNearestEvents(embedding, 10);
  const nearestEvent = nearestEvents[0];
  let eventId: string;
  const existingEvent = nearestEvent && nearestEvent.similarity >= NEW_EVENT_SIMILARITY_THRESHOLD
    ? await getEventForComparison(nearestEvent.eventId)
    : undefined;
  const development = {
    eventHint: article.title,
    summary: (screening.summary?.trim() || article.description || '').slice(0, 1500),
  };
  let attachedToExistingEvent = false;

  if (!nearestEvent || nearestEvent.similarity < NEW_EVENT_SIMILARITY_THRESHOLD) {
    eventId = await createEventForArticle(article, embedding, {
      title: development.eventHint,
      summary: development.summary,
    });
  } else if (nearestEvent.similarity > AUTO_ATTACH_SIMILARITY_THRESHOLD) {
    await attachArticleToEvent(article.id, nearestEvent.eventId, embedding);
    eventId = nearestEvent.eventId;
    attachedToExistingEvent = true;
  } else {
    const decision = await compareEvents(development, existingEvent!);

    if (decision === 'SAME_EVENT') {
      await attachArticleToEvent(article.id, nearestEvent.eventId, embedding);
      eventId = nearestEvent.eventId;
      attachedToExistingEvent = true;
    } else {
      eventId = await createEventForArticle(article, embedding, {
        title: development.eventHint,
        summary: development.summary,
      });
    }
  }

  if (attachedToExistingEvent) {
    const eventToUpdate = existingEvent ?? await getEventForComparison(eventId);
    const updatedEvent = await updateEventFromArticle(eventToUpdate, development);
    const updatedEmbedding = await createEventEmbedding(
      updatedEvent.title,
      updatedEvent.summary,
    );
    await updateEventDetails(eventId, updatedEvent, updatedEmbedding);
  }
  const analysis = await analyzeArticle({
    title: article.title,
    description: article.description,
    summary: development.summary,
    source: article.source,
    category: screening.category,
  }, { nearestEvents, existingEvent });
  const ranking = rankArticle(article.source, analysis);
  const preliminaryScore = ranking.score;
  const eligible = qualifiesForReview(ranking.score);

  if (!attachedToExistingEvent) {
    await updateEventDetails(eventId, { title: analysis.eventHint, summary: analysis.summary }, embedding);
  }

  await saveArticleAnalysis(article.id, analysis, ranking, preliminaryScore);
  await updateEventImportance(eventId);

  if (!eligible) {
    return { kind: 'BELOW_PRELIMINARY_THRESHOLD', preliminaryScore, eventId };
  }

  return { kind: 'PROCESSED', analysis, ranking, eventId, nearestEvents, preliminaryScore };
}
