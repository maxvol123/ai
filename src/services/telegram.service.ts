import { ArticleAnalysis, ArticleScreening } from './analysis.service';
import { RankingResult } from './ranking.service';

interface TelegramMessage {
  message_id: number;
}

export interface TelegramPostArticle {
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderPostWithSourceLink(post: string, source: string, url: string): string {
  const sourceLine = `Source: ${source}`;
  const normalized = /^Source:.*$/m.test(post)
    ? post.replace(/^Source:.*$/m, sourceLine)
    : post.replace(/(\n\n)(?=#)/, `$1${sourceLine}\n\n`);
  const withFallback = normalized === post && !post.includes(sourceLine)
    ? `${post}\n\n${sourceLine}`
    : normalized;

  return escapeHtml(withFallback).replace(
    escapeHtml(sourceLine),
    `Source: <a href="${escapeHtml(url)}">${escapeHtml(source)}</a>`,
  );
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
  article: { id: string; source: string; title: string; url: string },
  analysis: ArticleAnalysis,
  ranking: RankingResult,
): Promise<number> {
  const { approvalChatId } = getTelegramConfig();

  if (!approvalChatId) {
    throw new Error('CHAT_ID must be set');
  }
  const recommendation = ranking.recommendedForPublish ? 'Recommend publishing' : 'Recommend skipping';
  const text = [
    `New article from <a href="${escapeHtml(article.url)}">${escapeHtml(article.source)}</a>`,
    '',
    escapeHtml(article.title),
    '',
    `Ranking score: ${ranking.score}/10`,
    `Impact: ${analysis.impact} · Novelty: ${analysis.novelty} · Reach: ${analysis.reach}`,
    `Authority: ${ranking.sourceAuthority} · Expected attention: ${analysis.expectedAttention}`,
    `Confidence: ${analysis.confidence}% · Event: ${analysis.eventHint}`,
    `Category: ${analysis.category}`,
    `Summary: ${analysis.summary}`,
    `Why it matters: ${analysis.whyItMatters}`,
    `AI: ${recommendation}`,
    '',
  ].join('\n');

  const message = await telegramRequest<TelegramMessage>('sendMessage', {
    chat_id: approvalChatId,
    text: text.slice(0, 4096),
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Approve', callback_data: `approve:${article.id}` },
        { text: '❌ Reject', callback_data: `reject:${article.id}` },
      ]],
    },
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

  // telegramPost is the editorially prepared publication text. The fallback
  // keeps articles analyzed before this field was introduced publishable.
  const fallbackPost = [
    article.title,
    article.summary,
    article.whyItMatters ? `Why it matters: ${article.whyItMatters}` : null,
  ].filter((line): line is string => Boolean(line)).join('\n\n');
  const post = article.telegramPost?.trim() || fallbackPost;
  const text = renderPostWithSourceLink(post, article.source, article.url);

  const message = await telegramRequest<TelegramMessage>('sendMessage', {
    chat_id: channelId,
    text: text.slice(0, 4096),
    parse_mode: 'HTML',
    disable_web_page_preview: false,
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
