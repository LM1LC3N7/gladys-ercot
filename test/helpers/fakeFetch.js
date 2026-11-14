// -----------------------------------------------------------------------------
// Fake `fetch` for the tests: routes requests to handlers, records every
// call, and fails loudly on an unexpected URL. No test touches the network.
// Also builds synthetic ERCOT answers (no recorded data is shipped).
// -----------------------------------------------------------------------------

import { setFetch } from '../../src/http.js';
import { HOUR, SLOT } from '../../src/constants.js';
import { localDate, localParts } from '../../src/time.js';

setFetch(async (url) => {
  throw new Error(`Network call without a fake fetch in a test: ${url}`);
});

export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/**
 * Install a fake fetch. `routes` is a list of [pattern, handler]: the first
 * route whose RegExp matches the URL answers handler(call), `call` being
 * `{ url, params, init, form }` with the query and the form body parsed.
 */
export function installFetch(routes) {
  const calls = [];
  const previous = setFetch(async (url, init = {}) => {
    const call = {
      url,
      params: Object.fromEntries(new URL(url).searchParams),
      init,
      form: typeof init.body === 'string' ? Object.fromEntries(new URLSearchParams(init.body)) : {},
    };
    calls.push(call);
    const route = routes.find(([pattern]) => pattern.test(url));
    if (!route) throw new Error(`Unexpected network call in a test: ${url}`);
    return route[1](call);
  });
  return { calls, restore: () => setFetch(previous) };
}

export const FIELDS = [
  'deliveryDate',
  'deliveryHour',
  'deliveryInterval',
  'settlementPoint',
  'settlementPointType',
  'settlementPointPrice',
  'DSTFlag',
];

/** An ERCOT report answer with these rows (arrays in FIELDS order). */
export function report(rows) {
  return {
    _meta: { totalRecords: rows.length, pageSize: 1000, totalPages: 1, currentPage: 1 },
    report: { reportEMIL: 'NP6-905-CD', reportName: 'spp_node_zone_hub' },
    fields: FIELDS.map((name) => ({ name, label: name })),
    data: rows,
  };
}

/** The ERCOT row of the 15-minute interval starting at `t` (outside the change-of-time days). */
export function rowAt(t, point, price, { type = 'LZ' } = {}) {
  // The local clock of the interval start: hour ending = local hour + 1.
  const { h, mi } = localParts(t);
  return [localDate(t), h + 1, mi / 15 + 1, point, type, price, false];
}

/** A price that depends on the interval and the point (to tell answers apart). */
export const priceAt = (t, point = 'LZ_HOUSTON') =>
  Math.round((((t / SLOT) % 97) + point.length) * 100 + 1234) / 100;

/** Rows of every ended interval from `from` to `now` (exclusive of the running one). */
export function rowsUntil(from, now, point) {
  const rows = [];
  for (let t = Math.ceil(from / SLOT) * SLOT; t + SLOT <= now; t += SLOT) {
    rows.push(rowAt(t, point, priceAt(t, point)));
  }
  return rows;
}

export const TOKEN_ANSWER = (n = 1) => ({
  access_token: `access.${n}`,
  token_type: 'Bearer',
  expires_in: '3600',
  refresh_token: `refresh.${n}`,
  id_token: `eyJ.idtoken${n}.sig`,
});

export { HOUR };
