import test from 'node:test';
import assert from 'node:assert/strict';
import { openReview, REVIEW_URL } from '../src/review.js';
test('review opens the company flow with only public product context', async () => {
  let options;
  await openReview(async value => { options = value; });
  const url = new URL(options.url);
  assert.equal(url.origin, 'https://kittycorp.vercel.app');
  assert.equal(url.pathname, '/contact');
  assert.deepEqual([...url.searchParams], [['subject', 'Review'], ['product', 'SecretChat']]);
  assert.deepEqual(Object.keys(options), ['url']);
  assert.equal(options.url, REVIEW_URL);
});
