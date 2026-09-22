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

export interface ProcessedArticle {
  kind: 'PROCESSED';
  analysis: ArticleAnalysis;
  ranking: RankingResult;
  eventId: string;
  nearestEvents: NearestEvent[];
}

export interface NeedsContentArticle {
  kind: 'NEEDS_CONTENT';
  screening: ArticleScreening;
}

export type ProcessArticleResult = ProcessedArticle | NeedsContentArticle | undefined;

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

  const analysis = await analyzeArticle(articleForProcessing);
  const embedding = await createEventEmbedding(analysis.eventHint, analysis.summary);
  const nearestEvents = await findNearestEvents(embedding, 10);
  const nearestEvent = nearestEvents[0];
  let eventId: string;
  let existingEvent: { title: string; summary: string } | undefined;
  let attachedToExistingEvent = false;

  if (!nearestEvent || nearestEvent.similarity < NEW_EVENT_SIMILARITY_THRESHOLD) {
    eventId = await createEventForArticle(article, embedding, {
      title: analysis.eventHint,
      summary: analysis.summary,
    });
  } else if (nearestEvent.similarity > AUTO_ATTACH_SIMILARITY_THRESHOLD) {
    await attachArticleToEvent(article.id, nearestEvent.eventId, embedding);
    eventId = nearestEvent.eventId;
    attachedToExistingEvent = true;
  } else {
    existingEvent = await getEventForComparison(nearestEvent.eventId);
    const decision = await compareEvents(analysis, existingEvent);

    if (decision === 'SAME_EVENT') {
      await attachArticleToEvent(article.id, nearestEvent.eventId, embedding);
      eventId = nearestEvent.eventId;
      attachedToExistingEvent = true;
    } else {
      eventId = await createEventForArticle(article, embedding, {
        title: analysis.eventHint,
        summary: analysis.summary,
      });
    }
  }

  if (attachedToExistingEvent) {
    const eventToUpdate = existingEvent ?? await getEventForComparison(eventId);
    const updatedEvent = await updateEventFromArticle(eventToUpdate, analysis);
    const updatedEmbedding = await createEventEmbedding(
      updatedEvent.title,
      updatedEvent.summary,
    );
    await updateEventDetails(eventId, updatedEvent, updatedEmbedding);
  }
  const ranking = rankArticle(article.source, analysis);

  await saveArticleAnalysis(article.id, analysis, ranking);
  await updateEventImportance(eventId);

  return { kind: 'PROCESSED', analysis, ranking, eventId, nearestEvents };
}
