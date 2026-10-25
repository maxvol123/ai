require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
let responses, calls;
class FakeOpenAI {
  responses = { create: async input => { calls.push(input); return responses.shift(); } };
}
const id = require.resolve('openai');
require.cache[id] = { id, filename: id, loaded: true, exports: { __esModule: true, default: FakeOpenAI } };
const { generateDigestDisplay } = require('../src/services/dontskip-copy.service');
const stories = [
  { id: 'a', title: 'Rapidly scaling online storage to serve over 1 billion ChatGPT users (Part II)' },
  { id: 'b', title: 'Now Google says it might use Gmail and Google Photos data to target ads' },
];
const copy = [
  { id: 'a', kicker: 'OpenAI', displayHeadline: 'ChatGPT storage scales for 1B+ users' },
  { id: 'b', kicker: 'Google', displayHeadline: 'Gmail data may power ad targeting' },
];
const response = stories => ({ status: 'completed', output_text: JSON.stringify({ stories }) });
test('generates separate uppercase copy with strict schema, supplied IDs and uncertainty instructions', async () => {
  calls = []; responses = [response(copy)];
  const result = await generateDigestDisplay(stories);
  assert.equal(result[0].kicker, 'OPENAI');
  assert.equal(result[1].displayHeadline, 'GMAIL DATA MAY POWER AD TARGETING');
  assert.equal(calls[0].store, false);
  assert.equal(calls[0].text.format.strict, true);
  assert.deepEqual(JSON.parse(calls[0].input), stories);
  assert.match(calls[0].instructions, /MAY must remain MAY/);
});
test('invalid, mismatched or oversized copy gets only one regeneration attempt', async () => {
  for (const invalid of [copy.slice(0, 1), [{ ...copy[0], id: 'wrong' }, copy[1]],
    [{ ...copy[0], displayHeadline: 'X'.repeat(56) }, copy[1]],
    [{ ...copy[0], displayHeadline: 'W'.repeat(48) }, copy[1]],
    [copy[0], { ...copy[1], displayHeadline: 'GMAIL DATA POWERS AD TARGETING' }]]) {
    calls = []; responses = [response(invalid), response(copy)];
    assert.equal((await generateDigestDisplay(stories))[0].id, 'a');
    assert.equal(calls.length, 2);
    assert.match(calls[1].instructions, /previous output failed/);
  }
  calls = []; responses = [response([]), response([])];
  await assert.rejects(generateDigestDisplay(stories), /Invalid story count/);
  assert.equal(calls.length, 2);
});
test('incomplete response never becomes publication copy', async () => {
  calls = []; responses = [{ status: 'incomplete', output_text: JSON.stringify({ stories: copy }) }];
  await assert.rejects(generateDigestDisplay(stories), /incomplete/);
  assert.equal(calls.length, 1);
});
