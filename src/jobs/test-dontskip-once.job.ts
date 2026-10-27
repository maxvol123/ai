import 'dotenv/config';
import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '../db/prisma';
import { DigestCandidate, digestCaption, digestImageHeadline, selectDigestCandidates } from '../services/daily-digest.service';
import { generateDigestDisplay } from '../services/dontskip-copy.service';
import { generateDontSkipImage, layoutHeadline } from '../services/dontskip-image';
import { sendDigestPhoto } from '../services/telegram.service';

/** Read today's stories, render once and send a test to the owner, without changing the scheduled issue. */
export async function runDontSkipOnce(options: {
  date?: string; localOnly?: boolean; sample?: boolean; output?: string;
} = {}) {
  const date = options.date ?? new Date().toISOString().slice(0, 10);
  const start = new Date(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(start.getTime()) || start.toISOString().slice(0, 10) !== date) {
    throw new Error('Use --date YYYY-MM-DD (UTC)');
  }
  const chatId = process.env.CHAT_ID;
  if (!options.localOnly && (!chatId || !process.env.HTTPAPI_TG)) {
    throw new Error('CHAT_ID and HTTPAPI_TG are required; use --local-only to save PNG without Telegram');
  }
  let selected: DigestCandidate[];
  if (options.sample) {
    selected = [
      { id: 'sample-1', title: 'Cohere says Qwen tried to send file to Beijing', url: 'https://example.com/1',
        display: { kicker: 'COHERE', displayHeadline: 'SAYS QWEN TRIED TO SEND FILE TO BEIJING' } },
      { id: 'sample-2', title: 'LFM3: build specialized multimodal models', url: 'https://example.com/2',
        display: { kicker: 'LFM3', displayHeadline: 'BUILD SPECIALIZED MULTIMODAL MODELS' } },
    ];
    console.log('[digest:test] Using screenshot sample; no database or model requests');
  } else {
    const saved = await prisma.dailyDigest.findUnique({ where: { date } });
    let candidates = saved?.candidates as unknown as DigestCandidate[] | undefined;
    if (!candidates?.length) {
      const articles = await prisma.article.findMany({
        where: { status: 'PUBLISHED', telegramMessageId: { not: null },
          channelPublishedAt: { gte: start, lt: new Date(start.getTime() + 86_400_000) } },
        orderBy: [{ channelPublishedAt: 'asc' }, { id: 'asc' }],
        select: { id: true, title: true, url: true, score: true, telegramPost: true },
      });
      candidates = articles.map(article => ({ ...article,
        imageHeadline: digestImageHeadline(article.title, article.telegramPost) }));
    }
    selected = selectDigestCandidates(candidates, saved?.selectedIds ?? []);
    if (selected.length !== 2) {
      throw new Error(`Not enough selected or scored published stories for ${date}. Use --sample to test the screenshot layout without articles.`);
    }
    console.log(`[digest:test] ${date} UTC; saved issue: ${saved?.status ?? 'none'}; stories: ${selected.map(item => item.id).join(', ')}`);
    const reusable = await Promise.all(selected.map(async (item, index) => {
      if (!item.display) return false;
      try {
        await layoutHeadline(item.display.displayHeadline, index ? 'secondary' : 'primary');
        return true;
      } catch { return false; }
    }));
    if (reusable.some(valid => !valid)) {
      const copy = await generateDigestDisplay(selected);
      selected = selected.map((item, index) => ({ ...item, display: copy[index] }));
    }
  }
  console.log(`[digest:test] cwd: ${process.cwd()}`);
  console.log(`[digest:test] template: ${path.resolve(process.env.DONTSKIP_TEMPLATE_PATH ?? path.join(__dirname, '../../assets/dontskip-background.png'))}`);
  selected.forEach(item => console.log(`[digest:test] ${item.display!.kicker}: ${item.display!.displayHeadline}`));
  const photo = await generateDontSkipImage({
    firstHeadline: selected[0].display!.displayHeadline, firstKicker: selected[0].display!.kicker,
    secondHeadline: selected[1].display!.displayHeadline, secondKicker: selected[1].display!.kicker, date: start,
  });
  const output = path.resolve(options.output ?? `exports/dontskip-test-${date}-${Date.now()}.png`);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, photo);
  console.log(`[digest:test] Saved: ${output}`);
  let messageId: number | undefined;
  if (!options.localOnly) {
    messageId = await sendDigestPhoto(photo, `TEST — ${date} UTC\n\n${digestCaption(selected)}`, chatId!);
    console.log(`[digest:test] Sent to CHAT_ID; message ${messageId}`);
  }
  return { output, messageId };
}

if (require.main === module) {
  Promise.resolve().then(async () => {
    const { values } = parseArgs({ options: {
      date: { type: 'string' }, output: { type: 'string' },
      'local-only': { type: 'boolean' }, sample: { type: 'boolean' }, help: { type: 'boolean' },
    } });
    if (values.help) {
      console.log('npm run digest:test -- [--date YYYY-MM-DD] [--sample] [--local-only] [--output file.png]\nDefault: render the UTC day once and send a TEST photo to CHAT_ID. No database writes or channel publication.');
      return;
    }
    await runDontSkipOnce({ date: values.date, output: values.output,
      localOnly: values['local-only'], sample: values.sample });
  }).catch((error: unknown) => {
    console.error('[digest:test] Failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }).finally(async () => { await prisma.$disconnect(); });
}
