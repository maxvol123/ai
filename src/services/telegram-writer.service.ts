import { qualifiesForReview } from './editorial-config';

export interface TelegramWriterArticle {
  preliminaryScore: number | null;
  source: string;
  title: string;
  summary: string | null;
  whyItMatters: string | null;
}

// Ranking produces the publication facts; approval does not invoke another model.
export async function writeTelegramPost(article: TelegramWriterArticle): Promise<string> {
  if (!qualifiesForReview(article.preliminaryScore)) {
    throw new Error('Article does not qualify for writing; rerun ranking first');
  }
  return [
    article.title,
    article.summary,
    article.whyItMatters ? 'Why it matters: ' + article.whyItMatters : null,
    'Source: ' + article.source,
  ].filter(Boolean).join('\n\n');
}
