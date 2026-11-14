// -----------------------------------------------------------------------------
// The integration against the SDK's fake Gladys, a fake ERCOT and a test clock
// that moves on its own (every read of the clock advances it).
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { ACTION_TEST, ErcotApp, backoff, tagOf } from '../src/app.js';
import { normalizeConfig } from '../src/config.js';
import { HOUR, MINUTE, SLOT, ZONES, ZONE_KEYS, calendarKey } from '../src/constants.js';
import { localMidnight } from '../src/time.js';
import {
  TOKEN_ANSWER,
  installFetch,
  json,
  priceAt,
  report,
  rowsUntil,
} from './helpers/fakeFetch.js';
import { createClock } from './helpers/clock.js';

const PASSWORD = 'Sup3r-Secret!pw';
const KEY = '0123456789abcdef0123456789abcdef';
const USER = 'jane.doe@example.com';
const CONFIG = {
  username: USER,
  password: PASSWORD,
  subscription_key: KEY,
  zones: ['houston', 'north'],
};
const START = Date.parse('2026-11-14T18:07:00Z'); // 12:07 Central time
const HOUSTON = 'ext:ercot:zone:houston';
const PRICE = (zone) => `ext:ercot:zone:${zone}:price`;

let fake;
afterEach(() => fake?.restore());

// Per test: every app is stopped BEFORE any data folder is removed.
const cleanups = new WeakMap();
function track(t, { app, dir }) {
  let entry = cleanups.get(t);
  if (!entry) {
    entry = { apps: [], dirs: [] };
    cleanups.set(t, entry);
    t.after(async () => {
      for (const a of entry.apps) await a.stop();
      for (const d of entry.dirs) rmSync(d, { recursive: true, force: true });
    });
  }
  if (app) entry.apps.push(app);
  if (dir) entry.dirs.push(dir);
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ercot-'));
  track(t, { dir });
  return dir;
}

function memoryLogger() {
  const lines = [];
  const log =
    (level) =>
    (...args) =>
      lines.push(`${level} ${args.map(String).join(' ')}`);
  return { lines, info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') };
}

/**
 * The fake ERCOT: `ercot.token(call)` and `ercot.prices(call, point)` can be
 * replaced per test; by default every ended interval of the dates asked.
 */
function fakeErcot(clock) {
  const ercot = { inFlight: 0, maxInFlight: 0, tokens: 0 };
  ercot.token = () => {
    ercot.tokens += 1;
    return json(TOKEN_ANSWER(ercot.tokens));
  };
  ercot.prices = (call, point) => {
    const from = localMidnight(call.params.deliveryDateFrom);
    return json(report(rowsUntil(from, clock.now(), point)));
  };
  const wrap = (fn) => async (call) => {
    ercot.inFlight += 1;
    ercot.maxInFlight = Math.max(ercot.maxInFlight, ercot.inFlight);
    try {
      return await fn(call);
    } finally {
      ercot.inFlight -= 1;
    }
  };
  fake = installFetch([
    [/b2clogin\.com/, wrap((call) => ercot.token(call))],
    [/api\.ercot\.com/, wrap((call) => ercot.prices(call, call.params.settlementPoint))],
  ]);
  ercot.calls = () => fake.calls;
  ercot.tokenCalls = () => fake.calls.filter((c) => /b2clogin/.test(c.url));
  ercot.priceCalls = () => fake.calls.filter((c) => /api\.ercot/.test(c.url));
  return ercot;
}

function newApp(t, { gladys, clock, dataDir, logger }) {
  const app = new ErcotApp({
    gladys,
    logger,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    dataDir,
  });
  gladys.onAction(ACTION_TEST, () => app.testConnection());
  clock.waitFor = () => app.reading;
  track(t, { app });
  return app;
}

function setup(t, { config = CONFIG, now = START, dataDir, clock } = {}) {
  clock ??= createClock(now);
  const ercot = fakeErcot(clock);
  const gladys = createFakeGladys({
    selector: 'ercot',
    config,
    energyCalendars: Object.fromEntries(ZONE_KEYS.map((z) => [calendarKey(z), []])),
  });
  dataDir ??= tempDir(t);
  const logger = memoryLogger();
  const app = newApp(t, { gladys, clock, dataDir, logger });
  return { app, gladys, clock, dataDir, logger, ercot };
}

/** Wait (real time, bounded) for a condition: fails, never hangs. */
async function until(cond, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const readData = (dir) => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
const status = (gladys) => gladys.fake.connectionStatus;
const statusText = (gladys) => JSON.stringify(status(gladys));

/** No secret anywhere: logs, /data, statuses. */
function assertNoSecret({ logger, dataDir, gladys }) {
  const places = [logger.lines.join('\n'), statusText(gladys)];
  try {
    places.push(readFileSync(join(dataDir, 'state.json'), 'utf8'));
  } catch {
    // no file yet
  }
  for (const text of places) {
    for (const secret of [PASSWORD, KEY, USER, 'jane.doe', 'eyJ.idtoken']) {
      assert.ok(!text.includes(secret), `secret ${secret} leaked`);
    }
  }
}

test('start: devices, one token, the prices of each zone, calendars, sensors, status', async (t) => {
  const { app, gladys, dataDir, ercot, logger } = setup(t);
  await app.start(CONFIG);
  await app.reading;
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => d.external_id),
    [HOUSTON, 'ext:ercot:zone:north'],
  );
  assert.equal(ercot.tokenCalls().length, 1);
  assert.deepEqual(
    ercot
      .priceCalls()
      .map((c) => [c.params.settlementPoint, c.params.deliveryDateFrom, c.params.deliveryDateTo]),
    [
      [ZONES.houston, '2026-11-11', '2026-11-14'],
      [ZONES.north, '2026-11-11', '2026-11-14'],
    ],
  );
  assert.equal(ercot.maxInFlight, 1, 'one request at a time');
  const entries = gladys.fake.energyCalendars[calendarKey('houston')];
  // From 3 days back (rounded to the local date asked) to the last ended interval (18:00).
  const first = START - 3 * 24 * HOUR;
  const expected = Math.floor((START - first) / SLOT);
  assert.ok(Math.abs(entries.length - expected) <= 1, `${entries.length} entries`);
  for (const entry of entries) {
    const t0 = Date.parse(entry.starts_at);
    assert.equal(t0 % SLOT, 0, 'aligned on 15 minutes');
    assert.ok(t0 + SLOT <= START + 1000, 'only ended intervals');
    assert.equal(entry.value, Math.round(priceAt(t0, ZONES.houston) * 100) / 100_000, 'USD/kWh');
  }
  assert.equal(gladys.fake.energyCalendars[calendarKey('south')].length, 0, 'zones not chosen');
  const last = Date.parse('2026-11-14T17:45:00Z');
  assert.equal(gladys.fake.lastState(PRICE('houston')), priceAt(last, ZONES.houston));
  const [state] = gladys.fake.states.filter(
    (s) => s.device_feature_external_id === PRICE('houston'),
  );
  assert.equal(state.created_at, undefined, 'a fresh price is published without a date');
  assert.equal(status(gladys).connected, true);
  assert.match(statusText(gladys), /Real-time prices read \(LZ_HOUSTON, LZ_NORTH\)/);
  const data = readData(dataDir);
  assert.ok(data.attempt_at > 0);
  assert.equal(data.zones.houston.slots.length, entries.length);
  assert.ok(
    data.zones.houston.slots.every((s) => s.length === 2),
    'nothing pending',
  );
  assert.equal(data.refused, null);
  assertNoSecret({ logger, dataDir, gladys });
});

test('pace: one cycle every 15 minutes, never sooner; the token kept 55 minutes', async (t) => {
  const { app, gladys, clock, ercot } = setup(t);
  await app.start(CONFIG);
  await app.reading;
  const cycles = () => ercot.priceCalls().length / 2;
  assert.equal(cycles(), 1);
  await clock.advance(15 * MINUTE - 1000);
  assert.equal(cycles(), 1, 'not before 15 minutes');
  await clock.advance(2000);
  assert.equal(cycles(), 2);
  // The second read asks from the date of the last price known only.
  const second = ercot.priceCalls()[2];
  assert.equal(second.params.deliveryDateFrom, '2026-11-14');
  assert.equal(ercot.tokenCalls().length, 1, 'token reused');
  // A new price per cycle: the sensor follows.
  assert.equal(
    gladys.fake.lastState(PRICE('houston')),
    priceAt(Date.parse('2026-11-14T18:00:00Z'), ZONES.houston),
  );
  await clock.advance(45 * MINUTE);
  assert.equal(cycles(), 5);
  assert.equal(ercot.tokenCalls().length, 2, 'a new token after 55 minutes');
  // The button does not read before the pace allows it.
  const answer = await gladys.fake.action(ACTION_TEST, {});
  assert.equal(cycles(), 5);
  assert.match(JSON.stringify(answer), /Real-time prices read/);
});

test('restart: the pace comes from /data; a future attempt time is read as now', async (t) => {
  const first = setup(t);
  await first.app.start(CONFIG);
  await first.app.reading;
  await first.app.stop();
  const clock = createClock(START + 5 * MINUTE);
  const second = setup(t, { dataDir: first.dataDir, clock });
  await second.app.connected();
  assert.equal(second.ercot.calls().length, 0, 'no read at the restart');
  await clock.advance(10 * MINUTE - 1000);
  assert.equal(second.ercot.calls().length, 0);
  await clock.advance(2000);
  assert.equal(second.ercot.priceCalls().length, 2);
  // Nothing republished as new: the sensor got only the newer interval.
  const states = second.gladys.fake.states.filter(
    (s) => s.device_feature_external_id === PRICE('houston'),
  );
  assert.equal(states.length, 1);
  await second.app.stop();

  const data = readData(first.dataDir);
  data.attempt_at = START + 10 * 24 * HOUR;
  writeFileSync(join(first.dataDir, 'state.json'), JSON.stringify(data));
  const clock3 = createClock(START + 20 * MINUTE);
  const third = setup(t, { dataDir: first.dataDir, clock: clock3 });
  await third.app.start(CONFIG);
  assert.equal(third.ercot.calls().length, 0, 'a future attempt is now, not a read');
  await clock3.advance(15 * MINUTE + 1000);
  assert.equal(third.ercot.priceCalls().length, 2);
});

test('login refused: stopped, kept across restarts, never sent again by itself', async (t) => {
  const { app, gladys, clock, dataDir, ercot, logger } = setup(t);
  ercot.token = () => json({ error: 'invalid_grant', error_description: 'AADB2C90225' }, 400);
  await app.start(CONFIG);
  await app.reading;
  assert.equal(ercot.tokenCalls().length, 1);
  assert.equal(ercot.priceCalls().length, 0);
  assert.equal(status(gladys).connected, false);
  assert.match(statusText(gladys), /refused the user name or password/);
  await clock.advance(24 * HOUR);
  assert.equal(ercot.calls().length, 1, 'no automatic try');
  const data = readData(dataDir);
  assert.match(data.refused.salt, /^[0-9a-f]{32}$/);
  assert.ok(Number.isInteger(data.refused.tag) && data.refused.tag < 256);
  assert.deepEqual(Object.keys(data.refused).sort(), ['kind', 'salt', 'tag']);
  assertNoSecret({ logger, dataDir, gladys });
  await app.stop();

  // Restart with the same credentials: still refused, no request.
  const again = setup(t, { dataDir, clock });
  again.ercot.token = () => json({ error: 'invalid_grant' }, 400);
  await again.app.connected();
  await clock.advance(2 * HOUR);
  assert.equal(again.ercot.calls().length, 0);
  assert.match(statusText(again.gladys), /refused/);
  // Saving the same configuration again does not lift it either.
  await again.app.start(CONFIG);
  await clock.advance(HOUR);
  assert.equal(again.ercot.calls().length, 0);
});

test('login refused: new credentials are tried within a minute, in process or after a restart', async (t) => {
  const { app, gladys, clock, dataDir, ercot } = setup(t);
  ercot.token = () => json({ error: 'invalid_grant' }, 400);
  await app.start(CONFIG);
  await app.reading;
  ercot.token = () => json(TOKEN_ANSWER());
  await app.start({ ...CONFIG, password: 'another one' });
  await clock.advance(MINUTE + 1000);
  assert.equal(ercot.tokenCalls().length, 2);
  assert.equal(ercot.priceCalls().length, 2);
  assert.equal(status(gladys).connected, true);
  assert.equal(readData(dataDir).refused, null, 'erased at the success');
  await app.stop();

  // After a restart: another password than the refused one (tag differs).
  const dir = tempDir(t);
  const first = setup(t, { dataDir: dir, clock });
  first.ercot.token = () => json({ error: 'invalid_grant' }, 400);
  await first.app.start(CONFIG);
  await first.app.reading;
  await first.app.stop();
  const refused = readData(dir).refused;
  let other = 'x';
  for (
    let i = 0;
    tagOf(refused.salt, normalizeConfig({ ...CONFIG, password: other })) === refused.tag;
    i += 1
  ) {
    other = `x${i}`;
  }
  const second = setup(t, { dataDir: dir, clock });
  await second.app.start({ ...CONFIG, password: other });
  await clock.advance(MINUTE + 1000);
  assert.equal(second.ercot.tokenCalls().length, 1);
  assert.equal(readData(dir).refused, null);
});

test('login refused: the button tries once per click, a minute apart, and lifts it on success', async (t) => {
  const { app, gladys, clock, ercot } = setup(t);
  ercot.token = () => json({ error: 'invalid_grant' }, 400);
  await app.start(CONFIG);
  await app.reading;
  let answer = await gladys.fake.action(ACTION_TEST, {});
  assert.equal(ercot.tokenCalls().length, 1, 'too soon after the refused try');
  assert.match(JSON.stringify(answer), /short while ago/);
  await clock.advance(MINUTE);
  answer = await gladys.fake.action(ACTION_TEST, {});
  assert.equal(ercot.tokenCalls().length, 2);
  assert.match(JSON.stringify(answer), /refused the user name or password/);
  await clock.advance(MINUTE);
  ercot.token = () => json(TOKEN_ANSWER());
  answer = await gladys.fake.action(ACTION_TEST, {});
  assert.equal(ercot.tokenCalls().length, 3);
  assert.match(JSON.stringify(answer), /Real-time prices read/);
  assert.equal(status(gladys).connected, true);
  await clock.advance(15 * MINUTE + 1000);
  assert.equal(ercot.tokenCalls().length, 3, 'token kept');
  assert.equal(ercot.priceCalls().length, 4, 'the pace is back');
});

test('the refusal tag: 8 bits of a salted hash, many passwords share it', () => {
  const salt = '00112233445566778899aabbccddeeff';
  const tag = tagOf(salt, normalizeConfig(CONFIG));
  let same = 0;
  for (let i = 0; i < 4096; i += 1) {
    if (tagOf(salt, normalizeConfig({ ...CONFIG, password: `guess-${i}` })) === tag) same += 1;
  }
  // About 4096 / 256 = 16: a guess cannot be confirmed by the tag.
  assert.ok(same >= 4 && same <= 40, `${same} collisions`);
  assert.notEqual(tagOf('ffeeddccbbaa99887766554433221100', normalizeConfig(CONFIG)), undefined);
});

test('subscription key refused: stopped like a login refusal, said as such', async (t) => {
  const { app, gladys, clock, ercot, dataDir } = setup(t);
  ercot.prices = () =>
    json({ statusCode: 401, message: 'Access denied due to invalid subscription key.' }, 401);
  await app.start(CONFIG);
  await app.reading;
  assert.equal(ercot.priceCalls().length, 1, 'the second zone is not tried');
  assert.match(statusText(gladys), /refused the subscription key/);
  assert.equal(readData(dataDir).refused.kind, 'key');
  await clock.advance(6 * HOUR);
  assert.equal(ercot.calls().length, 2);
});

test('a 401 without the key: one new token for an old one, never a refusal', async (t) => {
  const { app, gladys, clock, ercot, dataDir } = setup(t);
  await app.start(CONFIG);
  await app.reading;
  // The old token is revoked: one new token, the zone read again, fine.
  let revoked = true;
  ercot.prices = (call, point) => {
    if (revoked && call.init.headers.Authorization === 'Bearer eyJ.idtoken1.sig') {
      return json({ statusCode: 401, message: 'Invalid JWT.' }, 401);
    }
    return json(report(rowsUntil(localMidnight(call.params.deliveryDateFrom), clock.now(), point)));
  };
  await clock.advance(15 * MINUTE + 1000);
  assert.equal(ercot.tokenCalls().length, 2);
  assert.equal(ercot.priceCalls().length, 5);
  assert.equal(status(gladys).connected, true);
  // Every token refused by the API: a failure, spaced, at most one hour, no refusal.
  revoked = false;
  const times = [];
  ercot.prices = () => {
    times.push(clock.now());
    return json({ statusCode: 401, message: 'Invalid JWT.' }, 401);
  };
  await clock.advance(15 * MINUTE + 1000);
  assert.equal(ercot.tokenCalls().length, 3, 'old token: one new one');
  assert.equal(readData(dataDir).refused, null);
  assert.match(statusText(gladys), /token was not accepted/);
  await clock.advance(10 * HOUR);
  const cycles = times.filter((t0, i) => i === 0 || t0 - times[i - 1] > MINUTE);
  const gaps = cycles.slice(1).map((t0, i) => Math.round((t0 - cycles[i]) / MINUTE));
  assert.deepEqual(gaps.slice(0, 4), [15, 30, 60, 60], 'doubled, one hour at most');
  assert.equal(readData(dataDir).refused, null, 'never a refusal');
  assert.equal(backoff(9, HOUR), HOUR);
});

test('a 400 or 403 of the token endpoint without invalid_grant is not a refusal', async (t) => {
  const { app, gladys, ercot, dataDir } = setup(t);
  ercot.token = () => json({ error: 'unauthorized_client' }, 400);
  await app.start(CONFIG);
  await app.reading;
  assert.equal(readData(dataDir).refused, null);
  assert.match(statusText(gladys), /Read failed \(unexpected HTTP answer\)/);
  assert.equal(readData(dataDir).failures, 1);
});

test('429: Retry-After obeyed and kept across a restart, the button included', async (t) => {
  const { app, gladys, clock, ercot, dataDir } = setup(t);
  ercot.prices = () => json({ error_key: 'throttled' }, 429, { 'retry-after': '7200' });
  await app.start(CONFIG);
  await app.reading;
  assert.equal(ercot.priceCalls().length, 1, 'the cycle stops at the 429');
  const data = readData(dataDir);
  assert.ok(Math.abs(data.pause_until - (data.attempt_at + 2 * HOUR)) < 5000);
  const answer = await gladys.fake.action(ACTION_TEST, {});
  assert.match(JSON.stringify(answer), /paused/);
  await app.stop();
  const again = setup(t, { dataDir, clock });
  await again.app.start(CONFIG);
  await clock.advance(2 * HOUR - MINUTE);
  assert.equal(again.ercot.calls().length, 0);
  await clock.advance(2 * MINUTE);
  assert.equal(again.ercot.priceCalls().length, 2);
});

test('5xx and network failures: 15 min, 30, 60... up to 6 hours, then back', async (t) => {
  const { app, gladys, clock, ercot } = setup(t);
  ercot.prices = () => new Response('', { status: 503 });
  await app.start(CONFIG);
  await app.reading;
  const times = [];
  ercot.prices = () => {
    times.push(clock.now());
    return new Response('', { status: 503 });
  };
  await clock.advance(30 * HOUR);
  const gaps = times.slice(1).map((t0, i) => Math.round((t0 - times[i]) / MINUTE));
  assert.deepEqual(gaps.slice(0, 5), [30, 60, 120, 240, 360]);
  assert.equal(Math.round((times[0] - START) / MINUTE), 15);
  assert.match(statusText(gladys), /ERCOT server error/);
  ercot.prices = (call, point) =>
    json(report(rowsUntil(localMidnight(call.params.deliveryDateFrom), clock.now(), point)));
  await clock.advance(6 * HOUR);
  assert.equal(status(gladys).connected, true);
});

test('one zone unreadable: the other one is read and published', async (t) => {
  const { app, gladys, clock, ercot } = setup(t);
  ercot.prices = (call, point) =>
    point === ZONES.houston
      ? new Response('<html>', { status: 200 })
      : json(report(rowsUntil(localMidnight(call.params.deliveryDateFrom), clock.now(), point)));
  await app.start(CONFIG);
  await app.reading;
  assert.equal(gladys.fake.energyCalendars[calendarKey('houston')].length, 0);
  assert.ok(gladys.fake.energyCalendars[calendarKey('north')].length > 200);
  assert.equal(status(gladys).connected, true);
  assert.match(
    statusText(gladys),
    /last read incomplete \(unreadable answer or unexpected format\)/,
  );
});

test('calendar: a failed publication is sent again, a refused key is not', async (t) => {
  const { app, gladys, clock, dataDir, logger } = setup(t);
  let fail = 500;
  const real = gladys.publishEnergyCalendar.bind(gladys);
  const sent = [];
  t.mock.method(gladys, 'publishEnergyCalendar', async (key, entries) => {
    sent.push([key, entries.length]);
    if (key === calendarKey('houston') && fail) {
      const err = new Error('failed');
      err.status = fail;
      throw err;
    }
    return real(key, entries);
  });
  await app.start(CONFIG);
  await app.reading;
  assert.ok(
    readData(dataDir).zones.houston.slots.every((s) => s[2] === 1),
    'kept as pending',
  );
  assert.ok(
    sent.every(([, n]) => n <= 500),
    'batches of 500 at most',
  );
  fail = 0;
  await clock.advance(15 * MINUTE + 1000);
  const entries = gladys.fake.energyCalendars[calendarKey('houston')];
  assert.ok(entries.length > 280, 'the pending prices were sent');
  assert.ok(readData(dataDir).zones.houston.slots.every((s) => s.length === 2));
  fail = 403;
  await clock.advance(15 * MINUTE);
  const count = sent.length;
  await clock.advance(15 * MINUTE);
  assert.ok(sent.length - count <= 2, 'the refused entries are not sent again');
  assert.equal(logger.lines.filter((l) => /belongs to another integration/.test(l)).length, 1);
  assert.match(
    statusText(gladys),
    /Real-time prices read .*\. Calendars not fed \(other integration\): houston"/,
  );
  // Accepted again: the reason goes away.
  fail = 0;
  await clock.advance(15 * MINUTE);
  assert.doesNotMatch(statusText(gladys), /not fed/);
});

test('calendar status: compact with every zone refused, the price kept; cleared by a new configuration', async (t) => {
  const all = { ...CONFIG, zones: ZONE_KEYS };
  const { app, gladys } = setup(t, { config: all });
  t.mock.method(gladys, 'publishEnergyCalendar', async () => {
    const err = new Error('owned');
    err.status = 403;
    throw err;
  });
  await app.start(all);
  await app.reading;
  const message = status(gladys).message;
  assert.match(
    message.en,
    /^Real-time prices read \(LZ_HOUSTON, LZ_NORTH, LZ_SOUTH, LZ_WEST\), last interval/,
  );
  assert.match(message.en, /Calendars not fed \(other integration\): houston, north, south, west$/);
  assert.match(
    message.fr,
    /Calendriers non alimentés \(autre intégration\) : houston, north, south, west$/,
  );
  assert.ok(message.en.length <= 200 && message.fr.length <= 200);
  await app.start(CONFIG);
  assert.doesNotMatch(statusText(gladys), /not fed/);
});

test('refused, then a click: ERCOT answers but unreadably, the refusal is lifted, the real cause said', async (t) => {
  const { app, gladys, clock, ercot, dataDir } = setup(t);
  ercot.token = () => json({ error: 'invalid_grant' }, 400);
  await app.start(CONFIG);
  await app.reading;
  await clock.advance(MINUTE);
  ercot.token = () => json(TOKEN_ANSWER());
  ercot.prices = () => new Response('not json', { status: 200 });
  const ack = await gladys.fake.action(ACTION_TEST, {});
  assert.match(ack.data.message.en, /Read failed \(unreadable answer or unexpected format\)/);
  assert.equal(readData(dataDir).refused, null);
});

test('calendar entries: aligned, ended, within the host window, never a text', async (t) => {
  const { app, gladys, clock, ercot } = setup(t);
  ercot.prices = (call, point) => {
    const rows = rowsUntil(
      localMidnight(call.params.deliveryDateFrom),
      clock.now() + 2 * HOUR,
      point,
    );
    rows[rows.length - 2][5] = '';
    rows[rows.length - 3][5] = 'N/A';
    return json(report(rows));
  };
  await app.start(CONFIG);
  await app.reading;
  const entries = gladys.fake.energyCalendars[calendarKey('houston')];
  for (const e of entries) {
    const t0 = Date.parse(e.starts_at);
    assert.ok(t0 + SLOT <= START + 1000, 'a future interval is not a real-time price');
    assert.ok(t0 >= START - 5 * 365 * 24 * HOUR);
    assert.equal(typeof e.value, 'number');
    assert.notEqual(e.value, 0);
  }
  const starts = new Set(entries.map((e) => Date.parse(e.starts_at)));
  const holes = [];
  for (let t0 = Date.parse(entries[0].starts_at); t0 + SLOT <= START; t0 += SLOT) {
    if (!starts.has(t0)) holes.push(t0);
  }
  assert.equal(holes.length, 0, 'the text prices fall after now here: nothing missing');
});

test('a price given as text is a hole in the calendar, never 0', async (t) => {
  const { app, gladys, clock, ercot } = setup(t);
  ercot.prices = (call, point) => {
    const rows = rowsUntil(localMidnight(call.params.deliveryDateFrom), clock.now(), point);
    rows[rows.length - 3][5] = '';
    return json(report(rows));
  };
  await app.start(CONFIG);
  await app.reading;
  const entries = gladys.fake.energyCalendars[calendarKey('houston')];
  const hole = Date.parse('2026-11-14T17:15:00Z');
  assert.ok(!entries.some((e) => Date.parse(e.starts_at) === hole));
  assert.ok(entries.some((e) => Date.parse(e.starts_at) === hole + SLOT));
});

test('sensor: dated when 30 minutes late, nothing after 2 hours, never twice', async (t) => {
  const { app, gladys, clock, ercot } = setup(t);
  let lag = 45 * MINUTE;
  ercot.prices = (call, point) =>
    json(report(rowsUntil(localMidnight(call.params.deliveryDateFrom), clock.now() - lag, point)));
  await app.start(CONFIG);
  await app.reading;
  let states = gladys.fake.states.filter((s) => s.device_feature_external_id === PRICE('houston'));
  assert.equal(states.length, 1);
  assert.equal(states[0].created_at, '2026-11-14T17:15:00.000Z');
  // A reconnection publishes nothing again.
  await app.connected();
  await clock.advance(MINUTE);
  states = gladys.fake.states.filter((s) => s.device_feature_external_id === PRICE('houston'));
  assert.equal(states.length, 1);
  // ERCOT publishes nothing new: the next cycle sends nothing again.
  const frozen = clock.now() - lag;
  ercot.prices = (call, point) =>
    json(report(rowsUntil(localMidnight(call.params.deliveryDateFrom), frozen, point)));
  await clock.advance(15 * MINUTE + 1000);
  assert.equal(ercot.priceCalls().length, 4);
  states = gladys.fake.states.filter((s) => s.device_feature_external_id === PRICE('houston'));
  assert.equal(states.length, 1, 'never twice');
  lag = 3 * HOUR;
  const dir = tempDir(t);
  const late = setup(t, { dataDir: dir, clock: createClock(START) });
  late.ercot.prices = (call, point) =>
    json(report(rowsUntil(localMidnight(call.params.deliveryDateFrom), START - lag, point)));
  await late.app.start(CONFIG);
  await late.app.reading;
  assert.equal(late.gladys.fake.states.length, 0, 'too old for the sensor');
  assert.ok(
    late.gladys.fake.energyCalendars[calendarKey('houston')].length > 0,
    'the calendar has it',
  );
  assert.match(statusText(late.gladys), /No recent price/);
});

test('catch-up: after an outage the read starts from the last price known', async (t) => {
  const { app, gladys, clock, ercot } = setup(t);
  await app.start(CONFIG);
  await app.reading;
  ercot.prices = () => new Response('', { status: 502 });
  await clock.advance(20 * HOUR);
  const before = ercot.priceCalls().length;
  ercot.prices = (call, point) =>
    json(report(rowsUntil(localMidnight(call.params.deliveryDateFrom), clock.now(), point)));
  await clock.advance(6 * HOUR + 1000);
  const back = ercot.priceCalls()[before];
  assert.equal(back.params.deliveryDateFrom, '2026-11-14', 'from the last price known');
  assert.equal(back.params.deliveryDateTo, '2026-11-15');
  const entries = gladys.fake.energyCalendars[calendarKey('houston')].map((e) =>
    Date.parse(e.starts_at),
  );
  for (let t0 = entries[0]; t0 + SLOT <= clock.now() - 6 * HOUR; t0 += SLOT) {
    assert.ok(entries.includes(t0), `hole at ${new Date(t0).toISOString()}`);
  }
});

test('getConfig failing in `connected`: status, retried, then started', async (t) => {
  const { app, gladys, clock, ercot } = setup(t);
  let fail = 1;
  const real = gladys.getConfig.bind(gladys);
  t.mock.method(gladys, 'getConfig', async () => {
    if (fail-- > 0) throw new Error('down');
    return real();
  });
  await app.connected();
  assert.match(statusText(gladys), /did not give the configuration/);
  assert.equal(ercot.calls().length, 0);
  await clock.advance(10_000);
  assert.equal(ercot.priceCalls().length, 2);
  assert.equal(status(gladys).connected, true);
});

test('/data unreadable: nothing read, retried on its own timer', async (t) => {
  const dataDir = tempDir(t);
  mkdirSync(join(dataDir, 'state.json'));
  const { app, gladys, clock, ercot } = setup(t, { dataDir });
  await app.start(CONFIG);
  assert.match(statusText(gladys), /unreadable/);
  await clock.advance(HOUR);
  assert.equal(ercot.calls().length, 0);
  rmSync(join(dataDir, 'state.json'), { recursive: true });
  await clock.advance(10_000);
  assert.equal(ercot.priceCalls().length, 2);
});

test('/data unwritable: the attempt cannot be saved, nothing is sent', async (t) => {
  const dataDir = tempDir(t);
  mkdirSync(join(dataDir, 'state.json.tmp'));
  const { app, gladys, clock, ercot } = setup(t, { dataDir });
  await app.start(CONFIG);
  await app.reading;
  assert.equal(ercot.calls().length, 0);
  assert.match(statusText(gladys), /not writable/);
  rmSync(join(dataDir, 'state.json.tmp'), { recursive: true });
  await clock.advance(10_000);
  assert.equal(ercot.priceCalls().length, 2);
});

test('a configuration saved during a read: no false failure, the pace kept', async (t) => {
  const { app, gladys, clock, ercot, dataDir } = setup(t);
  let release;
  ercot.prices = (call) =>
    new Promise((resolve, reject) => {
      release = resolve;
      call.init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  clock.waitFor = undefined;
  await app.start(CONFIG);
  await until(() => ercot.priceCalls().length === 1);
  await app.start({ ...CONFIG, zones: ['west'] });
  assert.equal(readData(dataDir).failures, 0);
  assert.doesNotMatch(statusText(gladys), /failed/);
  assert.equal(typeof release, 'function');
  ercot.prices = (call, point) =>
    json(report(rowsUntil(localMidnight(call.params.deliveryDateFrom), clock.now(), point)));
  clock.waitFor = () => app.reading;
  await clock.advance(15 * MINUTE - 2000);
  assert.equal(ercot.priceCalls().length, 1, 'the pace counts from the stopped read');
  await clock.advance(3000);
  assert.equal(ercot.priceCalls().at(-1).params.settlementPoint, ZONES.west);
});

test('a configuration error says which field, and nothing is read', async (t) => {
  const { app, gladys, clock, ercot } = setup(t);
  await app.start({ ...CONFIG, password: '' });
  assert.match(statusText(gladys), /Enter the password/);
  await clock.advance(HOUR);
  assert.equal(ercot.calls().length, 0);
  const answer = await gladys.fake.action(ACTION_TEST, {});
  assert.match(JSON.stringify(answer), /Enter the password/);
});

test('the status never leaks a secret, whatever the failure', async (t) => {
  const { app, gladys, clock, ercot, logger, dataDir } = setup(t);
  ercot.token = () =>
    json({ error: 'invalid_request', error_description: `bad ${PASSWORD} ${USER}` }, 400);
  await app.start(CONFIG);
  await app.reading;
  ercot.token = () => {
    throw new Error(`socket ${PASSWORD}`);
  };
  await clock.advance(HOUR);
  ercot.token = () => json(TOKEN_ANSWER());
  ercot.prices = () => json({ message: `${KEY} unknown` }, 400);
  await clock.advance(HOUR);
  assertNoSecret({ logger, dataDir, gladys });
});

test('a 401 on a token just given: no second token, a failure', async (t) => {
  const { app, gladys, ercot, dataDir } = setup(t);
  ercot.prices = () => json({ statusCode: 401, message: 'Invalid JWT.' }, 401);
  await app.start(CONFIG);
  await app.reading;
  assert.equal(ercot.tokenCalls().length, 1);
  assert.equal(ercot.priceCalls().length, 1);
  assert.equal(readData(dataDir).refused, null);
  assert.equal(readData(dataDir).failures, 1);
  assert.match(statusText(gladys), /token was not accepted/);
});

test('/data with a pause far in the future: invalid, the pace is the normal one', async (t) => {
  const dataDir = tempDir(t);
  writeFileSync(
    join(dataDir, 'state.json'),
    JSON.stringify({
      v: 1,
      attempt_at: START - 20 * MINUTE,
      failures: 3,
      pause_until: START + 10 * 24 * HOUR,
    }),
  );
  const { app, ercot } = setup(t, { dataDir });
  await app.start(CONFIG);
  await app.reading;
  assert.equal(ercot.priceCalls().length, 2, 'read at once: the pause is not believed');
});

test('/data corrupt: read as a read just made (never sooner than 15 minutes)', async (t) => {
  const dataDir = tempDir(t);
  writeFileSync(join(dataDir, 'state.json'), '{not json');
  const { app, clock, ercot } = setup(t, { dataDir });
  await app.start(CONFIG);
  await clock.advance(15 * MINUTE - 1000);
  assert.equal(ercot.calls().length, 0);
  await clock.advance(2000);
  assert.equal(ercot.priceCalls().length, 2);
});

test('refused: no timer left, and a pending /data retry never reads by itself', async (t) => {
  const { app, clock, ercot, dataDir } = setup(t);
  ercot.token = () => json({ error: 'invalid_grant' }, 400);
  await app.start(CONFIG);
  await app.reading;
  assert.equal(app.readDueMono, undefined);
  assert.deepEqual(clock.pending(), [], 'no read scheduled while refused');
  // The button's try cannot save its attempt: it waits for /data, then the
  // retry must not send the refused credentials by itself.
  await clock.advance(MINUTE);
  mkdirSync(join(dataDir, 'state.json.tmp'));
  const ack = await app.testConnection();
  assert.match(ack.en, /refused/);
  assert.equal(ercot.calls().length, 1);
  rmSync(join(dataDir, 'state.json.tmp'), { recursive: true });
  await clock.advance(HOUR);
  assert.equal(ercot.calls().length, 1);
});

test('a timer firing early does not read early (monotonic check)', async (t) => {
  const { app, clock, ercot } = setup(t);
  await app.start(CONFIG);
  await app.reading;
  assert.equal(ercot.priceCalls().length, 2);
  await clock.fireEarly();
  assert.equal(ercot.priceCalls().length, 2, 'the timer re-arms itself');
  await clock.advance(15 * MINUTE + 1000);
  assert.equal(ercot.priceCalls().length, 4);
});

test('every zone without a readable price: not connected, the real cause, the 15-minute pace', async (t) => {
  const breaks = [
    () => new Response('not json', { status: 200 }),
    () => json({ ...report([]), data: {} }),
    (call, point, clock) => {
      const rows = rowsUntil(localMidnight(call.params.deliveryDateFrom), clock.now(), point);
      return json(report(rows.map((r) => [r[0], '01:00', ...r.slice(2)])));
    },
  ];
  for (const broken of breaks) {
    const { app, gladys, clock, ercot, logger, dataDir } = setup(t);
    await app.start(CONFIG);
    await app.reading;
    assert.equal(status(gladys).connected, true);
    ercot.prices = (call, point) => broken(call, point, clock);
    await clock.advance(15 * MINUTE + 1000);
    assert.equal(status(gladys).connected, false);
    assert.match(statusText(gladys), /Read failed \(unreadable answer or unexpected format\)/);
    assert.ok(logger.lines.some((l) => /No zone read: answer/.test(l)));
    const before = ercot.priceCalls().length;
    await clock.advance(15 * MINUTE);
    assert.equal(ercot.priceCalls().length, before + 2, 'the pace goes on, no pause');
    assert.equal(readData(dataDir).pause_until, 0);
    await app.stop();
  }
});

test('some rows unreadable: left out, logged once per zone', async (t) => {
  const { app, clock, ercot, logger } = setup(t);
  ercot.prices = (call, point) => {
    const rows = rowsUntil(localMidnight(call.params.deliveryDateFrom), clock.now(), point);
    rows[5][5] = 'N/A';
    rows[6][1] = '01:00';
    return json(report(rows));
  };
  await app.start(CONFIG);
  await app.reading;
  await clock.advance(15 * MINUTE + 1000);
  const lines = logger.lines.filter((l) => /price rows unreadable/.test(l));
  assert.deepEqual(lines, [
    'warn 2 houston price rows unreadable, left out',
    'warn 2 north price rows unreadable, left out',
  ]);
});

test('negative prices are published as they are, the 5,000 $/MWh cap kept', async (t) => {
  const { app, gladys, clock, ercot } = setup(t);
  ercot.prices = (call, point) => {
    const rows = rowsUntil(localMidnight(call.params.deliveryDateFrom), clock.now(), point);
    rows.at(-1)[5] = -250;
    rows.at(-2)[5] = 5000;
    rows.at(-3)[5] = 10_000.01;
    return json(report(rows));
  };
  await app.start(CONFIG);
  await app.reading;
  const entries = gladys.fake.energyCalendars[calendarKey('houston')];
  const at = (iso) => entries.find((e) => e.starts_at === iso)?.value;
  assert.equal(at('2026-11-14T17:45:00.000Z'), -0.25);
  assert.equal(at('2026-11-14T17:30:00.000Z'), 5);
  assert.equal(at('2026-11-14T17:15:00.000Z'), undefined, 'beyond 10,000: unknown');
  assert.equal(gladys.fake.lastState(PRICE('houston')), -250);
});

test('new credentials: the token of the old ones is dropped and never used', async (t) => {
  const { app, clock, ercot } = setup(t);
  await app.start(CONFIG);
  await app.reading;
  assert.ok(app.token);
  await app.start({ ...CONFIG, password: 'a new one' });
  assert.equal(app.token, undefined, 'not kept in memory');
  await clock.advance(15 * MINUTE + 1000);
  const tokens = ercot.tokenCalls();
  assert.equal(tokens.length, 2);
  assert.equal(tokens[1].form.password, 'a new one');
  assert.equal(ercot.priceCalls().at(-1).init.headers.Authorization, 'Bearer eyJ.idtoken2.sig');
});

test('a token of other credentials is not used, even if it is still in memory', async (t) => {
  const { app, clock, ercot } = setup(t);
  await app.start(CONFIG);
  await app.reading;
  const old = app.token;
  await app.start({ ...CONFIG, subscription_key: 'fedcba9876543210fedcba9876543210' });
  app.token = old;
  await clock.advance(15 * MINUTE + 1000);
  assert.equal(ercot.tokenCalls().length, 2);
});

test('a stop during the attempt write: nothing is sent afterwards', async (t) => {
  const { app, clock, ercot } = setup(t);
  let release;
  const real = app.store.save.bind(app.store);
  t.mock.method(app.store, 'save', async (state) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    return real(state);
  });
  clock.waitFor = undefined;
  const started = app.start(CONFIG);
  await until(() => release);
  const stopped = app.stop();
  release();
  await started;
  await stopped;
  await clock.advance(HOUR);
  assert.equal(ercot.calls().length, 0);
});

test('/data slots: unaligned or future ones are not read back', async (t) => {
  const dataDir = tempDir(t);
  const slot = Date.parse('2026-11-14T17:00:00Z');
  writeFileSync(
    join(dataDir, 'state.json'),
    JSON.stringify({
      v: 1,
      attempt_at: START - MINUTE,
      zones: {
        houston: {
          slots: [
            [slot, 10],
            [slot + 60_000, 11],
            [START + 2 * HOUR - (START % SLOT), 12],
          ],
          state_t: 0,
        },
      },
    }),
  );
  const { app } = setup(t, { dataDir });
  await app.start(CONFIG);
  assert.deepEqual(
    app.state.zones.houston.slots.map((s) => s.t),
    [slot],
  );
});

test('sensor: the running interval read back from /data is never sent', async (t) => {
  const dataDir = tempDir(t);
  const running = START - (START % SLOT);
  writeFileSync(
    join(dataDir, 'state.json'),
    JSON.stringify({
      v: 1,
      attempt_at: START - HOUR,
      zones: { houston: { slots: [[running, 77.5]], state_t: 0 } },
    }),
  );
  const { app, gladys, ercot } = setup(t, { dataDir });
  ercot.prices = (call, point) =>
    json(report(rowsUntil(localMidnight(call.params.deliveryDateFrom), START - HOUR, point)));
  await app.start(CONFIG);
  await app.reading;
  const states = gladys.fake.states.filter(
    (s) => s.device_feature_external_id === PRICE('houston'),
  );
  assert.ok(
    states.every((s) => s.state !== 77.5),
    'an interval not ended is not a price',
  );
});

test('after an outage longer than 3 days, the read goes 3 days back, no more', async (t) => {
  const { app, clock, ercot } = setup(t);
  await app.start(CONFIG);
  await app.reading;
  ercot.prices = () => new Response('', { status: 503 });
  await clock.advance(4 * 24 * HOUR);
  const before = ercot.priceCalls().length;
  ercot.prices = (call, point) =>
    json(report(rowsUntil(localMidnight(call.params.deliveryDateFrom), clock.now(), point)));
  await clock.advance(7 * HOUR);
  const back = ercot.priceCalls()[before];
  const wall = Date.parse(back.params.deliveryDateTo + 'T12:00:00Z');
  assert.ok(
    back.params.deliveryDateFrom >=
      new Date(wall - 3 * 24 * HOUR - 24 * HOUR).toISOString().slice(0, 10),
  );
  assert.ok(back.params.deliveryDateFrom > '2026-11-14', `from ${back.params.deliveryDateFrom}`);
});

test('prices older than 3 days are neither kept nor published', async (t) => {
  const { app, gladys, clock, ercot, dataDir } = setup(t);
  // An answer that ignores the dates asked: 6 days of prices.
  ercot.prices = (call, point) =>
    json(report(rowsUntil(START - 6 * 24 * HOUR, clock.now(), point)));
  await app.start(CONFIG);
  await app.reading;
  const oldest = START - 3 * 24 * HOUR - 1000;
  const entries = gladys.fake.energyCalendars[calendarKey('houston')];
  assert.ok(entries.every((e) => Date.parse(e.starts_at) >= oldest));
  assert.ok(readData(dataDir).zones.houston.slots.every(([t0]) => t0 >= oldest));
});

test('the wall clock going back during a cycle does not delay the next one', async (t) => {
  const { app, clock, ercot } = setup(t);
  ercot.prices = (call, point) => {
    if (ercot.priceCalls().length === 1) clock.jumpWall(-2 * HOUR);
    return json(report(rowsUntil(localMidnight(call.params.deliveryDateFrom), clock.now(), point)));
  };
  await app.start(CONFIG);
  await app.reading;
  await clock.advance(15 * MINUTE + 1000);
  assert.equal(ercot.priceCalls().length, 4, 'monotonic pace');
});

test('a reconnection sends the status again (Gladys keeps it in memory only)', async (t) => {
  const { app, gladys } = setup(t, { config: { ...CONFIG, password: '' } });
  await app.start({ ...CONFIG, password: '' });
  const sent = [];
  t.mock.method(gladys, 'setConnectionStatus', async (...args) => {
    sent.push(args);
  });
  await app.connected();
  assert.equal(sent.length, 1);
  assert.match(JSON.stringify(sent[0]), /Enter the password/);
});

test('a configuration saved after the wall clock went back keeps the monotonic pace', async (t) => {
  const { app, clock, ercot } = setup(t);
  await app.start(CONFIG);
  await app.reading;
  clock.jumpWall(-2 * HOUR);
  await clock.advance(10 * MINUTE);
  await app.start(CONFIG);
  await clock.advance(5 * MINUTE + 1000);
  assert.equal(
    ercot.priceCalls().length,
    4,
    '15 minutes after the last attempt, not after the reload',
  );
});
