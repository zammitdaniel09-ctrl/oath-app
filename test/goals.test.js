// Goal progress labels and logging a new value: pure checks, no database. The full goal flow through the
// API is in research.test.js (14 and 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeProgress, nextGoalValue } from '../src/goals.js';

const none = { tasks: [], habits: [], stats: new Map() };

test('a number goal that goes down reads towards its target, not past it', () => {
  const weight = { id: 1, measure: 'number', unit: 'kg', start_value: 90, target_value: 80 };
  assert.deepEqual(computeProgress({ ...weight, current_value: 84 }, none), { pct: 60, label: '4 kg to go' });
  assert.deepEqual(computeProgress({ ...weight, current_value: 88 }, none), { pct: 20, label: '-2 kg since you started' });
  assert.deepEqual(computeProgress({ ...weight, current_value: 80 }, none), { pct: 100, label: 'Target reached' });
  assert.deepEqual(computeProgress({ ...weight, current_value: 79.4 }, none), { pct: 100, label: 'Target reached' });
  // Going up still works the same way.
  const savings = { id: 2, measure: 'number', unit: '', start_value: 10, target_value: 50 };
  assert.deepEqual(computeProgress({ ...savings, current_value: 30 }, none), { pct: 50, label: '20 to go' });
  assert.deepEqual(computeProgress({ ...savings, current_value: 55 }, none), { pct: 100, label: 'Target reached' });
});

test('steps count whole steps: a habit part way to strong is not a fraction of one', () => {
  const g = { id: 3, measure: 'steps' };
  const ctx = (strengths, done = 1, open = 2) => ({
    tasks: [...Array(done).fill({ goal_id: 3, done_at: new Date() }), ...Array(open).fill({ goal_id: 3, done_at: null })],
    habits: strengths.map((_, i) => ({ id: 10 + i, goal_id: 3 })),
    stats: new Map(strengths.map((s, i) => [10 + i, { strength: s }])),
  });
  // 1 task done and habits at 40% and 96%: 2.36 of 5, shown as 2.
  assert.deepEqual(computeProgress(g, ctx([40, 96])), { pct: 47, label: '2 of 5 steps done' });
  // Past halfway it counts what is left, again in whole steps.
  assert.deepEqual(computeProgress(g, ctx([40, 96], 2, 1)), { pct: 67, label: '2 steps to go' });
  assert.deepEqual(computeProgress(g, ctx([100, 100], 3, 0)), { pct: 100, label: 'Every step done' });
});

test('a logged value is rounded clear of float noise, and +N or -N can be typed as a phone gives it', () => {
  assert.equal(nextGoalValue(80.2, '+0.1'), 80.3);
  assert.equal(nextGoalValue(0.1, '+0.2'), 0.3);
  assert.equal(nextGoalValue(80.2, '-0.1'), 80.1);
  assert.equal(nextGoalValue(80.2, '- 0.1'), 80.1);
  assert.equal(nextGoalValue(80.2, '−0.2'), 80); // a typographic minus
  assert.equal(nextGoalValue(null, '+5'), 5);
  assert.equal(nextGoalValue(80, '84,5'), 84.5);
  assert.throws(() => nextGoalValue(80, 'abc'), /Type a number/);
  assert.throws(() => nextGoalValue(80, ''), /Type a number/);
});
