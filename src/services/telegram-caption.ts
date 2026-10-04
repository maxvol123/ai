export const TELEGRAM_CAPTION_TARGET_MIN = 650;
export const TELEGRAM_CAPTION_TARGET_MAX = 850;
export const TELEGRAM_CAPTION_HARD_MAX = 900;

export function validateTelegramCaption(post: string) {
  return { valid: post.trim().length > 0 && post.length <= TELEGRAM_CAPTION_HARD_MAX,
    length: post.length, maxLength: TELEGRAM_CAPTION_HARD_MAX };
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderCaption(post: string, source: string, articleUrl: string): string {
  const url = new URL(articleUrl);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid article source URL');
  const lines = post.split('\n');
  if (lines.filter(line => line.startsWith('Source:')).length !== 1) {
    throw new Error('Caption must contain exactly one Source line');
  }
  return lines.map(line => line.startsWith('Source:')
    ? `Source: <a href="${escapeHtml(url.toString())}">${escapeHtml(source)}</a>`
    : escapeHtml(line)).join('\n');
}

/** Check saved HTML without normalizing or rewriting any reviewed character. */
export function assertSafeSavedCaption(post: string, source: string, articleUrl: string): void {
  if (!validateTelegramCaption(post).valid) throw new Error('Invalid saved caption length');
  const sourceLine = renderCaption('Source: placeholder', source, articleUrl);
  const lines = post.split('\n');
  if (lines.filter(line => line === sourceLine).length !== 1) {
    throw new Error('Saved draft needs a new review with a valid Source link');
  }
  const text = lines.filter(line => line !== sourceLine).join('\n');
  if (/[<>]|&(?!amp;|lt;|gt;|quot;)/.test(text)) {
    throw new Error('Saved draft contains unsafe HTML; request a new review');
  }
}
