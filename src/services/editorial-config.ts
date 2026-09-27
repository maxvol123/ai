export const FINAL_EDITOR_THRESHOLD = 6.5;

export function editorialModels() {
  return {
    screening: process.env.SCREENING_MODEL?.trim() || 'gpt-5.6-luna',
    ranking: process.env.RANKING_MODEL?.trim() || 'gpt-5.6-terra',
    finalEditor: process.env.FINAL_EDITOR_MODEL?.trim() || 'gpt-5.6-sol',
  };
}

export function qualifiesForFinalEditor(score: number | null | undefined): boolean {
  return typeof score === 'number' && Number.isFinite(score) && score >= FINAL_EDITOR_THRESHOLD;
}
