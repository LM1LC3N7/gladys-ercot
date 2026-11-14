# ERCOT real-time prices (Texas)

Unofficial integration, not affiliated with ERCOT. It reads the **real-time Settlement Point Prices**
(report NP6-905-CD) of the Texas load zones you choose from the official
[ERCOT Public API](https://developer.ercot.com/applications/pubapi/user-guide/registration-and-authentication/),
every 15 minutes, and feeds the Gladys energy contracts with them.

Never tested with a real ERCOT account yet: the requests follow the official documentation and its
OpenAPI description, the answers were checked against synthetic ones only.

## Setup

1. Create a free account on the [ERCOT API Explorer](https://apiexplorer.ercot.com/) (Sign In / Sign Up,
   e-mail verification, a password of your choice).
2. In **Products**, subscribe to the **Public API** product; in your **Profile**, show and copy the
   **Primary key** of the subscription.
3. In Gladys, fill the configuration: the e-mail of the account, its password, the subscription key and
   the load zones to read (the one of your home: your retailer or utility tells it).
4. Create the devices you want from the Discovery tab, and an energy contract from the
   "ERCOT real-time price" template of your zone.

ERCOT blocks requests from outside the USA: the integration only works from a Gladys installed in the
United States.

The password is used for one thing: the one-hour ID token, asked as the ERCOT documentation shows (a POST
to `ercotb2c.b2clogin.com`, the user name and password in the form body, never in the address). The
password and the subscription key are kept by Gladys in its database; the integration keeps the token in
memory only and never writes the password, the key or the token, nor logs them.

## What you get

- **A Gladys energy calendar per zone**: `spot-ercot-rt-lz-houston`, `-north`, `-south`, `-west`, one price
  per 15-minute interval in USD per kWh (the ERCOT price in $/MWh divided by 1,000), local time of Texas
  (America/Chicago). The first read goes three days back; after an outage, the read starts from the last
  price known (three days at most).
- **A contract template per zone**, "ERCOT real-time price, <zone> load zone": the real-time price plus
  your adder per kWh (retailer margin, delivery charges per kWh), your monthly charges and a tax rate, all
  0 by default, and a **fallback price that you choose** (no default).
- **A device per zone** with one sensor, "Real-time price ($/MWh)": the price of the last interval ERCOT
  published, sent once. Without a date while that interval ended less than 30 minutes ago (a scene can
  react to it), dated with its end up to 2 hours, not sent beyond.

## What the Gladys engine cannot express

- **The current interval has no price yet.** ERCOT publishes a real-time price a few minutes after its
  15-minute interval ends. So the price widget and the "current price" scene condition show the
  **fallback price** of the contract for the running interval, and the cost of an interval read before
  its price came is computed with the fallback, then corrected when the price arrives (Gladys recomputes
  the costs that read a changed calendar value). Gladys shows a warning on its Jobs page each time the
  fallback is used.
- **A missing price is never guessed**: an interval that ERCOT gives without a readable number (empty,
  text) is left out of the calendar; it is never 0.
- The template is the simple shape of a wholesale-indexed plan (price + adder + monthly charges + tax);
  demand charges, tiers or a capped price are not in it.
- Wholesale prices are not your retail rate: most Texas plans are fixed-rate.

## Reads, pace and errors

- One cycle every 15 minutes, never sooner (ERCOT publishes one price per 15 minutes; the only
  exceptions follow a refusal: new credentials, the button, once a minute at most): a token when
  needed (reused for 55 minutes), then one request per zone, one at a time. At most 6 requests per cycle,
  far under the 30 requests per minute ERCOT allows. The time of each cycle is written to `/data` before
  its first request, so a restart or a new configuration keeps the pace.
- Errors (no answer, HTTP 5xx, 403) pause the reads 15 minutes, then 30, 60... up to 6 hours. An HTTP 429
  pauses them the same way, longer if its `Retry-After` asks (6 hours at most). A pause is kept across restarts
  and applies to the button too.
- An HTTP 403 usually means the request came from outside the USA: it is a failure, not a refusal.
- An HTTP 401 that does not name the subscription key: the token is renewed once and the zone read again;
  if a new token is not accepted either, it is a failure, retried after 15 minutes, then up to every hour.
- **Refusals**: an OAuth `invalid_grant` answer to the token request (user name or password refused), or
  a 401 naming the subscription key, stops the reads. The integration does not try the same credentials
  again by itself, even after a restart (it keeps 8 bits of a salted hash of them in `/data`: nothing to
  find them back from). New credentials are tried within a minute. The **Test the connection** button
  tries the account again (once a minute at most) and lifts the refusal if ERCOT accepts.
- An unreadable answer for one zone does not stop the other zones.
- `/data` unreadable or not writable: nothing is read until it is fixed (retried every 10 seconds).

## Not included

- Day-ahead prices, hub prices, the energy-weighted load zone prices (LZEW), the other load zones
  (Austin Energy, CPS Energy, LCRA, Rayburn): not in this version.
- Demand and generation of the ERCOT grid: see the integration gladys-us-grid.
- No command: read-only.

## Data

The prices come from ERCOT's public market information, read through its Public API with your own
account and subject to the ERCOT [Terms of Use](https://www.ercot.com/help/terms/data-portal). Nothing is shipped
with the integration.
