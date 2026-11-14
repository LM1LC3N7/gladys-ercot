// -----------------------------------------------------------------------------
// Real time, sped up 9,000 times (15 minutes = 100 ms): the cycles leave 15
// minutes apart, never sooner; failures wait 15, 30, 60 minutes. Large
// margins: late under load is fine, early never. The gaps are measured on
// the attempt time the module decides on.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ErcotApp } from '../src/app.js';
import { MINUTE, ZONE_KEYS, calendarKey } from '../src/constants.js';
import { localMidnight } from '../src/time.js';
import { TOKEN_ANSWER, installFetch, json, report, rowsUntil } from './helpers/fakeFetch.js';
import { realClock } from './helpers/realClock.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const CONFIG = {
  username: 'u@example.com',
  password: 'pw',
  subscription_key: '0123456789abcdef0123456789abcdef',
  zones: ['houston'],
};

async function measure(t, prices, count) {
  const clock = realClock({ start: Date.parse('2026-11-14T18:07:00Z'), speed: 9000 });
  const times = [];
  let app;
  const fake = installFetch([
    [/b2clogin/, () => json(TOKEN_ANSWER())],
    [
      /api\.ercot/,
      (call) => {
        times.push(app.state.attempt_at);
        assert.ok(clock.now() >= app.state.attempt_at, 'the request leaves after its attempt');
        return prices(call, clock);
      },
    ],
  ]);
  const dataDir = mkdtempSync(join(tmpdir(), 'ercot-rc-'));
  const gladys = createFakeGladys({
    selector: 'ercot',
    config: CONFIG,
    energyCalendars: Object.fromEntries(ZONE_KEYS.map((z) => [calendarKey(z), []])),
  });
  app = new ErcotApp({
    gladys,
    logger: quiet,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    dataDir,
    // The /data bound is real I/O time: 5 s real, not 5 simulated seconds (0.5 ms here).
    dataTimeout: 5000 * 9000,
  });
  t.after(async () => {
    await app.stop();
    clock.close();
    fake.restore();
    rmSync(dataDir, { recursive: true, force: true });
  });
  await app.start(CONFIG);
  const deadline = Date.now() + 20_000;
  while (times.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  await app.stop();
  assert.ok(
    times.length >= count,
    `only ${times.length} reads in 20 s ${JSON.stringify({ a: app.state?.attempt_at, p: app.state?.pause_until, f: app.state?.failures, e: app.lastError, due: app.readDueMono, mono: clock.monotonic(), r: !!app.reading, st: app.lastStatus })}`,
  );
  return times.slice(1).map((m, i) => m - times[i]);
}

test('real clock: a cycle every 15 minutes, never sooner', async (t) => {
  const gaps = await measure(
    t,
    (call, clock) =>
      json(
        report(rowsUntil(localMidnight(call.params.deliveryDateFrom), clock.now(), 'LZ_HOUSTON')),
      ),
    5,
  );
  for (const gap of gaps) {
    assert.ok(gap >= 15 * MINUTE, `gap ${gap / MINUTE} min`);
    assert.ok(gap <= 45 * MINUTE, `gap ${gap / MINUTE} min`);
  }
});

test('real clock: failures wait 15, 30, then 60 minutes', async (t) => {
  const gaps = await measure(t, () => new Response('', { status: 503 }), 4);
  [15, 30, 60].forEach((minutes, i) => {
    assert.ok(gaps[i] >= minutes * MINUTE, `gap ${i}: ${gaps[i] / MINUTE} min`);
    assert.ok(gaps[i] <= minutes * MINUTE * 2 + 15 * MINUTE, `gap ${i}: ${gaps[i] / MINUTE} min`);
  });
});

test('real clock: a cycle longer than the interval does not stop the next ones', async (t) => {
  const gaps = await measure(
    t,
    async (call, clock) => {
      // 150 ms real = 22.5 simulated minutes: the next cycle is due before this one ends.
      await new Promise((resolve) => setTimeout(resolve, 150));
      return json(
        report(rowsUntil(localMidnight(call.params.deliveryDateFrom), clock.now(), 'LZ_HOUSTON')),
      );
    },
    4,
  );
  for (const gap of gaps) assert.ok(gap >= 15 * MINUTE, `gap ${gap / MINUTE} min`);
});
