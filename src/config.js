// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized.
// The password and the subscription key stay in this object only: never
// logged, never in /data, never in a status.
// -----------------------------------------------------------------------------

import { ZONE_KEYS } from './constants.js';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/** The zones chosen: an array (multi_select) or a comma-separated text, known keys only. */
function zonesOf(value) {
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const zones = [];
  let unknown = false;
  for (const item of list) {
    const key = text(item).toLowerCase();
    if (!key) continue;
    if (ZONE_KEYS.includes(key)) {
      if (!zones.includes(key)) zones.push(key);
    } else {
      unknown = true;
    }
  }
  return { zones: ZONE_KEYS.filter((k) => zones.includes(k)), unknown };
}

/**
 * `{ username, password, key, zones, error }`: `error` names the first
 * problem (never a value) and the credentials are undefined then.
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const username = text(source.username);
  // A password is taken as typed (spaces included), never trimmed.
  const password = typeof source.password === 'string' ? source.password : '';
  const key = text(source.subscription_key);
  const { zones, unknown } = zonesOf(source.zones);
  const config = {
    username: undefined,
    password: undefined,
    key: undefined,
    zones,
    error: undefined,
  };
  if (!username) config.error = 'username_missing';
  else if (CONTROL.test(username) || username.length > 256) config.error = 'username_invalid';
  else if (!password) config.error = 'password_missing';
  else if (CONTROL.test(password) || password.length > 256) config.error = 'password_invalid';
  else if (!key) config.error = 'key_missing';
  else if (!/^[A-Za-z0-9]{16,128}$/.test(key)) config.error = 'key_invalid';
  else if (zones.length === 0) config.error = unknown ? 'zones_invalid' : 'zones_missing';
  if (!config.error) {
    config.username = username;
    config.password = password;
    config.key = key;
  }
  return config;
}

/** The credentials as one text (in memory only), to see whether they changed. */
export const credentialsKey = (config) =>
  config.error ? '' : JSON.stringify([config.username, config.password, config.key]);
