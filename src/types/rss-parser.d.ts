declare module 'rss-parser' {
  interface FeedItem {
    [key: string]: unknown;
    title?: string;
    link?: string;
    contentSnippet?: string;
    pubDate?: string;
  }

  interface Feed {
    items: FeedItem[];
  }

  export default class Parser {
    constructor(options?: { customFields?: { item?: Array<string | [string, string, { keepArray: boolean }]> } });
    parseURL(url: string): Promise<Feed>;
    parseString(xml: string): Promise<Feed>;
  }
}
