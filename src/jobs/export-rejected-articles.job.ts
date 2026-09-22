import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { prisma } from '../db/prisma';

const sources = [
  'arXiv cs.AI',
  'arXiv cs.LG',
  'arXiv cs.CL',
  'Hugging Face Papers',
  'Cohere',
  'Mistral',
];

function escapeCsv(value: string | Date | null): string {
  const text = value instanceof Date ? value.toISOString() : value ?? '';
  return `"${text.replaceAll('"', '""')}"`;
}

async function exportRejectedArticles(): Promise<void> {
  const articles = await prisma.article.findMany({
    where: { source: { in: sources }, status: 'REJECTED' },
    select: {
      source: true,
      title: true,
      url: true,
      publishedAt: true,
      screeningReason: true,
      createdAt: true,
    },
    orderBy: [{ source: 'asc' }, { publishedAt: 'desc' }],
  });

  const header = ['source', 'title', 'url', 'published_at', 'screening_reason', 'collected_at'];
  const rows = articles.map((article) => [
    article.source,
    article.title,
    article.url,
    article.publishedAt,
    article.screeningReason,
    article.createdAt,
  ].map(escapeCsv).join(','));

  const outputDir = resolve(process.cwd(), 'exports');
  const outputPath = resolve(outputDir, 'rejected-arxiv-huggingface-cohere-mistral.csv');
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, [header.join(','), ...rows].join('\n'), 'utf8');

  console.log(`Exported ${articles.length} rejected articles to ${outputPath}`);
}

exportRejectedArticles()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
