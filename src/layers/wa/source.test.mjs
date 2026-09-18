import test from 'node:test';
import assert from 'node:assert/strict';
import { createWaOpenDataSource } from './source.js';

test('WA client source accepts only its bounded same-origin dataset contract', async () => {
  const calls = [];
  const source = createWaOpenDataSource({
    fetchImpl: async (url, options) => {
      calls.push([url, options]);
      return new Response(
        JSON.stringify({
          dataset: 'cameras',
          fetchedAt: 1,
          features: [],
        }),
      );
    },
  });
  assert.equal((await source.getDataset('cameras')).dataset, 'cameras');
  assert.equal(calls[0][0], '/api/wa/cameras');
  await assert.rejects(source.getDataset('unknown'), /Unknown WA dataset/);
});
