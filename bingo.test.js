import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LINES, completedLines, deal, clean } from './server.js';

const pool = Array.from({ length: 40 }, (_, i) => `t${i}`);

test('deal gives 25 unique cells with FREE in the center', () => {
  const card = deal(pool);
  assert.equal(card.length, 25);
  assert.equal(card[12], 'FREE');
  assert.equal(new Set(card).size, 25);
});

test('12 lines, center counts as marked', () => {
  assert.equal(LINES.length, 12);
  const card = deal(pool);
  assert.deepEqual(completedLines(card, new Set()), []);
  // middle row needs only 4 marks thanks to FREE
  const mid = new Set([10, 11, 13, 14].map(i => card[i]));
  assert.deepEqual(completedLines(card, mid), [[10, 11, 12, 13, 14]]);
  // diagonal
  const diag = new Set([0, 6, 18, 24].map(i => card[i]));
  assert.deepEqual(completedLines(card, diag), [[0, 6, 12, 18, 24]]);
  // full card = all 12 lines
  assert.equal(completedLines(card, new Set(card)).length, 12);
});

test('clean trims, dedupes case-insensitively, drops junk', () => {
  assert.deepEqual(clean([' A ', 'a', '', 'FREE', 42, 'b']), ['A', 'b']);
});
