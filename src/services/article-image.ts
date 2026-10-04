import * as cheerio from 'cheerio';

export function normalizeImageUrl(raw: unknown, articleUrl: string): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const decoded = raw.trim().replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, entity =>
      cheerio.load(`<span>${entity}</span>`).text());
    const url = new URL(decoded, articleUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const path = decodeURIComponent(url.pathname).toLowerCase();
    if (/\.svg(?:$|\/)/.test(path) || /(?:^|[\/_.-])(?:favicon|icons?|logos?|avatars?|tracking|pixel|spacer)(?:[\/_.-]|$)/.test(path)) return null;
    if ([url.searchParams.get('format'), url.searchParams.get('fm')].includes('svg')) return null;
    return url.toString();
  } catch { return null; }
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function entries(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value == null ? [] : [value];
}

function dimensions(data: Record<string, unknown>): number {
  const width = Number(data.width);
  const height = Number(data.height);
  if ((width > 0 && width < 120) || (height > 0 && height < 80)) return -1;
  return width > 0 ? width : height > 0 ? height : 0;
}

export function imageValue(value: unknown, base: string): string | null {
  const found: Array<{ url: string; size: number }> = [];
  for (const entry of entries(value)) {
    const direct = normalizeImageUrl(entry, base);
    if (direct) { found.push({ url: direct, size: 0 }); continue; }
    const data = object(entry);
    const attributes = object(data.$);
    const size = dimensions({ ...data, ...attributes });
    if (size < 0) continue;
    for (const raw of [attributes.url, attributes.href, attributes.src, data.url, data.contentUrl, data.href, data.src, data._]) {
      for (const candidate of entries(raw)) {
        const url = normalizeImageUrl(candidate, base);
        if (url) found.push({ url, size });
      }
    }
  }
  return found.sort((a, b) => b.size - a.size)[0]?.url ?? null;
}

export function selectSrcset(raw: string | undefined, base: string): string | null {
  const candidates = (raw ?? '').replace(/data:[^\s]+(?:\s+\d+(?:\.\d+)?[wx])?/gi, '').split(',').flatMap(part => {
    const match = part.trim().match(/^(\S+)(?:\s+(\d+(?:\.\d+)?)(w|x))?$/);
    if (!match) return [];
    const url = normalizeImageUrl(match[1], base);
    const size = Number(match[2] ?? 1);
    if (!url || size <= 0 || (match[3] === 'w' && (size < 120 || size > 4096)) ||
        (match[3] === 'x' && size > 4)) return [];
    return [{ url, size }];
  });
  return candidates.sort((a, b) => b.size - a.size)[0]?.url ?? null;
}

export function extractEmbeddedImage(html: unknown, base: string): string | null {
  if (typeof html !== 'string') return null;
  const $ = cheerio.load(html);
  for (const element of $('img').toArray()) {
    if (dimensions(element.attribs) < 0) continue;
    const responsive = selectSrcset($(element).attr('srcset'), base);
    if (responsive) return responsive;
    for (const raw of [$(element).attr('data-src'), $(element).attr('data-lazy-src'), $(element).attr('src')]) {
      const url = normalizeImageUrl(raw, base);
      if (url) return url;
    }
  }
  return null;
}

/** Item-level imagery only; a feed/channel logo is not an article image. */
export function extractFeedImage(value: unknown, base: string): string | null {
  const item = object(value);
  const groups = entries(item['media:group']).map(object);
  for (const key of ['media:content', 'media:thumbnail']) {
    const candidates: unknown[] = [];
    for (const entry of [item[key], ...groups.map(group => group[key])].flatMap(entries)) {
      const data = object(entry);
      const attrs = Object.keys(object(data.$)).length ? object(data.$) : data;
      // Media RSS can also contain video/audio assets.
      if (typeof attrs.type === 'string' && !attrs.type.toLowerCase().startsWith('image/')) continue;
      if (typeof attrs.medium === 'string' && attrs.medium.toLowerCase() !== 'image') continue;
      if (typeof attrs.type === 'string' && attrs.type.toLowerCase().includes('svg')) continue;
      candidates.push(entry);
    }
    const url = imageValue(candidates, base);
    if (url) return url;
  }
  const enclosures: unknown[] = [];
  for (const entry of [...entries(item.enclosures ?? item.enclosure), ...entries(item.atomLinks)]) {
    const data = object(entry);
    const attrs = Object.keys(object(data.$)).length ? object(data.$) : data;
    if (attrs.rel !== undefined && attrs.rel !== 'enclosure') continue;
    if (typeof attrs.type !== 'string' || !attrs.type.toLowerCase().startsWith('image/')) continue;
    if (attrs.type.toLowerCase().includes('svg')) continue;
    enclosures.push(entry);
  }
  const enclosure = imageValue(enclosures, base);
  if (enclosure) return enclosure;
  for (const html of [item['content:encoded'], item.description ?? item.content, item.summary]) {
    const url = extractEmbeddedImage(html, base);
    if (url) return url;
  }
  // Preserve support for explicit item imagery after the specified RSS fields.
  for (const value of [item.imageUrl, item.image, object(item.itunes).image]) {
    const url = imageValue(value, base);
    if (url) return url;
  }
  return null;
}

export function extractJsonLdImage($: cheerio.CheerioAPI, base: string): string | null {
  const articles: Record<string, unknown>[] = [];
  const other: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 30 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(entry => visit(entry, depth + 1)); return; }
    const data = object(value);
    const types = entries(data['@type']).filter((type): type is string => typeof type === 'string');
    if (types.some(type => /Article|BlogPosting|Report|NewsPosting/i.test(type))) articles.push(data);
    else if (types.length === 0 || types.some(type => /WebPage|CreativeWork/i.test(type))) other.push(data);
    for (const nested of Object.values(data)) visit(nested, depth + 1);
  };
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    try { visit(JSON.parse($(script).text())); }
    catch { console.warn(`[image] url=${base} malformed JSON-LD ignored`); }
  }
  for (const data of [...articles, ...other]) {
    const url = imageValue(data.image, base) ?? imageValue(data.thumbnailUrl, base);
    if (url) return url;
  }
  return null;
}
