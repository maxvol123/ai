import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { generateDontSkipImage, layoutHeadline } from '../services/dontskip-image';

async function main() {
  const firstHeadline = process.argv[2] ?? 'CHATGPT STORAGE SCALES FOR 1B USERS';
  const secondHeadline = process.argv[3] ?? 'GMAIL DATA MAY POWER AD TARGETING';
  const output = path.resolve('exports/dontskip-editorial-preview.png');
  const image = await generateDontSkipImage({ firstHeadline, secondHeadline,
    firstKicker: process.argv[4] ?? 'OPENAI', secondKicker: process.argv[5] ?? 'GOOGLE',
    date: new Date('2026-10-23T00:00:00Z') });
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, image);
  for (const [index, headline] of [firstHeadline, secondHeadline].entries()) {
    const { lines, fontSize } = await layoutHeadline(headline, index ? 'secondary' : 'primary');
    console.log(`${fontSize}px: ${lines.join(' / ')}`);
  }
  console.log(output);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
