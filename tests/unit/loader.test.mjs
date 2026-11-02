import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunksForRange, hydrationOrder } from '../../web/js/loader.js';

const CHUNK = 1024;

test('chunk ranges are inclusive of both ends and clamped to the image', () => {
  assert.deepEqual(chunksForRange(0, 1024, CHUNK, 4096), [0]);
  assert.deepEqual(chunksForRange(1023, 2, CHUNK, 4096), [0, 1]);
  assert.deepEqual(chunksForRange(1024, 1024, CHUNK, 4096), [1]);
  assert.deepEqual(chunksForRange(3000, 5000, CHUNK, 4096), [2, 3]);
});

test('hydration order follows the stages, merges duplicates, and still covers the image', () => {
  const manifest = {
    chunkSize: CHUNK,
    imageBytes: 4096,
    disc: { sectorSize: 2048 },
    hydration: [
      { stageIndex: 2, lba: 0, sectors: 1, paths: ['SYSTEM.CNF'] },
      { stageIndex: 0, lba: 1, sectors: 2, paths: ['AAA/PRO/STDWTITL.PRO'] },
      { stageIndex: 1, lba: 1, sectors: 1, paths: ['overlap'] },
    ],
  };
  const order = hydrationOrder(manifest);
  // The plan arrives out of order on purpose: the loader must sort it.
  const stages = order.map((o) => o.stageIndex);
  assert.deepEqual(stages, [...stages].sort((a, b) => a - b));
  assert.equal(stages[0], 0, 'stage 0 comes first');
  // Every chunk appears exactly once, and none is lost to the overlap.
  assert.equal(new Set(order.map((o) => o.index)).size, order.length);
  assert.equal(order.length, 4);
  assert.deepEqual([...order.map((o) => o.index)].sort(), [0, 1, 2, 3]);
});

test('image tails the plan never mentions are still fetched', () => {
  const manifest = {
    chunkSize: CHUNK,
    imageBytes: 4096,
    disc: { sectorSize: 2048 },
    hydration: [{ stageIndex: 0, lba: 0, sectors: 1, paths: ['only one'] }],
  };
  const order = hydrationOrder(manifest);
  assert.equal(order.length, 4);
  const tail = order.filter((o) => o.stageIndex === 99);
  assert.equal(tail.length, 2, 'the two chunks the plan never mentioned');
  assert.deepEqual(order.slice(-2), tail, 'and they come last');
});
