import 'dotenv/config';
import { prisma } from '../db/prisma';
import { saveTelegramMessageId } from '../services/article.service';
import { processArticle } from '../services/news-pipeline.service';
import { sendApprovalRequest } from '../services/telegram.service';

const ARTICLE_COUNT = 2;

async function run(): Promise<void> {
  const candidates = await prisma.article.findMany({
    where: { status: 'NEW' },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  const selected = [...candidates]
    .sort(() => Math.random() - 0.5)
    .filter((article, index, articles) =>
      articles.findIndex((candidate) => candidate.source === article.source) === index,
    )
    .slice(0, ARTICLE_COUNT);

  if (selected.length < ARTICLE_COUNT) {
    throw new Error(`Only ${selected.length} distinct sources have NEW articles`);
  }

  for (const article of selected) {
    const processed = await processArticle(article);
    if (!processed) {
      console.log(`Rejected by screening: ${article.source} — ${article.title}`);
      continue;
    }

    if (processed.kind === 'NEEDS_CONTENT') {
      console.log(`Needs content: ${article.source} — ${article.title}`);
      continue;
    }

    const { analysis, ranking } = processed;
    if (ranking.score < 5) {
      console.log(`Below Telegram threshold (${ranking.score}/10): ${article.source} — ${article.title}`);
      continue;
    }

    const messageId = await sendApprovalRequest(article, analysis, ranking);
    await saveTelegramMessageId(article.id, messageId);
    console.log(`Sent for approval: ${article.source} — ${article.title}`);
  }
}

run()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
