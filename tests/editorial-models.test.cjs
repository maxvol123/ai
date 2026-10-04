require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.OPENAI_API = 'test-key';
process.env.SCREENING_MODEL = 'screening-model';
process.env.RANKING_MODEL = 'ranking-model';
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
const { qualifiesForReview } = require('../src/services/editorial-config');
const article = { title: 'News', source: 'OpenAI', url: 'https://example.com' };
const context = { nearestEvents: [{ title: 'Prior event', similarity: 0.8 }] };

test('ranking receives only compact fields and writing makes no model call', async () => {
  await analysis.screenArticle(article);
  const full = { ...article, content: 'SECRET_FULL_BODY', description: 'LONG_DESCRIPTION'.repeat(1000), summary: 'Extracted facts', category: 'Research' };
  await analysis.analyzeArticle(full, context);
  assert.deepEqual(requests.map(r => r.model), ['screening-model', 'ranking-model']);
  const input = JSON.parse(requests[1].input);
  assert.deepEqual(Object.keys(input), ['title', 'description', 'source', 'category', 'eventContext']);
  assert.equal(input.description, 'Extracted facts');
  assert.equal(input.source, 'OpenAI');
  assert.equal(input.category, 'Research');
  assert.ok(requests[1].input.includes('Prior event'));
  assert.ok(!requests[1].input.includes('SECRET_FULL_BODY'));
  const post = await writeTelegramPost({ ...article, preliminaryScore: 6.5, summary: 'Summary', whyItMatters: 'Impact' });
  assert.equal(post, 'News\n\nSummary\n\nWhy it matters: Impact\n\nSource: OpenAI');
  assert.equal(requests.length, 2);
});

test('ranking bounds descriptions and event context without falling back to full content', async () => {
  await analysis.analyzeArticle({ ...article, description: 'x'.repeat(10000), content: 'SECRET_FULL_BODY' }, {
    nearestEvents: Array.from({length: 20}, () => ({ title: 'y'.repeat(1000), similarity: 0.8, secret: 'hidden' })),
    existingEvent: { title: 'z'.repeat(1000), summary: 's'.repeat(10000), secret: 'hidden' },
  });
  const input = JSON.parse(requests.at(-1).input);
  assert.equal(input.description.length, 1500);
  assert.equal(input.eventContext.nearestEvents.length, 10);
  assert.equal(input.eventContext.existingEvent.summary.length, 1500);
  assert.ok(!requests.at(-1).input.includes('secret'));
  await analysis.analyzeArticle({ ...article, content: 'SECRET_FULL_BODY' }, context);
  assert.equal(JSON.parse(requests.at(-1).input).description, '');
});

test('writing rejects low, missing, or nonfinite scores before any API calls', async () => {
  const count = requests.length;
  for (const score of [6.49, 0, null, undefined, NaN, Infinity]) {
    assert.equal(qualifiesForReview(score), false);
    await assert.rejects(writeTelegramPost({ ...article, preliminaryScore: score }), /does not qualify/);
  }
  assert.equal(requests.length, count);
});
