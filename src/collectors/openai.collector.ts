import { collectRSS } from './rss.collector';

export function collectOpenAI() {
  return collectRSS('OpenAI', 'https://openai.com/news/rss.xml');
}
