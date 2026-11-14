// -----------------------------------------------------------------------------
// ERCOT local time: normal days, the spring and autumn changes of time, and
// the local date around midnight (Central time is west of UTC).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayHours, intervalStart, localDate, localMidnight, nextDate } from '../src/time.js';

const iso = (t) => (t === undefined ? undefined : new Date(t).toISOString());

test('a normal day: 24 hours, hour ending 1 starts at local midnight', () => {
  assert.equal(dayHours('2026-11-14').length, 24);
  assert.equal(iso(localMidnight('2026-11-14')), '2026-11-14T06:00:00.000Z');
  assert.equal(iso(localMidnight('2026-07-04')), '2026-07-04T05:00:00.000Z');
  assert.equal(iso(intervalStart('2026-11-14', 1, 1, false)), '2026-11-14T06:00:00.000Z');
  assert.equal(iso(intervalStart('2026-11-14', 1, 4, false)), '2026-11-14T06:45:00.000Z');
  assert.equal(iso(intervalStart('2026-11-14', 24, 4, false)), '2026-11-15T05:45:00.000Z');
  assert.equal(iso(intervalStart('2026-07-04', 15, 2, false)), '2026-07-04T19:15:00.000Z');
  assert.equal(intervalStart('2026-11-14', 2, 1, true), undefined, 'no repeated hour');
});

test('spring change (2026-03-08): 23 hours, hour ending 02 or 03 is the hour from 01:00', () => {
  assert.equal(dayHours('2026-03-08').length, 23);
  assert.equal(iso(intervalStart('2026-03-08', 1, 1, false)), '2026-03-08T06:00:00.000Z');
  assert.equal(iso(intervalStart('2026-03-08', 2, 1, false)), '2026-03-08T07:00:00.000Z');
  assert.equal(iso(intervalStart('2026-03-08', 3, 1, false)), '2026-03-08T07:00:00.000Z');
  // 03:00 CDT = 08:00 UTC.
  assert.equal(iso(intervalStart('2026-03-08', 4, 1, false)), '2026-03-08T08:00:00.000Z');
  assert.equal(iso(intervalStart('2026-03-08', 24, 4, false)), '2026-03-09T04:45:00.000Z');
  assert.equal(intervalStart('2026-03-08', 2, 1, true), undefined);
});

test('autumn change (2026-11-01): 25 hours, hour ending 02 twice, the second flagged', () => {
  assert.equal(dayHours('2026-11-01').length, 25);
  assert.equal(iso(intervalStart('2026-11-01', 1, 1, false)), '2026-11-01T05:00:00.000Z');
  assert.equal(iso(intervalStart('2026-11-01', 2, 1, false)), '2026-11-01T06:00:00.000Z');
  assert.equal(iso(intervalStart('2026-11-01', 2, 1, true)), '2026-11-01T07:00:00.000Z');
  assert.equal(iso(intervalStart('2026-11-01', 3, 1, false)), '2026-11-01T08:00:00.000Z');
  assert.equal(iso(intervalStart('2026-11-01', 24, 4, false)), '2026-11-02T05:45:00.000Z');
  assert.equal(intervalStart('2026-11-01', 3, 1, true), undefined, 'only 02 is repeated');
  // Every interval of the day is distinct and 15 minutes apart.
  const starts = [];
  for (let he = 1; he <= 24; he += 1) {
    for (const rep of he === 2 ? [false, true] : [false]) {
      for (let i = 1; i <= 4; i += 1) starts.push(intervalStart('2026-11-01', he, i, rep));
    }
  }
  assert.equal(new Set(starts).size, 100);
  starts.slice(1).forEach((t, i) => assert.equal(t - starts[i], 15 * 60_000));
});

test('invalid dates, hours and intervals are no instant', () => {
  assert.equal(intervalStart('2026-02-30', 1, 1, false), undefined);
  assert.equal(intervalStart('11/14/2026', 1, 1, false), undefined);
  assert.equal(intervalStart('2026-11-14', 0, 1, false), undefined);
  assert.equal(intervalStart('2026-11-14', 25, 1, false), undefined);
  assert.equal(intervalStart('2026-11-14', 1, 0, false), undefined);
  assert.equal(intervalStart('2026-11-14', 1, 5, false), undefined);
  assert.equal(intervalStart('2026-11-14', 1.5, 1, false), undefined);
  assert.equal(intervalStart(undefined, 1, 1, false), undefined);
});

test('the local date at midnight, west of UTC, and the next date', () => {
  assert.equal(localDate(Date.parse('2026-11-15T05:59:59Z')), '2026-11-14');
  assert.equal(localDate(Date.parse('2026-11-15T06:00:00Z')), '2026-11-15');
  assert.equal(localDate(Date.parse('2026-07-05T04:59:00Z')), '2026-07-04');
  assert.equal(nextDate('2026-03-08'), '2026-03-09');
  assert.equal(nextDate('2026-11-01'), '2026-11-02');
  assert.equal(nextDate('2026-12-31'), '2027-01-01');
});
