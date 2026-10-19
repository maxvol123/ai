import sharp from 'sharp';
import path from 'node:path';
import { access } from 'node:fs/promises';
import { escapeHtml } from './telegram-caption';

export function wrapHeadline(text: string, maxChars = 32): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.trim().split(/\s+/u)) {
    // Split unusually long tokens too, so they cannot run off the canvas.
    for (const chunk of word.match(new RegExp(`.{1,${maxChars}}`, 'gu')) ?? []) {
      const next = current ? `${current} ${chunk}` : chunk;
      if (next.length > maxChars && current) { lines.push(current); current = chunk; }
      else current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length > 3 ? [...lines.slice(0, 2), lines[2].slice(0, maxChars - 1).trimEnd() + '…'] : lines;
}

function renderLines(headline: string, startY: number): string {
  return wrapHeadline(headline).map((line, index) =>
    `<text x="600" y="${startY + index * 70}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="58" font-weight="700" fill="#ffffff">${escapeHtml(line)}</text>`).join('');
}

export async function generateDontSkipImage(params: {
  firstHeadline: string; secondHeadline: string; date: Date;
}): Promise<Buffer> {
  const date = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC',
  }).format(params.date);
  const templatePath = path.resolve(process.env.DONTSKIP_TEMPLATE_PATH ?? 'assets/dontskip-template.png');
  let hasTemplate = false;
  try { await access(templatePath); hasTemplate = true; } catch {
    if (process.env.DONTSKIP_TEMPLATE_PATH) throw new Error(`Cannot read DONTSKIP_TEMPLATE_PATH: ${templatePath}`);
  }
  const dateSvg = `<text x="600" y="1180" text-anchor="middle" font-family="Consolas, Liberation Mono, DejaVu Sans Mono, monospace" font-size="26" font-weight="400" letter-spacing="1.5" fill="#7e8f89">${escapeHtml(date)}</text>`;
  if (hasTemplate) {
    const metadata = await sharp(templatePath).metadata();
    if (!metadata.width || metadata.width !== metadata.height) {
      throw new Error('DONTSKIP template must be square');
    }
    const headlinesSvg = `<svg width="1200" height="1200" xmlns="http://www.w3.org/2000/svg">
      ${renderLines(params.firstHeadline, 260)}
      ${renderLines(params.secondHeadline, 780)}
      ${dateSvg}
    </svg>`;
    return sharp(templatePath)
      .resize(1200, 1200)
      .composite([{ input: Buffer.from(headlinesSvg), top: 0, left: 0 }])
      .png().toBuffer();
  }
  const logoPath = path.resolve(process.env.DONTSKIP_LOGO_PATH ?? 'assets/tikrd-logo.png');
  let hasLogo = false;
  try { await access(logoPath); hasLogo = true; } catch {
    if (process.env.DONTSKIP_LOGO_PATH) throw new Error(`Cannot read DONTSKIP_LOGO_PATH: ${logoPath}`);
  }
  const svg = `<svg width="1200" height="1200" xmlns="http://www.w3.org/2000/svg">
    <rect width="1200" height="1200" fill="#030303"/>
    ${renderLines(params.firstHeadline, 260)}
    <text x="600" y="540" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="130" font-weight="900" fill="#ffffff">#DONT</text>
    <text x="600" y="660" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="130" font-weight="900" fill="#28f5a5">SKIP</text>
    ${renderLines(params.secondHeadline, 780)}
    <ellipse cx="600" cy="1310" rx="720" ry="300" fill="#04110e" stroke="#27f4b0" stroke-width="8"/>
    <ellipse cx="600" cy="1285" rx="680" ry="270" fill="none" stroke="#27f4b0" stroke-width="2" opacity="0.45"/>
    ${dateSvg}
    ${hasLogo ? '' : '<text x="600" y="1135" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="700" fill="#ffffff">TIKRD</text>'}
  </svg>`;
  const image = sharp(Buffer.from(svg));
  if (hasLogo) {
    const logo = await sharp(logoPath).resize(120, 90, { fit: 'inside' }).png().toBuffer();
    const metadata = await sharp(logo).metadata();
    image.composite([{ input: logo, left: Math.round((1200 - metadata.width!) / 2), top: 1070 }]);
  }
  return image.png().toBuffer();
}
