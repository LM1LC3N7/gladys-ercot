// -----------------------------------------------------------------------------
// ERCOT local time (Central Prevailing Time) to UTC instants. Pure, no
// dependency: the offsets come from Intl (the tz database of Node).
//
// ERCOT dates every price by its local delivery date, its hour ENDING (1-24)
// and its 15-minute interval (1-4) in the hour. A day has 24 hours, 23 on the
// spring change and 25 on the autumn one; the hour repeated in autumn is
// hour ending 02, the second one flagged by DSTFlag.
// -----------------------------------------------------------------------------

import { DAY, HOUR, ISO_ZONE, SLOT } from './constants.js';

const parts = new Intl.DateTimeFormat('en-US', {
  timeZone: ISO_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** The local wall clock of an instant: { y, m, d, h, mi }. */
export function localParts(t) {
  const out = {};
  for (const { type, value } of parts.formatToParts(new Date(t))) {
    if (type !== 'literal') out[type] = Number(value);
  }
  return { y: out.year, m: out.month, d: out.day, h: out.hour % 24, mi: out.minute };
}

/** The local date (YYYY-MM-DD) of an instant. */
export function localDate(t) {
  const { y, m, d } = localParts(t);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The instant of the local midnight starting `date` (YYYY-MM-DD), or undefined. */
export function localMidnight(date) {
  const match = DATE.exec(typeof date === 'string' ? date : '');
  if (!match) return undefined;
  const [y, m, d] = match.slice(1).map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const check = new Date(guess);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    return undefined;
  }
  // Central time is UTC-6 or UTC-5: midnight is at 05:00 or 06:00 UTC, and
  // never inside a change of time (02:00 local).
  for (const offset of [5, 6]) {
    const t = guess + offset * HOUR;
    const p = localParts(t);
    if (p.y === y && p.m === m && p.d === d && p.h === 0 && p.mi === 0) return t;
  }
  return undefined;
}

/** The next local date after `date`. */
export function nextDate(date) {
  const start = localMidnight(date);
  return start === undefined ? undefined : localDate(start + DAY + 2 * HOUR);
}

/** The UTC starts of the hours of a local day (23, 24 or 25), or undefined. */
export function dayHours(date) {
  const start = localMidnight(date);
  const next = nextDate(date);
  const end = next === undefined ? undefined : localMidnight(next);
  if (start === undefined || end === undefined) return undefined;
  const hours = [];
  for (let t = start; t < end; t += HOUR) hours.push(t);
  return hours;
}

/**
 * The UTC start of an ERCOT interval, or undefined when it does not exist.
 * `repeated` is the DSTFlag: true only for the second hour ending 02 of the
 * autumn day. On the spring day, the hour from 01:00 to 03:00 (local) is
 * hour ending 02 by its start and 03 by its end: both are read as that one
 * hour (a day that carries both is refused by the caller, two prices for one
 * instant).
 */
export function intervalStart(date, hourEnding, interval, repeated) {
  const hours = dayHours(date);
  if (!hours) return undefined;
  if (!Number.isInteger(hourEnding) || hourEnding < 1 || hourEnding > 24) return undefined;
  if (!Number.isInteger(interval) || interval < 1 || interval > 4) return undefined;
  let index;
  if (hours.length === 24) {
    if (repeated) return undefined;
    index = hourEnding - 1;
  } else if (hours.length === 23) {
    if (repeated) return undefined;
    index = hourEnding <= 1 ? 0 : hourEnding <= 3 ? 1 : hourEnding - 2;
  } else if (hours.length === 25) {
    if (repeated) {
      if (hourEnding !== 2) return undefined;
      index = 2;
    } else {
      index = hourEnding <= 2 ? hourEnding - 1 : hourEnding;
    }
  } else {
    return undefined;
  }
  return hours[index] + (interval - 1) * SLOT;
}
