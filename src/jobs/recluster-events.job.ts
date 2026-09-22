import 'dotenv/config';
import { prisma } from '../db/prisma';
import { cosineSimilarity } from '../services/embedding.service';

interface EmbeddedArticle {
  id: string;
  title: string;
  eventId: string | null;
  eventHint: string | null;
  summary: string | null;
  score: number | null;
  embedding: number[];
}

interface EventGroup {
  embedding: number[];
  articles: EmbeddedArticle[];
}

function asVector(value: unknown): number[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'number')
    ? value
    : undefined;
}

function centroid(vectors: number[][]): number[] {
  return vectors[0].map((_, index) =>
    vectors.reduce((sum, vector) => sum + vector[index], 0) / vectors.length,
  );
}

async function runReclusterEvents(): Promise<void> {
  const shouldApply = process.argv.includes('--apply');
  const records = await prisma.article.findMany({
    where: { eventId: { not: null } },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      title: true,
      eventId: true,
      eventHint: true,
      summary: true,
      score: true,
      embedding: true,
    },
  });
  const articles = records.flatMap((record) => {
    const embedding = asVector(record.embedding);
    return embedding ? [{ ...record, embedding }] : [];
  });
  const groups: EventGroup[] = [];

  for (const article of articles) {
    const closest = groups
      .map((group) => ({ group, similarity: cosineSimilarity(article.embedding, group.embedding) }))
      .sort((left, right) => right.similarity - left.similarity)[0];

    if (closest && closest.similarity >= 0.72) {
      closest.group.articles.push(article);
      closest.group.embedding = centroid(closest.group.articles.map((item) => item.embedding));
    } else {
      groups.push({ embedding: article.embedding, articles: [article] });
    }
  }

  const mergedGroups = groups.filter((group) => group.articles.length > 1);
  console.log(`Articles: ${articles.length}`);
  console.log(`Clusters after reclustering: ${groups.length}`);
  console.log(`Merged clusters: ${mergedGroups.length}`);

  for (const group of mergedGroups) {
    console.log(`- ${group.articles.length} articles: ${group.articles.map((article) => article.title).join(' | ')}`);
  }

  if (!shouldApply) {
    console.log('Dry run only. Run with --apply to persist these clusters.');
    return;
  }

  const redundantEventIds = new Set<string>();

  await prisma.$transaction(async (tx) => {
    for (const group of groups) {
      const leader = [...group.articles].sort((left, right) => (right.score ?? 0) - (left.score ?? 0))[0];

      if (!leader.eventId) {
        continue;
      }

      const importance = Math.max(...group.articles.map((article) => article.score ?? 0));
      await tx.event.update({
        where: { id: leader.eventId },
        data: {
          title: leader.eventHint ?? leader.title,
          summary: leader.summary ?? leader.title,
          embedding: group.embedding,
          importance,
          status: 'ACTIVE',
        },
      });
      await tx.article.updateMany({
        where: { id: { in: group.articles.map((article) => article.id) } },
        data: { eventId: leader.eventId },
      });

      for (const article of group.articles) {
        if (article.eventId && article.eventId !== leader.eventId) {
          redundantEventIds.add(article.eventId);
        }
      }
    }

    if (redundantEventIds.size > 0) {
      await tx.event.deleteMany({ where: { id: { in: [...redundantEventIds] } } });
    }
  });

  console.log(`Applied. Removed ${redundantEventIds.size} redundant events.`);
}

runReclusterEvents()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
