import { collectAllSources } from '../collectors/sources.collector';
import {
  saveArticles,
  saveTelegramMessageId,
} from '../services/article.service';
import { processArticle } from '../services/news-pipeline.service';
import {
  sendApprovalRequest,
  sendNeedsContentRequest,
} from '../services/telegram.service';

export async function runCollectJob(): Promise<void> {
  const articles = await collectAllSources();

  console.log(`Found ${articles.length} articles`);

  const newArticles = await saveArticles(articles);

  console.log(`Saved ${newArticles.length} new articles`);

  for (const article of newArticles) {
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
  }

  console.log(`Analyzed ${newArticles.length} new articles`);
}
