import { ArticleAnalysis, ArticleScreening } from './analysis.service';
import { RankingResult } from './ranking.service';
import { prisma } from '../db/prisma';
import { saveTelegramPost } from './article.service';
import { fetchArticlePage } from './article-content.service';
import { writeTelegramPost } from './telegram-writer.service';
import { assertSafeSavedCaption, escapeHtml, validateTelegramCaption } from './telegram-caption';
import { normalizeImageUrl } from './article-image';
import type { Article } from '@prisma/client';

function formatReviewEvaluation(article: Pick<Article,
  'score' | 'impact' | 'novelty' | 'reach' | 'expectedAttention' | 'confidence'>): string {
  const fields = [
    ['Score', article.score, 2, '/10'],
    ['Impact', article.impact, 1, '/10'],
    ['Novelty', article.novelty, 1, '/10'],
    ['Reach', article.reach, 1, '/10'],
    ['Expected attention', article.expectedAttention, 1, '/10'],
    ['Confidence', article.confidence, 0, '%'],
  ] as const;
  const lines = fields.flatMap(([label, value, decimals, suffix]) =>
    typeof value === 'number' && Number.isFinite(value)
      ? [`${label}: ${value.toFixed(decimals)}${suffix}`] : []);
  return lines.length ? ['AI evaluation', '', ...lines].join('\n') : '';
}

interface TelegramMessage {
  message_id: number;
}

export interface TelegramPostArticle {
  id: string;
  imageUrl?: string | null;
  title: string;
  url: string;
  source: string;
  summary: string | null;
  whyItMatters: string | null;
  telegramPost: string | null;
}

interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  data?: string;
  message?: TelegramMessage;
}

function getTelegramConfig() {
  const token = process.env.HTTPAPI_TG;
  const approvalChatId = process.env.CHAT_ID;
  const channelId = process.env.TELEGRAM_CHANNEL_ID;

  if (!token) {
    throw new Error('HTTPAPI_TG must be set');
  }

  return { token, approvalChatId, channelId };
}

async function telegramRequest<T>(
  method: string,
  payload: Record<string, unknown>,
): Promise<T> {
  const { token } = getTelegramConfig();
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = (await response.json()) as TelegramResponse<T>;

  if (!response.ok || !data.ok) {
    throw new Error(`Telegram ${method} failed: ${data.description ?? response.statusText}`);
  }

  return data.result;
}

export async function sendApprovalRequest(
  article: { id: string; source: string; title: string; url: string; imageUrl?: string | null },
  analysis: ArticleAnalysis,
  _ranking: RankingResult,
): Promise<number> {
  const { approvalChatId } = getTelegramConfig();

  if (!approvalChatId) {
    throw new Error('CHAT_ID must be set');
  }
  const stored = await prisma.article.findUniqueOrThrow({ where: { id: article.id } });
  if (stored.status !== 'ANALYZED') throw new Error('Article is not awaiting review');
  let imageUrl = normalizeImageUrl(stored.imageUrl, stored.url) ?? normalizeImageUrl(article.imageUrl, article.url);
  if (!imageUrl) {
    // Reuse the page fetched by screening when available.
    try { imageUrl = (await fetchArticlePage(article)).imageUrl; }
    catch (error) { console.warn('[article] article=' + article.id + ' image enrichment failed: ' + String(error)); }
  }
  if (imageUrl && imageUrl !== stored.imageUrl) {
    await prisma.article.update({ where: { id: article.id }, data: { imageUrl } });
  }
  let text = stored.telegramPost;
  if (!text) {
    text = await writeTelegramPost({ ...stored, summary: analysis.summary, whyItMatters: analysis.whyItMatters });
    await saveTelegramPost(article.id, text);
  }
  assertSafeSavedCaption(text, stored.source, stored.url);
  const evaluation = formatReviewEvaluation(stored);
  const reviewText = evaluation ? `${evaluation}\n\n${text}` : text;
  // Saved HTML is validated above. Count visible text after removing its Source
  // link and decoding the supported entities, as Telegram's caption limit does.
  const captionLength = reviewText.replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot);/g, '_').length;
  const splitPhotoReview = captionLength > 1024;
  let evaluationSent = false;

  const reply_markup = {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve:${article.id}` },
        { text: '❌ Reject', callback_data: `reject:${article.id}` },
      ]],
    };
  if (imageUrl) {
    try {
      const photo = await telegramRequest<TelegramMessage>('sendPhoto', {
        chat_id: approvalChatId, photo: imageUrl,
        caption: splitPhotoReview ? evaluation : reviewText, parse_mode: 'HTML',
        ...(splitPhotoReview ? {} : { reply_markup }),
      });
      if (!splitPhotoReview) return photo.message_id;
      evaluationSent = true;
    } catch (error) {
      const summary = String(error).replaceAll(process.env.HTTPAPI_TG ?? '<unset>', '[redacted]');
      console.warn(`[telegram] article=${article.id} imageUrl=${imageUrl} review photo failed: ${summary}; falling back to text`);
    }
  }
  const message = await telegramRequest<TelegramMessage>('sendMessage', {
    chat_id: approvalChatId, text: evaluationSent ? text : reviewText,
    disable_web_page_preview: true, parse_mode: 'HTML', reply_markup,
  });

  return message.message_id;
}

export async function sendNeedsContentRequest(
  article: { source: string; title: string; url: string },
  screening: ArticleScreening,
): Promise<number> {
  const { approvalChatId } = getTelegramConfig();

  if (!approvalChatId) {
    throw new Error('CHAT_ID must be set');
  }

  const text = [
    `Needs more information — <a href="${escapeHtml(article.url)}">${escapeHtml(article.source)}</a>`,
    '',
    escapeHtml(article.title),
    '',
    `Reason: ${escapeHtml(screening.reason)}`,
  ].join('\n');

  const message = await telegramRequest<TelegramMessage>('sendMessage', {
    chat_id: approvalChatId,
    text: text.slice(0, 4096),
    parse_mode: 'HTML',
  });

  return message.message_id;
}

export async function publishArticleToChannel(article: TelegramPostArticle): Promise<number> {
  const { channelId } = getTelegramConfig();

  if (!channelId) {
    throw new Error('TELEGRAM_CHANNEL_ID must be set');
  }

  const text = article.telegramPost;
  if (!text || !validateTelegramCaption(text).valid) {
    throw new Error(`Article ${article.id} has no valid reviewed draft`);
  }
  assertSafeSavedCaption(text, article.source, article.url);
  if (article.imageUrl) {
    try {
      console.log(`[telegram] article=${article.id} sending photo`);
      const photo = await telegramRequest<TelegramMessage>('sendPhoto', {
        chat_id: channelId, photo: article.imageUrl, caption: text, parse_mode: 'HTML',
      });
      return photo.message_id;
    } catch (error) {
      const summary = (error instanceof Error ? error.message : String(error))
        .replaceAll(process.env.HTTPAPI_TG ?? '<unset>', '[redacted]');
      console.warn(`[telegram] article=${article.id} imageUrl=${article.imageUrl} photo failed: ${summary}; falling back to text`);
    }
  }

  const message = await telegramRequest<TelegramMessage>('sendMessage', {
    chat_id: channelId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });

  return message.message_id;
}

export function getTelegramUpdates(offset?: number) {
  return telegramRequest<Array<{ update_id: number; callback_query?: TelegramCallbackQuery }>>(
    'getUpdates',
    {
      offset,
      timeout: 30,
      allowed_updates: ['callback_query'],
    },
  );
}

export function answerCallbackQuery(callbackQueryId: string, text: string) {
  return telegramRequest<boolean>('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
  });
}
