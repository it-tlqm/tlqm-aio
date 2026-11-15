import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCalendar, workflowDeadline } from '../src/workflows/calendar.js';
const calendar = {
  offsetMinutes: 420,
  weekdays: [1, 2, 3, 4, 5],
  shifts: [
    { start: 480, end: 720 },
    { start: 780, end: 1020 },
  ],
  holidays: ['2026-11-16'],
};
test('business deadlines skip breaks, weekend and holidays with fixed UTC offset', () => {
  assert.equal(
    workflowDeadline(new Date('2026-11-13T09:00:00Z'), 120, calendar).toISOString(),
    '2026-11-17T02:00:00.000Z',
  );
  assert.equal(
    workflowDeadline(new Date('2026-11-13T04:30:42Z'), 120, calendar).toISOString(),
    '2026-11-13T07:30:42.000Z',
  );
  assert.equal(
    workflowDeadline(new Date('2026-11-13T09:00:00Z'), 120).toISOString(),
    '2026-11-13T11:00:00.000Z',
  );
});
test('calendar rejects overlapping shifts, invalid dates and empty work weeks', () => {
  assert.throws(() => parseCalendar({ ...calendar, weekdays: [] }));
  assert.throws(() =>
    parseCalendar({
      ...calendar,
      shifts: [
        { start: 400, end: 800 },
        { start: 500, end: 700 },
      ],
    }),
  );
  assert.throws(() => parseCalendar({ ...calendar, holidays: ['2026-02-30'] }));
  assert.throws(() => parseCalendar({ ...calendar, offsetMinutes: 1420 }));
});
