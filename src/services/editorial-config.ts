export const REVIEW_THRESHOLD = 6.5;

export function editorialModels() {
  return {
    screening: process.env.SCREENING_MODEL?.trim() || 'gpt-5.6-luna',
    ranking: process.env.RANKING_MODEL?.trim() || 'gpt-5.6-terra',
  };
}

export function qualifiesForReview(score: number | null | undefined): boolean {
  return typeof score === 'number' && Number.isFinite(score) && score >= REVIEW_THRESHOLD;
}
