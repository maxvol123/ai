export interface Article {
  source: string;
  title: string;
  url: string;
  description?: string | null;
  content?: string | null;
  publishedAt?: Date | null;
}

export interface StoredArticle extends Article {
  id: string;
}
