// -----------------------------------------------------------------------------
// The ERCOT Public API: the ID token and the real-time Settlement Point Prices
// of a load zone, every answer checked field by field. No state here.
// -----------------------------------------------------------------------------

import {
  CLIENT_ID,
  MAX_ROWS,
  MAX_TOKEN_LENGTH,
  PAGE_SIZE,
  POINT_TYPE,
  PRICE_MAX,
  PRICE_MIN,
  SPP_MAX_BYTES,
  SPP_REPORT,
  SPP_URL,
  TOKEN_MAX_BYTES,
  TOKEN_SCOPE,
  TOKEN_URL,
} from './constants.js';
import { HttpError, requestJson } from './http.js';
import { intervalStart } from './time.js';

/** An answer that is not what was asked (never a refusal of the credentials). */
export class AnswerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AnswerError';
  }
}

/** The account refused: `kind` is 'login' (user name or password) or 'key' (subscription key). */
export class RefusedError extends Error {
  constructor(kind) {
    super(kind === 'key' ? 'subscription key refused' : 'user name or password refused');
    this.name = 'RefusedError';
    this.kind = kind;
  }
}

const TOKEN = /^[A-Za-z0-9._-]+$/;

/**
 * Ask an ID token. Resolves `{ token, lifetime }` (ms). A refusal of the
 * credentials is only an OAuth `invalid_grant` answer (400 or 401 with that
 * JSON error): any other 4xx, a 403, an unreadable answer is an ordinary
 * failure, never a refusal.
 */
export async function fetchToken({ username, password, signal }) {
  let answer;
  try {
    answer = await requestJson(TOKEN_URL, {
      method: 'POST',
      form: {
        username,
        password,
        grant_type: 'password',
        scope: TOKEN_SCOPE,
        client_id: CLIENT_ID,
        response_type: 'id_token',
      },
      limit: TOKEN_MAX_BYTES,
      signal,
    });
  } catch (err) {
    if (
      err instanceof HttpError &&
      (err.status === 400 || err.status === 401) &&
      err.body?.error === 'invalid_grant'
    ) {
      throw new RefusedError('login');
    }
    throw err;
  }
  const body = answer.body;
  const token = body?.id_token;
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH || !TOKEN.test(token)) {
    throw new AnswerError('no ID token in the answer');
  }
  // `expires_in` is a text in the documented example ("3600"): one hour at
  // most, 5 minutes at least; unreadable = one hour.
  const text = typeof body.expires_in === 'number' ? String(body.expires_in) : body.expires_in;
  const seconds = typeof text === 'string' && /^\d{1,6}$/.test(text) ? Number(text) : 3600;
  return { token, lifetime: Math.min(3600, Math.max(300, seconds)) * 1000 };
}

/** The URL of the prices of a settlement point between two local dates. */
export function pricesUrl(point, from, to) {
  const url = new URL(SPP_URL);
  url.searchParams.set('deliveryDateFrom', from);
  url.searchParams.set('deliveryDateTo', to);
  url.searchParams.set('settlementPoint', point);
  url.searchParams.set('settlementPointType', POINT_TYPE);
  url.searchParams.set('size', String(PAGE_SIZE));
  return url.toString();
}

/** Whether a 401 of the API is a refusal of the subscription key (Azure API Management wording). */
export function keyRefused(err) {
  if (!(err instanceof HttpError) || err.status !== 401) return false;
  const message = err.body?.message;
  return typeof message === 'string' && /subscription key/i.test(message);
}

/** Read the prices of a settlement point: `{ slots: [{ t, p }], date }` sorted by start. */
export async function fetchPrices({ token, key, point, from, to, signal }) {
  try {
    const { body, date } = await requestJson(pricesUrl(point, from, to), {
      headers: { Authorization: `Bearer ${token}`, 'Ocp-Apim-Subscription-Key': key },
      limit: SPP_MAX_BYTES,
      signal,
    });
    return { slots: parsePrices(body, point), date };
  } catch (err) {
    if (keyRefused(err)) throw new RefusedError('key');
    throw err;
  }
}

/** A strict number: a JSON number or a decimal text. '' or null is unknown, never 0. */
export function strictNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return /^-?\d{1,7}(\.\d{1,6})?$/.test(text) ? Number(text) : undefined;
}

/** A strict integer: a JSON integer or 1-2 digits. */
function strictInteger(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
  if (typeof value === 'string' && /^\d{1,2}$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

/** The DSTFlag: true, false, or undefined when unreadable. */
function flag(value) {
  if (value === true || value === 'Y' || value === 'true') return true;
  if (value === false || value === 'N' || value === 'false') return false;
  return undefined;
}

/** The delivery date as YYYY-MM-DD (the API's format), MM/DD/YYYY (ERCOT's files) accepted. */
function deliveryDate(value) {
  if (typeof value !== 'string') return undefined;
  const us = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  return us ? `${us[3]}-${us[1]}-${us[2]}` : value;
}

const FIELDS = [
  'deliveryDate',
  'deliveryHour',
  'deliveryInterval',
  'settlementPoint',
  'settlementPointType',
  'settlementPointPrice',
  'DSTFlag',
];

/**
 * The prices of an answer, in $/MWh: `[{ t, p }]` sorted by start. A row of
 * another point or type, with a missing, textual or out-of-range price, or an
 * interval that does not exist is left out (an unknown interval stays
 * unknown). Two different prices for one instant: both left out. Throws
 * AnswerError when the envelope is not this report.
 */
export function parsePrices(body, point) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new AnswerError('not an ERCOT report');
  }
  const emil = body.report?.reportEMIL;
  if (emil !== undefined && String(emil).toUpperCase() !== SPP_REPORT) {
    throw new AnswerError('another ERCOT report');
  }
  if (!Array.isArray(body.data)) throw new AnswerError('no data in the answer');
  const names = Array.isArray(body.fields) ? body.fields.map((f) => f?.name) : undefined;
  const index = {};
  for (const name of FIELDS) {
    index[name] = names ? names.indexOf(name) : -1;
  }
  const read = (row, name) => {
    if (Array.isArray(row)) return index[name] >= 0 ? row[index[name]] : undefined;
    return row && typeof row === 'object' && Object.hasOwn(row, name) ? row[name] : undefined;
  };
  const prices = new Map();
  const conflicts = new Set();
  for (const row of body.data.slice(0, MAX_ROWS)) {
    if (read(row, 'settlementPoint') !== point) continue;
    if (read(row, 'settlementPointType') !== POINT_TYPE) continue;
    const p = strictNumber(read(row, 'settlementPointPrice'));
    if (p === undefined || p < PRICE_MIN || p > PRICE_MAX) continue;
    const repeated = flag(read(row, 'DSTFlag'));
    if (repeated === undefined) continue;
    const t = intervalStart(
      deliveryDate(read(row, 'deliveryDate')),
      strictInteger(read(row, 'deliveryHour')),
      strictInteger(read(row, 'deliveryInterval')),
      repeated,
    );
    if (t === undefined) continue;
    if (prices.has(t) && prices.get(t) !== p) conflicts.add(t);
    prices.set(t, p);
  }
  for (const t of conflicts) prices.delete(t);
  return [...prices.entries()].map(([t, p]) => ({ t, p })).sort((a, b) => a.t - b.t);
}
