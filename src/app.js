// -----------------------------------------------------------------------------
// The integration: every 15 minutes at most, asks an ID token when needed and
// reads the real-time prices of the load zones chosen, feeds their Gladys
// energy calendars and their sensors. index.js only wires the SDK handlers.
//
// Clocks: `now` (wall) dates the prices and what goes to /data; `monotonic`
// decides inside the process when the next read may leave and when the token
// ends. After a restart the wait is rebuilt from the attempt time saved in
// /data, which is written BEFORE every cycle.
//
// Secrets: the password and the subscription key live in `this.config` and
// the token in `this.token`, in memory only. /data keeps, after a refusal, 8
// bits of a salted hash of the credentials: nothing to find them back from,
// enough not to send refused credentials again by themselves after a restart.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createLogger } from '@gladysassistant/integration-sdk';
import { credentialsKey, normalizeConfig } from './config.js';
import {
  BACKFILL,
  CONFIG_RETRY_MAX,
  CONFIG_RETRY_MIN,
  DATA_RETRY,
  KEEP,
  LIVE_LAG,
  MAX_AUTH_BACKOFF,
  MAX_BACKOFF,
  MAX_STATE_AGE,
  MIN_GAP,
  PAUSE_MAX,
  PAUSE_MIN,
  PRICE_MAX,
  PRICE_MIN,
  READ_INTERVAL,
  SLOT,
  TOKEN_MARGIN,
  ZONES,
  ZONE_KEYS,
  calendarKey,
} from './constants.js';
import { buildDevice, FEATURE_PRICE, idsOf } from './devices.js';
import { AnswerError, RefusedError, fetchPrices, fetchToken } from './ercot.js';
import { BodyError, HttpError, retryAfterMs } from './http.js';
import { T, report } from './i18n.js';
import { Store } from './store.js';
import { localDate } from './time.js';

export const ACTION_TEST = 'test_connection';

const defaultTimers = { setTimeout, clearTimeout };
const SKEW = 60_000;
/** Calendar entries per call (the host takes 2,000 at most). */
const CALENDAR_BATCH = 500;

const isTime = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** 8 bits of a salted hash of the credentials. */
export const tagOf = (salt, config) =>
  createHash('sha256')
    .update(`${salt}\u0000${credentialsKey(config)}`, 'utf8')
    .digest()[0];

/** The wait after `failures` failures in a row: 15 min doubled, up to `max`. */
export function backoff(failures, max = MAX_BACKOFF) {
  return Math.min(max, READ_INTERVAL * 2 ** Math.max(0, Math.min(16, failures) - 1));
}

/** The reason of a failure (status texts), never a raw message. */
export function reasonOf(err) {
  if (err instanceof HttpError) {
    if (err.status === 429) return 'rate';
    if (err.status >= 500) return 'server';
    if (err.status === 403) return 'forbidden';
    if (err.status === 401) return 'unauthorized';
    return 'http';
  }
  if (err instanceof BodyError || err instanceof AnswerError) return 'answer';
  if (err?.message === 'no answer in time') return 'timeout';
  return 'network';
}

/** Whether a failure stops the whole cycle (the service, not one zone's answer). */
const stopsCycle = (reason) => !['answer', 'http'].includes(reason);

export class ErcotApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'ercot' }),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    dataDir = '/data',
    dataTimeout,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = new Store({ dataDir, timers, timeout: dataTimeout });
    this.config = normalizeConfig();
    this.credKey = undefined;
    this.state = undefined;
    this.token = undefined;
    this.generation = 0;
    this.lifecycle = Promise.resolve();
    this.reading = undefined;
    this.abort = undefined;
    this.readTimer = undefined;
    this.dataTimer = undefined;
    this.configTimer = undefined;
    this.configDelay = CONFIG_RETRY_MIN;
    this.readDueMono = undefined;
    this.lastAttemptMono = undefined;
    this.soon = false;
    this.lastStatus = undefined;
    this.lastError = undefined;
    this.partial = undefined;
    this.calendarWarned = new Set();
  }

  // --- Lifecycle -------------------------------------------------------------

  /** The `connected` event: read the config, retried without end if it fails. */
  async connected() {
    this.timers.clearTimeout(this.configTimer);
    this.configTimer = undefined;
    let raw;
    try {
      raw = await this.gladys.getConfig();
    } catch (err) {
      this.logger.warn(`Reading the configuration failed (${err?.name ?? 'Error'})`);
      await this.setStatus(false, T.configUnreadable);
      const delay = this.configDelay;
      this.configDelay = Math.min(CONFIG_RETRY_MAX, this.configDelay * 2);
      this.configTimer = this.timers.setTimeout(() => this.connected().catch(() => {}), delay);
      return;
    }
    this.configDelay = CONFIG_RETRY_MIN;
    await this.start(raw);
  }

  start(raw = {}) {
    return this.serialize(() => this.doStart(raw));
  }

  stop() {
    this.timers.clearTimeout(this.configTimer);
    this.configTimer = undefined;
    return this.serialize(() => this.doStop());
  }

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  async doStart(raw) {
    await this.doStop();
    const generation = ++this.generation;
    const previousKey = this.credKey;
    this.config = normalizeConfig(raw);
    const key = credentialsKey(this.config);
    // New credentials in this process: always tried (a restart compares the
    // 8-bit tag of /data instead), and the token of the old ones is dropped.
    this.credsChanged = previousKey !== undefined && key !== previousKey;
    if (key !== previousKey) this.token = undefined;
    this.credKey = key;
    this.lastError = undefined;
    this.partial = undefined;
    this.calendarWarned.clear();
    if (this.config.error) {
      await this.setStatus(false, T.configError(this.config.error));
      return;
    }
    await this.publishDevices();
    if (generation !== this.generation) return;
    await this.loadData(generation);
  }

  async doStop() {
    this.generation += 1;
    for (const key of ['readTimer', 'dataTimer']) {
      this.timers.clearTimeout(this[key]);
      this[key] = undefined;
    }
    this.readDueMono = undefined;
    this.abort?.abort();
    await this.reading?.catch(() => {});
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed (${err?.name ?? 'Error'})`));
  }

  // --- /data -------------------------------------------------------------------

  /** Load /data; unreadable: retried every DATA_RETRY, and nothing is read meanwhile. */
  async loadData(generation) {
    this.timers.clearTimeout(this.dataTimer);
    this.dataTimer = undefined;
    const result = await this.store.load();
    if (generation !== this.generation) return;
    if (!result.ok) {
      this.logger.warn('/data unreadable: trying again');
      await this.setStatus(false, T.dataUnreadable);
      if (generation === this.generation) {
        this.dataTimer = this.timers.setTimeout(() => this.loadData(generation), DATA_RETRY);
      }
      return;
    }
    this.state = this.sanitize(result.state, result.corrupt);
    this.scheduleRead();
    await this.updateStatus();
  }

  /** The state of /data, every field checked; a future date is invalid. */
  sanitize(raw, corrupt) {
    const wall = this.now();
    const state = { attempt_at: undefined, failures: 0, pause_until: 0, refused: null, zones: {} };
    // Unknown last attempt: as if it were now (never a read too early).
    if (corrupt) state.attempt_at = wall;
    if (isTime(raw.attempt_at)) {
      state.attempt_at = raw.attempt_at > wall + SKEW ? wall : raw.attempt_at;
    }
    if (Number.isInteger(raw.failures) && raw.failures > 0) {
      state.failures = Math.min(raw.failures, 16);
    }
    if (isTime(raw.pause_until)) {
      // Never longer than the longest pause this module sets: beyond, invalid.
      state.pause_until = raw.pause_until > wall + PAUSE_MAX + SKEW ? 0 : raw.pause_until;
    }
    const refused = raw.refused;
    if (
      refused &&
      typeof refused.salt === 'string' &&
      /^[0-9a-f]{32}$/.test(refused.salt) &&
      Number.isInteger(refused.tag) &&
      refused.tag >= 0 &&
      refused.tag < 256 &&
      (refused.kind === 'login' || refused.kind === 'key')
    ) {
      if (!this.credsChanged && tagOf(refused.salt, this.config) === refused.tag) {
        state.refused = { salt: refused.salt, tag: refused.tag, kind: refused.kind };
      } else {
        // Other credentials than the refused ones: tried soon.
        this.soon = true;
      }
    }
    for (const zone of ZONE_KEYS) {
      const entry = raw.zones?.[zone];
      if (!entry || typeof entry !== 'object') continue;
      const slots = Array.isArray(entry.slots)
        ? entry.slots
            .filter(
              (s) =>
                Array.isArray(s) &&
                Number.isInteger(s[0]) &&
                s[0] % SLOT === 0 &&
                s[0] <= wall + SKEW &&
                s[0] >= wall - KEEP &&
                typeof s[1] === 'number' &&
                Number.isFinite(s[1]) &&
                s[1] >= PRICE_MIN &&
                s[1] <= PRICE_MAX,
            )
            .map((s) => ({ t: s[0], p: s[1], pending: s[2] === 1 }))
        : [];
      const stateT = isTime(entry.state_t) && entry.state_t <= wall + SKEW ? entry.state_t : 0;
      state.zones[zone] = { slots: dedupe(slots), state_t: stateT };
    }
    return state;
  }

  persisted() {
    const s = this.state;
    const zones = {};
    for (const [zone, entry] of Object.entries(s.zones)) {
      zones[zone] = {
        slots: entry.slots.map(({ t, p, pending }) => (pending ? [t, p, 1] : [t, p])),
        state_t: entry.state_t,
      };
    }
    return {
      v: 1,
      attempt_at: s.attempt_at,
      failures: s.failures,
      pause_until: s.pause_until,
      refused: s.refused,
      zones,
    };
  }

  // --- Devices -----------------------------------------------------------------

  async publishDevices() {
    if (this.config.error) return;
    await this.gladys
      .publishDiscoveredDevices(this.config.zones.map((zone) => buildDevice(this.gladys, zone)))
      .catch((err) => this.logger.warn(`Publishing the devices failed (${err?.name ?? 'Error'})`));
  }

  /**
   * The last interval of a zone to its sensor, once: without a date while it
   * ended less than LIVE_LAG ago (a scene may react), dated up to
   * MAX_STATE_AGE, never beyond. Never republished (restart, reconnection).
   */
  async publishSensor(zone, wall, generation) {
    const entry = this.state.zones[zone];
    const last = entry?.slots.at(-1);
    if (!last || last.t <= entry.state_t) return;
    const age = wall - (last.t + SLOT);
    if (age > MAX_STATE_AGE || age < -SKEW) return;
    const state = {
      device_feature_external_id: idsOf(this.gladys, zone).feature(FEATURE_PRICE),
      state: last.p,
    };
    if (age > LIVE_LAG) state.created_at = new Date(last.t + SLOT).toISOString();
    if (generation !== this.generation) return;
    try {
      await this.gladys.publishStates([state]);
      entry.state_t = last.t;
    } catch (err) {
      this.logger.warn(`Publishing the ${zone} price failed (${err?.name ?? 'Error'})`);
    }
  }

  // --- Reading ERCOT -----------------------------------------------------------

  /** Milliseconds before the next read may leave (0: now; Infinity: never by itself). */
  readDelay() {
    const state = this.state;
    if (!state || state.refused || this.config.error) return Infinity;
    const wall = this.now();
    let due = 0;
    if (isTime(state.attempt_at)) {
      due = state.attempt_at + (this.soon ? MIN_GAP : READ_INTERVAL);
    }
    if (isTime(state.pause_until)) due = Math.max(due, state.pause_until);
    return Math.min(PAUSE_MAX + READ_INTERVAL, Math.max(0, due - wall));
  }

  scheduleRead() {
    this.timers.clearTimeout(this.readTimer);
    this.readTimer = undefined;
    this.readDueMono = undefined;
    const delay = this.readDelay();
    if (!Number.isFinite(delay)) return;
    const mono = this.monotonic();
    this.readDueMono = mono + delay;
    const generation = this.generation;
    const fire = () => {
      if (generation !== this.generation) return;
      const left = this.readDueMono - this.monotonic();
      if (left > 0) {
        this.readTimer = this.timers.setTimeout(fire, left);
        return;
      }
      if (this.reading) {
        // Due while a cycle still runs (it took longer than the interval):
        // never lost, the pace is computed again once that cycle is over.
        this.reading.then(() => {
          if (generation === this.generation) this.scheduleRead();
        });
        return;
      }
      this.read(generation);
    };
    if (delay <= 0) {
      fire();
      return;
    }
    this.readTimer = this.timers.setTimeout(fire, delay);
  }

  /** One cycle; single-flight. Resolves when done (never rejects). */
  read(generation = this.generation, { manual = false } = {}) {
    if (!this.reading) {
      this.reading = this.doRead(generation, manual)
        .catch((err) => this.logger.error(`Read failed (${err?.name ?? 'Error'})`))
        .finally(() => {
          this.reading = undefined;
        });
    }
    return this.reading;
  }

  async doRead(generation, manual) {
    const state = this.state;
    this.timers.clearTimeout(this.readTimer);
    this.readTimer = undefined;
    if (!state || this.config.error || (state.refused && !manual)) return;
    // The attempt is on disk before the first request (pace kept across restarts).
    const attemptAt = this.now();
    const saved = await this.store.save({ ...this.persisted(), attempt_at: attemptAt });
    if (generation !== this.generation) return;
    if (!saved) {
      this.logger.warn('/data not writable: the read waits');
      await this.setStatus(false, T.dataUnwritable);
      this.readTimer = this.timers.setTimeout(() => this.read(generation), DATA_RETRY);
      return;
    }
    state.attempt_at = Math.max(attemptAt, this.now());
    this.lastAttemptMono = this.monotonic();
    this.soon = false;
    const abort = new AbortController();
    this.abort = abort;
    const { failure, refused } = await this.cycle(abort.signal, generation);
    if (this.abort === abort) this.abort = undefined;
    const wall = this.now();
    if (abort.signal.aborted) {
      // Stopped (configuration saved, shutdown): neither a failure nor a
      // success; the prices read so far are kept.
    } else if (refused) {
      state.refused = refused;
      state.failures = 0;
      state.pause_until = 0;
      this.token = undefined;
      this.lastError = undefined;
      this.logger.warn(
        `ERCOT refused the ${refused.kind === 'key' ? 'subscription key' : 'login'}`,
      );
    } else if (failure) {
      state.failures += 1;
      const max = failure.reason === 'unauthorized' ? MAX_AUTH_BACKOFF : MAX_BACKOFF;
      let wait = backoff(state.failures, max);
      if (failure.reason === 'rate' || failure.reason === 'server') {
        const asked = retryAfterMs(failure.err?.retryAfter, failure.err?.date) ?? 0;
        wait = Math.min(PAUSE_MAX, Math.max(PAUSE_MIN, wait, asked));
      }
      state.pause_until = wall + wait;
      this.lastError = failure.reason;
      this.logger.warn(`Reading ERCOT failed (${failure.reason})`);
    } else {
      // A whole cycle accepted: the credentials work (a refusal is lifted).
      state.failures = 0;
      state.pause_until = 0;
      state.refused = null;
      this.lastError = undefined;
    }
    if (generation === this.generation) {
      for (const zone of this.config.zones) {
        await this.publishCalendar(zone, generation);
        await this.publishSensor(zone, wall, generation);
      }
    }
    if (!(await this.store.save(this.persisted()))) {
      this.logger.warn('/data not writable: the prices are kept in memory only');
    }
    if (generation !== this.generation) return;
    this.scheduleRead();
    await this.updateStatus();
  }

  /** A valid token, asked when missing or ending. Throws like fetchToken. */
  async ensureToken(signal) {
    const mono = this.monotonic();
    if (this.token && this.token.key === this.credKey && mono < this.token.until) {
      return this.token;
    }
    this.token = undefined;
    const { token, lifetime } = await fetchToken({
      username: this.config.username,
      password: this.config.password,
      signal,
    });
    this.token = {
      value: token,
      key: this.credKey,
      until: this.monotonic() + lifetime - TOKEN_MARGIN,
      fresh: true,
    };
    return this.token;
  }

  /**
   * One read of every zone, one request at a time. Resolves `{ failure }`
   * (the reason that stopped the service: pause), `{ refused }` (a refusal
   * record) or `{}`. A zone whose answer is unreadable does not stop the
   * others (`this.partial`).
   */
  async cycle(signal, generation) {
    this.partial = undefined;
    if (this.token) this.token.fresh = false;
    const refuse = (kind) => {
      const salt = randomBytes(16).toString('hex');
      return { refused: { salt, tag: tagOf(salt, this.config), kind } };
    };
    for (const zone of this.config.zones) {
      if (generation !== this.generation) return {};
      let retried = false;
      for (;;) {
        let token;
        try {
          token = await this.ensureToken(signal);
        } catch (err) {
          if (err instanceof RefusedError) return refuse('login');
          return { failure: { reason: reasonOf(err), err } };
        }
        try {
          await this.readZone(zone, token.value, signal);
          break;
        } catch (err) {
          if (err instanceof RefusedError) return refuse('key');
          const reason = reasonOf(err);
          if (reason === 'unauthorized') {
            // An old token may have been revoked: one new token, one retry.
            // A 401 on a token just given is a failure, never a refusal.
            this.token = undefined;
            if (!token.fresh && !retried) {
              retried = true;
              continue;
            }
            return { failure: { reason, err } };
          }
          if (stopsCycle(reason)) return { failure: { reason, err } };
          this.partial = reason;
          this.logger.warn(`The ${zone} prices were not read (${reason})`);
          break;
        }
      }
    }
    return {};
  }

  /** Read one zone and merge its prices; changed ones are marked for the calendar. */
  async readZone(zone, token, signal) {
    const wall = this.now();
    const entry = (this.state.zones[zone] ??= { slots: [], state_t: 0 });
    const lastKnown = entry.slots.at(-1)?.t;
    // From the last price known (an outage is caught up), three days at most.
    const fromT = Math.max(wall - BACKFILL, lastKnown === undefined ? wall - BACKFILL : lastKnown);
    const { slots } = await fetchPrices({
      token,
      key: this.config.key,
      point: ZONES[zone],
      from: localDate(fromT),
      to: localDate(wall),
      signal,
    });
    const known = new Map(entry.slots.map((s) => [s.t, s]));
    for (const { t, p } of slots) {
      // A price of an interval not yet ended is not a real-time price yet.
      if (t + SLOT > wall + SKEW || t < wall - KEEP) continue;
      const old = known.get(t);
      if (!old) known.set(t, { t, p, pending: true });
      else if (old.p !== p) known.set(t, { t, p, pending: true });
    }
    entry.slots = [...known.values()].filter((s) => s.t >= wall - KEEP).sort((a, b) => a.t - b.t);
  }

  /** Send the changed prices of a zone to its calendar (USD per kWh). */
  async publishCalendar(zone, generation) {
    const entry = this.state.zones[zone];
    const pending = entry?.slots.filter((s) => s.pending) ?? [];
    const key = calendarKey(zone);
    for (let i = 0; i < pending.length; i += CALENDAR_BATCH) {
      if (generation !== this.generation) return;
      const batch = pending.slice(i, i + CALENDAR_BATCH);
      try {
        await this.gladys.publishEnergyCalendar(
          key,
          batch.map(({ t, p }) => ({
            starts_at: new Date(t).toISOString(),
            price: Math.round(p * 100) / 100_000,
            currency: 'USD',
          })),
        );
        for (const slot of batch) slot.pending = false;
      } catch (err) {
        const status = err?.status ?? err?.statusCode;
        if (status === 403 || status === 400) {
          // Not ours (another integration owns the key) or refused: never sent again.
          for (const slot of batch) slot.pending = false;
        }
        const warned = `${key}:${status}`;
        if (!this.calendarWarned.has(warned)) {
          this.calendarWarned.add(warned);
          this.logger.warn(
            status === 403
              ? `Calendar ${key} belongs to another integration: not fed`
              : `Calendar ${key} not fed (${status ?? err?.name ?? 'Error'})`,
          );
        }
        if (status !== 403 && status !== 400) return;
      }
    }
  }

  // --- Status and action -------------------------------------------------------

  /** The newest interval known of the zones chosen, if it ended less than MAX_STATE_AGE ago. */
  latest(wall = this.now()) {
    let latest;
    for (const zone of this.config.zones) {
      const t = this.state?.zones[zone]?.slots.at(-1)?.t;
      if (t !== undefined && (latest === undefined || t > latest)) latest = t;
    }
    return latest !== undefined && wall - (latest + SLOT) <= MAX_STATE_AGE ? latest : undefined;
  }

  currentStatus() {
    const wall = this.now();
    if (this.config.error) return [false, T.configError(this.config.error)];
    if (!this.state) return [false, T.dataUnreadable];
    if (this.state.refused) return [false, T.refused(this.state.refused.kind)];
    const next = wall + this.readDelay();
    if (this.lastError) return [false, T.failed(this.lastError, next)];
    const latest = this.latest(wall);
    if (latest !== undefined) {
      return [
        true,
        T.ok({
          latest: latest + SLOT,
          zones: this.config.zones.map((z) => ZONES[z]),
          partial: this.partial,
        }),
      ];
    }
    if (this.state.attempt_at) return [false, T.noPrice(next)];
    return [false, T.waiting(next)];
  }

  async updateStatus() {
    const [connected, message] = this.currentStatus();
    await this.setStatus(connected, message);
  }

  /**
   * The configuration button. Paused: says until when. Refused: one cycle
   * per click (one per minute at most), which lifts the refusal if ERCOT
   * accepts. Otherwise reads now only if the 15-minute pace allows it.
   */
  async testConnection() {
    if (this.config.error) return report(T.configError(this.config.error));
    if (!this.state) return report(T.dataUnreadable);
    if (this.reading) {
      await this.reading;
    } else if (this.state.pause_until > this.now()) {
      return report(T.paused(this.state.pause_until));
    } else if (this.state.refused) {
      const mono = this.monotonic();
      const wall = this.now();
      const recent =
        this.lastAttemptMono !== undefined
          ? mono - this.lastAttemptMono < MIN_GAP
          : isTime(this.state.attempt_at) && wall - this.state.attempt_at < MIN_GAP;
      if (recent) {
        const since =
          this.lastAttemptMono !== undefined
            ? mono - this.lastAttemptMono
            : wall - this.state.attempt_at;
        return report(T.tooSoon(wall + MIN_GAP - since));
      }
      await this.read(this.generation, { manual: true });
    } else if (this.readDueMono !== undefined && this.monotonic() >= this.readDueMono) {
      await this.read();
    }
    return report(this.currentStatus()[1]);
  }
}

/** One slot per instant, the last one wins, sorted. */
function dedupe(slots) {
  const map = new Map();
  for (const s of slots) map.set(s.t, s);
  return [...map.values()].sort((a, b) => a.t - b.t);
}
