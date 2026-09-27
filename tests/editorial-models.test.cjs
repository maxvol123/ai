require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.OPENAI_API = 'test-key';
process.env.SCREENING_MODEL = 'screening-model';
process.env.RANKING_MODEL = 'ranking-model';
process.env.FINAL_EDITOR_MODEL = 'final-model';
const requests = [];
class OpenAI {
  responses = { create: async (request) => {
    requests.push(request);
    return { output_text: JSON.stringify({ decision: 'PASS', impact: 8, novelty: 8,
      reach: 8, expected_attention: 8, confidence: 90, event_hint: 'Event',
      category: 'AI', summary: 'Summary', why_it_matters: 'Impact' }) };
  } };
}
const id = require.resolve('openai');
require.cache[id] = { id, filename: id, loaded: true, exports: OpenAI };
const analysis = require('../src/services/analysis.service');
const { writeTelegramPost } = require('../src/services/telegram-writer.service');
const { qualifiesForFinalEditor } = require('../src/services/editorial-config');
const article = { title: 'News', source: 'OpenAI', url: 'https://example.com' };
const context = { nearestEvents: [{ title: 'Prior event', similarity: 0.8 }] };

test('models come from environment and event lookup reaches both rankers', async () => {
  await analysis.screenArticle(article);
  await analysis.preliminaryRankArticle(article, context);
  await analysis.compareEvents({ eventHint: 'Event', summary: 'Summary' }, { title: 'Event', summary: 'Summary' });
  await analysis.updateEventFromArticle({ title: 'Event', summary: 'Summary' }, { eventHint: 'Event', summary: 'Summary' });
  await analysis.finalRankArticle(article, context, 6.5);
  await writeTelegramPost({ ...article, preliminaryScore: 6.5 });
  assert.deepEqual(requests.map(r => r.model), ['screening-model', 'ranking-model', 'screening-model', 'screening-model', 'final-model', 'final-model']);
  assert.ok(requests[1].input.includes('Prior event'));
  assert.ok(requests[4].input.includes('Prior event'));
});

test('final ranking and writing reject low, missing, or nonfinite preliminary scores before API calls', async () => {
  const count = requests.length;
  for (const score of [6.49, 0, null, undefined, NaN, Infinity]) {
    assert.equal(qualifiesForFinalEditor(score), false);
    await assert.rejects(analysis.finalRankArticle(article, context, score), /does not qualify/);
    await assert.rejects(writeTelegramPost({ ...article, preliminaryScore: score }), /does not qualify/);
  }
  assert.equal(requests.length, count);
});
