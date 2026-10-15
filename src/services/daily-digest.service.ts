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
  return { inline_keyboard: items.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((item, index) => [{
    text: `${selected.includes(item.id) ? '✅' : '▫️'} ${page * PAGE_SIZE + index + 1}. ${item.title.slice(0, 65)}`,
    callback_data: `digest:${date}:${page * PAGE_SIZE + index}`,
  }]) };
}

async function notify(text: string, extra: Record<string, unknown> = {}) {
  if (!process.env.CHAT_ID) throw new Error('CHAT_ID must be set');
  return telegramRequest<{ message_id: number }>('sendMessage', {
    chat_id: process.env.CHAT_ID, text, ...extra,
  });
}

export async function handleDigestCallback(callback: TelegramCallbackQuery, now = new Date()): Promise<string> {
  if (String(callback.message?.chat?.id) !== process.env.CHAT_ID) return 'Выбор доступен только в чате владельца';
  const match = callback.data?.match(/^digest:(\d{4}-\d{2}-\d{2}):(\d+)$/);
  if (!match) return 'Неизвестная новость';
  const [, date, index] = match;
  const schedule = digestSchedule(now);
  if (date !== schedule.date || now < schedule.selection || now >= schedule.publish) return 'Выбор завершён';
  const digest = await prisma.dailyDigest.findUnique({ where: { date } });
  if (!digest || digest.status !== 'OPEN' || !digest.reviewMessageIds.includes(callback.message!.message_id)) return 'Выбор недоступен';
  const items = digest.candidates as unknown as DigestCandidate[];
  const item = items[Number(index)];
  if (!item) return 'Новость не найдена';
  let selected = digest.selectedIds;
  if (selected.includes(item.id)) selected = selected.filter(id => id !== item.id);
  else {
    if (selected.length >= 2) return 'Уже выбраны две новости. Сначала снимите одну галочку';
    selected = [...selected, item.id];
  }
  const result = await prisma.dailyDigest.updateMany({
    where: { date, status: 'OPEN', version: digest.version },
    data: { selectedIds: selected, version: { increment: 1 } },
  });
  if (!result.count) return 'Выбор изменился, нажмите ещё раз';
  // The saved selection remains valid even if Telegram cannot refresh a keyboard.
  try {
    const page = Math.floor(Number(index) / PAGE_SIZE);
    await telegramRequest('editMessageReplyMarkup', { chat_id: process.env.CHAT_ID,
      message_id: callback.message!.message_id, reply_markup: keyboard(date, items, selected, page) });
  } catch (error) { console.warn('[digest] Could not refresh selection keyboard', error); }
  return `Выбрано ${selected.length}/2. Публикация в 19:00 UTC`;
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
      await notify('Сегодня до 18:50 UTC опубликовано меньше двух новостей. Выпуск #DONTSKIP пропущен.');
    }
  }
  if (!digest || digest.status !== 'OPEN') return;
  let items = digest.candidates as unknown as DigestCandidate[];
  if (now < schedule.publish) {
    for (let page = digest.reviewMessageIds.length; page < Math.ceil(items.length / PAGE_SIZE); page++) {
      if (now.getTime() + Date.now() - startedAt >= schedule.publish.getTime()) break;
      const text = [`#DONTSKIP — ${schedule.date} (UTC)`,
        'Выберите 2 новости. Повторное нажатие снимает выбор. Публикация в 19:00 UTC. Если выбрано меньше двух, бот доберёт новости с самым высоким общим score.', '',
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
    if (result.count) await notify('Недостаточно выбранных новостей и новостей с общей оценкой для автоматического выбора. Сегодняшний #DONTSKIP пропущен.');
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
    await notify('Не удалось подтвердить публикацию #DONTSKIP. Проверьте канал перед повторной отправкой.');
    throw error;
  }
}
