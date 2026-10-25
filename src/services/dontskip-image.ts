import sharp, { OverlayOptions } from 'sharp';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { escapeHtml } from './telegram-caption';

export const LAYOUT = {
  canvas: { width: 1200, height: 1200 }, left: 110, right: 1090,
  story1: { kickerY: 125, line1Y: 190, line2Y: 255 },
  dontSkip: { y: 430 },
  story2: { kickerY: 600, line1Y: 665, line2Y: 730 },
  story1Number: { x: 1030, y: 185 },
  story1Label: { x: 1030, y: 229 },
  story2Number: { x: 1030, y: 650 },
  story2Label: { x: 1030, y: 694 },
  logo: { centerX: 600, y: 960 }, date: { y: 1095 },
} as const;

export const TYPE = {
  kicker: { size: 24, weight: 700, letterSpacing: 5, fill: '#7A8A84' },
  headlinePrimary: { size: 62, weight: 800, lineHeight: 72, fill: '#F5F5F5' },
  headlineSecondary: { size: 51, weight: 750, lineHeight: 64, fill: '#F5F5F5' },
  dontSkip: { size: 88, weight: 900 },
  storyNumber: { size: 140, weight: 800, fill: '#FFFFFF', opacity: 0.12 },
  storyLabel: { size: 18, weight: 700, letterSpacing: 2, fill: '#6F7D78', opacity: 0.75 },
  date: { size: 24, weight: 500, fill: '#A6B2AC' },
} as const;

const FONT = 'DejaVu Sans, Arial, sans-serif';
type Variant = 'primary' | 'secondary';

async function measure(text: string, size: number, weight: number) {
  const svg = `<svg width="2400" height="128" xmlns="http://www.w3.org/2000/svg">
    <text x="4" y="90" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="#F5F5F5">${escapeHtml(text)}</text></svg>`;
  return sharp(Buffer.from(svg)).trim().png().toBuffer({ resolveWithObject: true });
}

/** Display copy is written separately; wrapping must never truncate a claim. */
export async function layoutHeadline(headline: string, variant: Variant = 'primary') {
  const text = headline.trim().replace(/\s+/gu, ' ').toUpperCase();
  if (!text) throw new Error('Digest headline cannot be empty');
  if (text.length > 56) throw new Error('Digest display headline is too long (maximum 56 characters)');
  const words = text.split(' ');
  const type = variant === 'primary' ? TYPE.headlinePrimary : TYPE.headlineSecondary;
  const width = LAYOUT.right - LAYOUT.left;
  for (let fontSize = type.size; fontSize >= type.size - 6; fontSize -= 2) {
    const cache = new Map<string, Awaited<ReturnType<typeof measure>>>();
    const render = async (line: string) => {
      if (!cache.has(line)) cache.set(line, await measure(line, fontSize, type.weight));
      return cache.get(line)!;
    };
    const possibilities = [[text], ...words.slice(1).map((_, i) =>
      [words.slice(0, i + 1).join(' '), words.slice(i + 1).join(' ')])];
    let best: { lines: string[]; rendered: Awaited<ReturnType<typeof measure>>[]; cost: number } | undefined;
    for (const lines of possibilities) {
      if (lines.length === 2 && (/\b\d[\d,.]*$/u.test(lines[0]) && /^(?:BILLION|MILLION|USERS|TOKENS)\b/u.test(lines[1]) ||
          /\bGOOGLE$/u.test(lines[0]) && /^(?:PHOTOS|CLOUD|DRIVE|SEARCH|DEEPMIND)\b/u.test(lines[1]))) continue;
      const rendered = await Promise.all(lines.map(render));
      if (rendered.some(line => line.info.width > width)) continue;
      const cost = lines.length === 1 ? 0 : (rendered[0].info.width - rendered[1].info.width) ** 2 +
        lines.reduce((sum, line) => sum + Math.max(0, line.length - 24) ** 2 * 100, 0);
      if (!best || cost < best.cost) best = { lines, rendered, cost };
    }
    if (best) return { ...best, fontSize };
  }
  throw new Error('Digest display headline cannot fit in two readable lines');
}

async function storySvg(headline: string, kicker: string, variant: Variant) {
  const layout = await layoutHeadline(headline, variant);
  const position = variant === 'primary' ? LAYOUT.story1 : LAYOUT.story2;
  const type = variant === 'primary' ? TYPE.headlinePrimary : TYPE.headlineSecondary;
  const label = kicker.trim().replace(/\s+/gu, ' ').toUpperCase();
  if (!label || label.length > 22) throw new Error('Digest kicker must have 1–22 characters');
  return `<text x="${LAYOUT.left}" y="${position.kickerY}" font-size="${TYPE.kicker.size}" font-weight="${TYPE.kicker.weight}" letter-spacing="${TYPE.kicker.letterSpacing}" fill="${TYPE.kicker.fill}">${escapeHtml(label)}</text>` +
    layout.lines.map((line, index) => `<text x="${LAYOUT.left}" y="${index ? position.line2Y : position.line1Y}" font-size="${layout.fontSize}" font-weight="${type.weight}" fill="${type.fill}">${escapeHtml(line)}</text>`).join('');
}

export async function generateDontSkipImage(params: {
  firstHeadline: string; secondHeadline: string; firstKicker?: string; secondKicker?: string; date: Date;
}): Promise<Buffer> {
  const templatePath = path.resolve(process.env.DONTSKIP_TEMPLATE_PATH ?? 'assets/dontskip-background.png');
  let background: Buffer;
  try {
    await access(templatePath);
    const metadata = await sharp(templatePath).metadata();
    if (!metadata.width || metadata.width !== metadata.height) throw new Error('DONTSKIP template must be square');
    background = await sharp(templatePath).resize(1200, 1200).png().toBuffer();
  } catch (error) {
    if (process.env.DONTSKIP_TEMPLATE_PATH) {
      if (error instanceof Error && error.message.includes('must be square')) throw error;
      throw new Error(`Cannot read DONTSKIP_TEMPLATE_PATH: ${templatePath}`, { cause: error });
    }
    background = await sharp(Buffer.from(`<svg width="1200" height="1200" xmlns="http://www.w3.org/2000/svg"><rect width="1200" height="1200" fill="black"/><ellipse cx="600" cy="1380" rx="900" ry="310" fill="#04110e" stroke="#28F5A5" stroke-width="4"/></svg>`)).png().toBuffer();
  }
  const date = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(params.date);
  const first = await storySvg(params.firstHeadline, params.firstKicker ?? 'TOP STORY', 'primary');
  const second = await storySvg(params.secondHeadline, params.secondKicker ?? 'ALSO TODAY', 'secondary');
  const logoPath = path.resolve(process.env.DONTSKIP_LOGO_PATH ?? 'assets/tikrd-logo.png');
  let logo: Buffer | undefined;
  try { logo = await sharp(logoPath).resize(240, 125, { fit: 'inside' }).png().toBuffer(); } catch (error) {
    if (process.env.DONTSKIP_LOGO_PATH) throw new Error(`Cannot read DONTSKIP_LOGO_PATH: ${logoPath}`, { cause: error });
  }
  const svg = `<svg width="1200" height="1200" xmlns="http://www.w3.org/2000/svg" font-family="${FONT}">
    <g text-anchor="middle">
      <g font-size="${TYPE.storyNumber.size}" font-weight="${TYPE.storyNumber.weight}" fill="${TYPE.storyNumber.fill}" opacity="${TYPE.storyNumber.opacity}">
        <text x="${LAYOUT.story1Number.x}" y="${LAYOUT.story1Number.y}">01</text>
        <text x="${LAYOUT.story2Number.x}" y="${LAYOUT.story2Number.y}">02</text>
      </g>
      <g font-size="${TYPE.storyLabel.size}" font-weight="${TYPE.storyLabel.weight}" letter-spacing="${TYPE.storyLabel.letterSpacing}" fill="${TYPE.storyLabel.fill}" opacity="${TYPE.storyLabel.opacity}">
        <text x="${LAYOUT.story1Label.x}" y="${LAYOUT.story1Label.y}">TOP STORY</text>
        <text x="${LAYOUT.story2Label.x}" y="${LAYOUT.story2Label.y}">SECOND STORY</text>
      </g>
    </g>
    <rect x="92" y="110" width="4" height="155" rx="2" fill="#28F5A5" opacity="0.8"/>
    <rect x="92" y="${LAYOUT.story2.kickerY - 15}" width="4" height="150" rx="2" fill="#28F5A5" opacity="0.5"/>
    ${first}
    <text x="${LAYOUT.left}" y="${LAYOUT.dontSkip.y}" font-size="${TYPE.dontSkip.size}" font-weight="${TYPE.dontSkip.weight}"><tspan fill="#F5F5F5">#DONT</tspan><tspan fill="#28F5A5">SKIP</tspan></text>
    ${second}
    ${logo ? '' : '<text x="600" y="975" text-anchor="middle" font-size="30" font-weight="700" fill="#89938F">TIKRD AI NEWS</text>'}
    <text x="600" y="${LAYOUT.date.y}" text-anchor="middle" font-size="${TYPE.date.size}" font-weight="${TYPE.date.weight}" fill="${TYPE.date.fill}">${escapeHtml(date)}</text>
  </svg>`;
  const overlays: OverlayOptions[] = [{ input: Buffer.from(svg), left: 0, top: 0 }];
  if (logo) {
    const meta = await sharp(logo).metadata();
    overlays.push({ input: logo, left: Math.round(LAYOUT.logo.centerX - meta.width! / 2),
      top: Math.round(LAYOUT.logo.y - meta.height! / 2) });
  }
  return sharp(background).composite(overlays).png().toBuffer();
}
