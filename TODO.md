# TODO

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, `docker_image`, User-Agent).
- SDK `^0.16.0` (latest on npm on 2026-11-14). `gladys_version >=5.3.0`: energy calendars and
  `countries: ["US"]` (rule of 2026-11-12: a single-country module declares it).
- Source: the official ERCOT Public API, report NP6-905-CD (`spp_node_zone_hub`), real-time Settlement
  Point Prices per 15-minute settlement interval, settlement point type `LZ` (not `LZEW`). Written from
  developer.ercot.com and the OpenAPI file of github.com/ercot/api-specs (no licence file: read as
  documentation, nothing copied). No client library used.
- Token: the documented ROPC flow (Azure AD B2C), with the credentials in the form body as the documented
  curl example does (the other examples put them in the URL: never done here). `id_token` used as Bearer,
  valid one hour, no refresh (documented): asked again, renewed 5 minutes before its end, in memory only.
- Refusal = OAuth `invalid_grant` (400/401) on the token, or a 401 whose APIM message names the
  subscription key. Kept in /data as a random salt + 8 bits of SHA-256(salt, credentials); same tag at a
  restart = still refused (1 in 256 new credentials collide: the button lifts it). New credentials in
  process: always tried, within a minute. Button during a refusal: one cycle per click, one per minute.
- Pace: one cycle per 15 minutes (ERCOT posts one price per interval), at most 6 requests (token + 4
  zones + one 401 retry), one at a time: far under the documented 30 requests per minute. Failures: 15 min
  doubled up to 6 h (401 without refusal: up to 1 h); 429/5xx: `Retry-After` obeyed, 1 min to 6 h.
- Window asked: from the local date of the last price known (3 days back at first), to today. Prices of
  intervals not ended yet are ignored (never a real-time price).
- Local time: hour ending + interval + DSTFlag. Spring day: hour ending 02 or 03 both read as the hour from
  01:00 (both present with different prices: both dropped). Autumn day: the second hour ending 02 is the
  one flagged `DSTFlag` true (ERCOT: "the repeated hour"). Not checked against a real change-of-time day.
- Calendars `spot-ercot-rt-lz-<zone>`, `fifteen_minutes`, America/Chicago, USD per kWh = $/MWh / 1000
  (rounded to 0.01 $/MWh). Templates `ercot-rt-lz-<zone>` in `rules` mode: price from the calendar +
  `adder`, `monthly` fixed, `tax` on both, `fallback_price` WITHOUT default (the module never guesses a
  price; the engine needs a fallback for the running interval, whose price is not published yet). The
  manifest passes the core `validateManifest` (Gladys clone of 2026-11-09), checked by hand.
- Negative prices published as they are (a credit for the engine, tax included); the cap 5,000 $/MWh
  kept; beyond ±10,000 $/MWh unreadable (the fallback applies). `fallback_price` is `required` (the core
  refuses a negative one); the adder may be negative (review r1, I1 and M2).
- Every zone answered without a readable price = a failure with its real cause (`answer`), the 15-minute
  pace kept, no pause; unreadable rows logged once per zone (review r1, I2).
- The pace and the pauses run on the monotonic clock in the process; /data's wall times are turned into
  monotonic instants at the first load only (review r1, M1). `connected` sends the status again (M4).
- Sensor: last interval, without `created_at` if it ended < 30 min ago, dated up to 2 h, never beyond,
  once (interval start kept in /data).
- Four zones only (competitive retail areas): Houston, North, South, West.
- No `keywords` in the manifest. Status and button texts as { en, fr } objects.
- ERCOT API Terms of Use read: own account, honest User-Agent, no bot registration; the 3-downloads-a-year
  rule is for the Data Access Portal report files, not the API queries.

## Not verified

- Never run against the real API (no account; the API is geo-blocked outside the USA): the field names of
  the data rows, the `deliveryDate` format, the type of `DSTFlag` and of the hour/interval values, and the
  APIM wording of a refused key come from the documentation and the OpenAPI file; the parser accepts both
  arrays (with `fields`) and objects, `Y`/`N` and booleans, YYYY-MM-DD and MM/DD/YYYY.

## Later

- `timeout-minutes` in the CI workflows (template): not changed here, to keep the release by workflow.
- Hub prices, LZEW prices, the non-competitive load zones, day-ahead prices (NP4-190-CD).
- A scene trigger "price above / below a threshold".
