# gladys-ercot

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for the **ERCOT (Texas) real-time
prices**: the 15-minute Settlement Point Prices of the Houston, North, South and West load zones, read from
the official [ERCOT Public API](https://developer.ercot.com/applications/pubapi/user-guide/registration-and-authentication/)
with your free API Explorer account, fed into Gladys energy calendars (`spot-ercot-rt-lz-<zone>`) and
"ERCOT real-time price" contract templates, plus one price sensor per zone.

- One cycle every 15 minutes at most (at most 6 requests), kept across restarts; pauses on errors.
- The password is only used to get the one-hour token, as ERCOT documents it; the token stays in memory.
- ERCOT blocks requests from outside the USA.
- Never tested with a real ERCOT account yet.

Documentation: [English](docs/en.md) · [Français](docs/fr.md).

Not affiliated with ERCOT. Data: ERCOT public market information, under the
[ERCOT API Terms of Use](https://www.ercot.com/help/terms/data-portal).

## Development

```sh
npm install
npm test          # node --test, no network
npm run lint && npm run format:check
node scripts/cover.mjs cover.png
memcap node scripts/mutants.mjs   # mutation run of the guards (one mutant at a time)
```

Licence: Apache-2.0 (see `LICENSE` and `THIRD_PARTY_NOTICES.md`).
