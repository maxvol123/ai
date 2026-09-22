import { Source as DbSource } from '@prisma/client';
import { prisma } from '../db/prisma';
import { Article } from '../types/article';
import { Source, SourceType } from '../types/source';
import { collectHtmlNews, HtmlSource } from './html.collector';
import { collectRSS } from './rss.collector';

type CollectorKind = 'RSS' | 'HTML';

interface SourceDefinition extends Source {
  url: string;
  pollIntervalMinutes: number;
  collector: CollectorKind;
  articlePath?: string;
}

const definitions: SourceDefinition[] = [
  { name: 'OpenAI', type: 'OFFICIAL', authority: 10, enabled: true, url: 'https://openai.com/news/rss.xml', pollIntervalMinutes: 20, collector: 'RSS' },
  { name: 'Anthropic', type: 'OFFICIAL', authority: 10, enabled: true, url: 'https://www.anthropic.com/news', pollIntervalMinutes: 20, collector: 'HTML', articlePath: '/news' },
  { name: 'Google DeepMind', type: 'OFFICIAL', authority: 10, enabled: true, url: 'https://deepmind.google/blog/rss.xml', pollIntervalMinutes: 20, collector: 'RSS' },
  { name: 'Google AI / Gemini', type: 'OFFICIAL', authority: 10, enabled: true, url: 'https://blog.google/innovation-and-ai/technology/ai/rss/', pollIntervalMinutes: 20, collector: 'RSS' },
  { name: 'Mistral', type: 'OFFICIAL', authority: 10, enabled: true, url: 'https://mistral.ai/news/rss', pollIntervalMinutes: 20, collector: 'RSS' },
  { name: 'Microsoft AI', type: 'OFFICIAL', authority: 10, enabled: true, url: 'https://www.microsoft.com/en-us/research/feed/', pollIntervalMinutes: 20, collector: 'RSS' },
  { name: 'NVIDIA', type: 'OFFICIAL', authority: 10, enabled: true, url: 'https://blogs.nvidia.com/feed/', pollIntervalMinutes: 20, collector: 'RSS' },
  { name: 'Hugging Face', type: 'OFFICIAL', authority: 10, enabled: true, url: 'https://huggingface.co/blog/feed.xml', pollIntervalMinutes: 20, collector: 'RSS' },
  { name: 'TechCrunch AI', type: 'MEDIA', authority: 8, enabled: true, url: 'https://techcrunch.com/category/artificial-intelligence/feed/', pollIntervalMinutes: 10, collector: 'RSS' },
  { name: 'The Verge AI', type: 'MEDIA', authority: 8, enabled: true, url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml', pollIntervalMinutes: 10, collector: 'RSS' },
  { name: 'Ars Technica', type: 'MEDIA', authority: 8, enabled: true, url: 'https://feeds.arstechnica.com/arstechnica/technology-lab', pollIntervalMinutes: 10, collector: 'RSS' },
  { name: 'VentureBeat AI', type: 'MEDIA', authority: 8, enabled: true, url: 'https://venturebeat.com/category/ai/feed/', pollIntervalMinutes: 10, collector: 'RSS' },
  { name: 'MIT Technology Review', type: 'MEDIA', authority: 9, enabled: true, url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed/', pollIntervalMinutes: 10, collector: 'RSS' },
  { name: 'Wired', type: 'MEDIA', authority: 8, enabled: true, url: 'https://www.wired.com/feed/tag/ai/latest/rss', pollIntervalMinutes: 10, collector: 'RSS' },
  { name: 'arXiv cs.AI', type: 'RESEARCH', authority: 8, enabled: true, url: 'https://export.arxiv.org/api/query?search_query=cat:cs.AI&start=0&max_results=50&sortBy=submittedDate&sortOrder=descending', pollIntervalMinutes: 120, collector: 'RSS' },
  { name: 'arXiv cs.LG', type: 'RESEARCH', authority: 8, enabled: true, url: 'https://export.arxiv.org/api/query?search_query=cat:cs.LG&start=0&max_results=50&sortBy=submittedDate&sortOrder=descending', pollIntervalMinutes: 120, collector: 'RSS' },
  { name: 'arXiv cs.CL', type: 'RESEARCH', authority: 8, enabled: true, url: 'https://export.arxiv.org/api/query?search_query=cat:cs.CL&start=0&max_results=50&sortBy=submittedDate&sortOrder=descending', pollIntervalMinutes: 120, collector: 'RSS' },
  { name: 'Meta AI', type: 'OFFICIAL', authority: 10, enabled: true, url: 'https://ai.meta.com/blog/', pollIntervalMinutes: 45, collector: 'HTML', articlePath: '/blog' },
  { name: 'xAI', type: 'OFFICIAL', authority: 10, enabled: true, url: 'https://x.ai/news', pollIntervalMinutes: 45, collector: 'HTML', articlePath: '/news' },
  { name: 'Perplexity', type: 'OFFICIAL', authority: 10, enabled: true, url: 'https://www.perplexity.ai/hub/blog', pollIntervalMinutes: 45, collector: 'HTML', articlePath: '/hub/blog' },
  { name: 'Cohere', type: 'OFFICIAL', authority: 10, enabled: true, url: 'https://cohere.com/blog', pollIntervalMinutes: 45, collector: 'HTML', articlePath: '/blog' },
  { name: 'Stability AI', type: 'OFFICIAL', authority: 10, enabled: true, url: 'https://stability.ai/blog', pollIntervalMinutes: 45, collector: 'HTML', articlePath: '/blog' },
  { name: 'Reuters Tech/AI', type: 'MEDIA', authority: 9, enabled: true, url: 'https://www.reuters.com/technology/artificial-intelligence/', pollIntervalMinutes: 45, collector: 'HTML', articlePath: '/technology/artificial-intelligence' },
  { name: 'Hugging Face Papers', type: 'RESEARCH', authority: 8, enabled: true, url: 'https://huggingface.co/papers', pollIntervalMinutes: 120, collector: 'HTML', articlePath: '/papers' },
];

const definitionsByName = new Map(definitions.map((definition) => [definition.name, definition]));

function afterMinutes(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * 60_000);
}

function retryDelayMinutes(consecutiveFailures: number): number {
  if (consecutiveFailures === 1) return 10;
  if (consecutiveFailures === 2) return 30;
  if (consecutiveFailures === 3) return 60;
  return 180;
}

async function syncSourceDefinitions(): Promise<void> {
  await Promise.all(definitions.map((source) => prisma.source.upsert({
    where: { name: source.name },
    create: {
      name: source.name,
      url: source.url,
      type: source.type as SourceType,
      authority: source.authority,
      enabled: source.enabled,
      pollIntervalMinutes: source.pollIntervalMinutes,
    },
    // Scheduling settings are database-owned and may be edited without redeploying.
    update: { url: source.url, type: source.type as SourceType, authority: source.authority },
  })));
}

async function collectOneSource(source: DbSource): Promise<Article[]> {
  const definition = definitionsByName.get(source.name);
  if (!definition || !source.url) {
    throw new Error(`No collector configuration for source ${source.name}`);
  }

  if (definition.collector === 'RSS') {
    return collectRSS(source.name, source.url);
  }

  const htmlSource: HtmlSource = {
    source: source.name,
    url: source.url,
    articlePath: definition.articlePath!,
  };
  return collectHtmlNews(htmlSource);
}

async function collectAndSchedule(source: DbSource): Promise<Article[]> {
  const checkedAt = new Date();
  await prisma.source.update({ where: { id: source.id }, data: { lastCheckedAt: checkedAt } });

  try {
    const articles = await collectOneSource(source);
    await prisma.source.update({
      where: { id: source.id },
      data: {
        lastSuccessAt: checkedAt,
        nextCheckAt: afterMinutes(checkedAt, source.pollIntervalMinutes),
        consecutiveFailures: 0,
      },
    });
    return articles;
  } catch (error) {
    const failures = source.consecutiveFailures + 1;
    await prisma.source.update({
      where: { id: source.id },
      data: {
        consecutiveFailures: failures,
        nextCheckAt: afterMinutes(checkedAt, retryDelayMinutes(failures)),
      },
    });
    console.warn(`Skipping ${source.name}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/** Collect only sources whose database schedule says they are due. */
export async function collectAllSources(): Promise<Article[]> {
  await syncSourceDefinitions();

  const sources = await prisma.source.findMany({
    where: { enabled: true, nextCheckAt: { lte: new Date() } },
    orderBy: { nextCheckAt: 'asc' },
  });

  const results = await Promise.all(sources.map(collectAndSchedule));
  return results.flat();
}
