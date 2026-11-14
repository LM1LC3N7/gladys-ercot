// -----------------------------------------------------------------------------
// The ERCOT answers, checked field by field, and the requests sent: the token
// asked with the credentials in the form body (never the URL), the prices with
// the token and the subscription key in headers only.
// -----------------------------------------------------------------------------

import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AnswerError,
  RefusedError,
  fetchPrices,
  fetchToken,
  parsePrices,
  pricesUrl,
} from '../src/ercot.js';
import { BodyError, HttpError, requestJson, retryAfterMs } from '../src/http.js';
import { CLIENT_ID, MAX_ROWS, USER_AGENT } from '../src/constants.js';
import { FIELDS, TOKEN_ANSWER, installFetch, json, report } from './helpers/fakeFetch.js';

let fake;
afterEach(() => fake?.restore());

const P = 'LZ_HOUSTON';
const row = (date, he, i, price, { point = P, type = 'LZ', dst = false } = {}) => [
  date,
  he,
  i,
  point,
  type,
  price,
  dst,
];
const iso = (slots) => slots.map(({ t, p }) => [new Date(t).toISOString(), p]);

test('prices: the rows of the point and type asked, in order, $/MWh', () => {
  const slots = parsePrices(
    report([
      row('2026-11-14', 1, 2, 21.5),
      row('2026-11-14', 1, 1, -3.25),
      row('2026-11-14', 1, 3, 30, { point: 'LZ_NORTH' }),
      row('2026-11-14', 1, 3, 31, { type: 'LZEW' }),
      row('2026-11-14', 1, 4, '1234.56'),
    ]),
    P,
  );
  assert.deepEqual(iso(slots), [
    ['2026-11-14T06:00:00.000Z', -3.25],
    ['2026-11-14T06:15:00.000Z', 21.5],
    ['2026-11-14T06:45:00.000Z', 1234.56],
  ]);
});

test('prices: columns found by name, rows as objects, Y/N flags and US dates read', () => {
  const fields = [...FIELDS].reverse();
  const body = report([]);
  body.fields = fields.map((name) => ({ name }));
  // Reversed field order: the row follows it.
  body.data = [[true, 40, 'LZ', P, 1, 2, '2026-11-01']];
  assert.deepEqual(iso(parsePrices(body, P)), [['2026-11-01T07:00:00.000Z', 40]]);
  const objects = report([]);
  delete objects.fields;
  objects.data = [
    {
      deliveryDate: '11/14/2026',
      deliveryHour: '01',
      deliveryInterval: '1',
      settlementPoint: P,
      settlementPointType: 'LZ',
      settlementPointPrice: 12,
      DSTFlag: 'N',
    },
  ];
  assert.deepEqual(iso(parsePrices(objects, P)), [['2026-11-14T06:00:00.000Z', 12]]);
});

test('prices: a missing, textual or out-of-range price is unknown, never 0', () => {
  const bad = [null, '', ' ', 'N/A', '12,5', '1e3', true, {}, [], NaN, 10_001, -10_001, Infinity];
  const rows = bad.map((price, i) => row('2026-11-14', 2, (i % 4) + 1, price));
  rows.push(row('2026-11-14', 3, 1, 0));
  const slots = parsePrices(report(rows), P);
  assert.deepEqual(iso(slots), [['2026-11-14T08:00:00.000Z', 0]], 'only the real 0');
});

test('prices: an unreadable flag, hour or interval leaves the row out', () => {
  const slots = parsePrices(
    report([
      row('2026-11-14', 1, 1, 10, { dst: 'maybe' }),
      row('2026-11-14', 1, 1, 10, { dst: null }),
      row('2026-11-14', '1a', 1, 10),
      row('2026-11-14', 1, 1.5, 10),
      row('2026-11-14', 1, 5, 10),
      row('2026-11-14', 1, 1, 10, { dst: true }),
      row('2026-13-01', 1, 1, 10),
    ]),
    P,
  );
  assert.deepEqual(slots, []);
});

test('prices: two prices for one instant are both left out; the spring hour read once', () => {
  const slots = parsePrices(
    report([
      row('2026-11-14', 1, 1, 10),
      row('2026-11-14', 1, 1, 11),
      row('2026-11-14', 1, 2, 12),
      row('2026-11-14', 1, 2, 12),
      // Spring: 02 and 03 name the same hour: if both come, they disagree.
      row('2026-03-08', 2, 1, 20),
      row('2026-03-08', 3, 1, 21),
      row('2026-03-08', 3, 2, 22),
    ]),
    P,
  );
  assert.deepEqual(iso(slots), [
    ['2026-03-08T07:15:00.000Z', 22],
    ['2026-11-14T06:15:00.000Z', 12],
  ]);
});

test('prices: the envelope must be this report', () => {
  assert.throws(() => parsePrices([], P), AnswerError);
  assert.throws(() => parsePrices(null, P), AnswerError);
  assert.throws(() => parsePrices({ fields: [] }, P), AnswerError);
  const other = report([]);
  other.report.reportEMIL = 'NP4-190-CD';
  assert.throws(() => parsePrices(other, P), AnswerError);
  const polluted = JSON.parse('{"data":[{"__proto__":{"settlementPoint":"LZ_HOUSTON"}}]}');
  assert.deepEqual(parsePrices(polluted, P), []);
});

test('prices: rows beyond MAX_ROWS are not read', () => {
  const rows = [];
  for (let i = 0; i < MAX_ROWS + 50; i += 1) rows.push(row('2026-11-14', 1, 1, 'x'));
  rows.push(row('2026-11-14', 1, 1, 10));
  assert.deepEqual(parsePrices(report(rows), P), []);
});

test('token: POST, credentials in the form body only, the documented client id', async () => {
  fake = installFetch([[/b2clogin/, () => json(TOKEN_ANSWER())]]);
  const { token, lifetime } = await fetchToken({ username: 'jane@example.com', password: 'p&w=1' });
  assert.equal(token, 'eyJ.idtoken1.sig');
  assert.equal(lifetime, 3600_000);
  const [call] = fake.calls;
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.redirect, 'manual');
  assert.deepEqual(call.params, {}, 'nothing in the URL');
  assert.doesNotMatch(call.url, /jane|p%26w|password/);
  assert.equal(call.form.username, 'jane@example.com');
  assert.equal(call.form.password, 'p&w=1');
  assert.equal(call.form.grant_type, 'password');
  assert.equal(call.form.client_id, CLIENT_ID);
  assert.equal(call.form.response_type, 'id_token');
  assert.equal(call.init.headers['User-Agent'], USER_AGENT);
  assert.equal(call.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
});

test('token: only an OAuth invalid_grant is a refusal', async () => {
  const cases = [
    [json({ error: 'invalid_grant', error_description: 'AADB2C90225' }, 400), RefusedError],
    [json({ error: 'invalid_grant' }, 401), RefusedError],
    [json({ error: 'invalid_request' }, 400), HttpError],
    [json({ error: 'invalid_grant' }, 403), HttpError],
    [new Response('<html>bad gateway</html>', { status: 400 }), HttpError],
    [json({ error: 'invalid_grant' }, 503), HttpError],
    [json({ token_type: 'Bearer' }), AnswerError],
    [json({ id_token: 'a b' }), AnswerError],
    [json({ id_token: 'x'.repeat(20_000) }), AnswerError],
    [new Response('not json', { status: 200 }), BodyError],
  ];
  for (const [answer, type] of cases) {
    fake?.restore();
    fake = installFetch([[/b2clogin/, () => answer.clone()]]);
    await assert.rejects(fetchToken({ username: 'u', password: 'p' }), type);
  }
});

test('token: expires_in bounded between 5 minutes and one hour', async () => {
  for (const [given, ms] of [
    ['600', 600_000],
    [7200, 3600_000],
    ['10', 300_000],
    ['soon', 3600_000],
    [undefined, 3600_000],
  ]) {
    fake?.restore();
    fake = installFetch([[/b2clogin/, () => json({ id_token: 'a.b.c', expires_in: given })]]);
    assert.equal((await fetchToken({ username: 'u', password: 'p' })).lifetime, ms);
  }
});

test('prices request: token and key in headers, the zone and dates in the query', async () => {
  fake = installFetch([[/api\.ercot\.com/, () => json(report([row('2026-11-14', 1, 1, 9)]))]]);
  const { slots } = await fetchPrices({
    token: 'tok.en.1',
    key: 'k'.repeat(32),
    point: P,
    from: '2026-11-13',
    to: '2026-11-14',
  });
  assert.equal(slots.length, 1);
  const [call] = fake.calls;
  assert.equal(call.url, pricesUrl(P, '2026-11-13', '2026-11-14'));
  assert.deepEqual(call.params, {
    deliveryDateFrom: '2026-11-13',
    deliveryDateTo: '2026-11-14',
    settlementPoint: P,
    settlementPointType: 'LZ',
    size: '1000',
  });
  assert.equal(call.init.headers.Authorization, 'Bearer tok.en.1');
  assert.equal(call.init.headers['Ocp-Apim-Subscription-Key'], 'k'.repeat(32));
});

test('prices request: a 401 naming the subscription key is a key refusal, other 401s are not', async () => {
  const args = { token: 't', key: 'k', point: P, from: '2026-11-14', to: '2026-11-14' };
  fake = installFetch([
    [
      /api/,
      () =>
        json(
          {
            statusCode: 401,
            message:
              'Access denied due to invalid subscription key. Make sure to provide a valid key.',
          },
          401,
        ),
    ],
  ]);
  await assert.rejects(
    fetchPrices(args),
    (err) => err instanceof RefusedError && err.kind === 'key',
  );
  fake.restore();
  fake = installFetch([[/api/, () => json({ statusCode: 401, message: 'Invalid JWT.' }, 401)]]);
  await assert.rejects(fetchPrices(args), (err) => err instanceof HttpError && err.status === 401);
  fake.restore();
  fake = installFetch([[/api/, () => json({ message: 'subscription key' }, 403)]]);
  await assert.rejects(fetchPrices(args), (err) => err instanceof HttpError && err.status === 403);
});

test('http: a redirect is not followed, an oversized body is cut before its end', async () => {
  fake = installFetch([
    [/redirect/, () => new Response(null, { status: 302, headers: { location: 'https://evil' } })],
    [
      /big/,
      () => {
        let sent = 0;
        const stream = new ReadableStream({
          pull(controller) {
            sent += 1;
            if (sent > 1000) throw new Error('read to the end');
            controller.enqueue(new Uint8Array(64 * 1024).fill(32));
          },
        });
        return new Response(stream, { status: 200 });
      },
    ],
    [
      /declared/,
      () => new Response('{}', { status: 200, headers: { 'content-length': '999999' } }),
    ],
  ]);
  await assert.rejects(
    requestJson('https://x/redirect'),
    (e) => e instanceof HttpError && e.status === 302,
  );
  await assert.rejects(requestJson('https://x/big', { limit: 1024 * 1024 }), BodyError);
  await assert.rejects(requestJson('https://x/declared', { limit: 1000 }), BodyError);
});

test('http: a request that never answers ends at its timeout; an abort says stopped', async () => {
  fake = installFetch([
    [
      /slow/,
      (call) =>
        new Promise((_, reject) => {
          call.init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    ],
  ]);
  await assert.rejects(requestJson('https://x/slow', { timeout: 20 }), /no answer in time/);
  const controller = new AbortController();
  const pending = requestJson('https://x/slow', { timeout: 10_000, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /stopped/);
});

test('Retry-After: seconds, or a date against the answer Date header only', () => {
  assert.equal(retryAfterMs('120'), 120_000);
  assert.equal(
    retryAfterMs('Sat, 14 Nov 2026 12:10:00 GMT', 'Sat, 14 Nov 2026 12:00:00 GMT'),
    600_000,
  );
  assert.equal(retryAfterMs('Sat, 14 Nov 2026 12:10:00 GMT'), undefined);
  assert.equal(retryAfterMs('soon'), undefined);
  assert.equal(retryAfterMs(undefined), undefined);
});
