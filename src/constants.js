// -----------------------------------------------------------------------------
// Constants: endpoints, limits and schedule. Every key stored by Gladys (zone
// keys, feature keys, calendar and template keys) is forever: never rename one.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

/** The version of this integration, from package.json (copied in the image). */
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

export const VERSION = pkg.version;
/** Honest User-Agent, in the name of the integration (never a browser's). */
export const USER_AGENT = `gladys-ercot/${VERSION} (+https://github.com/LM1LC3N7/gladys-ercot)`;

// --- ERCOT Public API (developer.ercot.com, "Registration and Authentication") ---------

/**
 * The ID token: the ROPC flow of the official documentation, a POST whose
 * credentials go in the form body (the documented curl example), never in
 * the URL. The token is valid one hour and cannot be refreshed: a new POST.
 */
export const TOKEN_URL =
  'https://ercotb2c.b2clogin.com/ercotb2c.onmicrosoft.com/B2C_1_PUBAPI-ROPC-FLOW/oauth2/v2.0/token';
/** The public client id of the official documentation (not a secret). */
export const CLIENT_ID = 'fec253ea-0d06-4272-a5e6-b478baeecd70';
export const TOKEN_SCOPE = `openid ${CLIENT_ID} offline_access`;

/** NP6-905-CD: real-time Settlement Point Prices, one per 15-minute settlement interval. */
export const SPP_URL = 'https://api.ercot.com/api/public-reports/np6-905-cd/spp_node_zone_hub';
export const SPP_REPORT = 'NP6-905-CD';
/** The settlement point type read: the load zone price (not LZEW, the energy-weighted one). */
export const POINT_TYPE = 'LZ';

/**
 * The load zones of the competitive retail areas: key (feature, external
 * id, calendar and template keys) -> ERCOT settlement point.
 */
export const ZONES = {
  houston: 'LZ_HOUSTON',
  north: 'LZ_NORTH',
  south: 'LZ_SOUTH',
  west: 'LZ_WEST',
};
export const ZONE_KEYS = Object.keys(ZONES);

/** ERCOT's local time (Central Prevailing Time, with its changes of time). */
export const ISO_ZONE = 'America/Chicago';

/** The Gladys calendar of a zone: 15-minute real-time prices, USD per kWh. */
export const calendarKey = (zone) => `spot-ercot-rt-lz-${zone}`;
/** The contract template of a zone. */
export const templateKey = (zone) => `ercot-rt-lz-${zone}`;

// --- Bounds of the answers ----------------------------------------------------------------
/** A token answer (~5 KB): cut beyond. */
export const TOKEN_MAX_BYTES = 64 * 1024;
/** A price answer: ~400 rows of a few fields (~60 KB): cut beyond. */
export const SPP_MAX_BYTES = 1024 * 1024;
/** Rows asked per request (one page: the window never holds more). */
export const PAGE_SIZE = 1000;
/** Rows read in one answer, at most. */
export const MAX_ROWS = 2000;
/** A token, at most (characters). */
export const MAX_TOKEN_LENGTH = 16 * 1024;
/** One request, from the first byte sent to the last byte read, at most. */
export const REQUEST_TIMEOUT = 20_000;

// --- Schedule -----------------------------------------------------------------------------
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const SLOT = 15 * MINUTE;

/**
 * One read cycle every 15 minutes, never sooner (ERCOT posts a price per
 * 15-minute interval). A cycle sends at most 6 requests (a token, one per
 * zone, one retry): far under the 30 requests per minute ERCOT allows.
 */
export const READ_INTERVAL = 15 * MINUTE;
/** After new credentials lift a refusal, or for the button: one cycle per minute at most. */
export const MIN_GAP = MINUTE;
/** Failures double the wait, from 15 minutes to 6 hours; a 401 not explained: 1 hour at most. */
export const MAX_BACKOFF = 6 * HOUR;
export const MAX_AUTH_BACKOFF = HOUR;
/** A 429 or 5xx pause: Retry-After obeyed, between these bounds. */
export const PAUSE_MIN = MINUTE;
export const PAUSE_MAX = 6 * HOUR;
/** A token is renewed this long before its end (valid one hour). */
export const TOKEN_MARGIN = 5 * MINUTE;
/** Prices read back on a first read (none known yet), and kept in /data. */
export const BACKFILL = 3 * DAY;
export const KEEP = 3 * DAY;
/** The sensor: the last interval published without a date if it ended this recently... */
export const LIVE_LAG = 30 * MINUTE;
/** ...dated up to this age, never published beyond. */
export const MAX_STATE_AGE = 2 * HOUR;

/** /data: one operation at a time, bounded; retried on its own timer when it fails. */
export const DATA_TIMEOUT = 5_000;
export const DATA_RETRY = 10_000;
/** getConfig() failing in `connected`: retried with this spacing (doubling). */
export const CONFIG_RETRY_MIN = 10_000;
export const CONFIG_RETRY_MAX = 5 * MINUTE;
/** A status text, at most (characters). */
export const MAX_STATUS_LENGTH = 200;

// --- Value bounds (a value outside is unreadable, never published) ------------------------
/** $/MWh: ERCOT's offer floor is -$250 and its cap $5,000; congestion can pass them. */
export const PRICE_MIN = -10_000;
export const PRICE_MAX = 10_000;
