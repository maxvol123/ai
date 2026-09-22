import OpenAI from 'openai';

const client = new OpenAI({ apiKey: process.env.OPENAI_API });
const MAX_POST_WORDS = 180;

const instructions = `You are the senior writer for an English-language Telegram channel covering the most important developments in artificial intelligence.

Turn a verified AI news item into a concise, high-quality Telegram post for people interested in AI, technology, startups, research, developers, and the AI industry.

Write like a modern technology news publication: factual, sharp, concise, informative, easy to scan on mobile, professional but not corporate, and interesting without clickbait. Do not sound like an AI assistant. Avoid hype, unnecessary adjectives, and phrases such as "This groundbreaking development" or "This marks a significant milestone." Do not exaggerate claims; attribute allegations, predictions, estimates, and opinions.

Structure the post exactly as follows:
1. A one-sentence headline with no period. State the most important concrete development immediately.
2. One or two short paragraphs explaining what happened, who is involved, important numbers, product names, dates, technical details, and necessary context. Do not repeat the headline.
3. A new paragraph beginning exactly "Why it matters:" and explaining concrete broader significance. Mention limitations or uncertainty briefly when needed.
4. End with exactly "Source: {source_name}". Do not include the raw URL.
5. After the Source line, add one blank line and 3–6 story-specific hashtags on one line. Use no more than six; do not use unrelated tags, #News, or #BreakingNews unless genuinely breaking.

Target 100–180 words excluding hashtags. Major stories may use up to 220; minor stories 80–120. Use plain Telegram-friendly text, short paragraphs, no emojis, no bullets, and no headings except "Why it matters:" and "Source:". Do not mention internal editorial analysis, scores, confidence, recommendations, event IDs, or categorization. Use exact names and numbers from supplied material only. Never invent quotations, statistics, or facts.

Return only the finished Telegram post.`;

export interface TelegramWriterArticle {
  source: string;
  title: string;
  description: string | null;
  content: string | null;
  summary: string | null;
  whyItMatters: string | null;
  category: string | null;
  event: { title: string; summary: string } | null;
}

function limitPostWords(post: string): string {
  const paragraphs = post.trim().split(/\n\s*\n/).map((paragraph) => paragraph.trim());
  const sourceIndex = paragraphs.findIndex((paragraph) => paragraph.startsWith('Source:'));
  const body = sourceIndex === -1 ? paragraphs : paragraphs.slice(0, sourceIndex);
  const tail = sourceIndex === -1 ? [] : paragraphs.slice(sourceIndex);
  let remaining = MAX_POST_WORDS;

  const limitedBody = body
    .map((paragraph) => {
      if (remaining === 0) return '';
      const words = paragraph.split(/\s+/).filter(Boolean).slice(0, remaining);
      remaining -= words.length;
      return words.join(' ');
    })
    .filter(Boolean);

  return [...limitedBody, ...tail].join('\n\n');
}

export async function writeTelegramPost(article: TelegramWriterArticle): Promise<string> {
  if (!process.env.OPENAI_API) throw new Error('OPENAI_API is not set');

  const response = await client.responses.create({
    model: 'gpt-5.6',
    store: false,
    max_output_tokens: 600,
    instructions,
    input: `Source:\n${article.source}\n\nTitle:\n${article.title}\n\nArticle description/content:\n${article.content ?? article.description ?? ''}\n\nEditorial summary:\n${article.summary ?? ''}\n\nWhy it matters analysis:\n${article.whyItMatters ?? ''}\n\nCategory:\n${article.category ?? ''}\n\nKnown event context:\n${article.event ? `${article.event.title}: ${article.event.summary}` : ''}`,
  });

  if (!response.output_text) throw new Error('OpenAI returned an empty Telegram post');
  return limitPostWords(response.output_text);
}
