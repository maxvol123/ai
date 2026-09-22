import 'dotenv/config';
import { prisma } from '../db/prisma';
import {
  saveTelegramMessageId,
} from '../services/article.service';
import { processArticle } from '../services/news-pipeline.service';
import {
  sendApprovalRequest,
  sendNeedsContentRequest,
} from '../services/telegram.service';

async function runAnalyzeLatestJob(): Promise<void> {
  const requestedLimit = Number(process.argv[2] ?? 10);
  const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
    ? requestedLimit
    : 10;
  const onlyUnscreened = process.argv.includes('--unscreened');
  const articles = await prisma.article.findMany({
    where: {
      publishedAt: { not: null },
      ...(onlyUnscreened ? { screeningPassed: null } : {}),
    },
    orderBy: { publishedAt: 'desc' },
    take: limit,
  });

  console.log(`Analyzing ${articles.length} latest articles`);

  for (const article of articles) {
    const processed = await processArticle(article);

    if (!processed) {
      console.log(`Rejected by screening: ${article.title}`);
      continue;
    }

    if (processed.kind === 'NEEDS_CONTENT') {
      const messageId = await sendNeedsContentRequest(article, processed.screening);
      await saveTelegramMessageId(article.id, messageId);
      console.log(`Needs more content: ${article.title}`);
      continue;
    }

    const { analysis, ranking } = processed;

    if (ranking.score < 6) {
      console.log(`Below Telegram threshold (${ranking.score}/10): ${article.title}`);
      continue;
    }

    const messageId = await sendApprovalRequest(article, analysis, ranking);
    await saveTelegramMessageId(article.id, messageId);

    console.log(`Analyzed: ${article.title}`);
  }
}

runAnalyzeLatestJob()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
