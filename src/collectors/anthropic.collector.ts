import { collectHtmlNews } from './html.collector';

export function collectAnthropic() {
  return collectHtmlNews({
    source: 'Anthropic',
    url: 'https://www.anthropic.com/news',
    articlePath: '/news',
  });
}
