# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- ERCOT real-time Settlement Point Prices (report NP6-905-CD) of the Houston, North, South and West load
  zones, from the official ERCOT Public API (API Explorer account and subscription key).
- One Gladys energy calendar per zone (`spot-ercot-rt-lz-<zone>`, 15 minutes, USD per kWh) and one
  "ERCOT real-time price" contract template per zone (price + adder + monthly charges + tax, fallback price
  chosen by the user).
- One device per zone with the last real-time price published ($/MWh).
- `countries: ["US"]` in the manifest (Texas only; ERCOT blocks requests from outside the USA), Gladys
  5.3.0 or later.
- One cycle every 15 minutes at most, kept across restarts; pauses on errors and `Retry-After`; a refused
  login or subscription key is never tried again by itself.
