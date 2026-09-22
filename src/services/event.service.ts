import { prisma } from '../db/prisma';
import { StoredArticle } from '../types/article';
import { cosineSimilarity } from './embedding.service';

export const NEW_EVENT_SIMILARITY_THRESHOLD = 0.75;
export const AUTO_ATTACH_SIMILARITY_THRESHOLD = 0.9;

export interface NearestEvent {
  eventId: string;
  title: string;
  similarity: number;
}

function toVector(value: unknown): number[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'number')
    ? value
    : undefined;
}

export async function findNearestEvents(
  embedding: number[],
  limit: number,
): Promise<NearestEvent[]> {
  const events = await prisma.event.findMany({
    select: { id: true, title: true, embedding: true },
  });

  return events
    .flatMap((event) => {
      const eventEmbedding = toVector(event.embedding);
      if (!eventEmbedding) {
        return [];
      }

      return [{
        eventId: event.id,
        title: event.title,
        similarity: cosineSimilarity(embedding, eventEmbedding),
      }];
    })
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, Math.max(0, Math.floor(limit)));
}

export async function getEventForComparison(
  eventId: string,
): Promise<{ title: string; summary: string }> {
  return prisma.event.findUniqueOrThrow({
    where: { id: eventId },
    select: { title: true, summary: true },
  });
}

export async function attachArticleToEvent(
  articleId: string,
  eventId: string,
  embedding: number[],
): Promise<void> {
  await prisma.article.update({
    where: { id: articleId },
    data: { embedding, eventId },
  });
}

export async function updateEventDetails(
  eventId: string,
  eventDetails: { title: string; summary: string },
  embedding: number[],
): Promise<void> {
  await prisma.event.update({
    where: { id: eventId },
    data: {
      title: eventDetails.title,
      summary: eventDetails.summary,
      embedding,
    },
  });
}

export async function createEventForArticle(
  article: StoredArticle,
  embedding: number[],
  eventDetails: { title: string; summary: string },
): Promise<string> {
  const event = await prisma.event.create({
    data: {
      title: eventDetails.title,
      summary: eventDetails.summary,
      embedding,
      importance: 0,
      status: 'ACTIVE',
    },
  });

  await attachArticleToEvent(article.id, event.id, embedding);

  return event.id;
}

export async function updateEventImportance(eventId: string): Promise<void> {
  const event = await prisma.event.findUniqueOrThrow({
    where: { id: eventId },
    select: { articles: { select: { score: true } } },
  });
  const importance = Math.max(0, ...event.articles.map((article) => article.score ?? 0));

  await prisma.event.update({ where: { id: eventId }, data: { importance } });
}
