// -----------------------------------------------------------------------------
// The only place that talks to the network: one request with a timeout, an
// identifiable User-Agent, no redirect followed (a redirect would carry the
// token elsewhere) and a bounded body. The tests replace `fetch` with
// `setFetch()`. Errors never carry a header, a body or a URL with a secret.
// -----------------------------------------------------------------------------

import { REQUEST_TIMEOUT, USER_AGENT } from './constants.js';

let fetchImpl = (...args) => globalThis.fetch(...args);

/** Replace the fetch implementation (tests only). Returns the previous one. */
export function setFetch(impl) {
  const previous = fetchImpl;
  fetchImpl = impl;
  return previous;
}

/** A non-2xx answer: its status, Retry-After, Date and its body (bounded, parsed if JSON). */
export class HttpError extends Error {
  constructor(status, { retryAfter, date, body } = {}) {
    super(`HTTP ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.retryAfter = retryAfter;
    this.date = date;
    this.body = body;
  }
}

export class BodyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BodyError';
  }
}

/** Read a body, aborting as soon as it exceeds `limit` bytes. */
async function readBounded(response, limit, controller) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    controller.abort();
    throw new BodyError('answer too large');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      controller.abort();
      await reader.cancel().catch(() => {});
      throw new BodyError('answer too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Send a request and read a JSON answer: `{ body, date }`. Throws HttpError
 * on a non-2xx status (a 3xx included), BodyError on an oversized or non-JSON
 * body; a timeout, an abort by `signal` or a network failure rejects with a
 * plain message.
 */
export async function requestJson(
  url,
  { method = 'GET', headers = {}, form, limit, timeout = REQUEST_TIMEOUT, signal } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeout));
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    const init = {
      method,
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...headers },
      signal: controller.signal,
    };
    if (form) {
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      init.body = new URLSearchParams(form).toString();
    }
    const response = await fetchImpl(url, init);
    if (!response.ok) {
      let body;
      try {
        // A small error body is read (an OAuth error, an APIM message), bounded.
        body = parse(await readBounded(response, 16 * 1024, controller));
      } catch {
        body = undefined;
      }
      controller.abort();
      throw new HttpError(response.status, {
        retryAfter: response.headers.get('retry-after') ?? undefined,
        date: response.headers.get('date') ?? undefined,
        body,
      });
    }
    const text = await readBounded(response, limit, controller);
    const body = parse(text);
    if (body === undefined) throw new BodyError('answer is not JSON');
    return { body, date: response.headers.get('date') ?? undefined };
  } catch (err) {
    if (err instanceof HttpError || err instanceof BodyError) throw err;
    if (signal?.aborted) throw new Error('stopped', { cause: err });
    if (controller.signal.aborted) throw new Error('no answer in time', { cause: err });
    throw new Error('network error', { cause: err });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * The wait asked by a `Retry-After` header, in ms, or undefined. A date is
 * compared to the answer's own `Date` header (never to our clock); without a
 * readable `Date`, a date is ignored.
 */
export function retryAfterMs(retryAfter, date) {
  if (retryAfter === undefined || retryAfter === null) return undefined;
  const text = String(retryAfter).trim();
  if (/^\d{1,9}$/.test(text)) return Number(text) * 1000;
  const until = Date.parse(text);
  const at = date ? Date.parse(date) : NaN;
  if (Number.isNaN(until) || Number.isNaN(at)) return undefined;
  return Math.max(0, until - at);
}
