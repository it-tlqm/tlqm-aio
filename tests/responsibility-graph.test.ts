import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertResponsibilityGraph } from '../src/management/responsibilities.js';
const edge = (from: string, to: string, start = 0, end = 100) => ({
  id: from + to,
  from,
  to,
  start,
  end,
});
test('reporting graph rejects self reference and cycles with a shared effective interval', () => {
  assert.throws(() => assertResponsibilityGraph([], edge('a', 'a')), {
    code: 'RESPONSIBILITY_CYCLE',
  });
  assert.throws(
    () =>
      assertResponsibilityGraph([edge('b', 'c', 20, 70), edge('c', 'a', 50, 90)], edge('a', 'b')),
    { code: 'RESPONSIBILITY_CYCLE' },
  );
});
test('reporting graph permits historical reversals without simultaneous cycles', () => {
  assertResponsibilityGraph([edge('b', 'a', 100, 200)], edge('a', 'b'));
  assertResponsibilityGraph([edge('b', 'c', 0, 20), edge('c', 'a', 30, 100)], edge('a', 'b'));
});
test('editing a relationship excludes its old edge and checks the new interval', () => {
  assertResponsibilityGraph([edge('a', 'b'), edge('b', 'a', 100, 200)], edge('a', 'b', 0, 100));
  assert.throws(
    () =>
      assertResponsibilityGraph(
        [edge('a', 'b'), edge('b', 'a', 100, 200)],
        edge('a', 'b', 50, 150),
      ),
    { code: 'RESPONSIBILITY_CYCLE' },
  );
});
