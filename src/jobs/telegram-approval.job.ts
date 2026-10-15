import 'dotenv/config';
import {
  getApprovedArticleForPublishing,
  markArticlePublished,
  rejectArticlePublication,
  setArticleApproval,
} from '../services/article.service';
import {
  answerCallbackQuery,
  getTelegramUpdates,
  publishArticleToChannel,
  TelegramCallbackQuery,
} from '../services/telegram.service';
import { ArticlePublicationAgeError } from '../services/article-age';
import { handleDigestCallback, runDailyDigestTick } from '../services/daily-digest.service';

export async function handleCallback(callback: TelegramCallbackQuery): Promise<void> {
  if (callback.data?.startsWith('digest:')) {
    await safelyAnswerCallback(callback.id, await handleDigestCallback(callback));
    return;
  }
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

    let messageId: number;
    try {
      messageId = await publishArticleToChannel(article);
    } catch (error) {
      if (!(error instanceof ArticlePublicationAgeError)) throw error;
      await rejectArticlePublication(articleId, error.message);
      await safelyAnswerCallback(callback.id, error.message);
      return;
    }
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
  let digestRunning = false;
  const tick = async () => {
    if (digestRunning) return;
    digestRunning = true;
    try { await runDailyDigestTick(); }
    catch (error) { console.error('[digest]', error); }
    finally { digestRunning = false; }
  };
  // Independent of long polling and collection; UTC boundaries checked every second.
  const digestTimer = setInterval(() => void tick(), 1000);
  void tick();

  try {
    for (;;) {
      const updates = await getTelegramUpdates(offset);

      for (const update of updates) {
        offset = update.update_id + 1;

        if (update.callback_query) {
          await handleCallback(update.callback_query);
        }
      }
    }
  } finally { clearInterval(digestTimer); }
}

if (require.main === module) {
  runTelegramApprovalJob().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
