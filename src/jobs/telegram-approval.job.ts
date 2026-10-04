import 'dotenv/config';
import {
  getApprovedArticleForPublishing,
  markArticlePublished,
  setArticleApproval,
} from '../services/article.service';
import {
  answerCallbackQuery,
  getTelegramUpdates,
  publishArticleToChannel,
  TelegramCallbackQuery,
} from '../services/telegram.service';

export async function handleCallback(callback: TelegramCallbackQuery): Promise<void> {
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

    const messageId = await publishArticleToChannel(article);
    if (!await markArticlePublished(articleId, messageId)) {
      throw new Error(`Article ${articleId} sent as message ${messageId}, but publication status was not saved`);
    }
  }

  await safelyAnswerCallback(
    callback.id,
    changed ? (action === 'approve' ? 'Published to channel' : 'Article rejected') : 'Already reviewed or no saved draft; request a new review if needed',
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

if (require.main === module) {
  runTelegramApprovalJob().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
