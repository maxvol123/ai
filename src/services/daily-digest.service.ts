import { prisma } from '../db/prisma';
import { escapeHtml } from './telegram-caption';
import { generateDontSkipImage } from './dontskip-image';
import { sendDigestPhoto, telegramRequest, TelegramCallbackQuery } from './telegram.service';

export interface DigestCandidate { id: string; title: string; url: string; score?: number | null; }
const PAGE_SIZE = 5;

export function selectDigestCandidates(items: DigestCandidate[], selectedIds: string[]): DigestCandidate[] {
  const selected = [...new Set(selectedIds)].flatMap(id => {
    const item = items.find(candidate => candidate.id === id);
    return item ? [item] : [];
  }).slice(0, 2);
  const ranked = items.filter(item => typeof item.score === 'number' && Number.isFinite(item.score))
    .slice().sort((a, b) => b.score! - a.score!);
  for (const item of ranked) {
    if (selected.length === 2) break;
    if (!selected.some(candidate => candidate.id === item.id)) selected.push(item);
  }
  return selected;
}

export function digestSchedule(now: Date) {
  const date = now.toISOString().slice(0, 10);
  return { date, start: new Date(`${date}T00:00:00.000Z`),
    selection: new Date(`${date}T18:50:00.000Z`), publish: new Date(`${date}T19:00:00.000Z`) };
}

function postLink(messageId: number, sourceUrl: string): string {
  const channel = process.env.TELEGRAM_CHANNEL_ID ?? '';
  if (channel.startsWith('@')) return `https://t.me/${channel.slice(1)}/${messageId}`;
  if (/^-100\d+$/.test(channel)) return `https://t.me/c/${channel.slice(4)}/${messageId}`;
  return sourceUrl;
}

export function digestCaption(candidates: DigestCandidate[]): string {
  if (candidates.length !== 2) throw new Error('A digest requires exactly two stories');
  return '#DONTSKIP\n\n' + candidates.map(item => {
    const url = new URL(item.url);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid digest link');
    return `<a href="${escapeHtml(item.url)}">${escapeHtml(item.title.slice(0, 350))}</a>`;
  }).join('\n\n');
}

function keyboard(date: string, items: DigestCandidate[], selected: string[], page: number) {
  const inline_keyboard = items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((item, index) => [{
    text: `${selected.includes(item.id) ? '✅' : '▫️'} ${page * PAGE_SIZE + index + 1}. ${item.title.slice(0, 65)}`,
    callback_data: `digest:${date}:${page * PAGE_SIZE + index}`,
  }]);
  if (page === Math.ceil(items.length / PAGE_SIZE) - 1) {
    inline_keyboard.push([{ text: "🚫 Cancel today's digest", callback_data: `digest:${date}:cancel` }]);
  }
  return { inline_keyboard };
}

async function notify(text: string, extra: Record<string, unknown> = {}) {
  if (!process.env.CHAT_ID) throw new Error('CHAT_ID must be set');
  return telegramRequest<{ message_id: number }>('sendMessage', {
    chat_id: process.env.CHAT_ID, text, ...extra,
  });
}

export async function handleDigestCallback(callback: TelegramCallbackQuery, now = new Date()): Promise<string> {
  if (String(callback.message?.chat?.id) !== process.env.CHAT_ID) return 'Selection is only available in the owner chat';
  const match = callback.data?.match(/^digest:(\d{4}-\d{2}-\d{2}):(\d+|cancel)$/);
  if (!match) return 'Unknown story';
  const [, date, index] = match;
  const schedule = digestSchedule(now);
  if (date !== schedule.date || now < schedule.selection || now >= schedule.publish) return 'Selection has closed';
  const digest = await prisma.dailyDigest.findUnique({ where: { date } });
  if (!digest || !digest.reviewMessageIds.includes(callback.message!.message_id)) return 'Selection is unavailable';
  if (digest.status === 'CANCELLED') return "Today's #DONTSKIP digest has been cancelled";
  if (digest.status !== 'OPEN') return 'Selection is unavailable';
  if (index === 'cancel') {
    const result = await prisma.dailyDigest.updateMany({
      where: { date, status: 'OPEN', version: digest.version },
      data: { status: 'CANCELLED', version: { increment: 1 } },
    });
    if (!result.count) return 'The digest status has changed. Please tap again';
    // Cancellation is persisted first; failed keyboard cleanup cannot undo it.
    const edits = await Promise.allSettled(digest.reviewMessageIds.map(message_id =>
      telegramRequest('editMessageReplyMarkup', { chat_id: process.env.CHAT_ID,
        message_id, reply_markup: { inline_keyboard: [] } })));
    for (const edit of edits) {
      if (edit.status === 'rejected') console.warn('[digest] Could not remove cancelled issue keyboard', edit.reason);
    }
    return "Today's #DONTSKIP digest has been cancelled";
  }
  const items = digest.candidates as unknown as DigestCandidate[];
  const item = items[Number(index)];
  if (!item) return 'Story not found';
  let selected = digest.selectedIds;
  if (selected.includes(item.id)) selected = selected.filter(id => id !== item.id);
  else {
    if (selected.length >= 2) return 'Two stories are already selected. Deselect one first';
    selected = [...selected, item.id];
  }
  const result = await prisma.dailyDigest.updateMany({
    where: { date, status: 'OPEN', version: digest.version },
    data: { selectedIds: selected, version: { increment: 1 } },
  });
  if (!result.count) return 'The selection has changed. Please tap again';
  // The saved selection remains valid even if Telegram cannot refresh a keyboard.
  try {
    const page = Math.floor(Number(index) / PAGE_SIZE);
    await telegramRequest('editMessageReplyMarkup', { chat_id: process.env.CHAT_ID,
      message_id: callback.message!.message_id, reply_markup: keyboard(date, items, selected, page) });
  } catch (error) { console.warn('[digest] Could not refresh selection keyboard', error); }
  return `Selected ${selected.length}/2. Publication at 19:00 UTC`;
}

export async function runDailyDigestTick(now = new Date()): Promise<void> {
  const startedAt = Date.now();
  const schedule = digestSchedule(now);
  if (now < schedule.selection) return;
  let digest = await prisma.dailyDigest.findUnique({ where: { date: schedule.date } });
  if (!digest && now < schedule.publish) {
    const articles = await prisma.article.findMany({
      where: { status: 'PUBLISHED', telegramMessageId: { not: null },
        channelPublishedAt: { gte: schedule.start, lte: schedule.selection } },
      orderBy: [{ channelPublishedAt: 'asc' }, { id: 'asc' }],
      select: { id: true, title: true, url: true, telegramMessageId: true, score: true },
    });
    const candidates = articles.map(article => ({ id: article.id, title: article.title, score: article.score,
      url: postLink(article.telegramMessageId!, article.url) }));
    digest = await prisma.dailyDigest.upsert({ where: { date: schedule.date }, update: {},
      create: { date: schedule.date, candidates, status: candidates.length >= 2 ? 'OPEN' : 'SKIPPED' } });
    if (digest.status === 'SKIPPED') {
      await notify('Fewer than two stories were published today by 18:50 UTC. The #DONTSKIP digest has been skipped.');
    }
  }
  if (!digest || digest.status !== 'OPEN') return;
  let items = digest.candidates as unknown as DigestCandidate[];
  if (now < schedule.publish) {
    for (let page = digest.reviewMessageIds.length; page < Math.ceil(items.length / PAGE_SIZE); page++) {
      if (now.getTime() + Date.now() - startedAt >= schedule.publish.getTime()) break;
      const text = [`#DONTSKIP — ${schedule.date} (UTC)`,
        "Select 2 stories. Tap again to deselect. Publication at 19:00 UTC. If fewer than two stories are selected, the bot fills the remaining slots with the highest overall scores. To cancel today's digest, use the button at the end of the list.", '',
        ...items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((item, index) =>
          `${page * PAGE_SIZE + index + 1}. <a href="${escapeHtml(item.url)}">${escapeHtml(item.title.slice(0, 250))}</a>`),
      ].join('\n\n');
      const message = await notify(text, { parse_mode: 'HTML', disable_web_page_preview: true,
        reply_markup: keyboard(schedule.date, items, digest.selectedIds, page) });
      digest = await prisma.dailyDigest.update({ where: { date: schedule.date },
        data: { reviewMessageIds: { push: message.message_id } } });
    }
    return;
  }
  // Older saved candidate snapshots did not include scores. Enrich only those
  // snapshots, keeping the original candidate list and publication window.
  if (digest.selectedIds.length < 2 && items.some(item => item.score === undefined)) {
    const scores = await prisma.article.findMany({ where: { id: { in: items.map(item => item.id) } },
      select: { id: true, score: true } });
    const byId = new Map(scores.map(item => [item.id, item.score]));
    items = items.map(item => ({ ...item, score: item.score === undefined ? byId.get(item.id) ?? null : item.score }));
  }
  const selected = selectDigestCandidates(items, digest.selectedIds);
  if (selected.length !== 2) {
    const result = await prisma.dailyDigest.updateMany({ where: { date: schedule.date, status: 'OPEN' },
      data: { status: 'SKIPPED' } });
    if (result.count) await notify("Not enough selected or scored stories to complete today's #DONTSKIP digest. The digest has been skipped.");
    return;
  }
  // Render before claiming delivery, so a rendering failure/crash can be retried safely.
  const caption = digestCaption(selected);
  const photo = await generateDontSkipImage({ firstHeadline: selected[0].title,
    secondHeadline: selected[1].title, date: schedule.start });
  const claimed = await prisma.dailyDigest.updateMany({ where: { date: schedule.date, status: 'OPEN', version: digest.version },
    data: { status: 'PUBLISHING', selectedIds: selected.map(item => item.id), candidates: items.map(item => ({
      id: item.id, title: item.title, url: item.url, score: item.score ?? null,
    })) } });
  if (!claimed.count) return;
  // Never retry an ambiguous send automatically: Telegram has no idempotency key.
  // PUBLISHING remains available for manual reconciliation after a crash/timeout.
  try {
    const messageId = await sendDigestPhoto(photo, caption);
    await prisma.dailyDigest.update({ where: { date: schedule.date },
      data: { status: 'PUBLISHED', telegramMessageId: messageId } });
  } catch (error) {
    await notify('Could not confirm #DONTSKIP publication. Check the channel before sending again.');
    throw error;
  }
}
