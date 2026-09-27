require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');

process.env.OPENAI_API = 'test-key';
const calls = [];
let preliminaryScore = 6.49;
let decision = 'PASS';
let similarity = 0.8;
let saved;
const analysis = { impact: 8, novelty: 8, reach: 8, expectedAttention: 8, confidence: 100,
  eventHint: 'Event', summary: 'Summary', category: 'AI', whyItMatters: 'Impact' };
function mock(path, exports) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
mock('../src/services/analysis.service', {
  screenArticle: async () => { calls.push('screen'); return { decision, reason: 'test' }; },
  preliminaryRankArticle: async (_, context) => {
    calls.push('preliminary');
    assert.equal(context.nearestEvents[0].title, 'Existing');
    return { ...analysis, impact: preliminaryScore };
  },
  finalRankArticle: async (_, context, score) => {
    calls.push('final');
    assert.ok(score >= 6.5);
    return analysis;
  },
  compareEvents: async () => 'SAME_EVENT',
  updateEventFromArticle: async () => ({ title: 'Event', summary: 'Summary' }),
});
mock('../src/services/article.service', {
  saveArticleScreening: async () => {}, saveArticleContent: async () => {},
  saveArticleAnalysis: async (...args) => { saved = args; },
});
mock('../src/services/article-content.service', { fetchArticleContent: async () => null });
mock('../src/services/embedding.service', {
  createEventEmbedding: async () => { calls.push('embedding'); return [1, 0]; },
});
mock('../src/services/event.service', {
  NEW_EVENT_SIMILARITY_THRESHOLD: 0.75, AUTO_ATTACH_SIMILARITY_THRESHOLD: 0.9,
  findNearestEvents: async () => { calls.push('lookup'); return [{ eventId: 'event', title: 'Existing', similarity }]; },
  getEventForComparison: async () => ({ title: 'Existing', summary: 'Previous facts' }),
  createEventForArticle: async () => 'new-event', attachArticleToEvent: async () => {},
  updateEventDetails: async () => {}, updateEventImportance: async () => {},
});
mock('../src/services/ranking.service', {
  rankArticle: (_, value) => ({ score: value.impact, sourceAuthority: 10, recommendedForPublish: value.impact >= 7 }),
});
const { processArticle } = require('../src/services/news-pipeline.service');
const article = { id: 'article', source: 'OpenAI', title: 'News', url: 'https://example.com' };

test('pipeline gates final ranking at 6.5 after embedding and event lookup', async () => {
  for (const candidate of [6.49, 6.5, 8]) {
    for (const match of [0.5, 0.8, 0.95]) {
      calls.length = 0;
      preliminaryScore = candidate;
      similarity = match;
      const result = await processArticle(article);
      assert.deepEqual(calls.slice(0, 4), ['screen', 'embedding', 'lookup', 'preliminary']);
      assert.equal(calls.includes('final'), candidate >= 6.5);
      assert.equal(result.kind, candidate >= 6.5 ? 'PROCESSED' : 'BELOW_PRELIMINARY_THRESHOLD');
      assert.equal(saved[3], candidate);
      assert.equal(saved[2].score, candidate >= 6.5 ? 8 : candidate);
    }
  }
});

test('rejected or insufficient articles never reach ranking', async () => {
  for (const value of ['REJECT', 'NEEDS_CONTENT']) {
    calls.length = 0;
    decision = value;
    const result = await processArticle(article);
    assert.deepEqual(calls, ['screen']);
    assert.equal(result?.kind, value === 'REJECT' ? undefined : 'NEEDS_CONTENT');
  }
});
