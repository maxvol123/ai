declare module 'rss-parser' {
  interface FeedItem {
    title?: string;
    link?: string;
    contentSnippet?: string;
    pubDate?: string;
  }

  interface Feed {
    items: FeedItem[];
  }

  export default class Parser {
    parseURL(url: string): Promise<Feed>;
  }
}
