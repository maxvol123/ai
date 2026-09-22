import { ArticleAnalysis } from './analysis.service';
import { Source } from '../types/source';

export interface RankingResult {
  score: number;
  sourceAuthority: number;
  recommendedForPublish: boolean;
}

export const sources: Record<string, Source> = {
  OpenAI: { name: 'OpenAI', type: 'OFFICIAL', authority: 10, enabled: true },
  Anthropic: { name: 'Anthropic', type: 'OFFICIAL', authority: 10, enabled: true },
  'Google DeepMind': { name: 'Google DeepMind', type: 'OFFICIAL', authority: 10, enabled: true },
  'Google AI / Gemini': { name: 'Google AI / Gemini', type: 'OFFICIAL', authority: 10, enabled: true },
  'Meta AI': { name: 'Meta AI', type: 'OFFICIAL', authority: 10, enabled: true },
  xAI: { name: 'xAI', type: 'OFFICIAL', authority: 10, enabled: true },
  Mistral: { name: 'Mistral', type: 'OFFICIAL', authority: 10, enabled: true },
  'Microsoft AI': { name: 'Microsoft AI', type: 'OFFICIAL', authority: 10, enabled: true },
  NVIDIA: { name: 'NVIDIA', type: 'OFFICIAL', authority: 10, enabled: true },
  'Hugging Face': { name: 'Hugging Face', type: 'OFFICIAL', authority: 10, enabled: true },
  Perplexity: { name: 'Perplexity', type: 'OFFICIAL', authority: 10, enabled: true },
  Cohere: { name: 'Cohere', type: 'OFFICIAL', authority: 10, enabled: true },
  'Stability AI': { name: 'Stability AI', type: 'OFFICIAL', authority: 10, enabled: true },
  Reuters: { name: 'Reuters', type: 'MEDIA', authority: 9, enabled: true },
  TechCrunch: { name: 'TechCrunch', type: 'MEDIA', authority: 8, enabled: true },
  'TechCrunch AI': { name: 'TechCrunch AI', type: 'MEDIA', authority: 8, enabled: true },
  'The Verge AI': { name: 'The Verge AI', type: 'MEDIA', authority: 8, enabled: true },
  'Ars Technica': { name: 'Ars Technica', type: 'MEDIA', authority: 8, enabled: true },
  'VentureBeat AI': { name: 'VentureBeat AI', type: 'MEDIA', authority: 8, enabled: true },
  'MIT Technology Review': { name: 'MIT Technology Review', type: 'MEDIA', authority: 9, enabled: true },
  Wired: { name: 'Wired', type: 'MEDIA', authority: 8, enabled: true },
  'Reuters Tech/AI': { name: 'Reuters Tech/AI', type: 'MEDIA', authority: 9, enabled: true },
  'Hugging Face Papers': { name: 'Hugging Face Papers', type: 'RESEARCH', authority: 8, enabled: true },
  'arXiv cs.AI': { name: 'arXiv cs.AI', type: 'RESEARCH', authority: 8, enabled: true },
  'arXiv cs.LG': { name: 'arXiv cs.LG', type: 'RESEARCH', authority: 8, enabled: true },
  'arXiv cs.CL': { name: 'arXiv cs.CL', type: 'RESEARCH', authority: 8, enabled: true },
  'random blog': { name: 'random blog', type: 'MEDIA', authority: 5, enabled: true },
  'Telegram repost': { name: 'Telegram repost', type: 'SOCIAL', authority: 3, enabled: true },
};

export function getSourceAuthority(source: string): number {
  return sources[source]?.authority ?? 5;
}

export function rankArticle(
  source: string,
  analysis: ArticleAnalysis,
): RankingResult {
  const sourceAuthority = getSourceAuthority(source);
  const weightedScore =
    analysis.impact * 0.3 +
    analysis.novelty * 0.2 +
    analysis.reach * 0.2 +
    analysis.expectedAttention * 0.15 +
    sourceAuthority * 0.15;
  const confidenceMultiplier = 0.5 + analysis.confidence / 200;
  const score = Number(Math.min(10, weightedScore * confidenceMultiplier).toFixed(2));

  return {
    score,
    sourceAuthority,
    recommendedForPublish: score >= 7,
  };
}
