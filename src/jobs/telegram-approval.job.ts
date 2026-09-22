import 'dotenv/config';
import {
  getApprovedArticleForPublishing,
  markArticlePublished,
  saveTelegramPost,
  setArticleApproval,
} from '../services/article.service';
import {
  answerCallbackQuery,
  getTelegramUpdates,
  publishArticleToChannel,
  TelegramCallbackQuery,
} from '../services/telegram.service';
import { writeTelegramPost } from '../services/telegram-writer.service';

async function handleCallback(callback: TelegramCallbackQuery): Promise<void> {
  const match = callback.data?.match(/^(approve|reject):([a-z0-9]+)$/i);

  if (!match) {
    await safelyAnswerCallback(callback.id, 'Unknown action');
    return;
  }

  const [, action, articleId] = match;
  const changed = await setArticleApproval(articleId, action === 'approve');

  if (changed && action === 'approve') {
    const article = await getApprovedArticleForPublishing(articleId);

    if (!article) {
      throw new Error(`Approved article ${articleId} was not found`);
    }

    const telegramPost = await writeTelegramPost(article);
    await saveTelegramPost(articleId, telegramPost);
    await publishArticleToChannel({ ...article, telegramPost });
    await markArticlePublished(articleId);
  }

  await safelyAnswerCallback(
    callback.id,
    changed ? (action === 'approve' ? 'Published to channel' : 'Article rejected') : 'Already reviewed',
  );
}

async function safelyAnswerCallback(callbackId: string, text: string): Promise<void> {
  try {
    await answerCallbackQuery(callbackId, text);
  } catch (error) {
    // Telegram rejects callbacks older than a few minutes. The action itself may
    // already have been processed, so this must not stop the polling service.
    console.warn(`Could not answer Telegram callback: ${String(error)}`);
  }
}

export async function runTelegramApprovalJob(): Promise<void> {
  let offset: number | undefined;

  for (;;) {
    const updates = await getTelegramUpdates(offset);

    for (const update of updates) {
      offset = update.update_id + 1;

      if (update.callback_query) {
        await handleCallback(update.callback_query);
      }
    }
  }
}

runTelegramApprovalJob().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
